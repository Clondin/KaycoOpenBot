import { and, asc, desc, eq, isNull, lte, or } from "drizzle-orm";
import { createHmac, timingSafeEqual, verify } from "node:crypto";
import type { AgentActor } from "../agents/profile-types";
import type { AuditStore } from "../audit";
import { recordAuditEvent } from "../audit";
import {
  type CredentialSecretReader,
  decryptCredentialForUse,
} from "../credentials";
import type { Database } from "../db/client";
import {
  externalChannelConnections,
  externalIdentityLinks,
  externalMessages,
} from "../db/schema";
import { createOutboundFetch } from "../network/outbound";
import type { RunStore } from "../runs/store";
import {
  requireChannelAgent,
  safeBody,
  safeLine,
  WorkConflictError,
  WorkNotFoundError,
  WorkValidationError,
} from "../work/access";

export const EXTERNAL_CHANNEL_KINDS = [
  "telegram",
  "slack",
  "discord",
  "webhook",
] as const;
export type ExternalChannelKind = (typeof EXTERNAL_CHANNEL_KINDS)[number];

type ConnectionInput = {
  kind: ExternalChannelKind;
  name: string;
  agentId: string;
  channelId: string;
  credentialId?: string;
  inboundSecret?: string;
  config?: Record<string, unknown>;
};

type NormalizedInbound = {
  externalMessageId: string;
  externalUserId: string;
  externalConversationId: string;
  body: string;
  metadata: Record<string, unknown>;
};

type InboundHttp = {
  headers: Headers;
  rawBody: string;
};

type ConnectionRow = typeof externalChannelConnections.$inferSelect;
type MessageRow = typeof externalMessages.$inferSelect;

const MAX_EXTERNAL_BODY = 20_000;
const MAX_DELIVERY_BODY = 4_000;

export function createExternalChannelStore(options: {
  database: Database;
  runs: RunStore;
  credentials: CredentialSecretReader;
  encryptionKey: string;
  audit?: AuditStore;
  allowPrivateHosts?: boolean;
}) {
  const { database, runs, credentials, encryptionKey, audit } = options;
  const outboundFetch = createOutboundFetch({
    allowPrivateHosts: options.allowPrivateHosts === true,
  });

  const getOwned = async (actor: AgentActor, connectionId: string) => {
    const [connection] = await database
      .select()
      .from(externalChannelConnections)
      .where(
        and(
          eq(externalChannelConnections.id, connectionId),
          eq(externalChannelConnections.ownerUserId, actor.id),
        ),
      );
    if (!connection) throw new WorkNotFoundError("Channel bridge not found.");
    return connection;
  };

  const credentialFor = async (connection: ConnectionRow) => {
    if (!connection.credentialId) return null;
    return decryptCredentialForUse(
      encryptionKey,
      credentials,
      connection.credentialId,
    );
  };

  const record = async (
    eventType:
      | "external_channel.created"
      | "external_channel.updated"
      | "external_identity.paired"
      | "external_message.received"
      | "external_message.delivered"
      | "external_message.failed",
    targetType: "external_channel" | "external_identity" | "external_message",
    targetId: string,
    actorUserId: string | null,
    payload: Record<string, unknown>,
  ) => {
    if (!audit) return;
    await recordAuditEvent(audit, {
      eventType,
      targetType,
      targetId,
      ...(actorUserId ? { actorUserId } : {}),
      payload,
    });
  };

  const store = {
    async list(actor: AgentActor) {
      const connections = await database
        .select()
        .from(externalChannelConnections)
        .where(eq(externalChannelConnections.ownerUserId, actor.id))
        .orderBy(desc(externalChannelConnections.updatedAt));
      const identities = await database
        .select()
        .from(externalIdentityLinks)
        .where(eq(externalIdentityLinks.userId, actor.id))
        .orderBy(desc(externalIdentityLinks.updatedAt));
      const messages = await database
        .select()
        .from(externalMessages)
        .where(
          connections.length
            ? or(
                ...connections.map((connection) =>
                  eq(externalMessages.connectionId, connection.id),
                ),
              )
            : undefined,
        )
        .orderBy(desc(externalMessages.createdAt))
        .limit(connections.length ? 50 : 0);
      return { connections, identities, messages };
    },

    async create(actor: AgentActor, input: ConnectionInput) {
      await requireChannelAgent(
        database,
        actor,
        input.channelId,
        input.agentId,
      );
      if (!EXTERNAL_CHANNEL_KINDS.includes(input.kind)) {
        throw new WorkValidationError(
          "That external channel is not supported.",
        );
      }
      const secret = input.inboundSecret?.trim() || strongSecret();
      if (secret.length < 16 || secret.length > 500) {
        throw new WorkValidationError(
          "The inbound secret must be between 16 and 500 characters.",
        );
      }
      if (input.credentialId) {
        await decryptCredentialForUse(
          encryptionKey,
          credentials,
          input.credentialId,
        );
      }
      const [connection] = await database
        .insert(externalChannelConnections)
        .values({
          ownerUserId: actor.id,
          kind: input.kind,
          name: safeLine(input.name, "Bridge name"),
          agentId: input.agentId,
          channelId: input.channelId,
          ...(input.credentialId ? { credentialId: input.credentialId } : {}),
          inboundSecretHash: await hash(secret),
          config: sanitizeConfig(input.config ?? {}),
        })
        .returning();
      if (!connection) throw new Error("Channel bridge could not be created.");
      await record(
        "external_channel.created",
        "external_channel",
        connection.id,
        actor.id,
        { kind: connection.kind, bot: connection.agentId },
      );
      return { connection, inboundSecret: secret };
    },

    async update(
      actor: AgentActor,
      connectionId: string,
      input: { status?: "active" | "paused"; config?: Record<string, unknown> },
    ) {
      await getOwned(actor, connectionId);
      if (input.status && !["active", "paused"].includes(input.status)) {
        throw new WorkValidationError("Bridge status is invalid.");
      }
      const [updated] = await database
        .update(externalChannelConnections)
        .set({
          ...(input.status ? { status: input.status } : {}),
          ...(input.config ? { config: sanitizeConfig(input.config) } : {}),
          updatedAt: new Date(),
        })
        .where(eq(externalChannelConnections.id, connectionId))
        .returning();
      if (!updated) throw new WorkNotFoundError("Channel bridge not found.");
      await record(
        "external_channel.updated",
        "external_channel",
        connectionId,
        actor.id,
        { status: updated.status },
      );
      return updated;
    },

    async rotateSecret(actor: AgentActor, connectionId: string) {
      await getOwned(actor, connectionId);
      const secret = strongSecret();
      const [updated] = await database
        .update(externalChannelConnections)
        .set({ inboundSecretHash: await hash(secret), updatedAt: new Date() })
        .where(eq(externalChannelConnections.id, connectionId))
        .returning();
      if (!updated) throw new WorkNotFoundError("Channel bridge not found.");
      await record(
        "external_channel.updated",
        "external_channel",
        connectionId,
        actor.id,
        { secretRotated: true },
      );
      return { connection: updated, inboundSecret: secret };
    },

    async pairIdentity(
      actor: AgentActor,
      connectionId: string,
      input: {
        externalUserId: string;
        externalConversationId?: string;
        label?: string;
      },
    ) {
      await getOwned(actor, connectionId);
      const externalUserId = safeLine(
        input.externalUserId,
        "External user ID",
        200,
      );
      const [identity] = await database
        .insert(externalIdentityLinks)
        .values({
          connectionId,
          externalUserId,
          userId: actor.id,
          ...(input.externalConversationId?.trim()
            ? {
                externalConversationId: safeLine(
                  input.externalConversationId,
                  "External conversation ID",
                  200,
                ),
              }
            : {}),
          label: input.label?.trim()
            ? safeLine(input.label, "Pairing label")
            : "",
        })
        .onConflictDoUpdate({
          target: [
            externalIdentityLinks.connectionId,
            externalIdentityLinks.externalUserId,
          ],
          set: {
            userId: actor.id,
            externalConversationId: input.externalConversationId?.trim()
              ? safeLine(
                  input.externalConversationId,
                  "External conversation ID",
                  200,
                )
              : null,
            label: input.label?.trim()
              ? safeLine(input.label, "Pairing label")
              : "",
            status: "active",
            updatedAt: new Date(),
          },
        })
        .returning();
      if (!identity) throw new Error("External identity could not be paired.");
      await record(
        "external_identity.paired",
        "external_identity",
        identity.id,
        actor.id,
        { connection: connectionId },
      );
      return identity;
    },

    async ingestHttp(connectionId: string, input: InboundHttp) {
      const [connection] = await database
        .select()
        .from(externalChannelConnections)
        .where(eq(externalChannelConnections.id, connectionId));
      if (!connection || connection.status !== "active") {
        throw new WorkNotFoundError("Channel bridge not found.");
      }
      const parsed = await parseInbound(
        connection,
        input,
        await credentialFor(connection),
      );
      if ("protocolResponse" in parsed) return parsed;
      const [identity] = await database
        .select()
        .from(externalIdentityLinks)
        .where(
          and(
            eq(externalIdentityLinks.connectionId, connection.id),
            eq(externalIdentityLinks.externalUserId, parsed.externalUserId),
            eq(externalIdentityLinks.status, "active"),
            or(
              isNull(externalIdentityLinks.externalConversationId),
              eq(
                externalIdentityLinks.externalConversationId,
                parsed.externalConversationId,
              ),
            ),
          ),
        );
      if (!identity || identity.userId !== connection.ownerUserId) {
        throw new WorkConflictError(
          "This external identity has not been paired with the bridge owner.",
        );
      }

      const [receipt] = await database
        .insert(externalMessages)
        .values({
          connectionId: connection.id,
          direction: "inbound",
          externalMessageId: parsed.externalMessageId,
          externalUserId: parsed.externalUserId,
          externalConversationId: parsed.externalConversationId,
          body: safeBody(parsed.body, "External message", MAX_EXTERNAL_BODY),
          metadata: parsed.metadata,
          status: "accepted",
        })
        .onConflictDoNothing()
        .returning();
      if (!receipt) {
        const [existing] = await database
          .select({ taskRunId: externalMessages.taskRunId })
          .from(externalMessages)
          .where(
            and(
              eq(externalMessages.connectionId, connection.id),
              eq(externalMessages.direction, "inbound"),
              eq(externalMessages.externalMessageId, parsed.externalMessageId),
            ),
          );
        return { accepted: true, duplicate: true, runId: existing?.taskRunId };
      }

      try {
        const actor: AgentActor = { id: identity.userId, role: "user" };
        const run = await runs.create(actor, {
          channelId: connection.channelId,
          agentId: connection.agentId,
          title: `${connection.name}: external message`,
        });
        await database
          .update(externalMessages)
          .set({ taskRunId: run.id, updatedAt: new Date() })
          .where(eq(externalMessages.id, receipt.id));
        await database
          .update(externalChannelConnections)
          .set({
            lastInboundAt: new Date(),
            lastError: null,
            updatedAt: new Date(),
          })
          .where(eq(externalChannelConnections.id, connection.id));
        await record(
          "external_message.received",
          "external_message",
          receipt.id,
          identity.userId,
          { connection: connection.id, run: run.id, kind: connection.kind },
        );
        return { accepted: true, duplicate: false, runId: run.id };
      } catch (error) {
        await database
          .delete(externalMessages)
          .where(eq(externalMessages.id, receipt.id));
        throw error;
      }
    },

    async completeInbound(messageId: string, output: string) {
      const [inbound] = await database
        .select()
        .from(externalMessages)
        .where(
          and(
            eq(externalMessages.id, messageId),
            eq(externalMessages.direction, "inbound"),
          ),
        );
      if (!inbound) throw new WorkNotFoundError("External message not found.");
      await database
        .update(externalMessages)
        .set({ status: "completed", updatedAt: new Date() })
        .where(eq(externalMessages.id, messageId));
      const [outbound] = await database
        .insert(externalMessages)
        .values({
          connectionId: inbound.connectionId,
          direction: "outbound",
          externalConversationId: inbound.externalConversationId,
          taskRunId: inbound.taskRunId,
          body: safeBody(output, "External reply", 50_000),
          metadata: { replyTo: inbound.externalMessageId },
          status: "pending",
          nextAttemptAt: new Date(),
        })
        .returning();
      return outbound ?? null;
    },

    async failInbound(messageId: string, error: string) {
      await database
        .update(externalMessages)
        .set({
          status: "failed",
          lastError: safeLine(error, "Delivery error", 500),
          updatedAt: new Date(),
        })
        .where(eq(externalMessages.id, messageId));
    },

    async claimDelivery(workerId: string, now = new Date()) {
      return database.transaction(async (transaction) => {
        const [candidate] = await transaction
          .select({
            message: externalMessages,
            connection: externalChannelConnections,
          })
          .from(externalMessages)
          .innerJoin(
            externalChannelConnections,
            eq(externalChannelConnections.id, externalMessages.connectionId),
          )
          .where(
            and(
              eq(externalMessages.direction, "outbound"),
              or(
                eq(externalMessages.status, "pending"),
                and(
                  eq(externalMessages.status, "sending"),
                  lte(externalMessages.leaseExpiresAt, now),
                ),
              ),
              eq(externalChannelConnections.status, "active"),
              or(
                isNull(externalMessages.nextAttemptAt),
                lte(externalMessages.nextAttemptAt, now),
              ),
            ),
          )
          .orderBy(asc(externalMessages.createdAt))
          .limit(1)
          .for("update", { of: externalMessages, skipLocked: true });
        if (!candidate) return null;
        const [claimed] = await transaction
          .update(externalMessages)
          .set({
            status: "sending",
            attempt: candidate.message.attempt + 1,
            leaseOwner: workerId,
            leaseExpiresAt: new Date(now.getTime() + 60_000),
            updatedAt: now,
          })
          .where(eq(externalMessages.id, candidate.message.id))
          .returning();
        return claimed
          ? { message: claimed, connection: candidate.connection }
          : null;
      });
    },

    async deliver(claim: { message: MessageRow; connection: ConnectionRow }) {
      await deliverMessage(
        claim.connection,
        claim.message,
        await credentialFor(claim.connection),
        outboundFetch,
      );
    },

    async settleDelivery(
      claim: { message: MessageRow; connection: ConnectionRow },
      outcome: { ok: true } | { ok: false; error: string },
      now = new Date(),
    ) {
      const retry =
        !outcome.ok && claim.message.attempt < claim.message.maxAttempts;
      await database
        .update(externalMessages)
        .set({
          status: outcome.ok ? "delivered" : retry ? "pending" : "failed",
          leaseOwner: null,
          leaseExpiresAt: null,
          nextAttemptAt: retry
            ? new Date(now.getTime() + 5_000 * 2 ** claim.message.attempt)
            : null,
          deliveredAt: outcome.ok ? now : null,
          lastError: outcome.ok
            ? null
            : safeLine(outcome.error, "Delivery error", 500),
          updatedAt: now,
        })
        .where(
          and(
            eq(externalMessages.id, claim.message.id),
            eq(externalMessages.status, "sending"),
          ),
        );
      await database
        .update(externalChannelConnections)
        .set({
          ...(outcome.ok ? { lastOutboundAt: now, lastError: null } : {}),
          ...(!outcome.ok && !retry
            ? { lastError: safeLine(outcome.error, "Delivery error", 500) }
            : {}),
          updatedAt: now,
        })
        .where(eq(externalChannelConnections.id, claim.connection.id));
      await record(
        outcome.ok ? "external_message.delivered" : "external_message.failed",
        "external_message",
        claim.message.id,
        claim.connection.ownerUserId,
        {
          connection: claim.connection.id,
          attempt: claim.message.attempt,
          retry,
        },
      );
    },
  };

  return store;
}

export type ExternalChannelStore = ReturnType<
  typeof createExternalChannelStore
>;

export function startExternalDeliveryWorker(
  store: ExternalChannelStore,
  options: { intervalMs?: number; workerId?: string } = {},
) {
  const intervalMs = Math.max(1_000, options.intervalMs ?? 3_000);
  const workerId =
    options.workerId ??
    `external-delivery:${process.pid}:${crypto.randomUUID()}`;
  let stopped = false;
  let busy = false;
  const tick = async () => {
    if (stopped || busy) return;
    busy = true;
    try {
      for (let count = 0; count < 10 && !stopped; count += 1) {
        const claim = await store.claimDelivery(workerId);
        if (!claim) break;
        try {
          await store.deliver(claim);
          await store.settleDelivery(claim, { ok: true });
        } catch (error) {
          await store.settleDelivery(claim, {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } catch (error) {
      console.error(
        JSON.stringify({
          type: "external-delivery-worker-error",
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  void tick();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

async function parseInbound(
  connection: ConnectionRow,
  input: InboundHttp,
  credential: string | null,
): Promise<NormalizedInbound | { protocolResponse: Record<string, unknown> }> {
  const json = parseJson(input.rawBody);
  if (connection.kind === "telegram") {
    await requireHashedSecret(
      input.headers.get("x-telegram-bot-api-secret-token") ?? "",
      connection.inboundSecretHash,
    );
    const message = object(json.message ?? json.edited_message);
    return normalized({
      externalMessageId: String(json.update_id ?? message.message_id ?? ""),
      externalUserId: String(object(message.from).id ?? ""),
      externalConversationId: String(object(message.chat).id ?? ""),
      body: String(message.text ?? message.caption ?? ""),
      metadata: { provider: "telegram" },
    });
  }
  if (connection.kind === "slack") {
    const envelope = credentialEnvelope(credential);
    verifySlack(input, String(envelope.signingSecret ?? ""));
    if (json.type === "url_verification") {
      return { protocolResponse: { challenge: json.challenge } };
    }
    const event = object(json.event);
    if (event.bot_id || event.subtype === "bot_message") {
      throw new WorkConflictError("Bot-authored Slack events are ignored.");
    }
    return normalized({
      externalMessageId: String(
        json.event_id ?? event.client_msg_id ?? event.ts ?? "",
      ),
      externalUserId: String(event.user ?? ""),
      externalConversationId: String(event.channel ?? ""),
      body: String(event.text ?? ""),
      metadata: { provider: "slack", threadTs: event.thread_ts ?? null },
    });
  }
  if (connection.kind === "discord") {
    verifyDiscord(input, String(object(connection.config).publicKey ?? ""));
    if (json.type === 1) return { protocolResponse: { type: 1 } };
    const member = object(json.member);
    const user = object(member.user ?? json.user);
    const data = object(json.data);
    const options = Array.isArray(data.options) ? data.options : [];
    const prompt = options
      .map((item) => object(item))
      .find((item) => item.name === "prompt")?.value;
    return normalized({
      externalMessageId: String(json.id ?? ""),
      externalUserId: String(user.id ?? ""),
      externalConversationId: String(json.channel_id ?? ""),
      body: String(prompt ?? data.name ?? ""),
      metadata: {
        provider: "discord",
        interactionToken: json.token ? "present" : "absent",
      },
    });
  }

  await requireHashedSecret(
    bearer(input.headers),
    connection.inboundSecretHash,
  );
  return normalized({
    externalMessageId: String(json.id ?? json.messageId ?? ""),
    externalUserId: String(json.userId ?? ""),
    externalConversationId: String(json.conversationId ?? ""),
    body: String(json.text ?? json.body ?? ""),
    metadata: { provider: "webhook" },
  });
}

function normalized(input: NormalizedInbound): NormalizedInbound {
  if (
    !input.externalMessageId ||
    !input.externalUserId ||
    !input.externalConversationId ||
    !input.body.trim()
  ) {
    throw new WorkValidationError(
      "The external event does not contain a message, user, conversation, and text.",
    );
  }
  return {
    ...input,
    externalMessageId: safeLine(input.externalMessageId, "Message ID", 200),
    externalUserId: safeLine(input.externalUserId, "External user ID", 200),
    externalConversationId: safeLine(
      input.externalConversationId,
      "External conversation ID",
      200,
    ),
    body: safeBody(input.body, "External message", MAX_EXTERNAL_BODY),
  };
}

async function deliverMessage(
  connection: ConnectionRow,
  message: MessageRow,
  credential: string | null,
  guardedFetch: ReturnType<typeof createOutboundFetch>,
) {
  const body = Array.from(message.body).slice(0, MAX_DELIVERY_BODY).join("");
  let url: string;
  let headers: Record<string, string> = { "content-type": "application/json" };
  let payload: Record<string, unknown>;

  if (connection.kind === "telegram") {
    const token = credentialEnvelope(credential).botToken ?? credential;
    if (!token) throw new Error("The Telegram bot credential is missing.");
    url = `https://api.telegram.org/bot${String(token)}/sendMessage`;
    payload = { chat_id: message.externalConversationId, text: body };
  } else if (connection.kind === "slack") {
    const token = credentialEnvelope(credential).botToken ?? credential;
    if (!token) throw new Error("The Slack bot credential is missing.");
    url = "https://slack.com/api/chat.postMessage";
    headers = { ...headers, authorization: `Bearer ${String(token)}` };
    payload = { channel: message.externalConversationId, text: body };
  } else if (connection.kind === "discord") {
    const token = credentialEnvelope(credential).botToken ?? credential;
    if (!token) throw new Error("The Discord bot credential is missing.");
    url = `https://discord.com/api/v10/channels/${encodeURIComponent(message.externalConversationId)}/messages`;
    headers = { ...headers, authorization: `Bot ${String(token)}` };
    payload = { content: body };
  } else {
    const configured = object(connection.config).outboundUrl;
    if (typeof configured !== "string" || !configured.trim()) {
      throw new Error("The webhook outbound URL is not configured.");
    }
    url = configured;
    if (credential)
      headers = { ...headers, authorization: `Bearer ${credential}` };
    payload = {
      connectionId: connection.id,
      conversationId: message.externalConversationId,
      text: body,
      runId: message.taskRunId,
    };
  }

  const response = await guardedFetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  });
  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`External delivery returned HTTP ${response.status}.`);
  }
  if (connection.kind === "slack") {
    const slack = parseJson(responseText || "{}");
    if (slack.ok !== true) {
      throw new Error(
        `Slack rejected the message: ${String(slack.error ?? "unknown error")}.`,
      );
    }
  }
}

function parseJson(raw: string) {
  try {
    const value = JSON.parse(raw);
    return object(value);
  } catch {
    throw new WorkValidationError("The external event must be valid JSON.");
  }
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function credentialEnvelope(value: string | null) {
  if (!value) return {};
  try {
    return object(JSON.parse(value));
  } catch {
    return {};
  }
}

function bearer(headers: Headers) {
  const authorization = headers.get("authorization") ?? "";
  return authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : "";
}

async function requireHashedSecret(presented: string, expectedHash: string) {
  if (!presented || presented.length > 500) {
    throw new WorkNotFoundError("Channel bridge not found.");
  }
  const actual = await hash(presented);
  if (!same(actual, expectedHash)) {
    throw new WorkNotFoundError("Channel bridge not found.");
  }
}

function verifySlack(input: InboundHttp, signingSecret: string) {
  const timestamp = input.headers.get("x-slack-request-timestamp") ?? "";
  const signature = input.headers.get("x-slack-signature") ?? "";
  if (
    !signingSecret ||
    !/^\d+$/.test(timestamp) ||
    Math.abs(Date.now() / 1_000 - Number(timestamp)) > 300
  ) {
    throw new WorkNotFoundError("Channel bridge not found.");
  }
  const expected = `v0=${createHmac("sha256", signingSecret)
    .update(`v0:${timestamp}:${input.rawBody}`)
    .digest("hex")}`;
  if (!same(signature, expected)) {
    throw new WorkNotFoundError("Channel bridge not found.");
  }
}

function verifyDiscord(input: InboundHttp, publicKey: string) {
  const signature = input.headers.get("x-signature-ed25519") ?? "";
  const timestamp = input.headers.get("x-signature-timestamp") ?? "";
  if (!/^[0-9a-f]{64}$/i.test(publicKey) || !signature || !timestamp) {
    throw new WorkNotFoundError("Channel bridge not found.");
  }
  const key = Buffer.concat([
    Buffer.from("302a300506032b6570032100", "hex"),
    Buffer.from(publicKey, "hex"),
  ]);
  if (
    !verify(
      null,
      Buffer.from(timestamp + input.rawBody),
      { key, format: "der", type: "spki" },
      Buffer.from(signature, "hex"),
    )
  ) {
    throw new WorkNotFoundError("Channel bridge not found.");
  }
}

function sanitizeConfig(input: Record<string, unknown>) {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (/secret|token|password|credential/i.test(key)) {
      throw new WorkValidationError(
        "Secrets belong in the credential vault, not channel settings.",
      );
    }
    if (
      ["string", "number", "boolean"].includes(typeof value) ||
      value === null
    ) {
      output[key] = value;
    }
  }
  return output;
}

function strongSecret() {
  return `${crypto.randomUUID()}${crypto.randomUUID()}`;
}

async function hash(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Buffer.from(digest).toString("hex");
}

function same(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

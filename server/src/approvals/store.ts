import { and, desc, eq, gt, isNull } from "drizzle-orm";
import type { AgentActor } from "../agents/profile-types";
import type { AuditStore } from "../audit";
import { recordAuditEvent } from "../audit";
import type { PolicyContext } from "../computer/policy";
import type { Database } from "../db/client";
import { approvalRequests } from "../db/schema";
import type { RunStore } from "../runs/store";

export type ApprovalStatus =
  | "pending"
  | "approved"
  | "declined"
  | "expired"
  | "cancelled";

export type ApprovalRequest = {
  id: string;
  runId: string | null;
  channelId: string | null;
  requestedForUserId: string;
  decidedByUserId: string | null;
  botId: string;
  toolName: string;
  policyRule: string | null;
  title: string;
  summary: string;
  details: Array<{ label: string; value: string }>;
  status: ApprovalStatus;
  note: string | null;
  expiresAt: Date;
  decidedAt: Date | null;
  consumedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type ApprovalRequirement = {
  actor: {
    id: string;
    role?: "admin" | "user";
    userId?: string;
    runId?: string;
    channelId?: string;
    approvalId?: string;
  };
  botId: string;
  toolName: string;
  context: PolicyContext;
  policyRule: string | null;
};

export type ApprovalService = {
  /** Consume an exact approved request, or create/reuse the request that must be decided first. */
  authorize(
    input: ApprovalRequirement,
  ): Promise<
    | { authorized: true; approvalId: string }
    | { authorized: false; request: ApprovalRequest }
  >;
  get(actor: AgentActor, approvalId: string): Promise<ApprovalRequest | null>;
  list(
    actor: AgentActor,
    filter?: { runId?: string; channelId?: string; status?: ApprovalStatus },
  ): Promise<ApprovalRequest[]>;
  decide(
    actor: AgentActor,
    approvalId: string,
    decision: "approved" | "declined",
    note?: string,
  ): Promise<ApprovalRequest>;
};

const APPROVAL_LIFETIME_MS = 10 * 60_000;
const MAX_NOTE_CODE_POINTS = 500;

export class ApprovalNotFoundError extends Error {
  constructor() {
    super("Approval request not found.");
    this.name = "ApprovalNotFoundError";
  }
}

export class ApprovalAlreadyDecidedError extends Error {
  constructor() {
    super("That approval request has already been decided.");
    this.name = "ApprovalAlreadyDecidedError";
  }
}

export class ApprovalContextError extends Error {
  constructor() {
    super("The approval is not attached to this task.");
    this.name = "ApprovalContextError";
  }
}

function rowToApproval(
  row: typeof approvalRequests.$inferSelect,
): ApprovalRequest {
  const rawDetails =
    row.details &&
    typeof row.details === "object" &&
    "items" in row.details &&
    Array.isArray(row.details.items)
      ? row.details.items
      : [];
  const details = rawDetails.filter(
    (item): item is { label: string; value: string } =>
      Boolean(
        item &&
          typeof item === "object" &&
          "label" in item &&
          typeof item.label === "string" &&
          "value" in item &&
          typeof item.value === "string",
      ),
  );
  return {
    id: row.id,
    runId: row.runId,
    channelId: row.channelId,
    requestedForUserId: row.requestedForUserId,
    decidedByUserId: row.decidedByUserId,
    botId: row.botId,
    toolName: row.toolName,
    policyRule: row.policyRule,
    title: row.title,
    summary: row.summary,
    details,
    status: row.status as ApprovalStatus,
    note: row.note,
    expiresAt: row.expiresAt,
    decidedAt: row.decidedAt,
    consumedAt: row.consumedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonical(nested)]),
  );
}

async function fingerprint(input: ApprovalRequirement) {
  const bytes = new TextEncoder().encode(
    JSON.stringify(
      canonical({
        botId: input.botId,
        toolName: input.toolName,
        context: input.context,
      }),
    ),
  );
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function actionDescription(toolName: string, context: PolicyContext) {
  const verb: Record<string, string> = {
    computer_click: "Click on a page",
    computer_key: "Press a key on a page",
    computer_navigate: "Open a website",
    computer_type: "Enter text on a page",
    computer_write_file: "Write a workspace file",
    computer_read_file: "Read a workspace file",
    computer_list_files: "List workspace files",
    computer_scroll: "Scroll a page",
  };
  const title = verb[toolName] ?? "Perform an external action";
  const target =
    context.element?.name ||
    context.file?.path ||
    context.page.url ||
    context.mcp?.tool ||
    "the requested target";
  const details: Array<{ label: string; value: string }> = [
    { label: "Action", value: toolName },
  ];
  if (context.element) {
    details.push({ label: "Target", value: context.element.name });
    details.push({ label: "Element", value: context.element.role });
  }
  if (context.page.url)
    details.push({ label: "Page", value: context.page.url });
  if (context.file) details.push({ label: "File", value: context.file.path });
  if (context.key) details.push({ label: "Key", value: context.key });
  if (context.mcp) {
    details.push({ label: "Service", value: context.mcp.server });
    details.push({ label: "Tool", value: context.mcp.tool });
  }
  return { title, summary: `${title}: ${target}`, details };
}

function safeNote(note: string | undefined) {
  if (!note) return null;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: notes are displayed as plain text.
  const flattened = note.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim();
  return Array.from(flattened).slice(0, MAX_NOTE_CODE_POINTS).join("") || null;
}

export function createApprovalService(
  database: Database,
  auditStore: AuditStore,
  runStore?: RunStore,
): ApprovalService {
  const scopeFor = async (input: ApprovalRequirement) => {
    if (!input.actor.runId) return { runId: null, channelId: null };
    if (!runStore) throw new ApprovalContextError();
    const run = await runStore.get(
      { id: input.actor.id, role: input.actor.role ?? "user" },
      input.actor.runId,
    );
    if (
      !run ||
      run.actorUserId !== input.actor.id ||
      run.agentId !== input.botId ||
      (input.actor.channelId !== undefined &&
        input.actor.channelId !== run.channelId)
    ) {
      throw new ApprovalContextError();
    }
    return { runId: run.id, channelId: run.channelId };
  };

  const expireIfNeeded = async (row: typeof approvalRequests.$inferSelect) => {
    if (row.status !== "pending" || row.expiresAt.getTime() > Date.now())
      return row;
    const [expired] = await database
      .update(approvalRequests)
      .set({ status: "expired", updatedAt: new Date() })
      .where(
        and(
          eq(approvalRequests.id, row.id),
          eq(approvalRequests.status, "pending"),
        ),
      )
      .returning();
    if (expired) {
      await recordAuditEvent(auditStore, {
        eventType: "approval.expired",
        targetType: "approval",
        targetId: expired.id,
        payload: { bot: expired.botId, action: expired.toolName },
      });
      if (expired.runId) {
        await runStore
          ?.transitionSystem(expired.runId, "running")
          .catch(() => null);
      }
      return expired;
    }
    const [latest] = await database
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, row.id));
    return latest ?? row;
  };

  const service: ApprovalService = {
    async authorize(input) {
      const actionFingerprint = await fingerprint(input);
      const now = new Date();
      const scope = await scopeFor(input);
      const scopeConditions = scope.runId
        ? [
            eq(approvalRequests.runId, scope.runId),
            eq(approvalRequests.channelId, scope.channelId),
          ]
        : [isNull(approvalRequests.runId), isNull(approvalRequests.channelId)];

      if (input.actor.approvalId) {
        const [consumed] = await database
          .update(approvalRequests)
          .set({ consumedAt: now, updatedAt: now })
          .where(
            and(
              eq(approvalRequests.id, input.actor.approvalId),
              eq(approvalRequests.requestedForUserId, input.actor.id),
              eq(approvalRequests.botId, input.botId),
              eq(approvalRequests.toolName, input.toolName),
              eq(approvalRequests.fingerprint, actionFingerprint),
              ...scopeConditions,
              eq(approvalRequests.status, "approved"),
              isNull(approvalRequests.consumedAt),
              gt(approvalRequests.expiresAt, now),
            ),
          )
          .returning();
        if (consumed) {
          await recordAuditEvent(auditStore, {
            eventType: "approval.consumed",
            targetType: "approval",
            targetId: consumed.id,
            ...(input.actor.userId ? { actorUserId: input.actor.userId } : {}),
            payload: { bot: input.botId, action: input.toolName },
          });
          if (consumed.runId) {
            await runStore
              ?.transitionSystem(consumed.runId, "running")
              .catch(() => null);
          }
          return { authorized: true, approvalId: consumed.id };
        }
      }

      const [existing] = await database
        .select()
        .from(approvalRequests)
        .where(
          and(
            eq(approvalRequests.requestedForUserId, input.actor.id),
            eq(approvalRequests.botId, input.botId),
            eq(approvalRequests.fingerprint, actionFingerprint),
            ...scopeConditions,
            eq(approvalRequests.status, "pending"),
            gt(approvalRequests.expiresAt, now),
          ),
        )
        .orderBy(desc(approvalRequests.createdAt))
        .limit(1);
      if (existing)
        return { authorized: false, request: rowToApproval(existing) };

      const description = actionDescription(input.toolName, input.context);
      const [created] = await database
        .insert(approvalRequests)
        .values({
          runId: scope.runId,
          channelId: scope.channelId,
          requestedForUserId: input.actor.id,
          botId: input.botId,
          toolName: input.toolName,
          fingerprint: actionFingerprint,
          policyRule: input.policyRule,
          title: description.title,
          summary: description.summary,
          details: { items: description.details },
          expiresAt: new Date(now.getTime() + APPROVAL_LIFETIME_MS),
        })
        .returning();
      if (!created)
        throw new Error("The approval request could not be created.");
      await recordAuditEvent(auditStore, {
        eventType: "approval.requested",
        targetType: "approval",
        targetId: created.id,
        ...(input.actor.userId ? { actorUserId: input.actor.userId } : {}),
        payload: {
          bot: input.botId,
          action: input.toolName,
          run: scope.runId,
          rule: input.policyRule,
        },
      });
      if (scope.runId) {
        await runStore
          ?.transitionSystem(scope.runId, "waiting_for_approval")
          .catch(() => null);
      }
      return { authorized: false, request: rowToApproval(created) };
    },

    async get(actor, approvalId) {
      const [row] = await database
        .select()
        .from(approvalRequests)
        .where(
          and(
            eq(approvalRequests.id, approvalId),
            eq(approvalRequests.requestedForUserId, actor.id),
          ),
        );
      return row ? rowToApproval(await expireIfNeeded(row)) : null;
    },

    async list(actor, filter = {}) {
      const conditions = [
        eq(approvalRequests.requestedForUserId, actor.id),
        ...(filter.runId ? [eq(approvalRequests.runId, filter.runId)] : []),
        ...(filter.channelId
          ? [eq(approvalRequests.channelId, filter.channelId)]
          : []),
        ...(filter.status ? [eq(approvalRequests.status, filter.status)] : []),
      ];
      const rows = await database
        .select()
        .from(approvalRequests)
        .where(and(...conditions))
        .orderBy(desc(approvalRequests.createdAt))
        .limit(100);
      return Promise.all(
        rows.map(async (row) => rowToApproval(await expireIfNeeded(row))),
      );
    },

    async decide(actor, approvalId, decision, note) {
      const now = new Date();
      const [updated] = await database
        .update(approvalRequests)
        .set({
          status: decision,
          decidedByUserId: actor.id,
          decidedAt: now,
          note: safeNote(note),
          updatedAt: now,
        })
        .where(
          and(
            eq(approvalRequests.id, approvalId),
            eq(approvalRequests.requestedForUserId, actor.id),
            eq(approvalRequests.status, "pending"),
            gt(approvalRequests.expiresAt, now),
          ),
        )
        .returning();
      if (!updated) {
        const existing = await service.get(actor, approvalId);
        if (!existing) throw new ApprovalNotFoundError();
        if (existing.status === decision) return existing;
        throw new ApprovalAlreadyDecidedError();
      }
      await recordAuditEvent(auditStore, {
        eventType:
          decision === "approved" ? "approval.approved" : "approval.declined",
        targetType: "approval",
        targetId: updated.id,
        actorUserId: actor.id,
        payload: {
          bot: updated.botId,
          action: updated.toolName,
          run: updated.runId,
        },
      });
      // A declined tool call has an answer and can return control to the agent immediately. Approved
      // requests stay waiting until the gateway consumes the exact action.
      if (decision === "declined" && updated.runId) {
        await runStore
          ?.transitionSystem(updated.runId, "running")
          .catch(() => null);
      }
      return rowToApproval(updated);
    },
  };

  return service;
}

export function isApprovalStatus(value: unknown): value is ApprovalStatus {
  return ["pending", "approved", "declined", "expired", "cancelled"].includes(
    value as ApprovalStatus,
  );
}

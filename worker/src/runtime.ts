import { and, desc, eq, isNull } from "drizzle-orm";
import { createAuditStore, recordAuditEvent } from "../../server/src/audit";
import { createSyncPersistence } from "../../server/src/connectors/sync-persistence";
import {
  createCredentialStore,
  decryptCredentialForUse,
} from "../../server/src/credentials";
import type { Database } from "../../server/src/db/client";
import { credentials } from "../../server/src/db/schema";
import { createEmbeddingClient } from "../../server/src/knowledge/embeddings";
import { runConnector } from "./connector-runner";
import { createGoogleDriveAdapter } from "./google-drive";
import { type ClaimedConnector, createConnectorQueue } from "./queue";

export function startConnectorWorker(options: {
  database: Database;
  encryptionKey: string;
  intervalMs?: number;
  leaseMs?: number;
  successIntervalMs?: number;
  failureRetryMs?: number;
  workerId?: string;
}) {
  const queue = createConnectorQueue(options.database);
  const credentialStore = createCredentialStore(options.database);
  const audit = createAuditStore(options.database);
  const workerId =
    options.workerId ?? `connector:${process.pid}:${crypto.randomUUID()}`;
  const intervalMs = Math.max(1_000, options.intervalMs ?? 10_000);
  const leaseMs = Math.max(30_000, options.leaseMs ?? 120_000);
  const successIntervalMs = Math.max(
    60_000,
    options.successIntervalMs ?? 5 * 60_000,
  );
  const failureRetryMs = Math.max(10_000, options.failureRetryMs ?? 60_000);
  let stopped = false;
  let active: Promise<void> | null = null;
  let activeController: AbortController | null = null;

  const embeddingKey = async () => {
    const environment =
      process.env.EMBEDDING_API_KEY?.trim() ||
      process.env.OPENAI_API_KEY?.trim();
    if (environment) return environment;
    const [credential] = await options.database
      .select({ id: credentials.id })
      .from(credentials)
      .where(
        and(
          eq(credentials.kind, "model"),
          eq(credentials.provider, "openai"),
          isNull(credentials.revokedAt),
        ),
      )
      .orderBy(desc(credentials.createdAt), desc(credentials.id))
      .limit(1);
    return credential
      ? decryptCredentialForUse(
          options.encryptionKey,
          credentialStore,
          credential.id,
        )
      : null;
  };
  const embed = createEmbeddingClient({
    apiKey: embeddingKey,
    baseUrl: process.env.EMBEDDING_BASE_URL,
    model: process.env.EMBEDDING_MODEL,
  });

  const execute = async (claim: ClaimedConnector) => {
    const controller = new AbortController();
    activeController = controller;
    const heartbeat = setInterval(
      () => {
        void queue
          .heartbeat(claim.instanceId, workerId, new Date(), leaseMs)
          .then((owned) => {
            if (!owned) controller.abort(new Error("Connector lease lost."));
          })
          .catch(() => undefined);
      },
      Math.floor(leaseMs / 3),
    );
    heartbeat.unref?.();
    let changes = 0;
    try {
      const secret = await decryptCredentialForUse(
        options.encryptionKey,
        credentialStore,
        claim.credentialId,
      );
      if (claim.type !== "google_drive") {
        throw new Error("The OneDrive adapter is not installed yet.");
      }
      const roots = stringArray(claim.sourceMetadata.roots);
      const subject = stringValue(
        claim.sourceMetadata.impersonationSubject,
        "Google Drive impersonation subject",
      );
      const persistence = createSyncPersistence(
        options.database,
        claim.instanceId,
      );
      const originalPersist = persistence.persistBatch;
      persistence.persistBatch = async (batch, cursor) => {
        changes += batch.length;
        await originalPersist(batch, cursor);
      };
      await runConnector(
        createGoogleDriveAdapter({
          serviceAccountJson: secret,
          impersonationSubject: subject,
          roots,
          embed,
        }),
        persistence,
        "sync",
        controller.signal,
      );
      const finished = await queue.finish(
        claim,
        workerId,
        { ok: true, changes },
        new Date(),
        successIntervalMs,
        failureRetryMs,
      );
      if (finished) {
        await recordAuditEvent(audit, {
          eventType: "connector.sync_succeeded",
          targetType: "connector",
          targetId: claim.instanceId,
          payload: { type: claim.type, changes },
        });
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Connector sync failed.";
      const finished = await queue.finish(
        claim,
        workerId,
        { ok: false, error: message },
        new Date(),
        successIntervalMs,
        failureRetryMs,
      );
      if (finished) {
        await recordAuditEvent(audit, {
          eventType: "connector.sync_failed",
          targetType: "connector",
          targetId: claim.instanceId,
          payload: { type: claim.type, reason: message.slice(0, 500) },
        });
      }
    } finally {
      clearInterval(heartbeat);
      if (activeController === controller) activeController = null;
    }
  };

  const tick = async () => {
    if (stopped || active) return;
    const claim = await queue
      .claim(workerId, new Date(), leaseMs)
      .catch((error) => {
        console.error(
          JSON.stringify({
            type: "connector-claim-error",
            message: error instanceof Error ? error.message : String(error),
          }),
        );
        return null;
      });
    if (!claim) return;
    active = execute(claim).finally(() => {
      active = null;
      if (!stopped) queueMicrotask(() => void tick());
    });
    await active;
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  void tick();
  return async () => {
    stopped = true;
    clearInterval(timer);
    activeController?.abort(
      new Error("The connector worker is shutting down."),
    );
    await active;
  };
}

function stringArray(value: unknown) {
  if (!Array.isArray(value)) throw new Error("Connector roots are missing.");
  const roots = value.filter(
    (root): root is string => typeof root === "string" && Boolean(root.trim()),
  );
  if (roots.length === 0) throw new Error("Connector roots are missing.");
  return roots;
}

function stringValue(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is missing.`);
  }
  return value.trim();
}

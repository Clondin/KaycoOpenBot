import { and, asc, eq, isNotNull, lte, ne, or } from "drizzle-orm";
import type { Database } from "../../server/src/db/client";
import { connectorInstances, syncRuns } from "../../server/src/db/schema";

export type ClaimedConnector = {
  instanceId: string;
  syncRunId: string;
  type: "google_drive" | "onedrive";
  credentialId: string;
  sourceMetadata: Record<string, unknown>;
};

export function createConnectorQueue(database: Database) {
  return {
    async claim(workerId: string, now: Date, leaseMs: number) {
      return database.transaction(async (transaction) => {
        const [candidate] = await transaction
          .select()
          .from(connectorInstances)
          .where(
            or(
              and(
                ne(connectorInstances.status, "running"),
                lte(connectorInstances.nextSyncAt, now),
              ),
              and(
                eq(connectorInstances.status, "running"),
                isNotNull(connectorInstances.leaseExpiresAt),
                lte(connectorInstances.leaseExpiresAt, now),
              ),
            ),
          )
          .orderBy(asc(connectorInstances.nextSyncAt))
          .limit(1)
          .for("update", { of: connectorInstances, skipLocked: true });
        if (!candidate?.credentialId) return null;

        if (candidate.status === "running") {
          await transaction
            .update(syncRuns)
            .set({
              status: "failed",
              completedAt: now,
              error: "The previous connector worker lease expired.",
            })
            .where(
              and(
                eq(syncRuns.connectorInstanceId, candidate.id),
                eq(syncRuns.status, "running"),
              ),
            );
        }
        const [syncRun] = await transaction
          .insert(syncRuns)
          .values({
            connectorInstanceId: candidate.id,
            status: "running",
            stats: {},
          })
          .returning({ id: syncRuns.id });
        if (!syncRun)
          throw new Error("The connector sync run was not created.");
        const [claimed] = await transaction
          .update(connectorInstances)
          .set({
            status: "running",
            leaseOwner: workerId,
            leaseExpiresAt: new Date(now.getTime() + Math.max(10_000, leaseMs)),
            lastError: null,
            updatedAt: now,
          })
          .where(eq(connectorInstances.id, candidate.id))
          .returning();
        if (!claimed)
          throw new Error("The connector instance was not claimed.");
        return {
          instanceId: claimed.id,
          syncRunId: syncRun.id,
          type: claimed.type,
          credentialId: candidate.credentialId,
          sourceMetadata: claimed.sourceMetadata,
        } as ClaimedConnector;
      });
    },

    async heartbeat(
      instanceId: string,
      workerId: string,
      now: Date,
      leaseMs: number,
    ) {
      const [row] = await database
        .update(connectorInstances)
        .set({
          leaseExpiresAt: new Date(now.getTime() + Math.max(10_000, leaseMs)),
          updatedAt: now,
        })
        .where(
          and(
            eq(connectorInstances.id, instanceId),
            eq(connectorInstances.status, "running"),
            eq(connectorInstances.leaseOwner, workerId),
          ),
        )
        .returning({ id: connectorInstances.id });
      return Boolean(row);
    },

    async finish(
      claim: ClaimedConnector,
      workerId: string,
      outcome: { ok: true; changes: number } | { ok: false; error: string },
      now: Date,
      successIntervalMs: number,
      failureRetryMs: number,
    ) {
      return database.transaction(async (transaction) => {
        const status = outcome.ok ? "succeeded" : "failed";
        const error = outcome.ok ? null : outcome.error.slice(0, 1_000);
        const [finished] = await transaction
          .update(connectorInstances)
          .set({
            status,
            lastSyncAt: now,
            nextSyncAt: new Date(
              now.getTime() + (outcome.ok ? successIntervalMs : failureRetryMs),
            ),
            leaseOwner: null,
            leaseExpiresAt: null,
            lastError: error,
            updatedAt: now,
          })
          .where(
            and(
              eq(connectorInstances.id, claim.instanceId),
              eq(connectorInstances.status, "running"),
              eq(connectorInstances.leaseOwner, workerId),
            ),
          )
          .returning({ id: connectorInstances.id });
        if (!finished) return false;
        await transaction
          .update(syncRuns)
          .set({
            status,
            completedAt: now,
            error,
            stats: outcome.ok ? { changes: outcome.changes } : {},
          })
          .where(eq(syncRuns.id, claim.syncRunId));
        return true;
      });
    },
  };
}

export type ConnectorQueue = ReturnType<typeof createConnectorQueue>;

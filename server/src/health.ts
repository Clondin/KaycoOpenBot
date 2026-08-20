import { sql } from "drizzle-orm";
import type { Database } from "./db/client";

export type HealthReport = {
  status: "ready" | "degraded";
  checkedAt: string;
  checks: {
    database: "ok";
    modelCredential: "configured" | "missing";
    tasks: Record<string, number>;
    expiredTaskLeases: number;
    connectors: Array<{
      type: string;
      status: string;
      lastSyncAt: string | null;
      nextSyncAt: string;
      error: boolean;
    }>;
  };
};

/** Readiness and queue telemetry without exposing prompts, results, or connector errors. */
export function createHealthReader(
  database: Database,
  modelConfigured: () => Promise<boolean>,
) {
  return async (): Promise<HealthReport> => {
    const [taskRows, expiredRows, connectors, configured] = await Promise.all([
      database.execute<{ status: string; count: number }>(sql`
        select status::text as status, count(*)::int as count
        from task_runs
        group by status
      `),
      database.execute<{ count: number }>(sql`
        select count(*)::int as count
        from task_runs
        where status = 'running'
          and lease_expires_at is not null
          and lease_expires_at <= now()
      `),
      database.execute<{
        type: string;
        status: string;
        last_sync_at: Date | string | null;
        next_sync_at: Date | string;
        has_error: boolean;
      }>(sql`
        select type::text as type,
               status::text as status,
               last_sync_at,
               next_sync_at,
               (last_error is not null) as has_error
        from connector_instances
        order by type
      `),
      modelConfigured(),
    ]);
    const taskCounts = Object.fromEntries(
      [...taskRows].map((row) => [row.status, Number(row.count)]),
    );
    const expiredTaskLeases = Number([...expiredRows][0]?.count ?? 0);
    const connectorChecks = [...connectors].map((row) => ({
      type: row.type,
      status: row.status,
      lastSyncAt: iso(row.last_sync_at),
      nextSyncAt: iso(row.next_sync_at) as string,
      error: row.has_error,
    }));
    const degraded =
      !configured ||
      expiredTaskLeases > 0 ||
      connectorChecks.some((connector) => connector.status === "failed");
    return {
      status: degraded ? "degraded" : "ready",
      checkedAt: new Date().toISOString(),
      checks: {
        database: "ok",
        modelCredential: configured ? "configured" : "missing",
        tasks: taskCounts,
        expiredTaskLeases,
        connectors: connectorChecks,
      },
    };
  };
}

function iso(value: Date | string | null) {
  return value instanceof Date ? value.toISOString() : value;
}

export type HealthReader = ReturnType<typeof createHealthReader>;

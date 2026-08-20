import {
  and,
  asc,
  desc,
  eq,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import type { AgentActor } from "../agents/profile-types";
import type { AuditStore } from "../audit";
import { recordAuditEvent } from "../audit";
import type { Database } from "../db/client";
import {
  channelAgents,
  channelMemberships,
  delegations,
  intelligenceChannelMappings,
  routineDispatches,
  routines,
  taskRunEvents,
  taskRuns,
} from "../db/schema";

export const TASK_RUN_STATUSES = [
  "queued",
  "running",
  "waiting_for_approval",
  "waiting_for_input",
  "succeeded",
  "failed",
  "cancelled",
] as const;

export type TaskRunStatus = (typeof TASK_RUN_STATUSES)[number];

export type TaskRun = {
  id: string;
  channelId: string;
  agentId: string | null;
  threadId: string;
  actorUserId: string;
  title: string;
  status: TaskRunStatus;
  parentRunId: string | null;
  attempt: number;
  maxAttempts: number;
  maxRuntimeMs: number;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  nextAttemptAt: Date | null;
  output: string | null;
  error: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  lastHeartbeatAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type TaskRunEvent = {
  id: string;
  runId: string;
  sequence: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: Date;
};

export type AutomatedTaskSource =
  | { kind: "routine"; id: string; instruction: string }
  | { kind: "delegation"; id: string; instruction: string };

export type AutomatedTask = {
  run: TaskRun;
  source: AutomatedTaskSource;
};

export type AutomatedSettlement = {
  run: TaskRun;
  retryScheduled: boolean;
};

export type RunStore = {
  create(
    actor: AgentActor,
    input: {
      channelId: string;
      agentId: string;
      title?: string;
      parentRunId?: string;
      maxAttempts?: number;
      maxRuntimeMs?: number;
    },
  ): Promise<TaskRun>;
  get(actor: AgentActor, runId: string): Promise<TaskRun | null>;
  list(
    actor: AgentActor,
    channelId: string,
    limit?: number,
  ): Promise<TaskRun[]>;
  /** The person's queue across channels, newest first. */
  listAll(actor: AgentActor, limit?: number): Promise<TaskRun[]>;
  events(actor: AgentActor, runId: string): Promise<TaskRunEvent[]>;
  transition(
    actor: AgentActor,
    runId: string,
    status: TaskRunStatus,
    error?: string,
  ): Promise<TaskRun>;
  /** Used only by trusted server services such as the approval gateway. */
  transitionSystem(
    runId: string,
    status: TaskRunStatus,
    error?: string,
  ): Promise<TaskRun | null>;
  /** Atomically claims the oldest routine/delegation run that is ready. */
  claimAutomated(
    workerId: string,
    now: Date,
    leaseMs: number,
  ): Promise<AutomatedTask | null>;
  /** Extends a lease only while this worker still owns a running attempt. */
  heartbeatAutomated(
    runId: string,
    workerId: string,
    now: Date,
    leaseMs: number,
  ): Promise<boolean>;
  /** Completes an owned attempt or returns it to the queue with bounded backoff. */
  settleAutomated(
    runId: string,
    workerId: string,
    outcome: { ok: true; output?: string } | { ok: false; error: string },
    now: Date,
    baseRetryMs: number,
  ): Promise<AutomatedSettlement | null>;
  /** Reclaims attempts whose worker disappeared, using the same retry ceiling. */
  recoverExpiredAutomated(
    now: Date,
    baseRetryMs: number,
    maximum?: number,
  ): Promise<Array<{ task: AutomatedTask; retryScheduled: boolean }>>;
};

const TERMINAL = new Set<TaskRunStatus>(["succeeded", "failed", "cancelled"]);
const TRANSITIONS: Record<TaskRunStatus, ReadonlySet<TaskRunStatus>> = {
  queued: new Set(["running", "failed", "cancelled"]),
  running: new Set([
    "queued",
    "waiting_for_approval",
    "waiting_for_input",
    "succeeded",
    "failed",
    "cancelled",
  ]),
  waiting_for_approval: new Set(["running", "failed", "cancelled"]),
  waiting_for_input: new Set(["running", "failed", "cancelled"]),
  succeeded: new Set(),
  failed: new Set(),
  cancelled: new Set(),
};

const MAX_TITLE_CODE_POINTS = 120;
const MAX_ERROR_CODE_POINTS = 500;
const MAX_OUTPUT_CODE_POINTS = 50_000;

export class RunNotFoundError extends Error {
  constructor() {
    super("Task run not found.");
    this.name = "RunNotFoundError";
  }
}

export class RunTransitionError extends Error {
  constructor(from: TaskRunStatus, to: TaskRunStatus) {
    super(`A task run cannot move from ${from} to ${to}.`);
    this.name = "RunTransitionError";
  }
}

function safeText(value: string | undefined, fallback: string, limit: number) {
  const flattened = Array.from(value ?? "", (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159)
      ? " "
      : character;
  }).join("");
  const collapsed = flattened.trim().replace(/\s+/g, " ") || fallback;
  return Array.from(collapsed).slice(0, limit).join("");
}

function safeOutput(value: string | undefined) {
  const output = Array.from(value?.trim() ?? "")
    .slice(0, MAX_OUTPUT_CODE_POINTS)
    .join("");
  return output || null;
}

function rowToRun(row: typeof taskRuns.$inferSelect): TaskRun {
  return { ...row, status: row.status as TaskRunStatus };
}

type AutomatedRow = {
  run: typeof taskRuns.$inferSelect;
  routineId: string | null;
  routineInstruction: string | null;
  delegationId: string | null;
  delegationInstructions: string | null;
  delegationExpectedOutput: string | null;
  delegationContext: Record<string, unknown> | null;
};

function automatedTask(row: AutomatedRow): AutomatedTask {
  if (row.delegationId && row.delegationInstructions) {
    const context = row.delegationContext ?? {};
    const contextText = Object.keys(context).length
      ? `Context:\n${JSON.stringify(context)}`
      : "";
    return {
      run: rowToRun(row.run),
      source: {
        kind: "delegation",
        id: row.delegationId,
        instruction: [
          row.delegationInstructions,
          row.delegationExpectedOutput
            ? `Expected output:\n${row.delegationExpectedOutput}`
            : "",
          contextText,
        ]
          .filter(Boolean)
          .join("\n\n")
          .slice(0, 30_000),
      },
    };
  }
  if (row.routineId && row.routineInstruction) {
    return {
      run: rowToRun(row.run),
      source: {
        kind: "routine",
        id: row.routineId,
        instruction: row.routineInstruction,
      },
    };
  }
  throw new Error("An automated task has no durable source instruction.");
}

function retryDelay(attempt: number, baseRetryMs: number) {
  const exponent = Math.max(0, Math.min(attempt - 1, 8));
  return Math.max(1_000, baseRetryMs) * 2 ** exponent;
}

export function createRunStore(
  database: Database,
  auditStore?: AuditStore,
): RunStore {
  const appendEvent = async (
    executor: Database,
    runId: string,
    type: string,
    payload: Record<string, unknown>,
  ) => {
    const [{ next }] = await executor
      .select({
        next: sql<number>`coalesce(max(${taskRunEvents.sequence}), 0) + 1`,
      })
      .from(taskRunEvents)
      .where(eq(taskRunEvents.runId, runId));
    await executor.insert(taskRunEvents).values({
      runId,
      sequence: Number(next ?? 1),
      type,
      payload,
    });
  };

  const selectAutomated = (executor: Database) =>
    executor
      .select({
        run: taskRuns,
        routineId: routineDispatches.routineId,
        routineInstruction: routines.instruction,
        delegationId: delegations.id,
        delegationInstructions: delegations.instructions,
        delegationExpectedOutput: delegations.expectedOutput,
        delegationContext: delegations.context,
      })
      .from(taskRuns)
      .leftJoin(routineDispatches, eq(routineDispatches.taskRunId, taskRuns.id))
      .leftJoin(routines, eq(routines.id, routineDispatches.routineId))
      .leftJoin(delegations, eq(delegations.taskRunId, taskRuns.id));

  const settleOn = async (
    executor: Database,
    current: typeof taskRuns.$inferSelect,
    outcome: { ok: true; output?: string } | { ok: false; error: string },
    now: Date,
    baseRetryMs: number,
  ): Promise<AutomatedSettlement> => {
    const retryScheduled = !outcome.ok && current.attempt < current.maxAttempts;
    const status: TaskRunStatus = outcome.ok
      ? "succeeded"
      : retryScheduled
        ? "queued"
        : "failed";
    const error = outcome.ok
      ? null
      : safeText(
          outcome.error,
          "The automated task stopped without a reported reason.",
          MAX_ERROR_CODE_POINTS,
        );
    const [updated] = await executor
      .update(taskRuns)
      .set({
        status,
        error,
        output: outcome.ok ? safeOutput(outcome.output) : null,
        leaseOwner: null,
        leaseExpiresAt: null,
        nextAttemptAt: retryScheduled
          ? new Date(now.getTime() + retryDelay(current.attempt, baseRetryMs))
          : null,
        completedAt: TERMINAL.has(status) ? now : null,
        updatedAt: now,
      })
      .where(
        and(
          eq(taskRuns.id, current.id),
          eq(taskRuns.status, "running"),
          current.leaseOwner
            ? eq(taskRuns.leaseOwner, current.leaseOwner)
            : isNull(taskRuns.leaseOwner),
        ),
      )
      .returning();
    if (!updated) {
      throw new RunTransitionError("running", status);
    }
    await appendEvent(executor, current.id, "status", {
      from: "running",
      to: status,
      attempt: current.attempt,
      ...(error ? { error } : {}),
      ...(retryScheduled && updated.nextAttemptAt
        ? { retryAt: updated.nextAttemptAt.toISOString() }
        : {}),
    });
    return { run: rowToRun(updated), retryScheduled };
  };

  const transitionOn = async (
    runId: string,
    status: TaskRunStatus,
    error?: string,
  ): Promise<TaskRun | null> => {
    return database.transaction(async (transaction) => {
      const [current] = await transaction
        .select()
        .from(taskRuns)
        .where(eq(taskRuns.id, runId))
        .for("update");
      if (!current) return null;
      const from = current.status as TaskRunStatus;
      if (from === status) {
        if (status !== "running") return rowToRun(current);
        const now = new Date();
        const [heartbeat] = await transaction
          .update(taskRuns)
          .set({ lastHeartbeatAt: now, updatedAt: now })
          .where(eq(taskRuns.id, runId))
          .returning();
        return heartbeat ? rowToRun(heartbeat) : null;
      }
      if (!TRANSITIONS[from].has(status))
        throw new RunTransitionError(from, status);

      const now = new Date();
      const [updated] = await transaction
        .update(taskRuns)
        .set({
          status,
          updatedAt: now,
          lastHeartbeatAt: status === "running" ? now : current.lastHeartbeatAt,
          startedAt:
            status === "running" && current.startedAt === null
              ? now
              : current.startedAt,
          completedAt: TERMINAL.has(status) ? now : null,
          leaseOwner:
            TERMINAL.has(status) || status === "queued"
              ? null
              : current.leaseOwner,
          leaseExpiresAt:
            TERMINAL.has(status) || status === "queued"
              ? null
              : current.leaseExpiresAt,
          error:
            status === "failed"
              ? safeText(
                  error,
                  "The task stopped without a reported reason.",
                  MAX_ERROR_CODE_POINTS,
                )
              : null,
        })
        .where(and(eq(taskRuns.id, runId), eq(taskRuns.status, from)))
        .returning();
      if (!updated) throw new RunTransitionError(from, status);
      await appendEvent(transaction as unknown as Database, runId, "status", {
        from,
        to: status,
        ...(status === "failed" && updated.error
          ? { error: updated.error }
          : {}),
      });
      return rowToRun(updated);
    });
  };

  const store: RunStore = {
    async create(actor, input) {
      const run = await database.transaction(async (transaction) => {
        const [channel] = await transaction
          .select({ threadId: intelligenceChannelMappings.threadId })
          .from(channelMemberships)
          .innerJoin(
            intelligenceChannelMappings,
            and(
              eq(
                intelligenceChannelMappings.channelId,
                channelMemberships.channelId,
              ),
              eq(intelligenceChannelMappings.userId, channelMemberships.userId),
            ),
          )
          .where(
            and(
              eq(channelMemberships.channelId, input.channelId),
              eq(channelMemberships.userId, actor.id),
            ),
          );
        if (!channel) throw new RunNotFoundError();

        const [linkedAgent] = await transaction
          .select({ agentId: channelAgents.agentId })
          .from(channelAgents)
          .where(
            and(
              eq(channelAgents.channelId, input.channelId),
              eq(channelAgents.agentId, input.agentId),
            ),
          );
        if (!linkedAgent) throw new RunNotFoundError();

        if (input.parentRunId) {
          const [parent] = await transaction
            .select({ id: taskRuns.id })
            .from(taskRuns)
            .where(
              and(
                eq(taskRuns.id, input.parentRunId),
                eq(taskRuns.channelId, input.channelId),
                eq(taskRuns.actorUserId, actor.id),
              ),
            );
          if (!parent) throw new RunNotFoundError();
        }

        const [created] = await transaction
          .insert(taskRuns)
          .values({
            channelId: input.channelId,
            agentId: input.agentId,
            threadId: channel.threadId,
            actorUserId: actor.id,
            title: safeText(
              input.title,
              "Conversation task",
              MAX_TITLE_CODE_POINTS,
            ),
            ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
            ...(input.maxAttempts !== undefined
              ? {
                  maxAttempts: Math.max(
                    1,
                    Math.min(Math.trunc(input.maxAttempts), 10),
                  ),
                }
              : {}),
            ...(input.maxRuntimeMs !== undefined
              ? {
                  maxRuntimeMs: Math.max(
                    10_000,
                    Math.min(Math.trunc(input.maxRuntimeMs), 3_600_000),
                  ),
                }
              : {}),
          })
          .returning();
        if (!created) throw new Error("The task run could not be created.");
        await appendEvent(
          transaction as unknown as Database,
          created.id,
          "created",
          {
            status: "queued",
            ...(input.parentRunId ? { retriedFrom: input.parentRunId } : {}),
          },
        );
        return rowToRun(created);
      });

      if (auditStore) {
        await recordAuditEvent(auditStore, {
          eventType: input.parentRunId ? "task.retried" : "task.created",
          targetType: "task_run",
          targetId: run.id,
          actorUserId: actor.id,
          payload: {
            channel: run.channelId,
            bot: run.agentId,
            ...(input.parentRunId ? { parentRun: input.parentRunId } : {}),
          },
        });
      }
      return run;
    },

    async get(actor, runId) {
      const [row] = await database
        .select({ run: taskRuns })
        .from(taskRuns)
        .innerJoin(
          channelMemberships,
          and(
            eq(channelMemberships.channelId, taskRuns.channelId),
            eq(channelMemberships.userId, actor.id),
          ),
        )
        .where(eq(taskRuns.id, runId));
      return row ? rowToRun(row.run) : null;
    },

    async list(actor, channelId, limit = 20) {
      const rows = await database
        .select({ run: taskRuns })
        .from(taskRuns)
        .innerJoin(
          channelMemberships,
          and(
            eq(channelMemberships.channelId, taskRuns.channelId),
            eq(channelMemberships.userId, actor.id),
          ),
        )
        .where(eq(taskRuns.channelId, channelId))
        .orderBy(desc(taskRuns.createdAt))
        .limit(Math.max(1, Math.min(limit, 100)));
      return rows.map(({ run }) => rowToRun(run));
    },

    async listAll(actor, limit = 50) {
      const rows = await database
        .select({ run: taskRuns })
        .from(taskRuns)
        .innerJoin(
          channelMemberships,
          and(
            eq(channelMemberships.channelId, taskRuns.channelId),
            eq(channelMemberships.userId, actor.id),
          ),
        )
        .orderBy(desc(taskRuns.createdAt))
        .limit(Math.max(1, Math.min(limit, 200)));
      return rows.map(({ run }) => rowToRun(run));
    },

    async events(actor, runId) {
      if (!(await store.get(actor, runId))) throw new RunNotFoundError();
      const rows = await database
        .select()
        .from(taskRunEvents)
        .where(eq(taskRunEvents.runId, runId))
        .orderBy(taskRunEvents.sequence);
      return rows as TaskRunEvent[];
    },

    async transition(actor, runId, status, error) {
      if (!(await store.get(actor, runId))) throw new RunNotFoundError();
      const updated = await transitionOn(runId, status, error);
      if (!updated) throw new RunNotFoundError();
      if (auditStore) {
        await recordAuditEvent(auditStore, {
          eventType: "task.status_changed",
          targetType: "task_run",
          targetId: runId,
          actorUserId: actor.id,
          payload: { status },
        });
      }
      return updated;
    },

    transitionSystem: transitionOn,

    async claimAutomated(workerId, now, leaseMs) {
      return database.transaction(async (transaction) => {
        const [candidate] = await selectAutomated(
          transaction as unknown as Database,
        )
          .where(
            and(
              eq(taskRuns.status, "queued"),
              or(
                isNull(taskRuns.nextAttemptAt),
                lte(taskRuns.nextAttemptAt, now),
              ),
              or(
                isNotNull(routineDispatches.routineId),
                isNotNull(delegations.id),
              ),
            ),
          )
          .orderBy(asc(taskRuns.createdAt))
          .limit(1)
          .for("update", { of: taskRuns, skipLocked: true });
        if (!candidate) return null;

        const leaseExpiresAt = new Date(
          now.getTime() + Math.max(5_000, leaseMs),
        );
        const [claimed] = await transaction
          .update(taskRuns)
          .set({
            status: "running",
            attempt: candidate.run.attempt + 1,
            leaseOwner: workerId,
            leaseExpiresAt,
            nextAttemptAt: null,
            error: null,
            output: null,
            startedAt: candidate.run.startedAt ?? now,
            lastHeartbeatAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(taskRuns.id, candidate.run.id),
              eq(taskRuns.status, "queued"),
            ),
          )
          .returning();
        if (!claimed) return null;
        await appendEvent(
          transaction as unknown as Database,
          claimed.id,
          "claimed",
          {
            worker: workerId,
            attempt: claimed.attempt,
            leaseExpiresAt: leaseExpiresAt.toISOString(),
          },
        );
        await appendEvent(
          transaction as unknown as Database,
          claimed.id,
          "status",
          { from: "queued", to: "running", attempt: claimed.attempt },
        );
        return automatedTask({ ...candidate, run: claimed });
      });
    },

    async heartbeatAutomated(runId, workerId, now, leaseMs) {
      const [updated] = await database
        .update(taskRuns)
        .set({
          lastHeartbeatAt: now,
          leaseExpiresAt: new Date(now.getTime() + Math.max(5_000, leaseMs)),
          updatedAt: now,
        })
        .where(
          and(
            eq(taskRuns.id, runId),
            eq(taskRuns.status, "running"),
            eq(taskRuns.leaseOwner, workerId),
          ),
        )
        .returning({ id: taskRuns.id });
      return Boolean(updated);
    },

    async settleAutomated(runId, workerId, outcome, now, baseRetryMs) {
      return database.transaction(async (transaction) => {
        const [current] = await transaction
          .select()
          .from(taskRuns)
          .where(
            and(
              eq(taskRuns.id, runId),
              eq(taskRuns.status, "running"),
              eq(taskRuns.leaseOwner, workerId),
            ),
          )
          .for("update");
        if (!current) return null;
        return settleOn(
          transaction as unknown as Database,
          current,
          outcome,
          now,
          baseRetryMs,
        );
      });
    },

    async recoverExpiredAutomated(now, baseRetryMs, maximum = 20) {
      return database.transaction(async (transaction) => {
        const expired = await selectAutomated(
          transaction as unknown as Database,
        )
          .where(
            and(
              eq(taskRuns.status, "running"),
              isNotNull(taskRuns.leaseOwner),
              lte(taskRuns.leaseExpiresAt, now),
              or(
                isNotNull(routineDispatches.routineId),
                isNotNull(delegations.id),
              ),
            ),
          )
          .orderBy(asc(taskRuns.leaseExpiresAt))
          .limit(Math.max(1, Math.min(maximum, 100)))
          .for("update", { of: taskRuns, skipLocked: true });
        const recovered: Array<{
          task: AutomatedTask;
          retryScheduled: boolean;
        }> = [];
        for (const row of expired) {
          const settlement = await settleOn(
            transaction as unknown as Database,
            row.run,
            {
              ok: false,
              error:
                "The previous executor stopped responding before its lease expired.",
            },
            now,
            baseRetryMs,
          );
          recovered.push({
            task: automatedTask({ ...row, run: settlement.run }),
            retryScheduled: settlement.retryScheduled,
          });
        }
        return recovered;
      });
    },
  };

  return store;
}

export function isTaskRunStatus(value: unknown): value is TaskRunStatus {
  return TASK_RUN_STATUSES.includes(value as TaskRunStatus);
}

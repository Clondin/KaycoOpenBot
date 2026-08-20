import { and, desc, eq, sql } from "drizzle-orm";
import type { AgentActor } from "../agents/profile-types";
import type { AuditStore } from "../audit";
import { recordAuditEvent } from "../audit";
import type { Database } from "../db/client";
import {
  channelAgents,
  channelMemberships,
  intelligenceChannelMappings,
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

export type RunStore = {
  create(
    actor: AgentActor,
    input: {
      channelId: string;
      agentId: string;
      title?: string;
      parentRunId?: string;
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
};

const TERMINAL = new Set<TaskRunStatus>(["succeeded", "failed", "cancelled"]);
const TRANSITIONS: Record<TaskRunStatus, ReadonlySet<TaskRunStatus>> = {
  queued: new Set(["running", "failed", "cancelled"]),
  running: new Set([
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

function rowToRun(row: typeof taskRuns.$inferSelect): TaskRun {
  return { ...row, status: row.status as TaskRunStatus };
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
  };

  return store;
}

export function isTaskRunStatus(value: unknown): value is TaskRunStatus {
  return TASK_RUN_STATUSES.includes(value as TaskRunStatus);
}

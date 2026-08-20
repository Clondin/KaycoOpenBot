import { and, asc, desc, eq, lte } from "drizzle-orm";
import { timingSafeEqual } from "node:crypto";
import type { AgentActor } from "../agents/profile-types";
import type { AuditStore } from "../audit";
import { recordAuditEvent } from "../audit";
import type { Database } from "../db/client";
import { routineDispatches, routines, taskRuns } from "../db/schema";
import type { RunStore, TaskRun } from "../runs/store";
import {
  requireChannelAgent,
  requireProject,
  safeBody,
  safeLine,
  WorkConflictError,
  WorkNotFoundError,
  WorkValidationError,
} from "./access";
import type { NotificationStore } from "./notifications";
import {
  nextScheduledAt,
  parseRoutineSchedule,
  type RoutineSchedule,
  scheduleLabel,
  validTimeZone,
} from "./schedule";

export const ROUTINE_STATUSES = ["active", "paused", "archived"] as const;
export const ROUTINE_TRIGGERS = ["manual", "schedule", "webhook"] as const;
export type RoutineStatus = (typeof ROUTINE_STATUSES)[number];
export type RoutineTrigger = (typeof ROUTINE_TRIGGERS)[number];

export type RoutineInput = {
  name: string;
  description?: string;
  instruction: string;
  agentId: string;
  channelId: string;
  projectId?: string;
  status?: RoutineStatus;
  trigger: RoutineTrigger;
  schedule?: RoutineSchedule;
  timezone?: string;
};

export type RoutineRecord = Omit<
  typeof routines.$inferSelect,
  "schedule" | "status" | "trigger"
> & {
  schedule: RoutineSchedule | null;
  status: RoutineStatus;
  trigger: RoutineTrigger;
  scheduleLabel: string | null;
  latestRun: TaskRun | null;
};

type RoutineRow = typeof routines.$inferSelect;

export function createRoutineStore(
  database: Database,
  runs: RunStore,
  notifications: NotificationStore,
  audit?: AuditStore,
) {
  const normalizedSchedule = (
    trigger: RoutineTrigger,
    raw: unknown,
    timezone: string,
  ): { schedule: RoutineSchedule | null; nextRunAt: Date | null } => {
    if (trigger !== "schedule") return { schedule: null, nextRunAt: null };
    const parsed = parseRoutineSchedule(raw);
    if (!parsed.ok) throw new WorkValidationError(parsed.error);
    if (!validTimeZone(timezone)) {
      throw new WorkValidationError("Choose a valid IANA timezone.");
    }
    return {
      schedule: parsed.schedule,
      nextRunAt: nextScheduledAt(parsed.schedule, timezone, new Date()),
    };
  };

  const list = async (actor: AgentActor): Promise<RoutineRecord[]> => {
    const rows = await database
      .select({ routine: routines })
      .from(routines)
      .where(eq(routines.ownerUserId, actor.id))
      .orderBy(
        asc(routines.status),
        asc(routines.nextRunAt),
        desc(routines.updatedAt),
      );
    const dispatchRows = await database
      .select({ routineId: routineDispatches.routineId, run: taskRuns })
      .from(routineDispatches)
      .innerJoin(taskRuns, eq(taskRuns.id, routineDispatches.taskRunId))
      .orderBy(desc(routineDispatches.createdAt));
    const latestByRoutine = new Map<string, TaskRun>();
    for (const row of dispatchRows) {
      if (!latestByRoutine.has(row.routineId)) {
        latestByRoutine.set(row.routineId, row.run as TaskRun);
      }
    }
    return rows.map(({ routine }) =>
      mapRoutine(routine, latestByRoutine.get(routine.id) ?? null),
    );
  };

  const getOwned = async (actor: AgentActor, routineId: string) => {
    const [routine] = await database
      .select()
      .from(routines)
      .where(
        and(eq(routines.id, routineId), eq(routines.ownerUserId, actor.id)),
      )
      .limit(1);
    if (!routine) throw new WorkNotFoundError("Routine not found.");
    return routine;
  };

  const dispatch = async (
    routine: RoutineRow,
    reason: "manual" | "schedule" | "webhook",
    scheduledFor: Date,
  ) => {
    if (routine.status === "archived") {
      throw new WorkConflictError("An archived routine cannot run.");
    }
    if (reason !== "manual" && routine.status !== "active") {
      throw new WorkConflictError("This routine is paused.");
    }
    const [reservation] = await database
      .insert(routineDispatches)
      .values({ routineId: routine.id, scheduledFor, reason })
      .onConflictDoNothing()
      .returning();
    if (!reservation) return null;

    const actor: AgentActor = { id: routine.ownerUserId, role: "user" };
    try {
      const run = await runs.create(actor, {
        channelId: routine.channelId,
        agentId: routine.agentId,
        title: routine.name,
      });
      await database
        .update(routineDispatches)
        .set({ taskRunId: run.id })
        .where(eq(routineDispatches.id, reservation.id));
      await database
        .update(routines)
        .set({ lastRunAt: scheduledFor, updatedAt: new Date() })
        .where(eq(routines.id, routine.id));
      await notifications.create({
        userId: routine.ownerUserId,
        kind: "routine",
        title:
          reason === "schedule"
            ? "Scheduled routine is ready"
            : "Routine queued",
        body: `${routine.name} is in the work queue for its coworker.`,
        targetUrl: `/channel/${routine.channelId}`,
        metadata: { routineId: routine.id, runId: run.id, reason },
      });
      if (audit) {
        await recordAuditEvent(audit, {
          actorUserId: routine.ownerUserId,
          eventType: "routine.dispatched",
          targetType: "routine",
          targetId: routine.id,
          payload: { reason, taskRun: run.id, bot: routine.agentId },
        });
      }
      return { dispatch: { ...reservation, taskRunId: run.id }, run };
    } catch (error) {
      await database
        .delete(routineDispatches)
        .where(eq(routineDispatches.id, reservation.id));
      throw error;
    }
  };

  return {
    list,

    async get(actor: AgentActor, routineId: string) {
      const routine = await getOwned(actor, routineId);
      const all = await list(actor);
      return all.find((item) => item.id === routine.id) ?? null;
    },

    async create(actor: AgentActor, input: RoutineInput) {
      await requireChannelAgent(
        database,
        actor,
        input.channelId,
        input.agentId,
      );
      if (input.projectId)
        await requireProject(database, actor, input.projectId, true);
      const timezone = input.timezone?.trim() || "UTC";
      const timing = normalizedSchedule(
        input.trigger,
        input.schedule,
        timezone,
      );
      const webhookToken =
        input.trigger === "webhook"
          ? crypto.randomUUID() + crypto.randomUUID()
          : null;
      const [created] = await database
        .insert(routines)
        .values({
          ownerUserId: actor.id,
          agentId: input.agentId,
          channelId: input.channelId,
          ...(input.projectId ? { projectId: input.projectId } : {}),
          name: safeLine(input.name, "Routine name"),
          description: input.description?.trim()
            ? safeBody(input.description, "Routine description", 4_000)
            : "",
          instruction: safeBody(
            input.instruction,
            "Routine instruction",
            20_000,
          ),
          status: input.status ?? "active",
          trigger: input.trigger,
          schedule: timing.schedule ?? {},
          timezone,
          nextRunAt: timing.nextRunAt,
          ...(webhookToken
            ? { webhookTokenHash: await hashToken(webhookToken) }
            : {}),
        })
        .returning();
      if (!created) throw new Error("Routine could not be created.");
      if (audit) {
        await recordAuditEvent(audit, {
          actorUserId: actor.id,
          eventType: "routine.created",
          targetType: "routine",
          targetId: created.id,
          payload: { trigger: created.trigger, bot: created.agentId },
        });
      }
      return {
        routine: mapRoutine(created, null),
        ...(webhookToken ? { webhookToken } : {}),
      };
    },

    async update(
      actor: AgentActor,
      routineId: string,
      input: Partial<RoutineInput>,
    ) {
      const current = await getOwned(actor, routineId);
      const trigger = input.trigger ?? (current.trigger as RoutineTrigger);
      if (trigger === "webhook" && current.trigger !== "webhook") {
        throw new WorkValidationError(
          "Create a new webhook routine so its authentication token can be shown exactly once.",
        );
      }
      const timezone = input.timezone?.trim() || current.timezone;
      const schedule = input.schedule ?? current.schedule;
      const timing = normalizedSchedule(trigger, schedule, timezone);
      if (input.channelId || input.agentId) {
        await requireChannelAgent(
          database,
          actor,
          input.channelId ?? current.channelId,
          input.agentId ?? current.agentId,
        );
      }
      if (input.projectId)
        await requireProject(database, actor, input.projectId, true);
      const [updated] = await database
        .update(routines)
        .set({
          ...(input.name !== undefined
            ? { name: safeLine(input.name, "Routine name") }
            : {}),
          ...(input.description !== undefined
            ? {
                description: input.description.trim()
                  ? safeBody(input.description, "Routine description", 4_000)
                  : "",
              }
            : {}),
          ...(input.instruction !== undefined
            ? {
                instruction: safeBody(
                  input.instruction,
                  "Routine instruction",
                  20_000,
                ),
              }
            : {}),
          ...(input.agentId ? { agentId: input.agentId } : {}),
          ...(input.channelId ? { channelId: input.channelId } : {}),
          ...(input.projectId ? { projectId: input.projectId } : {}),
          ...(input.status ? { status: input.status } : {}),
          trigger,
          ...(current.trigger === "webhook" && trigger !== "webhook"
            ? { webhookTokenHash: null }
            : {}),
          schedule: timing.schedule ?? {},
          timezone,
          nextRunAt:
            (input.status ?? current.status) === "active"
              ? timing.nextRunAt
              : null,
          updatedAt: new Date(),
        })
        .where(eq(routines.id, routineId))
        .returning();
      if (!updated) throw new WorkNotFoundError("Routine not found.");
      return mapRoutine(updated, null);
    },

    async runNow(actor: AgentActor, routineId: string) {
      const routine = await getOwned(actor, routineId);
      return dispatch(routine, "manual", new Date());
    },

    async dispatchDue(now = new Date(), maximum = 20) {
      const claimed = await database.transaction(async (transaction) => {
        const due = await transaction
          .select()
          .from(routines)
          .where(
            and(
              eq(routines.status, "active"),
              eq(routines.trigger, "schedule"),
              lte(routines.nextRunAt, now),
            ),
          )
          .orderBy(asc(routines.nextRunAt))
          .limit(Math.max(1, Math.min(maximum, 100)))
          .for("update", { skipLocked: true });
        const claimedRows: Array<{ routine: RoutineRow; scheduledFor: Date }> =
          [];
        for (const routine of due) {
          if (!routine.nextRunAt) continue;
          const parsed = parseRoutineSchedule(routine.schedule);
          if (!parsed.ok) {
            await transaction
              .update(routines)
              .set({ status: "paused", nextRunAt: null, updatedAt: now })
              .where(eq(routines.id, routine.id));
            continue;
          }
          const scheduledFor = routine.nextRunAt;
          const nextRunAt = nextScheduledAt(
            parsed.schedule,
            routine.timezone,
            now,
          );
          await transaction
            .update(routines)
            .set({ nextRunAt, updatedAt: now })
            .where(eq(routines.id, routine.id));
          claimedRows.push({ routine, scheduledFor });
        }
        return claimedRows;
      });
      let dispatched = 0;
      for (const claimedItem of claimed) {
        if (
          await dispatch(
            claimedItem.routine,
            "schedule",
            claimedItem.scheduledFor,
          )
        ) {
          dispatched += 1;
        }
      }
      return dispatched;
    },

    async dispatchWebhook(routineId: string, token: string) {
      const [routine] = await database
        .select()
        .from(routines)
        .where(eq(routines.id, routineId));
      if (
        !routine?.webhookTokenHash ||
        !(await tokenMatches(token, routine.webhookTokenHash))
      ) {
        throw new WorkNotFoundError("Webhook not found.");
      }
      if (routine.trigger !== "webhook") {
        throw new WorkConflictError("This routine is not webhook-triggered.");
      }
      return dispatch(routine, "webhook", new Date());
    },
  };
}

function mapRoutine(row: RoutineRow, latestRun: TaskRun | null): RoutineRecord {
  const parsed =
    row.trigger === "schedule" ? parseRoutineSchedule(row.schedule) : null;
  const schedule = parsed?.ok ? parsed.schedule : null;
  return {
    ...row,
    status: row.status as RoutineStatus,
    trigger: row.trigger as RoutineTrigger,
    schedule,
    scheduleLabel: schedule ? scheduleLabel(schedule, row.timezone) : null,
    latestRun,
  };
}

async function hashToken(token: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return Buffer.from(digest).toString("hex");
}

async function tokenMatches(token: string, expected: string) {
  if (!token || token.length > 200) return false;
  const actual = await hashToken(token);
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

export type RoutineStore = ReturnType<typeof createRoutineStore>;

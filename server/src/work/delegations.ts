import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { AgentProfileStore } from "../agents/profile-store";
import type { AgentActor } from "../agents/profile-types";
import type { AuditEventType, AuditStore } from "../audit";
import { recordAuditEvent } from "../audit";
import type { ChannelStore } from "../channels/routes";
import type { Database } from "../db/client";
import {
  agents,
  delegationMessages,
  delegations,
  projectAgents,
} from "../db/schema";
import type { RunStore } from "../runs/store";
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

export const DELEGATION_STATUSES = [
  "queued",
  "accepted",
  "in_progress",
  "completed",
  "failed",
  "cancelled",
] as const;
export type DelegationStatus = (typeof DELEGATION_STATUSES)[number];

const TRANSITIONS: Record<DelegationStatus, ReadonlySet<DelegationStatus>> = {
  queued: new Set(["accepted", "in_progress", "failed", "cancelled"]),
  accepted: new Set(["in_progress", "failed", "cancelled"]),
  in_progress: new Set(["completed", "failed", "cancelled"]),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
};

export type DelegationInput = {
  sourceAgentId?: string;
  sourceChannelId?: string;
  targetAgentId: string;
  projectId?: string;
  title: string;
  instructions: string;
  expectedOutput?: string;
  context?: Record<string, unknown>;
  dueAt?: Date;
  parentDelegationId?: string;
  maxDepth?: number;
  maxChildren?: number;
  maxParallel?: number;
  budgetMinutes?: number;
  reviewRequired?: boolean;
};

export function createDelegationStore(
  database: Database,
  profiles: AgentProfileStore,
  channels: ChannelStore,
  runs: RunStore,
  notifications: NotificationStore,
  audit?: AuditStore,
) {
  const getOwned = async (actor: AgentActor, delegationId: string) => {
    const [delegation] = await database
      .select()
      .from(delegations)
      .where(
        and(
          eq(delegations.id, delegationId),
          eq(delegations.actorUserId, actor.id),
        ),
      )
      .limit(1);
    if (!delegation) throw new WorkNotFoundError("Delegation not found.");
    return delegation;
  };

  return {
    async list(actor: AgentActor) {
      const rows = await database
        .select({ delegation: delegations, targetName: agents.name })
        .from(delegations)
        .innerJoin(agents, eq(agents.id, delegations.targetAgentId))
        .where(eq(delegations.actorUserId, actor.id))
        .orderBy(asc(delegations.status), desc(delegations.updatedAt));
      return rows.map((row) => ({
        ...row.delegation,
        status: row.delegation.status as DelegationStatus,
        targetName: row.targetName,
      }));
    },

    async get(actor: AgentActor, delegationId: string) {
      const delegation = await getOwned(actor, delegationId);
      const messages = await database
        .select()
        .from(delegationMessages)
        .where(eq(delegationMessages.delegationId, delegationId))
        .orderBy(asc(delegationMessages.createdAt));
      return {
        ...delegation,
        status: delegation.status as DelegationStatus,
        messages,
      };
    },

    async create(actor: AgentActor, input: DelegationInput) {
      const parent = input.parentDelegationId
        ? await getOwned(actor, input.parentDelegationId)
        : null;
      const depth = parent ? parent.depth + 1 : 0;
      if (parent && depth > parent.maxDepth) {
        throw new WorkConflictError(
          `This handoff reached its maximum depth of ${parent.maxDepth}.`,
        );
      }
      if (parent) {
        const [counts] = await database
          .select({
            total: sql<number>`count(*)::int`,
            active: sql<number>`count(*) filter (where ${delegations.status} in ('queued', 'accepted', 'in_progress'))::int`,
          })
          .from(delegations)
          .where(eq(delegations.parentDelegationId, parent.id));
        if (Number(counts?.total ?? 0) >= parent.maxChildren) {
          throw new WorkConflictError(
            `This handoff already has its maximum of ${parent.maxChildren} children.`,
          );
        }
        if (Number(counts?.active ?? 0) >= parent.maxParallel) {
          throw new WorkConflictError(
            `This handoff already has ${parent.maxParallel} children running in parallel.`,
          );
        }
        if (parent.steeringStatus === "stopped") {
          throw new WorkConflictError("This handoff tree has been stopped.");
        }
      }
      const target = await profiles.get(actor, input.targetAgentId);
      if (!target) throw new WorkNotFoundError("Target coworker not found.");
      if (input.sourceAgentId) {
        if (!(await profiles.get(actor, input.sourceAgentId))) {
          throw new WorkNotFoundError("Source coworker not found.");
        }
        if (!input.sourceChannelId) {
          throw new WorkValidationError(
            "A source channel is required for a Bot handoff.",
          );
        }
        await requireChannelAgent(
          database,
          actor,
          input.sourceChannelId,
          input.sourceAgentId,
        );
      }
      if (input.projectId) {
        await requireProject(database, actor, input.projectId, true);
        // A handoff into a project also assigns the receiving coworker to that workspace.
        await database
          .insert(projectAgents)
          .values({
            projectId: input.projectId,
            agentId: input.targetAgentId,
            addedByUserId: actor.id,
          })
          .onConflictDoNothing();
      }
      if (input.dueAt && input.dueAt.getTime() <= Date.now()) {
        throw new WorkValidationError("The due date must be in the future.");
      }

      const maxDepth = parent
        ? Math.min(
            parent.maxDepth,
            boundedInteger(input.maxDepth ?? parent.maxDepth, depth, 8),
          )
        : boundedInteger(input.maxDepth ?? 3, depth, 8);
      const maxChildren = parent
        ? Math.min(
            parent.maxChildren,
            boundedInteger(input.maxChildren ?? parent.maxChildren, 1, 12),
          )
        : boundedInteger(input.maxChildren ?? 4, 1, 12);
      const maxParallel = parent
        ? Math.min(
            parent.maxParallel,
            boundedInteger(input.maxParallel ?? parent.maxParallel, 1, 6),
          )
        : boundedInteger(input.maxParallel ?? 2, 1, 6);
      const budgetMinutes = parent
        ? Math.min(
            parent.budgetMinutes,
            boundedInteger(input.budgetMinutes ?? parent.budgetMinutes, 1, 60),
          )
        : boundedInteger(input.budgetMinutes ?? 30, 1, 60);
      const reviewRequired = parent?.reviewRequired
        ? true
        : (input.reviewRequired ?? false);

      const targetChannel = await channels.create(actor, [input.targetAgentId]);
      const title = safeLine(input.title, "Delegation title");
      const instruction = safeBody(
        input.instructions,
        "Delegation instructions",
        20_000,
      );
      const run = await runs.create(actor, {
        channelId: targetChannel.id,
        agentId: input.targetAgentId,
        title,
        ...(parent ? { parentRunId: parent.taskRunId } : {}),
        maxRuntimeMs: budgetMinutes * 60_000,
      });
      const [delegation] = await database
        .insert(delegations)
        .values({
          actorUserId: actor.id,
          ...(input.sourceAgentId
            ? { sourceAgentId: input.sourceAgentId }
            : {}),
          ...(input.sourceChannelId
            ? { sourceChannelId: input.sourceChannelId }
            : {}),
          targetAgentId: input.targetAgentId,
          targetChannelId: targetChannel.id,
          taskRunId: run.id,
          ...(input.projectId ? { projectId: input.projectId } : {}),
          ...(parent ? { parentDelegationId: parent.id } : {}),
          depth,
          maxDepth,
          maxChildren,
          maxParallel,
          budgetMinutes,
          reviewRequired,
          title,
          instructions: instruction,
          expectedOutput: input.expectedOutput?.trim()
            ? safeBody(input.expectedOutput, "Expected output", 4_000)
            : "",
          context: input.context ?? {},
          ...(input.dueAt ? { dueAt: input.dueAt } : {}),
        })
        .returning();
      if (!delegation) throw new Error("Delegation could not be created.");
      await database.insert(delegationMessages).values({
        delegationId: delegation.id,
        senderUserId: actor.id,
        ...(input.sourceAgentId ? { senderAgentId: input.sourceAgentId } : {}),
        kind: "handoff",
        body: instruction,
        metadata: { expectedOutput: delegation.expectedOutput },
      });
      await notifications.create({
        userId: actor.id,
        kind: "delegation",
        title: `Work assigned to ${target.name}`,
        body: title,
        targetUrl: `/channel/${targetChannel.id}`,
        metadata: { delegationId: delegation.id, runId: run.id },
      });
      if (audit) {
        await recordAuditEvent(audit, {
          actorUserId: actor.id,
          eventType: "delegation.created",
          targetType: "delegation",
          targetId: delegation.id,
          payload: {
            from: input.sourceAgentId ?? "person",
            to: input.targetAgentId,
            taskRun: run.id,
            ...(input.projectId ? { project: input.projectId } : {}),
          },
        });
      }
      return {
        ...delegation,
        status: "queued" as const,
        targetName: target.name,
      };
    },

    async steer(
      actor: AgentActor,
      delegationId: string,
      input: { instruction?: string; stop?: boolean },
    ) {
      const delegation = await getOwned(actor, delegationId);
      if (input.instruction?.trim()) {
        const instruction = safeBody(
          input.instruction,
          "Steering instruction",
          20_000,
        );
        if (
          !input.stop &&
          !["queued", "accepted"].includes(delegation.status)
        ) {
          throw new WorkConflictError(
            "A running handoff cannot be rewritten. Stop it or steer a queued handoff before execution starts.",
          );
        }
        if (!input.stop) {
          const revised = safeBody(
            `${delegation.instructions}\n\nSteering update:\n${instruction}`,
            "Delegation instructions",
            20_000,
          );
          await database
            .update(delegations)
            .set({ instructions: revised, updatedAt: new Date() })
            .where(eq(delegations.id, delegationId));
        }
        await database.insert(delegationMessages).values({
          delegationId,
          senderUserId: actor.id,
          kind: "steering",
          body: instruction,
        });
        await auditEvent(audit, actor, "delegation.steered", delegationId, {
          stopped: input.stop === true,
        });
      }
      if (!input.stop) return getOwned(actor, delegationId);

      const affected = [delegation];
      let frontier = [delegation.id];
      while (frontier.length) {
        const children = await database
          .select()
          .from(delegations)
          .where(inArray(delegations.parentDelegationId, frontier));
        affected.push(...children);
        frontier = children.map((child) => child.id);
      }
      for (const item of affected) {
        if (["completed", "failed", "cancelled"].includes(item.status))
          continue;
        await database
          .update(delegations)
          .set({
            status: "cancelled",
            steeringStatus: "stopped",
            completedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(delegations.id, item.id));
        await runs
          .transitionSystem(item.taskRunId, "cancelled")
          .catch(() => undefined);
      }
      await auditEvent(audit, actor, "delegation.tree_stopped", delegationId, {
        affected: affected.map((item) => item.id),
      });
      return getOwned(actor, delegationId);
    },

    async review(actor: AgentActor, delegationId: string) {
      const current = await getOwned(actor, delegationId);
      if (!current.reviewRequired || current.status !== "completed") {
        throw new WorkConflictError(
          "Only completed handoffs that require review can be reviewed.",
        );
      }
      const [reviewed] = await database
        .update(delegations)
        .set({ reviewedAt: new Date(), updatedAt: new Date() })
        .where(eq(delegations.id, delegationId))
        .returning();
      if (!reviewed) throw new WorkNotFoundError("Delegation not found.");
      await database.insert(delegationMessages).values({
        delegationId,
        senderUserId: actor.id,
        kind: "review",
        body: "The result was reviewed and accepted.",
      });
      await auditEvent(audit, actor, "delegation.reviewed", delegationId, {
        accepted: true,
      });
      return reviewed;
    },

    async transition(
      actor: AgentActor,
      delegationId: string,
      status: DelegationStatus,
      input: { result?: string; error?: string } = {},
    ) {
      const current = await getOwned(actor, delegationId);
      const from = current.status as DelegationStatus;
      if (from !== status && !TRANSITIONS[from].has(status)) {
        throw new WorkConflictError(
          `A delegation cannot move from ${from} to ${status}.`,
        );
      }
      if (status === "completed" && !input.result?.trim()) {
        throw new WorkValidationError("A completed delegation needs a result.");
      }
      if (status === "failed" && !input.error?.trim()) {
        throw new WorkValidationError("A failed delegation needs a reason.");
      }
      const completed = ["completed", "failed", "cancelled"].includes(status);
      const [updated] = await database
        .update(delegations)
        .set({
          status,
          ...(status === "completed"
            ? {
                result: safeBody(input.result as string, "Result", 50_000),
                error: null,
              }
            : {}),
          ...(status === "failed"
            ? {
                error: safeBody(input.error as string, "Failure reason", 4_000),
              }
            : {}),
          completedAt: completed ? new Date() : null,
          updatedAt: new Date(),
        })
        .where(eq(delegations.id, delegationId))
        .returning();
      if (!updated) throw new WorkNotFoundError("Delegation not found.");

      await syncTaskRun(runs, current.taskRunId, status, input.error);
      await database.insert(delegationMessages).values({
        delegationId,
        senderUserId: actor.id,
        ...(status === "completed"
          ? { senderAgentId: current.targetAgentId }
          : {}),
        kind: "status",
        body:
          status === "completed"
            ? (updated.result as string)
            : status === "failed"
              ? (updated.error as string)
              : `Status changed to ${status.replace("_", " ")}.`,
        metadata: { from, to: status },
      });
      if (completed) {
        await notifications.create({
          userId: actor.id,
          kind: "delegation",
          title:
            status === "completed"
              ? "Delegated work completed"
              : status === "failed"
                ? "Delegated work needs attention"
                : "Delegated work cancelled",
          body: updated.title,
          targetUrl: `/channel/${updated.targetChannelId}`,
          metadata: { delegationId: updated.id, status },
        });
      }
      return { ...updated, status };
    },

    async addMessage(
      actor: AgentActor,
      delegationId: string,
      input: { body: string; agentId?: string; kind?: string },
    ) {
      const delegation = await getOwned(actor, delegationId);
      if (
        input.agentId &&
        ![delegation.sourceAgentId, delegation.targetAgentId].includes(
          input.agentId,
        )
      ) {
        throw new WorkConflictError(
          "That coworker is not part of this handoff.",
        );
      }
      const [message] = await database
        .insert(delegationMessages)
        .values({
          delegationId,
          senderUserId: actor.id,
          ...(input.agentId ? { senderAgentId: input.agentId } : {}),
          kind: input.kind?.trim()
            ? safeLine(input.kind, "Message kind", 40)
            : "note",
          body: safeBody(input.body, "Message", 20_000),
        })
        .returning();
      if (!message) throw new Error("Message could not be created.");
      return message;
    },
  };
}

async function syncTaskRun(
  runs: RunStore,
  runId: string,
  status: DelegationStatus,
  error?: string,
) {
  if (status === "accepted" || status === "in_progress") {
    await runs.transitionSystem(runId, "running").catch(() => undefined);
    return;
  }
  if (status === "completed") {
    await runs.transitionSystem(runId, "running").catch(() => undefined);
    await runs.transitionSystem(runId, "succeeded").catch(() => undefined);
    return;
  }
  if (status === "failed") {
    await runs.transitionSystem(runId, "running").catch(() => undefined);
    await runs.transitionSystem(runId, "failed", error).catch(() => undefined);
    return;
  }
  if (status === "cancelled") {
    await runs.transitionSystem(runId, "cancelled").catch(() => undefined);
  }
}

export type DelegationStore = ReturnType<typeof createDelegationStore>;

function boundedInteger(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(Math.trunc(value), maximum));
}

async function auditEvent(
  audit: AuditStore | undefined,
  actor: AgentActor,
  eventType: AuditEventType,
  targetId: string,
  payload: Record<string, unknown>,
) {
  if (!audit) return;
  await recordAuditEvent(audit, {
    actorUserId: actor.id,
    eventType,
    targetType: "delegation",
    targetId,
    payload,
  });
}

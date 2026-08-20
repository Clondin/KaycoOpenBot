import { and, asc, desc, eq } from "drizzle-orm";
import type { AgentProfileStore } from "../agents/profile-store";
import type { AgentActor } from "../agents/profile-types";
import type { AuditStore } from "../audit";
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

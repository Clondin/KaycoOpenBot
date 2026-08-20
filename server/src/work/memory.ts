import { and, desc, eq } from "drizzle-orm";
import type { AgentProfileStore } from "../agents/profile-store";
import type { AgentActor } from "../agents/profile-types";
import type { AuditStore } from "../audit";
import { recordAuditEvent } from "../audit";
import type { Database } from "../db/client";
import { memoryEntries } from "../db/schema";
import {
  requireProject,
  safeBody,
  safeLine,
  WorkNotFoundError,
  WorkValidationError,
} from "./access";

export const MEMORY_SCOPES = ["user", "agent", "project"] as const;
export const MEMORY_KINDS = [
  "preference",
  "fact",
  "instruction",
  "decision",
] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export type MemoryInput = {
  scope: MemoryScope;
  kind: MemoryKind;
  title: string;
  content: string;
  agentId?: string;
  projectId?: string;
  source?: string;
  confidence?: number;
  pinned?: boolean;
};

export function createMemoryStore(
  database: Database,
  profiles: AgentProfileStore,
  audit?: AuditStore,
) {
  const validateScope = async (actor: AgentActor, input: MemoryInput) => {
    if (input.scope === "user") {
      if (input.agentId || input.projectId) {
        throw new WorkValidationError(
          "User memory cannot be attached to a coworker or project.",
        );
      }
      return;
    }
    if (input.scope === "agent") {
      if (!input.agentId || input.projectId) {
        throw new WorkValidationError(
          "Coworker memory needs exactly one coworker.",
        );
      }
      if (!(await profiles.get(actor, input.agentId))) {
        throw new WorkNotFoundError("Coworker not found.");
      }
      return;
    }
    if (!input.projectId || input.agentId) {
      throw new WorkValidationError(
        "Project memory needs exactly one project.",
      );
    }
    await requireProject(database, actor, input.projectId, true);
  };

  return {
    async list(
      actor: AgentActor,
      filters: {
        scope?: MemoryScope;
        agentId?: string;
        projectId?: string;
      } = {},
    ) {
      return database
        .select()
        .from(memoryEntries)
        .where(
          and(
            eq(memoryEntries.ownerUserId, actor.id),
            filters.scope ? eq(memoryEntries.scope, filters.scope) : undefined,
            filters.agentId
              ? eq(memoryEntries.agentId, filters.agentId)
              : undefined,
            filters.projectId
              ? eq(memoryEntries.projectId, filters.projectId)
              : undefined,
          ),
        )
        .orderBy(desc(memoryEntries.pinned), desc(memoryEntries.updatedAt));
    },

    async create(actor: AgentActor, input: MemoryInput) {
      await validateScope(actor, input);
      const confidence = input.confidence ?? 100;
      if (!Number.isInteger(confidence) || confidence < 0 || confidence > 100) {
        throw new WorkValidationError("Confidence must be between 0 and 100.");
      }
      const [memory] = await database
        .insert(memoryEntries)
        .values({
          ownerUserId: actor.id,
          scope: input.scope,
          kind: input.kind,
          ...(input.agentId ? { agentId: input.agentId } : {}),
          ...(input.projectId ? { projectId: input.projectId } : {}),
          title: safeLine(input.title, "Memory title"),
          content: safeBody(input.content, "Memory", 20_000),
          source: input.source?.trim()
            ? safeLine(input.source, "Memory source", 120)
            : "user",
          confidence,
          pinned: input.pinned ?? false,
        })
        .returning();
      if (!memory) throw new Error("Memory could not be created.");
      if (audit) {
        await recordAuditEvent(audit, {
          actorUserId: actor.id,
          eventType: "memory.created",
          targetType: "memory",
          targetId: memory.id,
          payload: {
            scope: memory.scope,
            kind: memory.kind,
            ...(memory.agentId ? { bot: memory.agentId } : {}),
            ...(memory.projectId ? { project: memory.projectId } : {}),
            // The title identifies the item; content can contain confidential context.
            title: memory.title,
          },
        });
      }
      return memory;
    },

    async update(
      actor: AgentActor,
      memoryId: string,
      input: Partial<
        Pick<
          MemoryInput,
          "title" | "content" | "kind" | "confidence" | "pinned"
        >
      >,
    ) {
      if (
        input.confidence !== undefined &&
        (!Number.isInteger(input.confidence) ||
          input.confidence < 0 ||
          input.confidence > 100)
      ) {
        throw new WorkValidationError("Confidence must be between 0 and 100.");
      }
      const [memory] = await database
        .update(memoryEntries)
        .set({
          ...(input.title !== undefined
            ? { title: safeLine(input.title, "Memory title") }
            : {}),
          ...(input.content !== undefined
            ? { content: safeBody(input.content, "Memory", 20_000) }
            : {}),
          ...(input.kind ? { kind: input.kind } : {}),
          ...(input.confidence !== undefined
            ? { confidence: input.confidence }
            : {}),
          ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(memoryEntries.id, memoryId),
            eq(memoryEntries.ownerUserId, actor.id),
          ),
        )
        .returning();
      if (!memory) throw new WorkNotFoundError("Memory not found.");
      return memory;
    },

    async remove(actor: AgentActor, memoryId: string) {
      const [removed] = await database
        .delete(memoryEntries)
        .where(
          and(
            eq(memoryEntries.id, memoryId),
            eq(memoryEntries.ownerUserId, actor.id),
          ),
        )
        .returning({ id: memoryEntries.id });
      if (!removed) throw new WorkNotFoundError("Memory not found.");
    },
  };
}

export type MemoryStore = ReturnType<typeof createMemoryStore>;

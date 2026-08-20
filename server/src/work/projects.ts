import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { AgentProfileStore } from "../agents/profile-store";
import type { AgentActor } from "../agents/profile-types";
import type { AuditStore } from "../audit";
import { recordAuditEvent } from "../audit";
import type { Database } from "../db/client";
import {
  agents,
  projectAgents,
  projectArtifacts,
  projectMembers,
  projects,
} from "../db/schema";
import {
  requireProject,
  safeBody,
  safeLine,
  WorkConflictError,
  WorkNotFoundError,
} from "./access";

export type ProjectStatus = "active" | "archived";

export type ProjectRecord = {
  id: string;
  name: string;
  description: string;
  status: ProjectStatus;
  role: "owner" | "editor" | "viewer";
  agents: Array<{ id: string; name: string }>;
  artifactCount: number;
  createdAt: Date;
  updatedAt: Date;
};

export type ArtifactRecord = typeof projectArtifacts.$inferSelect;

export function createProjectStore(
  database: Database,
  profiles: AgentProfileStore,
  audit?: AuditStore,
) {
  const list = async (actor: AgentActor): Promise<ProjectRecord[]> => {
    const rows = await database
      .select({
        project: projects,
        role: projectMembers.role,
        agentId: projectAgents.agentId,
        agentName: agents.name,
      })
      .from(projectMembers)
      .innerJoin(projects, eq(projects.id, projectMembers.projectId))
      .leftJoin(projectAgents, eq(projectAgents.projectId, projects.id))
      .leftJoin(agents, eq(agents.id, projectAgents.agentId))
      .where(eq(projectMembers.userId, actor.id))
      .orderBy(asc(projects.status), desc(projects.updatedAt));

    const counts = await database
      .select({
        projectId: projectArtifacts.projectId,
        count: sql<number>`count(*)`,
      })
      .from(projectArtifacts)
      .groupBy(projectArtifacts.projectId);
    const countByProject = new Map(
      counts.map((row) => [row.projectId, Number(row.count)]),
    );
    const mapped = new Map<string, ProjectRecord>();
    for (const row of rows) {
      const existing = mapped.get(row.project.id);
      if (existing) {
        if (row.agentId && row.agentName) {
          existing.agents.push({ id: row.agentId, name: row.agentName });
        }
        continue;
      }
      mapped.set(row.project.id, {
        id: row.project.id,
        name: row.project.name,
        description: row.project.description,
        status: row.project.status as ProjectStatus,
        role: row.role,
        agents:
          row.agentId && row.agentName
            ? [{ id: row.agentId, name: row.agentName }]
            : [],
        artifactCount: countByProject.get(row.project.id) ?? 0,
        createdAt: row.project.createdAt,
        updatedAt: row.project.updatedAt,
      });
    }
    return [...mapped.values()];
  };

  return {
    list,

    async get(actor: AgentActor, projectId: string) {
      await requireProject(database, actor, projectId);
      return (
        (await list(actor)).find((project) => project.id === projectId) ?? null
      );
    },

    async create(
      actor: AgentActor,
      input: { name: string; description?: string; agentIds?: string[] },
    ) {
      const name = safeLine(input.name, "Project name");
      const description = input.description?.trim()
        ? safeBody(input.description, "Project description", 4_000)
        : "";
      const agentIds = [...new Set(input.agentIds ?? [])];
      for (const agentId of agentIds) {
        if (!(await profiles.get(actor, agentId))) {
          throw new WorkNotFoundError("Coworker not found.");
        }
      }
      const project = await database.transaction(async (transaction) => {
        const [created] = await transaction
          .insert(projects)
          .values({ ownerUserId: actor.id, name, description })
          .returning();
        if (!created) throw new Error("Project could not be created.");
        await transaction.insert(projectMembers).values({
          projectId: created.id,
          userId: actor.id,
          role: "owner",
        });
        if (agentIds.length) {
          await transaction.insert(projectAgents).values(
            agentIds.map((agentId) => ({
              projectId: created.id,
              agentId,
              addedByUserId: actor.id,
            })),
          );
        }
        return created;
      });
      if (audit) {
        await recordAuditEvent(audit, {
          actorUserId: actor.id,
          eventType: "project.created",
          targetType: "project",
          targetId: project.id,
          payload: { name, bots: agentIds },
        });
      }
      return (await list(actor)).find(
        (item) => item.id === project.id,
      ) as ProjectRecord;
    },

    async update(
      actor: AgentActor,
      projectId: string,
      input: { name?: string; description?: string; status?: ProjectStatus },
    ) {
      await requireProject(database, actor, projectId, true);
      const [updated] = await database
        .update(projects)
        .set({
          ...(input.name !== undefined
            ? { name: safeLine(input.name, "Project name") }
            : {}),
          ...(input.description !== undefined
            ? {
                description: input.description.trim()
                  ? safeBody(input.description, "Project description", 4_000)
                  : "",
              }
            : {}),
          ...(input.status ? { status: input.status } : {}),
          updatedAt: new Date(),
        })
        .where(eq(projects.id, projectId))
        .returning();
      if (!updated) throw new WorkNotFoundError("Project not found.");
      return (await list(actor)).find(
        (item) => item.id === projectId,
      ) as ProjectRecord;
    },

    async addAgent(actor: AgentActor, projectId: string, agentId: string) {
      await requireProject(database, actor, projectId, true);
      if (!(await profiles.get(actor, agentId))) {
        throw new WorkNotFoundError("Coworker not found.");
      }
      await database
        .insert(projectAgents)
        .values({ projectId, agentId, addedByUserId: actor.id })
        .onConflictDoNothing();
      await database
        .update(projects)
        .set({ updatedAt: new Date() })
        .where(eq(projects.id, projectId));
      return (await list(actor)).find(
        (item) => item.id === projectId,
      ) as ProjectRecord;
    },

    async removeAgent(actor: AgentActor, projectId: string, agentId: string) {
      await requireProject(database, actor, projectId, true);
      await database
        .delete(projectAgents)
        .where(
          and(
            eq(projectAgents.projectId, projectId),
            eq(projectAgents.agentId, agentId),
          ),
        );
      await database
        .update(projects)
        .set({ updatedAt: new Date() })
        .where(eq(projects.id, projectId));
    },

    async listArtifacts(actor: AgentActor, projectId: string) {
      await requireProject(database, actor, projectId);
      return database
        .select()
        .from(projectArtifacts)
        .where(eq(projectArtifacts.projectId, projectId))
        .orderBy(desc(projectArtifacts.updatedAt));
    },

    async createArtifact(
      actor: AgentActor,
      projectId: string,
      input: {
        title: string;
        kind?: string;
        content: string;
        agentId?: string;
        metadata?: Record<string, unknown>;
      },
    ) {
      await requireProject(database, actor, projectId, true);
      if (input.agentId) {
        const [assigned] = await database
          .select({ agentId: projectAgents.agentId })
          .from(projectAgents)
          .where(
            and(
              eq(projectAgents.projectId, projectId),
              eq(projectAgents.agentId, input.agentId),
            ),
          )
          .limit(1);
        if (!assigned)
          throw new WorkConflictError(
            "That coworker is not assigned to this project.",
          );
      }
      const [artifact] = await database
        .insert(projectArtifacts)
        .values({
          projectId,
          createdByUserId: actor.id,
          ...(input.agentId ? { createdByAgentId: input.agentId } : {}),
          title: safeLine(input.title, "Artifact title"),
          kind: input.kind?.trim()
            ? safeLine(input.kind, "Artifact kind", 40).toLowerCase()
            : "note",
          content: safeBody(input.content, "Artifact content", 100_000),
          metadata: input.metadata ?? {},
        })
        .returning();
      if (!artifact) throw new Error("Artifact could not be created.");
      await database
        .update(projects)
        .set({ updatedAt: new Date() })
        .where(eq(projects.id, projectId));
      return artifact;
    },

    async updateArtifact(
      actor: AgentActor,
      projectId: string,
      artifactId: string,
      input: { title?: string; content: string; expectedVersion: number },
    ) {
      await requireProject(database, actor, projectId, true);
      const [artifact] = await database
        .update(projectArtifacts)
        .set({
          ...(input.title !== undefined
            ? { title: safeLine(input.title, "Artifact title") }
            : {}),
          content: safeBody(input.content, "Artifact content", 100_000),
          version: input.expectedVersion + 1,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(projectArtifacts.id, artifactId),
            eq(projectArtifacts.projectId, projectId),
            eq(projectArtifacts.version, input.expectedVersion),
          ),
        )
        .returning();
      if (!artifact) {
        const [exists] = await database
          .select({ id: projectArtifacts.id })
          .from(projectArtifacts)
          .where(
            and(
              eq(projectArtifacts.id, artifactId),
              eq(projectArtifacts.projectId, projectId),
            ),
          );
        if (exists)
          throw new WorkConflictError(
            "This artifact changed. Reload it before saving.",
          );
        throw new WorkNotFoundError("Artifact not found.");
      }
      return artifact;
    },
  };
}

export type ProjectStore = ReturnType<typeof createProjectStore>;

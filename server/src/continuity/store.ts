import { and, desc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { AgentActor } from "../agents/profile-types";
import type { AuditEventType, AuditStore } from "../audit";
import { recordAuditEvent } from "../audit";
import type { Database } from "../db/client";
import {
  botBundles,
  channelMemberships,
  continuityMessages,
  continuitySnapshots,
  intelligenceChannelMappings,
  skills,
  skillUsageEvents,
  skillVersions,
  toolProgramRuns,
  toolPrograms,
} from "../db/schema";
import type { GrantedTool, ToolRunContext } from "../plugins/tools";
import {
  WorkConflictError,
  WorkNotFoundError,
  WorkValidationError,
} from "../work/access";

const MAX_MESSAGE = 100_000;
const MAX_SUMMARY = 50_000;
const MAX_PROGRAM_STEPS = 8;
const MAX_PROGRAM_DEFINITION = 200_000;
const MAX_STEP_RESULT = 1_000_000;
const MAX_BUNDLE_MANIFEST = 200_000;
const FORBIDDEN_BUNDLE_KEYS = [
  "secret",
  "token",
  "password",
  "credential",
  "grant",
  "history",
  "transcript",
  "memory",
  "cookie",
  "session",
];

export type ContextMessageInput = {
  channelId: string;
  threadId: string;
  messageId: string;
  agentId?: string;
  role: "user" | "assistant" | "system";
  content: string;
  anchor?: Record<string, unknown>;
  occurredAt: Date;
};

export type ProgramStep = {
  id: string;
  tool: string;
  arguments: Record<string, unknown>;
};

export type ProgramStepInput = Omit<ProgramStep, "id"> & { id?: string };

export type BotBundleManifest = {
  persona?: Record<string, unknown>;
  skillSlugs?: string[];
  routines?: Array<Record<string, unknown>>;
  components?: string[];
  modelDefaults?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

export function createContinuityStore(database: Database, audit?: AuditStore) {
  const requireChannel = async (
    actor: AgentActor,
    channelId: string,
    threadId?: string,
  ) => {
    const [membership] = await database
      .select({
        channelId: channelMemberships.channelId,
        threadId: intelligenceChannelMappings.threadId,
      })
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
          eq(channelMemberships.channelId, channelId),
          eq(channelMemberships.userId, actor.id),
        ),
      );
    if (!membership || (threadId && membership.threadId !== threadId)) {
      throw new WorkNotFoundError("Conversation not found.");
    }
    return membership;
  };

  const getProgram = async (actor: AgentActor, programId: string) => {
    const [program] = await database
      .select()
      .from(toolPrograms)
      .where(
        and(
          eq(toolPrograms.id, programId),
          eq(toolPrograms.ownerUserId, actor.id),
        ),
      );
    if (!program) throw new WorkNotFoundError("Tool program not found.");
    return program;
  };

  const getSkill = async (actor: AgentActor, skillId: string) => {
    const [skill] = await database
      .select()
      .from(skills)
      .where(
        and(
          eq(skills.id, skillId),
          or(isNull(skills.ownerUserId), eq(skills.ownerUserId, actor.id)),
        ),
      );
    if (!skill) throw new WorkNotFoundError("Skill not found.");
    return skill;
  };

  const requireMutableSkill = async (actor: AgentActor, skillId: string) => {
    const skill = await getSkill(actor, skillId);
    if (skill.ownerUserId !== actor.id && actor.role !== "admin") {
      throw new WorkConflictError(
        "Only an administrator can change a deployment skill.",
      );
    }
    return skill;
  };

  const captureSkill = async (
    actor: AgentActor,
    skillId: string,
    provenance: Record<string, unknown> = {},
    scan: Record<string, unknown> = {},
  ) => {
    const skill = await getSkill(actor, skillId);
    const contentHash = await hash(
      JSON.stringify({
        title: skill.title,
        summary: skill.summary,
        instructions: skill.instructions,
      }),
    );
    const [latest] = await database
      .select()
      .from(skillVersions)
      .where(eq(skillVersions.skillId, skillId))
      .orderBy(desc(skillVersions.version))
      .limit(1);
    if (latest?.contentHash === contentHash) return latest;
    const [version] = await database
      .insert(skillVersions)
      .values({
        skillId,
        version: (latest?.version ?? 0) + 1,
        contentHash,
        title: skill.title,
        summary: skill.summary,
        instructions: skill.instructions,
        provenance: {
          origin: skill.origin,
          installedBy: skill.installedBy,
          ...provenance,
        },
        scan,
        createdByUserId: actor.id,
      })
      .returning();
    if (!version) throw new Error("Skill version could not be recorded.");
    return version;
  };

  const saveProgramRun = async (input: {
    actor: AgentActor;
    agentId: string;
    programId?: string;
    run?: ToolRunContext;
    status: "succeeded" | "failed";
    stepNames: string[];
    trace: unknown[];
    output?: string;
    error?: string;
  }) => {
    const [record] = await database
      .insert(toolProgramRuns)
      .values({
        ...(input.programId ? { programId: input.programId } : {}),
        ownerUserId: input.actor.id,
        agentId: input.agentId,
        ...(input.run?.runId ? { taskRunId: input.run.runId } : {}),
        status: input.status,
        stepNames: { items: input.stepNames },
        trace: { items: input.trace },
        ...(input.output
          ? { output: Array.from(input.output).slice(0, 50_000).join("") }
          : {}),
        ...(input.error
          ? { error: Array.from(input.error).slice(0, 4_000).join("") }
          : {}),
        completedAt: new Date(),
      })
      .returning();
    return record;
  };

  return {
    async overview(actor: AgentActor) {
      const [snapshots, programs, programRuns, bundles, skillRows] =
        await Promise.all([
          database
            .select()
            .from(continuitySnapshots)
            .where(eq(continuitySnapshots.ownerUserId, actor.id))
            .orderBy(desc(continuitySnapshots.createdAt))
            .limit(20),
          database
            .select()
            .from(toolPrograms)
            .where(eq(toolPrograms.ownerUserId, actor.id))
            .orderBy(desc(toolPrograms.updatedAt))
            .limit(50),
          database
            .select()
            .from(toolProgramRuns)
            .where(eq(toolProgramRuns.ownerUserId, actor.id))
            .orderBy(desc(toolProgramRuns.createdAt))
            .limit(30),
          database
            .select()
            .from(botBundles)
            .where(eq(botBundles.ownerUserId, actor.id))
            .orderBy(desc(botBundles.updatedAt))
            .limit(50),
          database
            .select()
            .from(skills)
            .where(
              or(isNull(skills.ownerUserId), eq(skills.ownerUserId, actor.id)),
            )
            .orderBy(skills.title),
        ]);

      const health = await Promise.all(
        skillRows.map(async (skill) => {
          const [versions, usage] = await Promise.all([
            database
              .select()
              .from(skillVersions)
              .where(eq(skillVersions.skillId, skill.id))
              .orderBy(desc(skillVersions.version)),
            database
              .select({
                count: sql<number>`count(*)::int`,
                lastUsedAt: sql<Date | null>`max(${skillUsageEvents.usedAt})`,
              })
              .from(skillUsageEvents)
              .where(
                and(
                  eq(skillUsageEvents.skillId, skill.id),
                  eq(skillUsageEvents.ownerUserId, actor.id),
                ),
              ),
          ]);
          const currentHash = await hash(
            JSON.stringify({
              title: skill.title,
              summary: skill.summary,
              instructions: skill.instructions,
            }),
          );
          const latest = versions[0];
          const lastUsedAt = usage[0]?.lastUsedAt ?? null;
          const stale =
            !lastUsedAt ||
            Date.now() - new Date(lastUsedAt).getTime() > 90 * 24 * 60 * 60_000;
          return {
            id: skill.id,
            slug: skill.slug,
            title: skill.title,
            origin: skill.origin,
            lifecycleStatus: skill.lifecycleStatus,
            pinnedVersion: skill.pinnedVersion,
            mutable: skill.ownerUserId === actor.id || actor.role === "admin",
            currentHash,
            versionCount: versions.length,
            latestVersion: latest?.version ?? null,
            drifted: Boolean(latest && latest.contentHash !== currentHash),
            usageCount: Number(usage[0]?.count ?? 0),
            lastUsedAt,
            health:
              skill.lifecycleStatus === "archived"
                ? "archived"
                : latest && latest.contentHash !== currentHash
                  ? "changed"
                  : stale
                    ? "stale"
                    : "healthy",
          };
        }),
      );

      const [messageCount] = await database
        .select({ count: sql<number>`count(*)::int` })
        .from(continuityMessages)
        .where(eq(continuityMessages.ownerUserId, actor.id));

      return {
        indexedMessageCount: Number(messageCount?.count ?? 0),
        snapshots,
        programs: programs.map((program) => ({
          ...program,
          steps: parseStoredSteps(program.steps),
        })),
        programRuns: programRuns.map((run) => ({
          ...run,
          stepNames: arrayItems<string>(run.stepNames),
          trace: arrayItems(run.trace),
        })),
        bundles,
        skillHealth: health,
      };
    },

    async indexMessage(actor: AgentActor, input: ContextMessageInput) {
      await requireChannel(actor, input.channelId, input.threadId);
      const content = bounded(input.content, MAX_MESSAGE, "Message content");
      const contentHash = await hash(content);
      const [message] = await database
        .insert(continuityMessages)
        .values({
          ownerUserId: actor.id,
          channelId: input.channelId,
          threadId: boundedLine(input.threadId, "Thread ID", 300),
          messageId: boundedLine(input.messageId, "Message ID", 300),
          ...(input.agentId
            ? { agentId: boundedLine(input.agentId, "Agent ID", 200) }
            : {}),
          role: input.role,
          content,
          contentHash,
          anchor: input.anchor ?? {},
          occurredAt: input.occurredAt,
        })
        .onConflictDoUpdate({
          target: [
            continuityMessages.ownerUserId,
            continuityMessages.threadId,
            continuityMessages.messageId,
          ],
          set: {
            content,
            contentHash,
            anchor: input.anchor ?? {},
            occurredAt: input.occurredAt,
            ...(input.agentId ? { agentId: input.agentId } : {}),
          },
        })
        .returning();
      if (!message) throw new Error("Message could not be indexed.");
      const [indexed] = await database
        .select({ count: sql<number>`count(*)::int` })
        .from(continuityMessages)
        .where(
          and(
            eq(continuityMessages.ownerUserId, actor.id),
            eq(continuityMessages.channelId, input.channelId),
          ),
        );
      const count = Number(indexed?.count ?? 0);
      if (count >= 50 && count % 50 === 0) {
        const [existing] = await database
          .select({ id: continuitySnapshots.id })
          .from(continuitySnapshots)
          .where(
            and(
              eq(continuitySnapshots.ownerUserId, actor.id),
              eq(continuitySnapshots.channelId, input.channelId),
              eq(continuitySnapshots.throughMessageId, message.messageId),
            ),
          );
        if (!existing) {
          const chunk = await database
            .select()
            .from(continuityMessages)
            .where(
              and(
                eq(continuityMessages.ownerUserId, actor.id),
                eq(continuityMessages.channelId, input.channelId),
              ),
            )
            .orderBy(desc(continuityMessages.occurredAt))
            .limit(50);
          const ordered = chunk.reverse();
          const summary = ordered
            .map(
              (item) =>
                `[${item.role} ${item.messageId}] ${item.content.replace(/\s+/g, " ").slice(0, 240)}`,
            )
            .join("\n");
          await database.insert(continuitySnapshots).values({
            ownerUserId: actor.id,
            channelId: input.channelId,
            threadId: input.threadId,
            throughMessageId: message.messageId,
            summary: summary.slice(0, MAX_SUMMARY),
            anchors: {
              items: ordered.map((item) => ({
                messageId: item.messageId,
                occurredAt: item.occurredAt.toISOString(),
              })),
            },
            tokenEstimate: Math.ceil(summary.length / 4),
            sourceMessageCount: ordered.length,
          });
        }
      }
      return message;
    },

    async search(
      actor: AgentActor,
      query: string,
      options: { channelId?: string; limit?: number } = {},
    ) {
      const normalized = boundedLine(query, "Search query", 300);
      if (options.channelId) await requireChannel(actor, options.channelId);
      const words = normalized
        .split(/\s+/)
        .map((word) => word.replace(/[%_]/g, ""))
        .filter(Boolean)
        .slice(0, 8);
      if (!words.length) {
        throw new WorkValidationError("Search query needs searchable text.");
      }
      const match = and(
        ...words.map((word) => ilike(continuityMessages.content, `%${word}%`)),
      );
      return database
        .select()
        .from(continuityMessages)
        .where(
          and(
            eq(continuityMessages.ownerUserId, actor.id),
            options.channelId
              ? eq(continuityMessages.channelId, options.channelId)
              : undefined,
            match,
          ),
        )
        .orderBy(desc(continuityMessages.occurredAt))
        .limit(Math.max(1, Math.min(options.limit ?? 30, 100)));
    },

    async createSnapshot(
      actor: AgentActor,
      input: {
        channelId: string;
        threadId: string;
        throughMessageId: string;
        summary: string;
        anchors?: unknown[];
        tokenEstimate?: number;
        sourceMessageCount?: number;
      },
    ) {
      await requireChannel(actor, input.channelId, input.threadId);
      const [snapshot] = await database
        .insert(continuitySnapshots)
        .values({
          ownerUserId: actor.id,
          channelId: input.channelId,
          threadId: boundedLine(input.threadId, "Thread ID", 300),
          throughMessageId: boundedLine(
            input.throughMessageId,
            "Message ID",
            300,
          ),
          summary: bounded(input.summary, MAX_SUMMARY, "Context summary"),
          anchors: { items: (input.anchors ?? []).slice(0, 200) },
          tokenEstimate: boundedInteger(input.tokenEstimate, 0, 2_000_000),
          sourceMessageCount: boundedInteger(
            input.sourceMessageCount,
            0,
            100_000,
          ),
        })
        .returning();
      if (!snapshot) throw new Error("Context snapshot could not be created.");
      await auditEvent(
        audit,
        actor,
        "continuity.snapshot_created",
        snapshot.id,
        {
          channelId: snapshot.channelId,
          throughMessageId: snapshot.throughMessageId,
        },
      );
      return snapshot;
    },

    async createProgram(
      actor: AgentActor,
      input: {
        agentId: string;
        name: string;
        description?: string;
        steps: ProgramStepInput[];
      },
    ) {
      const steps = parseSteps(input.steps);
      const [program] = await database
        .insert(toolPrograms)
        .values({
          ownerUserId: actor.id,
          agentId: boundedLine(input.agentId, "Coworker", 200),
          name: boundedLine(input.name, "Program name", 120),
          description: input.description?.trim()
            ? bounded(input.description, 2_000, "Program description")
            : "",
          steps: { items: steps },
          status: "draft",
        })
        .returning();
      if (!program) throw new Error("Tool program could not be created.");
      return program;
    },

    async reviewProgram(
      actor: AgentActor,
      programId: string,
      approve: boolean,
    ) {
      await getProgram(actor, programId);
      const [program] = await database
        .update(toolPrograms)
        .set({
          status: approve ? "approved" : "draft",
          reviewedByUserId: approve ? actor.id : null,
          reviewedAt: approve ? new Date() : null,
          updatedAt: new Date(),
        })
        .where(eq(toolPrograms.id, programId))
        .returning();
      if (!program) throw new WorkNotFoundError("Tool program not found.");
      await auditEvent(
        audit,
        actor,
        approve ? "tool_program.approved" : "tool_program.unapproved",
        program.id,
        { agentId: program.agentId, revision: program.revision },
      );
      return program;
    },

    async programsFor(actor: AgentActor, agentId: string) {
      return database
        .select()
        .from(toolPrograms)
        .where(
          and(
            eq(toolPrograms.ownerUserId, actor.id),
            eq(toolPrograms.agentId, agentId),
            eq(toolPrograms.status, "approved"),
          ),
        )
        .orderBy(toolPrograms.name);
    },

    async executeApprovedProgram(input: {
      actor: AgentActor;
      agentId: string;
      programId: string;
      tools: GrantedTool[];
      run?: ToolRunContext;
      signal?: AbortSignal;
    }) {
      const program = await getProgram(input.actor, input.programId);
      if (program.agentId !== input.agentId || program.status !== "approved") {
        throw new WorkConflictError(
          "That tool program is not approved for this coworker.",
        );
      }
      const steps = parseStoredSteps(program.steps);
      if (!steps.length)
        throw new WorkValidationError("Tool program has no valid steps.");
      const byName = new Map(input.tools.map((tool) => [tool.name, tool]));
      const trace: Array<Record<string, unknown>> = [];
      let output = "";
      try {
        for (const [index, step] of steps.entries()) {
          if (input.signal?.aborted)
            throw new Error("The tool program was stopped.");
          const tool = byName.get(step.tool);
          if (!tool) throw new Error(`Tool ${step.tool} is no longer granted.`);
          const startedAt = Date.now();
          const result = Array.from(
            await tool.execute(step.arguments, {
              ...(input.signal ? { abortSignal: input.signal } : {}),
            }),
          )
            .slice(0, MAX_STEP_RESULT)
            .join("");
          output = result;
          trace.push({
            index,
            tool: step.tool,
            durationMs: Date.now() - startedAt,
            resultHash: await hash(result),
            resultPreview: result.replace(/\s+/g, " ").slice(0, 280),
          });
        }
        const record = await saveProgramRun({
          actor: input.actor,
          agentId: input.agentId,
          programId: program.id,
          ...(input.run ? { run: input.run } : {}),
          status: "succeeded",
          stepNames: steps.map((step) => step.tool),
          trace,
          output,
        });
        return { program, record, output, trace };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "The tool program failed.";
        await saveProgramRun({
          actor: input.actor,
          agentId: input.agentId,
          programId: program.id,
          ...(input.run ? { run: input.run } : {}),
          status: "failed",
          stepNames: steps.map((step) => step.tool),
          trace,
          error: message,
        });
        throw new WorkConflictError(message);
      }
    },

    async recordProgramRun(input: {
      actor: AgentActor;
      agentId: string;
      programId?: string;
      run?: ToolRunContext;
      status: "succeeded" | "failed";
      stepNames: string[];
      trace: unknown[];
      output?: string;
      error?: string;
    }) {
      return saveProgramRun(input);
    },

    captureSkill,

    async recordSkillUsage(
      actor: AgentActor,
      input: {
        skillId: string;
        agentId?: string;
        channelId?: string;
        taskRunId?: string;
        outcome?: string;
      },
    ) {
      const skill = await getSkill(actor, input.skillId);
      if (input.channelId) await requireChannel(actor, input.channelId);
      await captureSkill(actor, skill.id, { reason: "first_observed_use" });
      const [event] = await database
        .insert(skillUsageEvents)
        .values({
          ownerUserId: actor.id,
          skillId: skill.id,
          ...(input.agentId ? { agentId: input.agentId } : {}),
          ...(input.channelId ? { channelId: input.channelId } : {}),
          ...(input.taskRunId ? { taskRunId: input.taskRunId } : {}),
          outcome: boundedLine(input.outcome ?? "invoked", "Outcome", 40),
        })
        .returning();
      return event;
    },

    async updateSkillHealth(
      actor: AgentActor,
      skillId: string,
      input: {
        lifecycleStatus?: "active" | "archived";
        pinnedVersion?: number | null;
      },
    ) {
      await requireMutableSkill(actor, skillId);
      await captureSkill(actor, skillId, { reason: "health_control" });
      if (input.pinnedVersion) {
        const [version] = await database
          .select({ id: skillVersions.id })
          .from(skillVersions)
          .where(
            and(
              eq(skillVersions.skillId, skillId),
              eq(skillVersions.version, input.pinnedVersion),
            ),
          );
        if (!version)
          throw new WorkValidationError("Pinned version not found.");
      }
      const [skill] = await database
        .update(skills)
        .set({
          ...(input.lifecycleStatus
            ? { lifecycleStatus: input.lifecycleStatus }
            : {}),
          ...(input.pinnedVersion !== undefined
            ? { pinnedVersion: input.pinnedVersion }
            : {}),
          updatedAt: new Date(),
        })
        .where(eq(skills.id, skillId))
        .returning();
      if (!skill) throw new WorkNotFoundError("Skill not found.");
      await auditEvent(audit, actor, "skill.health_changed", skillId, {
        lifecycleStatus: skill.lifecycleStatus,
        pinnedVersion: skill.pinnedVersion,
      });
      return skill;
    },

    async rollbackSkill(actor: AgentActor, skillId: string, version: number) {
      await requireMutableSkill(actor, skillId);
      await captureSkill(actor, skillId, { reason: "before_rollback" });
      const [target] = await database
        .select()
        .from(skillVersions)
        .where(
          and(
            eq(skillVersions.skillId, skillId),
            eq(skillVersions.version, version),
          ),
        );
      if (!target) throw new WorkNotFoundError("Skill version not found.");
      await database
        .update(skills)
        .set({
          title: target.title,
          summary: target.summary,
          instructions: target.instructions,
          updatedAt: new Date(),
        })
        .where(eq(skills.id, skillId));
      const restored = await captureSkill(actor, skillId, {
        reason: "rollback",
        restoredFromVersion: version,
      });
      await auditEvent(audit, actor, "skill.rolled_back", skillId, {
        restoredFromVersion: version,
        newVersion: restored.version,
      });
      return restored;
    },

    async createBundle(
      actor: AgentActor,
      input: {
        name: string;
        description?: string;
        version?: number;
        manifest: BotBundleManifest;
      },
    ) {
      validateManifest(input.manifest);
      const manifestText = JSON.stringify(input.manifest);
      if (manifestText.length > MAX_BUNDLE_MANIFEST) {
        throw new WorkValidationError("Bot bundle manifest is too large.");
      }
      const [bundle] = await database
        .insert(botBundles)
        .values({
          ownerUserId: actor.id,
          name: boundedLine(input.name, "Bundle name", 120),
          description: input.description?.trim()
            ? bounded(input.description, 4_000, "Bundle description")
            : "",
          version: boundedInteger(input.version, 1, 100_000) || 1,
          manifest: input.manifest,
          contentHash: await hash(manifestText),
          status: "active",
        })
        .returning();
      if (!bundle) throw new Error("Bot bundle could not be created.");
      await auditEvent(audit, actor, "bot_bundle.created", bundle.id, {
        name: bundle.name,
        version: bundle.version,
        contentHash: bundle.contentHash,
      });
      return bundle;
    },

    async archiveBundle(actor: AgentActor, bundleId: string) {
      const [bundle] = await database
        .update(botBundles)
        .set({ status: "archived", updatedAt: new Date() })
        .where(
          and(
            eq(botBundles.id, bundleId),
            eq(botBundles.ownerUserId, actor.id),
          ),
        )
        .returning();
      if (!bundle) throw new WorkNotFoundError("Bot bundle not found.");
      await auditEvent(audit, actor, "bot_bundle.archived", bundle.id, {
        name: bundle.name,
        version: bundle.version,
      });
      return bundle;
    },
  };
}

export type ContinuityStore = ReturnType<typeof createContinuityStore>;

/**
 * A reviewed program calls only the tools already granted to this Bot. Every step therefore keeps
 * its existing grant, policy, approval, credential, and audit behavior. Only the final result is
 * returned to model context; the bounded trace is kept in OpenBot for inspection.
 */
export async function governedProgramTools(options: {
  tools: GrantedTool[];
  actor: AgentActor;
  agentId: string;
  run?: ToolRunContext;
  store: ContinuityStore;
}): Promise<GrantedTool[]> {
  const programs = await options.store.programsFor(
    options.actor,
    options.agentId,
  );
  if (!programs.length || !options.tools.length) return [];
  const byName = new Map(options.tools.map((tool) => [tool.name, tool]));
  const available = programs.filter((program) =>
    parseStoredSteps(program.steps).every((step) => byName.has(step.tool)),
  );
  if (!available.length) return [];

  return [
    {
      name: "openbot_run_tool_program",
      description:
        "Run one reviewed multi-tool program. Each step uses its original OpenBot grant, policy, approval, credential, and audit path; only the final result enters model context.",
      parameters: z.object({
        program: z.enum(
          available.map((program) => program.name) as [string, ...string[]],
        ),
      }),
      execute: async (args, execution) => {
        const name =
          args && typeof args === "object" && "program" in args
            ? String((args as { program: unknown }).program)
            : "";
        const program = available.find((candidate) => candidate.name === name);
        if (!program) return "That reviewed tool program is not available.";
        const steps = parseStoredSteps(program.steps);
        const trace: Array<Record<string, unknown>> = [];
        let finalOutput = "";
        try {
          for (const [index, step] of steps.entries()) {
            if (execution?.abortSignal?.aborted) {
              throw new Error("The tool program was stopped.");
            }
            const tool = byName.get(step.tool);
            if (!tool)
              throw new Error(`Tool ${step.tool} is no longer granted.`);
            const startedAt = Date.now();
            const result = Array.from(
              await tool.execute(step.arguments, execution),
            )
              .slice(0, MAX_STEP_RESULT)
              .join("");
            finalOutput = result;
            trace.push({
              index,
              tool: step.tool,
              durationMs: Date.now() - startedAt,
              resultHash: await hash(result),
              resultPreview: result.replace(/\s+/g, " ").slice(0, 280),
            });
          }
          const record = await options.store.recordProgramRun({
            actor: options.actor,
            agentId: options.agentId,
            programId: program.id,
            ...(options.run ? { run: options.run } : {}),
            status: "succeeded",
            stepNames: steps.map((step) => step.tool),
            trace,
            output: finalOutput,
          });
          return [
            finalOutput,
            "",
            `[Tool program ${program.name} completed ${steps.length} governed steps${record ? `; run ${record.id}` : ""}.]`,
          ].join("\n");
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "The tool program failed.";
          await options.store.recordProgramRun({
            actor: options.actor,
            agentId: options.agentId,
            programId: program.id,
            ...(options.run ? { run: options.run } : {}),
            status: "failed",
            stepNames: steps.map((step) => step.tool),
            trace,
            error: message,
          });
          return `The reviewed tool program stopped: ${message}`;
        }
      },
    },
  ];
}

/** Owner-scoped continuity search available to Bots without exposing the canonical transcript store. */
export function continuityTools(options: {
  store: ContinuityStore;
  actor: AgentActor;
  channelId?: string;
}): GrantedTool[] {
  return [
    {
      name: "openbot_context_search",
      description:
        "Search this person's owner-scoped OpenBot Context Vault for exact prior messages and anchors. Use when a needed decision or detail is no longer in the active context.",
      parameters: z.object({
        query: z.string().min(2).max(300),
        acrossConversations: z.boolean().optional(),
        limit: z.number().int().min(1).max(20).optional(),
      }),
      execute: async (args) => {
        const parsed = z
          .object({
            query: z.string(),
            acrossConversations: z.boolean().optional(),
            limit: z.number().optional(),
          })
          .parse(args);
        const results = await options.store.search(
          options.actor,
          parsed.query,
          {
            ...(!parsed.acrossConversations && options.channelId
              ? { channelId: options.channelId }
              : {}),
            limit: parsed.limit ?? 8,
          },
        );
        return JSON.stringify(
          results.map((result) => ({
            channelId: result.channelId,
            messageId: result.messageId,
            role: result.role,
            content: result.content.slice(0, 2_000),
            occurredAt: result.occurredAt,
          })),
        );
      },
    },
  ];
}

function parseSteps(value: ProgramStepInput[]): ProgramStep[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new WorkValidationError("A tool program needs at least one step.");
  }
  if (value.length > MAX_PROGRAM_STEPS) {
    throw new WorkValidationError(
      `A tool program may contain at most ${MAX_PROGRAM_STEPS} steps.`,
    );
  }
  let definition: string;
  try {
    definition = JSON.stringify(value);
  } catch {
    throw new WorkValidationError("Tool program steps must be JSON values.");
  }
  if (definition.length > MAX_PROGRAM_DEFINITION) {
    throw new WorkValidationError("Tool program definition is too large.");
  }
  return value.map((step, index) => {
    if (!step || typeof step !== "object") {
      throw new WorkValidationError(`Program step ${index + 1} is invalid.`);
    }
    return {
      id: step.id
        ? boundedLine(step.id, `Program step ${index + 1} id`, 120)
        : crypto.randomUUID(),
      tool: boundedLine(step.tool, `Program step ${index + 1} tool`, 240),
      arguments:
        step.arguments &&
        typeof step.arguments === "object" &&
        !Array.isArray(step.arguments)
          ? step.arguments
          : {},
    };
  });
}

function parseStoredSteps(value: unknown): ProgramStep[] {
  try {
    return parseSteps(arrayItems<ProgramStepInput>(value));
  } catch {
    return [];
  }
}

function arrayItems<T = unknown>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Array.isArray((value as { items?: unknown }).items)
  ) {
    return (value as { items: T[] }).items;
  }
  return [];
}

function validateManifest(manifest: BotBundleManifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new WorkValidationError("A Bot bundle manifest must be an object.");
  }
  const walk = (value: unknown, path: string[]) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const [index, item] of value.entries())
        walk(item, [...path, String(index)]);
      return;
    }
    for (const [key, item] of Object.entries(value)) {
      const normalized = key.toLocaleLowerCase();
      if (FORBIDDEN_BUNDLE_KEYS.some((word) => normalized.includes(word))) {
        throw new WorkValidationError(
          `Bot bundles cannot contain ${[...path, key].join(".")}.`,
        );
      }
      walk(item, [...path, key]);
    }
  };
  walk(manifest, []);
}

function bounded(value: string, limit: number, label: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new WorkValidationError(`${label} is required.`);
  }
  const output = Array.from(value.trim()).slice(0, limit).join("");
  if (Array.from(value.trim()).length > limit) {
    throw new WorkValidationError(`${label} is too long.`);
  }
  return output;
}

function boundedLine(value: string, label: string, limit: number) {
  return bounded(value, limit, label).replace(/[\r\n\t]+/g, " ");
}

function boundedInteger(
  value: number | undefined,
  minimum: number,
  maximum: number,
) {
  if (!Number.isFinite(value)) return minimum;
  return Math.max(minimum, Math.min(Math.trunc(value as number), maximum));
}

async function hash(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Buffer.from(digest).toString("hex");
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
    targetType: "continuity",
    targetId,
    payload,
  });
}

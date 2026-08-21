import { and, desc, eq } from "drizzle-orm";
import type { AgentActor } from "../agents/profile-types";
import type { AuditStore } from "../audit";
import { recordAuditEvent } from "../audit";
import type { Database } from "../db/client";
import { memorySuggestions, skillProposals, skills } from "../db/schema";
import type { PluginStore } from "../plugins/store";
import type { RunStore } from "../runs/store";
import {
  MEMORY_KINDS,
  MEMORY_SCOPES,
  type MemoryInput,
  type MemoryStore,
} from "../work/memory";
import {
  safeBody,
  safeLine,
  WorkConflictError,
  WorkNotFoundError,
  WorkValidationError,
} from "../work/access";

type SkillProposalInput = {
  slug: string;
  title: string;
  summary?: string;
  instructions: string;
  sourceRunId?: string;
};

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

export function createLearningStore(options: {
  database: Database;
  plugins: PluginStore;
  runs: RunStore;
  memory: MemoryStore;
  audit?: AuditStore;
}) {
  const { database, plugins, runs, memory, audit } = options;

  const auditDecision = async (
    eventType:
      | "skill_proposal.created"
      | "skill_proposal.applied"
      | "skill_proposal.rejected"
      | "skill_proposal.rolled_back"
      | "memory_suggestion.created"
      | "memory_suggestion.promoted"
      | "memory_suggestion.rejected",
    targetType: "skill_proposal" | "memory_suggestion",
    targetId: string,
    actorUserId: string,
    payload: Record<string, unknown>,
  ) => {
    if (!audit) return;
    await recordAuditEvent(audit, {
      eventType,
      targetType,
      targetId,
      actorUserId,
      payload,
    });
  };

  const proposalOwned = async (actor: AgentActor, proposalId: string) => {
    const [proposal] = await database
      .select()
      .from(skillProposals)
      .where(
        and(
          eq(skillProposals.id, proposalId),
          eq(skillProposals.ownerUserId, actor.id),
        ),
      );
    if (!proposal) throw new WorkNotFoundError("Skill proposal not found.");
    return proposal;
  };

  const suggestionOwned = async (actor: AgentActor, suggestionId: string) => {
    const [suggestion] = await database
      .select()
      .from(memorySuggestions)
      .where(
        and(
          eq(memorySuggestions.id, suggestionId),
          eq(memorySuggestions.ownerUserId, actor.id),
        ),
      );
    if (!suggestion)
      throw new WorkNotFoundError("Memory suggestion not found.");
    return suggestion;
  };

  const proposalInput = async (
    actor: AgentActor,
    input: SkillProposalInput,
  ) => {
    const slug = input.slug.trim().toLocaleLowerCase();
    if (!SLUG.test(slug)) {
      throw new WorkValidationError(
        "A skill slug uses lower-case letters, numbers, and hyphens.",
      );
    }
    const sourceRun = input.sourceRunId
      ? await runs.get(actor, input.sourceRunId)
      : null;
    if (input.sourceRunId && !sourceRun) {
      throw new WorkNotFoundError("Source run not found.");
    }
    if (sourceRun && sourceRun.status !== "succeeded") {
      throw new WorkConflictError(
        "Only a completed run can become learning evidence.",
      );
    }

    const [existing] = await database
      .select()
      .from(skills)
      .where(eq(skills.slug, slug));
    if (
      existing &&
      actor.role !== "admin" &&
      existing.ownerUserId !== actor.id
    ) {
      throw new WorkConflictError("That skill belongs to somebody else.");
    }
    const title = safeLine(input.title, "Skill title");
    const summary = input.summary?.trim()
      ? safeLine(input.summary, "Skill summary", 240)
      : "Learned from a reviewed OpenBot run.";
    const instructions = safeBody(
      input.instructions,
      "Skill instructions",
      30_000,
    );
    const scan = scanSkill(instructions);
    const canonical = { slug, title, summary, instructions };
    return {
      ...canonical,
      sourceRun,
      existing,
      scan,
      proposalHash: await contentHash(canonical),
      baseHash: existing ? await skillHash(existing) : null,
    };
  };

  return {
    async overview(actor: AgentActor) {
      const [proposals, suggestions] = await Promise.all([
        database
          .select()
          .from(skillProposals)
          .where(eq(skillProposals.ownerUserId, actor.id))
          .orderBy(desc(skillProposals.createdAt))
          .limit(100),
        database
          .select()
          .from(memorySuggestions)
          .where(eq(memorySuggestions.ownerUserId, actor.id))
          .orderBy(desc(memorySuggestions.createdAt))
          .limit(100),
      ]);
      return { proposals, suggestions };
    },

    async proposeSkill(actor: AgentActor, input: SkillProposalInput) {
      const prepared = await proposalInput(actor, input);
      const [proposal] = await database
        .insert(skillProposals)
        .values({
          ownerUserId: actor.id,
          ...(prepared.sourceRun ? { sourceRunId: prepared.sourceRun.id } : {}),
          ...(prepared.existing ? { targetSkillId: prepared.existing.id } : {}),
          operation: prepared.existing ? "update" : "create",
          slug: prepared.slug,
          title: prepared.title,
          summary: prepared.summary,
          instructions: prepared.instructions,
          status: prepared.scan.quarantine ? "quarantined" : "pending",
          baseHash: prepared.baseHash,
          proposalHash: prepared.proposalHash,
          evidence: {
            ...(prepared.sourceRun
              ? {
                  sourceRunId: prepared.sourceRun.id,
                  sourceRunTitle: prepared.sourceRun.title,
                }
              : {}),
            ...(prepared.existing
              ? {
                  previous: {
                    slug: prepared.existing.slug,
                    title: prepared.existing.title,
                    summary: prepared.existing.summary,
                    instructions: prepared.existing.instructions,
                    ownerUserId: prepared.existing.ownerUserId,
                  },
                }
              : {}),
          },
          scan: prepared.scan,
        })
        .returning();
      if (!proposal) throw new Error("Skill proposal could not be created.");
      await auditDecision(
        "skill_proposal.created",
        "skill_proposal",
        proposal.id,
        actor.id,
        {
          operation: proposal.operation,
          slug: proposal.slug,
          status: proposal.status,
          sourceRun: proposal.sourceRunId,
        },
      );
      return proposal;
    },

    async proposeSkillFromRun(
      actor: AgentActor,
      runId: string,
      input: Partial<Omit<SkillProposalInput, "sourceRunId">>,
    ) {
      const run = await runs.get(actor, runId);
      if (!run) throw new WorkNotFoundError("Source run not found.");
      if (run.status !== "succeeded" || !run.output) {
        throw new WorkConflictError(
          "The run needs a completed text result before it can be learned.",
        );
      }
      const fallbackSlug = slugFrom(run.title);
      return this.proposeSkill(actor, {
        slug: input.slug ?? fallbackSlug,
        title: input.title ?? run.title,
        summary:
          input.summary ?? `Reusable procedure learned from ${run.title}.`,
        instructions: input.instructions ?? run.output,
        sourceRunId: run.id,
      });
    },

    async applySkill(actor: AgentActor, proposalId: string) {
      const proposal = await proposalOwned(actor, proposalId);
      if (proposal.status === "quarantined") {
        throw new WorkConflictError(
          "This proposal is quarantined. Edit the risky instructions and create a new proposal.",
        );
      }
      if (proposal.status !== "pending") {
        throw new WorkConflictError("This proposal is no longer pending.");
      }
      const expected = await contentHash({
        slug: proposal.slug,
        title: proposal.title,
        summary: proposal.summary,
        instructions: proposal.instructions,
      });
      if (expected !== proposal.proposalHash) {
        await markProposal(database, proposal.id, "quarantined", actor.id);
        throw new WorkConflictError(
          "The proposal hash no longer matches its content.",
        );
      }
      const [current] = await database
        .select()
        .from(skills)
        .where(eq(skills.slug, proposal.slug));
      const currentHash = current ? await skillHash(current) : null;
      if (currentHash !== proposal.baseHash) {
        await markProposal(database, proposal.id, "stale", actor.id);
        throw new WorkConflictError(
          "The installed skill changed after this proposal was created. Review a fresh proposal.",
        );
      }
      await plugins.installSkill({
        slug: proposal.slug,
        title: proposal.title,
        summary: proposal.summary,
        instructions: proposal.instructions,
        origin: "learned",
        ownerUserId: current?.ownerUserId ?? actor.id,
        by: actor.id,
      });
      const [applied] = await database
        .update(skillProposals)
        .set({
          status: "applied",
          appliedSkillId: proposal.slug,
          reviewedByUserId: actor.id,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(skillProposals.id, proposal.id))
        .returning();
      await auditDecision(
        "skill_proposal.applied",
        "skill_proposal",
        proposal.id,
        actor.id,
        { operation: proposal.operation, slug: proposal.slug },
      );
      return applied;
    },

    async rejectSkill(actor: AgentActor, proposalId: string) {
      const proposal = await proposalOwned(actor, proposalId);
      if (!["pending", "quarantined", "stale"].includes(proposal.status)) {
        throw new WorkConflictError("This proposal has already been decided.");
      }
      const [rejected] = await database
        .update(skillProposals)
        .set({
          status: "rejected",
          reviewedByUserId: actor.id,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(skillProposals.id, proposal.id))
        .returning();
      await auditDecision(
        "skill_proposal.rejected",
        "skill_proposal",
        proposal.id,
        actor.id,
        { slug: proposal.slug },
      );
      return rejected;
    },

    async rollbackSkill(actor: AgentActor, proposalId: string) {
      const proposal = await proposalOwned(actor, proposalId);
      if (proposal.status !== "applied") {
        throw new WorkConflictError(
          "Only an applied proposal can be rolled back.",
        );
      }
      const [current] = await database
        .select()
        .from(skills)
        .where(eq(skills.slug, proposal.slug));
      if (!current || (await skillHash(current)) !== proposal.proposalHash) {
        throw new WorkConflictError(
          "The skill changed after this proposal was applied, so an automatic rollback is unsafe.",
        );
      }
      const evidence = object(proposal.evidence);
      const previous = object(evidence.previous);
      if (proposal.operation === "create") {
        await plugins.uninstallSkill(proposal.slug, actor.id);
      } else {
        await plugins.installSkill({
          slug: String(previous.slug ?? proposal.slug),
          title: String(previous.title ?? ""),
          summary: String(previous.summary ?? ""),
          instructions: String(previous.instructions ?? ""),
          ownerUserId:
            typeof previous.ownerUserId === "string"
              ? previous.ownerUserId
              : previous.ownerUserId === null
                ? null
                : actor.id,
          by: actor.id,
        });
      }
      const [rolledBack] = await database
        .update(skillProposals)
        .set({ status: "rolled_back", updatedAt: new Date() })
        .where(eq(skillProposals.id, proposal.id))
        .returning();
      await auditDecision(
        "skill_proposal.rolled_back",
        "skill_proposal",
        proposal.id,
        actor.id,
        { slug: proposal.slug },
      );
      return rolledBack;
    },

    async suggestMemory(
      actor: AgentActor,
      input: MemoryInput & { sourceRunId?: string },
    ) {
      if (
        !MEMORY_SCOPES.includes(input.scope) ||
        !MEMORY_KINDS.includes(input.kind)
      ) {
        throw new WorkValidationError("Memory scope or kind is invalid.");
      }
      const sourceRun = input.sourceRunId
        ? await runs.get(actor, input.sourceRunId)
        : null;
      if (input.sourceRunId && !sourceRun) {
        throw new WorkNotFoundError("Source run not found.");
      }
      const confidence = input.confidence ?? 70;
      if (!Number.isInteger(confidence) || confidence < 0 || confidence > 100) {
        throw new WorkValidationError("Confidence must be between 0 and 100.");
      }
      if (input.scope === "project") {
        throw new WorkValidationError(
          "Project memory suggestions need project review and are not supported yet.",
        );
      }
      if (input.scope === "agent" && !input.agentId) {
        throw new WorkValidationError("Coworker memory needs a coworker.");
      }
      const [suggestion] = await database
        .insert(memorySuggestions)
        .values({
          ownerUserId: actor.id,
          ...(sourceRun ? { sourceRunId: sourceRun.id } : {}),
          scope: input.scope,
          kind: input.kind,
          ...(input.agentId ? { agentId: input.agentId } : {}),
          title: safeLine(input.title, "Memory title"),
          content: safeBody(input.content, "Memory", 20_000),
          confidence,
        })
        .returning();
      if (!suggestion)
        throw new Error("Memory suggestion could not be created.");
      await auditDecision(
        "memory_suggestion.created",
        "memory_suggestion",
        suggestion.id,
        actor.id,
        {
          scope: suggestion.scope,
          kind: suggestion.kind,
          sourceRun: suggestion.sourceRunId,
        },
      );
      return suggestion;
    },

    async promoteMemory(actor: AgentActor, suggestionId: string) {
      const suggestion = await suggestionOwned(actor, suggestionId);
      if (suggestion.status !== "pending") {
        throw new WorkConflictError(
          "This memory suggestion has already been decided.",
        );
      }
      const promoted = await memory.create(actor, {
        scope: suggestion.scope as MemoryInput["scope"],
        kind: suggestion.kind as MemoryInput["kind"],
        ...(suggestion.agentId ? { agentId: suggestion.agentId } : {}),
        title: suggestion.title,
        content: suggestion.content,
        confidence: suggestion.confidence,
        source: suggestion.sourceRunId
          ? `learned from run ${suggestion.sourceRunId}`
          : "reviewed suggestion",
      });
      const [updated] = await database
        .update(memorySuggestions)
        .set({
          status: "promoted",
          promotedMemoryId: promoted.id,
          updatedAt: new Date(),
        })
        .where(eq(memorySuggestions.id, suggestion.id))
        .returning();
      await auditDecision(
        "memory_suggestion.promoted",
        "memory_suggestion",
        suggestion.id,
        actor.id,
        { memory: promoted.id },
      );
      return updated;
    },

    async rejectMemory(actor: AgentActor, suggestionId: string) {
      const suggestion = await suggestionOwned(actor, suggestionId);
      if (suggestion.status !== "pending") {
        throw new WorkConflictError(
          "This memory suggestion has already been decided.",
        );
      }
      const [updated] = await database
        .update(memorySuggestions)
        .set({ status: "rejected", updatedAt: new Date() })
        .where(eq(memorySuggestions.id, suggestion.id))
        .returning();
      await auditDecision(
        "memory_suggestion.rejected",
        "memory_suggestion",
        suggestion.id,
        actor.id,
        { kind: suggestion.kind },
      );
      return updated;
    },
  };
}

export type LearningStore = ReturnType<typeof createLearningStore>;

async function markProposal(
  database: Database,
  proposalId: string,
  status: string,
  userId: string,
) {
  await database
    .update(skillProposals)
    .set({
      status,
      reviewedByUserId: userId,
      reviewedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(skillProposals.id, proposalId));
}

function scanSkill(instructions: string) {
  const checks = [
    {
      id: "secret-exfiltration",
      pattern:
        /(?:send|upload|post|exfiltrat).{0,80}(?:secret|token|credential|password)/i,
      severity: "critical",
    },
    {
      id: "policy-bypass",
      pattern:
        /(?:ignore|bypass|disable).{0,60}(?:policy|approval|guard|safety)/i,
      severity: "critical",
    },
    {
      id: "hidden-network-target",
      pattern:
        /https?:\/\/(?:localhost|127\.0\.0\.1|169\.254\.169\.254|\[?::1\]?)/i,
      severity: "critical",
    },
    {
      id: "destructive-shell",
      pattern: /\b(?:rm\s+-rf|format\s+[a-z]:|drop\s+(?:database|table))\b/i,
      severity: "warning",
    },
  ] as const;
  const findings = checks
    .filter((check) => check.pattern.test(instructions))
    .map(({ id, severity }) => ({ id, severity }));
  return {
    version: 1,
    findings,
    quarantine: findings.some((finding) => finding.severity === "critical"),
  };
}

async function contentHash(value: Record<string, unknown>) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return Buffer.from(digest).toString("hex");
}

function skillHash(skill: {
  slug: string;
  title: string;
  summary: string;
  instructions: string;
}) {
  return contentHash({
    slug: skill.slug,
    title: skill.title,
    summary: skill.summary,
    instructions: skill.instructions,
  });
}

function slugFrom(value: string) {
  const slug = value
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return SLUG.test(slug) ? slug : `learned-${crypto.randomUUID().slice(0, 8)}`;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

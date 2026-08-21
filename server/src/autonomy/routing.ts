import { and, asc, desc, eq, isNull, or } from "drizzle-orm";
import type { AgentActor } from "../agents/profile-types";
import type { AuditStore } from "../audit";
import { recordAuditEvent } from "../audit";
import type { Database } from "../db/client";
import { modelRouteAttempts, modelRoutes } from "../db/schema";
import {
  safeLine,
  WorkNotFoundError,
  WorkValidationError,
} from "../work/access";

export type ModelCandidate = { provider: string; model: string };
export type ModelFailureCode =
  | "rate_limit"
  | "authentication"
  | "timeout"
  | "unavailable"
  | "context_limit"
  | "other";

const DEFAULT_RETRYABLE: ModelFailureCode[] = [
  "rate_limit",
  "timeout",
  "unavailable",
];

export function createModelRouteStore(database: Database, audit?: AuditStore) {
  const getOwned = async (actor: AgentActor, routeId: string) => {
    const [route] = await database
      .select()
      .from(modelRoutes)
      .where(
        and(eq(modelRoutes.id, routeId), eq(modelRoutes.ownerUserId, actor.id)),
      );
    if (!route) throw new WorkNotFoundError("Model route not found.");
    return route;
  };

  return {
    async list(actor: AgentActor) {
      const routes = await database
        .select()
        .from(modelRoutes)
        .where(eq(modelRoutes.ownerUserId, actor.id))
        .orderBy(desc(modelRoutes.updatedAt));
      return routes.map((route) => ({
        ...route,
        candidates: candidateItems(route.candidates),
        retryableCodes: failureItems(route.retryableCodes),
      }));
    },

    async save(
      actor: AgentActor,
      input: {
        id?: string;
        name: string;
        agentId?: string;
        candidates: ModelCandidate[];
        retryableCodes?: ModelFailureCode[];
        status?: "active" | "paused";
      },
    ) {
      const candidates = normalizeCandidates(input.candidates);
      const retryable = [
        ...new Set(input.retryableCodes ?? DEFAULT_RETRYABLE),
      ].filter(isFailureCode);
      if (retryable.length === 0) {
        throw new WorkValidationError(
          "Choose at least one failure that may use a fallback.",
        );
      }
      if (input.id) {
        await getOwned(actor, input.id);
        const [updated] = await database
          .update(modelRoutes)
          .set({
            name: safeLine(input.name, "Route name"),
            agentId: input.agentId ?? null,
            candidates: { items: candidates },
            retryableCodes: { items: retryable },
            status: input.status ?? "active",
            updatedAt: new Date(),
          })
          .where(eq(modelRoutes.id, input.id))
          .returning();
        if (!updated) throw new WorkNotFoundError("Model route not found.");
        return updated;
      }
      const [created] = await database
        .insert(modelRoutes)
        .values({
          ownerUserId: actor.id,
          name: safeLine(input.name, "Route name"),
          ...(input.agentId ? { agentId: input.agentId } : {}),
          candidates: { items: candidates },
          retryableCodes: { items: retryable },
          status: input.status ?? "active",
        })
        .returning();
      if (!created) throw new Error("Model route could not be created.");
      if (audit) {
        await recordAuditEvent(audit, {
          eventType: "model_route.changed",
          targetType: "model_route",
          targetId: created.id,
          actorUserId: actor.id,
          payload: { bot: created.agentId, candidates: candidates.length },
        });
      }
      return created;
    },

    async remove(actor: AgentActor, routeId: string) {
      await getOwned(actor, routeId);
      await database.delete(modelRoutes).where(eq(modelRoutes.id, routeId));
    },

    async plan(
      actor: AgentActor,
      agentId: string,
      primary: ModelCandidate,
    ): Promise<{
      routeId: string | null;
      candidates: ModelCandidate[];
      retryableCodes: ModelFailureCode[];
    }> {
      const rows = await database
        .select()
        .from(modelRoutes)
        .where(
          and(
            eq(modelRoutes.ownerUserId, actor.id),
            eq(modelRoutes.status, "active"),
            or(eq(modelRoutes.agentId, agentId), isNull(modelRoutes.agentId)),
          ),
        )
        // A coworker-specific route wins over the person's default route.
        .orderBy(asc(modelRoutes.agentId), desc(modelRoutes.updatedAt));
      const route = rows.find((row) => row.agentId === agentId) ?? rows[0];
      if (!route) {
        return {
          routeId: null,
          candidates: [primary],
          retryableCodes: DEFAULT_RETRYABLE,
        };
      }
      const configured = normalizeCandidates(
        candidateItems(route.candidates),
        false,
      ).filter((candidate) => candidate.provider === primary.provider);
      const candidates = dedupeCandidates([primary, ...configured]).slice(0, 4);
      const retryableCodes = failureItems(route.retryableCodes);
      return {
        routeId: route.id,
        candidates,
        retryableCodes:
          retryableCodes.length > 0 ? retryableCodes : DEFAULT_RETRYABLE,
      };
    },

    async recordAttempt(input: {
      routeId: string | null;
      taskRunId: string;
      ordinal: number;
      candidate: ModelCandidate;
      outcome: "succeeded" | "failed";
      errorCode?: ModelFailureCode;
    }) {
      await database.insert(modelRouteAttempts).values({
        ...(input.routeId ? { routeId: input.routeId } : {}),
        taskRunId: input.taskRunId,
        ordinal: input.ordinal,
        provider: input.candidate.provider,
        model: input.candidate.model,
        outcome: input.outcome,
        ...(input.errorCode ? { errorCode: input.errorCode } : {}),
      });
    },

    async attempts(actor: AgentActor, limit = 100) {
      return database
        .select({ attempt: modelRouteAttempts })
        .from(modelRouteAttempts)
        .innerJoin(
          modelRoutes,
          and(
            eq(modelRoutes.id, modelRouteAttempts.routeId),
            eq(modelRoutes.ownerUserId, actor.id),
          ),
        )
        .orderBy(desc(modelRouteAttempts.createdAt))
        .limit(Math.max(1, Math.min(limit, 200)));
    },
  };
}

export type ModelRouteStore = ReturnType<typeof createModelRouteStore>;

export function classifyModelFailure(error: unknown): ModelFailureCode {
  const message = (
    error instanceof Error ? error.message : String(error)
  ).toLowerCase();
  if (/429|rate.?limit|too many requests|quota/.test(message))
    return "rate_limit";
  if (/401|403|auth|credential|api.?key|unauthorized/.test(message)) {
    return "authentication";
  }
  if (/timeout|timed out|deadline|stall|aborted/.test(message))
    return "timeout";
  if (/context.{0,12}(?:length|limit|window)|too many tokens/.test(message)) {
    return "context_limit";
  }
  if (/502|503|504|unavailable|overloaded|connection reset/.test(message)) {
    return "unavailable";
  }
  return "other";
}

function normalizeCandidates(
  value: unknown,
  required = true,
): ModelCandidate[] {
  if (!Array.isArray(value)) {
    if (!required) return [];
    throw new WorkValidationError("Model candidates must be a list.");
  }
  const candidates = value.map((candidate) => {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      throw new WorkValidationError(
        "Each model candidate needs a provider and model.",
      );
    }
    const record = candidate as Record<string, unknown>;
    if (
      typeof record.provider !== "string" ||
      typeof record.model !== "string"
    ) {
      throw new WorkValidationError(
        "Each model candidate needs a provider and model.",
      );
    }
    return {
      provider: safeLine(record.provider, "Model provider", 80),
      model: safeLine(record.model, "Model", 160),
    };
  });
  if (required && candidates.length === 0) {
    throw new WorkValidationError("Add at least one model candidate.");
  }
  if (candidates.length > 4) {
    throw new WorkValidationError(
      "A fallback route may contain at most four models.",
    );
  }
  return dedupeCandidates(candidates);
}

function dedupeCandidates(candidates: ModelCandidate[]) {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.provider}\u0000${candidate.model}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isFailureCode(value: unknown): value is ModelFailureCode {
  return (
    typeof value === "string" &&
    [
      "rate_limit",
      "authentication",
      "timeout",
      "unavailable",
      "context_limit",
      "other",
    ].includes(value)
  );
}

function candidateItems(value: Record<string, unknown>) {
  return Array.isArray(value.items) ? (value.items as ModelCandidate[]) : [];
}

function failureItems(value: Record<string, unknown>) {
  const items = Array.isArray(value.items)
    ? value.items.filter(isFailureCode)
    : [];
  return items.length > 0 ? items : DEFAULT_RETRYABLE;
}

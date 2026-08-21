import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../auth/guards";
import {
  WorkConflictError,
  WorkNotFoundError,
  WorkValidationError,
} from "../work/access";
import {
  EXTERNAL_CHANNEL_KINDS,
  type ExternalChannelKind,
  type ExternalChannelStore,
} from "./channels";
import type { LearningStore } from "./learning";
import type {
  ModelCandidate,
  ModelFailureCode,
  ModelRouteStore,
} from "./routing";
import type { ToolResultStore } from "./tool-catalog";

export type AutonomyServices = {
  channels: ExternalChannelStore;
  learning: LearningStore;
  routing: ModelRouteStore;
  results: ToolResultStore;
};

export function createAutonomyRoutes(
  services: AutonomyServices,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.get("/overview", requireUser, async (context) => {
    const actor = context.var.actor;
    const [channelState, learning, modelRoutes, modelAttempts, toolResults] =
      await Promise.all([
        services.channels.list(actor),
        services.learning.overview(actor),
        services.routing.list(actor),
        services.routing.attempts(actor, 50),
        services.results.list(actor, 30),
      ]);
    return context.json(
      dateDto({
        ...channelState,
        ...learning,
        modelRoutes,
        modelAttempts: modelAttempts.map((item) => item.attempt),
        toolResults,
      }),
    );
  });

  routes.post("/connections", requireUser, async (context) => {
    if (context.var.actor.role !== "admin") {
      return context.json(
        { error: "An administrator connects an external chat provider." },
        403,
      );
    }
    const body = await objectBody(context);
    if (
      !body ||
      !EXTERNAL_CHANNEL_KINDS.includes(body.kind as ExternalChannelKind) ||
      typeof body.name !== "string" ||
      typeof body.agentId !== "string" ||
      typeof body.channelId !== "string"
    ) {
      return context.json(
        {
          error: "Channel kind, name, coworker, and conversation are required.",
        },
        400,
      );
    }
    return autonomyCall(
      context,
      async () =>
        dateDto(
          await services.channels.create(context.var.actor, {
            kind: body.kind as ExternalChannelKind,
            name: body.name as string,
            agentId: body.agentId as string,
            channelId: body.channelId as string,
            ...(typeof body.credentialId === "string"
              ? { credentialId: body.credentialId }
              : {}),
            ...(typeof body.inboundSecret === "string"
              ? { inboundSecret: body.inboundSecret }
              : {}),
            ...(plainObject(body.config) ? { config: body.config } : {}),
          }),
        ),
      201,
    );
  });

  routes.patch("/connections/:connectionId", requireUser, async (context) => {
    if (context.var.actor.role !== "admin") {
      return context.json(
        { error: "An administrator changes an external chat provider." },
        403,
      );
    }
    const body = await objectBody(context);
    if (!body)
      return context.json({ error: "Bridge changes are required." }, 400);
    return autonomyCall(context, async () => ({
      connection: dateDto(
        await services.channels.update(
          context.var.actor,
          context.req.param("connectionId"),
          {
            ...(body.status === "active" || body.status === "paused"
              ? { status: body.status }
              : {}),
            ...(plainObject(body.config) ? { config: body.config } : {}),
          },
        ),
      ),
    }));
  });

  routes.post(
    "/connections/:connectionId/rotate-secret",
    requireUser,
    async (context) => {
      if (context.var.actor.role !== "admin") {
        return context.json(
          { error: "An administrator rotates an external chat secret." },
          403,
        );
      }
      return autonomyCall(context, async () =>
        dateDto(
          await services.channels.rotateSecret(
            context.var.actor,
            context.req.param("connectionId"),
          ),
        ),
      );
    },
  );

  routes.post(
    "/connections/:connectionId/identities",
    requireUser,
    async (context) => {
      const body = await objectBody(context);
      if (!body || typeof body.externalUserId !== "string") {
        return context.json({ error: "External user ID is required." }, 400);
      }
      return autonomyCall(
        context,
        async () => ({
          identity: dateDto(
            await services.channels.pairIdentity(
              context.var.actor,
              context.req.param("connectionId"),
              {
                externalUserId: body.externalUserId as string,
                ...(typeof body.externalConversationId === "string"
                  ? { externalConversationId: body.externalConversationId }
                  : {}),
                ...(typeof body.label === "string"
                  ? { label: body.label }
                  : {}),
              },
            ),
          ),
        }),
        201,
      );
    },
  );

  routes.post("/learning/skills", requireUser, async (context) => {
    const body = await objectBody(context);
    if (
      !body ||
      typeof body.slug !== "string" ||
      typeof body.title !== "string" ||
      typeof body.instructions !== "string"
    ) {
      return context.json(
        { error: "Skill slug, title, and instructions are required." },
        400,
      );
    }
    return autonomyCall(
      context,
      async () => ({
        proposal: dateDto(
          await services.learning.proposeSkill(context.var.actor, {
            slug: body.slug as string,
            title: body.title as string,
            instructions: body.instructions as string,
            ...(typeof body.summary === "string"
              ? { summary: body.summary }
              : {}),
            ...(typeof body.sourceRunId === "string"
              ? { sourceRunId: body.sourceRunId }
              : {}),
          }),
        ),
      }),
      201,
    );
  });

  routes.post("/learning/runs/:runId/skill", requireUser, async (context) => {
    const body = (await objectBody(context)) ?? {};
    return autonomyCall(
      context,
      async () => ({
        proposal: dateDto(
          await services.learning.proposeSkillFromRun(
            context.var.actor,
            context.req.param("runId"),
            {
              ...(typeof body.slug === "string" ? { slug: body.slug } : {}),
              ...(typeof body.title === "string" ? { title: body.title } : {}),
              ...(typeof body.summary === "string"
                ? { summary: body.summary }
                : {}),
              ...(typeof body.instructions === "string"
                ? { instructions: body.instructions }
                : {}),
            },
          ),
        ),
      }),
      201,
    );
  });

  for (const [action, method] of [
    ["apply", "applySkill"],
    ["reject", "rejectSkill"],
    ["rollback", "rollbackSkill"],
  ] as const) {
    routes.post(
      `/learning/skills/:proposalId/${action}`,
      requireUser,
      async (context) =>
        autonomyCall(context, async () => ({
          proposal: dateDto(
            await services.learning[method](
              context.var.actor,
              context.req.param("proposalId"),
            ),
          ),
        })),
    );
  }

  routes.post("/learning/memory", requireUser, async (context) => {
    const body = await objectBody(context);
    if (
      !body ||
      typeof body.scope !== "string" ||
      typeof body.kind !== "string" ||
      typeof body.title !== "string" ||
      typeof body.content !== "string"
    ) {
      return context.json(
        { error: "Memory scope, kind, title, and content are required." },
        400,
      );
    }
    return autonomyCall(
      context,
      async () => ({
        suggestion: dateDto(
          await services.learning.suggestMemory(context.var.actor, {
            scope: body.scope as never,
            kind: body.kind as never,
            title: body.title as string,
            content: body.content as string,
            ...(typeof body.agentId === "string"
              ? { agentId: body.agentId }
              : {}),
            ...(typeof body.confidence === "number"
              ? { confidence: body.confidence }
              : {}),
            ...(typeof body.sourceRunId === "string"
              ? { sourceRunId: body.sourceRunId }
              : {}),
          }),
        ),
      }),
      201,
    );
  });

  for (const [action, method] of [
    ["promote", "promoteMemory"],
    ["reject", "rejectMemory"],
  ] as const) {
    routes.post(
      `/learning/memory/:suggestionId/${action}`,
      requireUser,
      async (context) =>
        autonomyCall(context, async () => ({
          suggestion: dateDto(
            await services.learning[method](
              context.var.actor,
              context.req.param("suggestionId"),
            ),
          ),
        })),
    );
  }

  routes.post("/model-routes", requireUser, async (context) => {
    const body = await objectBody(context);
    if (
      !body ||
      typeof body.name !== "string" ||
      !Array.isArray(body.candidates)
    ) {
      return context.json(
        { error: "Route name and model candidates are required." },
        400,
      );
    }
    return autonomyCall(
      context,
      async () => ({
        route: dateDto(
          await services.routing.save(context.var.actor, {
            ...(typeof body.id === "string" ? { id: body.id } : {}),
            name: body.name as string,
            ...(typeof body.agentId === "string"
              ? { agentId: body.agentId }
              : {}),
            candidates: body.candidates as ModelCandidate[],
            ...(Array.isArray(body.retryableCodes)
              ? { retryableCodes: body.retryableCodes as ModelFailureCode[] }
              : {}),
            ...(body.status === "active" || body.status === "paused"
              ? { status: body.status }
              : {}),
          }),
        ),
      }),
      typeof body.id === "string" ? 200 : 201,
    );
  });

  routes.delete("/model-routes/:routeId", requireUser, async (context) =>
    autonomyCall(context, async () => {
      await services.routing.remove(
        context.var.actor,
        context.req.param("routeId"),
      );
      return { ok: true };
    }),
  );

  routes.get("/tool-results/:artifactId", requireUser, async (context) =>
    autonomyCall(context, async () => ({
      artifact: dateDto(
        await services.results.get(
          context.var.actor,
          context.req.param("artifactId"),
        ),
      ),
    })),
  );

  return routes;
}

export function createExternalChannelIngressRoutes(
  channels: ExternalChannelStore,
) {
  const routes = new Hono();
  routes.post("/:connectionId", async (context) => {
    const connectionId = context.req.param("connectionId");
    if (!UUID_PATTERN.test(connectionId)) {
      return context.json({ error: "Channel bridge not found." }, 404);
    }
    try {
      const result = await channels.ingestHttp(connectionId, {
        headers: context.req.raw.headers,
        rawBody: await context.req.text(),
      });
      if ("protocolResponse" in result) {
        return context.json(result.protocolResponse);
      }
      return context.json(result, 202);
    } catch (error) {
      if (error instanceof WorkNotFoundError) {
        return context.json({ error: "Channel bridge not found." }, 404);
      }
      if (error instanceof WorkConflictError) {
        return context.json({ error: error.message }, 403);
      }
      if (error instanceof WorkValidationError) {
        return context.json({ error: error.message }, 400);
      }
      throw error;
    }
  });
  return routes;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function objectBody(context: Context) {
  const value = await context.req.json().catch(() => null);
  return plainObject(value) ? value : null;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function dateDto<T>(value: T): T {
  if (value instanceof Date) return value.toISOString() as T;
  if (Array.isArray(value)) return value.map(dateDto) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, dateDto(item)]),
    ) as T;
  }
  return value;
}

async function autonomyCall(
  context: Context,
  call: () => Promise<Record<string, unknown>>,
  successStatus: 200 | 201 = 200,
) {
  try {
    return context.json(await call(), successStatus);
  } catch (error) {
    if (error instanceof WorkNotFoundError) {
      return context.json({ error: error.message }, 404);
    }
    if (error instanceof WorkValidationError) {
      return context.json({ error: error.message }, 400);
    }
    if (error instanceof WorkConflictError) {
      return context.json({ error: error.message }, 409);
    }
    throw error;
  }
}

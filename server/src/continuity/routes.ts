import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../auth/guards";
import {
  WorkConflictError,
  WorkNotFoundError,
  WorkValidationError,
} from "../work/access";
import type {
  BotBundleManifest,
  ContinuityStore,
  ProgramStepInput,
} from "./store";

export function createContinuityRoutes(
  store: ContinuityStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.get("/overview", requireUser, async (context) =>
    continuityCall(context, async () =>
      dateDto(await store.overview(context.var.actor)),
    ),
  );

  routes.get("/search", requireUser, async (context) => {
    const query = context.req.query("q")?.trim();
    if (!query)
      return context.json({ error: "Search query is required." }, 400);
    return continuityCall(context, async () => ({
      results: dateDto(
        await store.search(context.var.actor, query, {
          ...(context.req.query("channelId")
            ? { channelId: context.req.query("channelId") }
            : {}),
          ...(context.req.query("limit")
            ? { limit: Number(context.req.query("limit")) }
            : {}),
        }),
      ),
    }));
  });

  routes.post("/messages", requireUser, async (context) => {
    const body = await objectBody(context);
    if (
      !body ||
      typeof body.channelId !== "string" ||
      typeof body.threadId !== "string" ||
      typeof body.messageId !== "string" ||
      !["user", "assistant", "system"].includes(String(body.role)) ||
      typeof body.content !== "string" ||
      typeof body.occurredAt !== "string"
    ) {
      return context.json(
        {
          error:
            "Channel, thread, message, role, content, and time are required.",
        },
        400,
      );
    }
    const occurredAt = new Date(body.occurredAt);
    if (Number.isNaN(occurredAt.getTime())) {
      return context.json({ error: "Message time is invalid." }, 400);
    }
    return continuityCall(
      context,
      async () => ({
        message: dateDto(
          await store.indexMessage(context.var.actor, {
            channelId: body.channelId as string,
            threadId: body.threadId as string,
            messageId: body.messageId as string,
            ...(typeof body.agentId === "string"
              ? { agentId: body.agentId }
              : {}),
            role: body.role as "user" | "assistant" | "system",
            content: body.content as string,
            ...(plainObject(body.anchor) ? { anchor: body.anchor } : {}),
            occurredAt,
          }),
        ),
      }),
      201,
    );
  });

  routes.post("/snapshots", requireUser, async (context) => {
    const body = await objectBody(context);
    if (
      !body ||
      typeof body.channelId !== "string" ||
      typeof body.threadId !== "string" ||
      typeof body.throughMessageId !== "string" ||
      typeof body.summary !== "string"
    ) {
      return context.json(
        {
          error: "Channel, thread, through-message, and summary are required.",
        },
        400,
      );
    }
    return continuityCall(
      context,
      async () => ({
        snapshot: dateDto(
          await store.createSnapshot(context.var.actor, {
            channelId: body.channelId as string,
            threadId: body.threadId as string,
            throughMessageId: body.throughMessageId as string,
            summary: body.summary as string,
            ...(Array.isArray(body.anchors) ? { anchors: body.anchors } : {}),
            ...(typeof body.tokenEstimate === "number"
              ? { tokenEstimate: body.tokenEstimate }
              : {}),
            ...(typeof body.sourceMessageCount === "number"
              ? { sourceMessageCount: body.sourceMessageCount }
              : {}),
          }),
        ),
      }),
      201,
    );
  });

  routes.post("/programs", requireUser, async (context) => {
    const body = await objectBody(context);
    if (
      !body ||
      typeof body.agentId !== "string" ||
      typeof body.name !== "string" ||
      !Array.isArray(body.steps)
    ) {
      return context.json(
        { error: "Coworker, program name, and steps are required." },
        400,
      );
    }
    return continuityCall(
      context,
      async () => ({
        program: dateDto(
          await store.createProgram(context.var.actor, {
            agentId: body.agentId as string,
            name: body.name as string,
            ...(typeof body.description === "string"
              ? { description: body.description }
              : {}),
            steps: body.steps as ProgramStepInput[],
          }),
        ),
      }),
      201,
    );
  });

  routes.post("/programs/:programId/review", requireUser, async (context) => {
    const body = await objectBody(context);
    if (!body || typeof body.approved !== "boolean") {
      return context.json({ error: "Review decision is required." }, 400);
    }
    return continuityCall(context, async () => ({
      program: dateDto(
        await store.reviewProgram(
          context.var.actor,
          context.req.param("programId"),
          body.approved as boolean,
        ),
      ),
    }));
  });

  routes.post("/skills/:skillId/usage", requireUser, async (context) => {
    const body = (await objectBody(context)) ?? {};
    return continuityCall(
      context,
      async () => ({
        event: dateDto(
          await store.recordSkillUsage(context.var.actor, {
            skillId: context.req.param("skillId"),
            ...(typeof body.agentId === "string"
              ? { agentId: body.agentId }
              : {}),
            ...(typeof body.channelId === "string"
              ? { channelId: body.channelId }
              : {}),
            ...(typeof body.taskRunId === "string"
              ? { taskRunId: body.taskRunId }
              : {}),
            ...(typeof body.outcome === "string"
              ? { outcome: body.outcome }
              : {}),
          }),
        ),
      }),
      201,
    );
  });

  routes.patch("/skills/:skillId", requireUser, async (context) => {
    const body = await objectBody(context);
    if (!body)
      return context.json({ error: "Skill changes are required." }, 400);
    const lifecycleStatus =
      body.lifecycleStatus === "active" || body.lifecycleStatus === "archived"
        ? body.lifecycleStatus
        : undefined;
    const pinnedVersion =
      body.pinnedVersion === null || typeof body.pinnedVersion === "number"
        ? (body.pinnedVersion as number | null)
        : undefined;
    if (lifecycleStatus === undefined && pinnedVersion === undefined) {
      return context.json({ error: "Skill health change is invalid." }, 400);
    }
    return continuityCall(context, async () => ({
      skill: dateDto(
        await store.updateSkillHealth(
          context.var.actor,
          context.req.param("skillId"),
          {
            ...(lifecycleStatus ? { lifecycleStatus } : {}),
            ...(pinnedVersion !== undefined ? { pinnedVersion } : {}),
          },
        ),
      ),
    }));
  });

  routes.post("/skills/:skillId/rollback", requireUser, async (context) => {
    const body = await objectBody(context);
    if (!body || typeof body.version !== "number") {
      return context.json({ error: "Skill version is required." }, 400);
    }
    return continuityCall(context, async () => ({
      version: dateDto(
        await store.rollbackSkill(
          context.var.actor,
          context.req.param("skillId"),
          Math.trunc(body.version as number),
        ),
      ),
    }));
  });

  routes.post("/bundles", requireUser, async (context) => {
    const body = await objectBody(context);
    if (!body || typeof body.name !== "string" || !plainObject(body.manifest)) {
      return context.json(
        { error: "Bundle name and manifest are required." },
        400,
      );
    }
    return continuityCall(
      context,
      async () => ({
        bundle: dateDto(
          await store.createBundle(context.var.actor, {
            name: body.name as string,
            ...(typeof body.description === "string"
              ? { description: body.description }
              : {}),
            ...(typeof body.version === "number"
              ? { version: body.version }
              : {}),
            manifest: body.manifest as BotBundleManifest,
          }),
        ),
      }),
      201,
    );
  });

  routes.post("/bundles/:bundleId/archive", requireUser, async (context) =>
    continuityCall(context, async () => ({
      bundle: dateDto(
        await store.archiveBundle(
          context.var.actor,
          context.req.param("bundleId"),
        ),
      ),
    })),
  );

  return routes;
}

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

async function continuityCall(
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

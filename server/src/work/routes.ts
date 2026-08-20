import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../auth/guards";
import type { RunStore } from "../runs/store";
import {
  WorkConflictError,
  WorkNotFoundError,
  WorkValidationError,
} from "./access";
import {
  DELEGATION_STATUSES,
  type DelegationStatus,
  type DelegationStore,
} from "./delegations";
import {
  MEMORY_KINDS,
  MEMORY_SCOPES,
  type MemoryKind,
  type MemoryScope,
  type MemoryStore,
} from "./memory";
import type { NotificationStore } from "./notifications";
import type { ProjectStatus, ProjectStore } from "./projects";
import {
  ROUTINE_STATUSES,
  ROUTINE_TRIGGERS,
  type RoutineStatus,
  type RoutineInput,
  type RoutineStore,
  type RoutineTrigger,
} from "./routines";
import { parseRoutineSchedule } from "./schedule";
import { WORK_TEMPLATES } from "./templates";

export type WorkServices = {
  projects: ProjectStore;
  routines: RoutineStore;
  delegations: DelegationStore;
  memory: MemoryStore;
  notifications: NotificationStore;
  runs: RunStore;
};

export function createWorkRoutes(
  services: WorkServices,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.get("/overview", requireUser, async (context) => {
    const actor = context.var.actor;
    const [runs, routines, delegations, projects, notifications, memory] =
      await Promise.all([
        services.runs.listAll(actor, 100),
        services.routines.list(actor),
        services.delegations.list(actor),
        services.projects.list(actor),
        services.notifications.list(actor, false, 50),
        services.memory.list(actor),
      ]);
    return context.json({
      templates: WORK_TEMPLATES,
      runs: runs.map(dateDto),
      routines: routines.map(dateDto),
      delegations: delegations.map(dateDto),
      projects: projects.map(dateDto),
      notifications: notifications.map(dateDto),
      memory: memory.map(dateDto),
    });
  });

  routes.get("/projects", requireUser, async (context) =>
    context.json({
      projects: (await services.projects.list(context.var.actor)).map(dateDto),
    }),
  );
  routes.post("/projects", requireUser, async (context) => {
    const body = await objectBody(context);
    if (!body || typeof body.name !== "string") {
      return context.json({ error: "Project name is required." }, 400);
    }
    const agentIds = stringArray(body.agentIds);
    return workCall(
      context,
      async () => ({
        project: dateDto(
          await services.projects.create(context.var.actor, {
            name: body.name as string,
            ...(typeof body.description === "string"
              ? { description: body.description }
              : {}),
            ...(agentIds ? { agentIds } : {}),
          }),
        ),
      }),
      201,
    );
  });
  routes.patch("/projects/:projectId", requireUser, async (context) => {
    const body = await objectBody(context);
    if (!body)
      return context.json({ error: "Project changes are required." }, 400);
    if (
      body.status !== undefined &&
      body.status !== "active" &&
      body.status !== "archived"
    ) {
      return context.json({ error: "Project status is invalid." }, 400);
    }
    return workCall(context, async () => ({
      project: dateDto(
        await services.projects.update(
          context.var.actor,
          context.req.param("projectId"),
          {
            ...(typeof body.name === "string" ? { name: body.name } : {}),
            ...(typeof body.description === "string"
              ? { description: body.description }
              : {}),
            ...(body.status ? { status: body.status as ProjectStatus } : {}),
          },
        ),
      ),
    }));
  });
  routes.post("/projects/:projectId/agents", requireUser, async (context) => {
    const body = await objectBody(context);
    if (!body || typeof body.agentId !== "string") {
      return context.json({ error: "Coworker is required." }, 400);
    }
    return workCall(context, async () => ({
      project: dateDto(
        await services.projects.addAgent(
          context.var.actor,
          context.req.param("projectId"),
          body.agentId as string,
        ),
      ),
    }));
  });
  routes.delete(
    "/projects/:projectId/agents/:agentId",
    requireUser,
    async (context) =>
      workCall(context, async () => {
        await services.projects.removeAgent(
          context.var.actor,
          context.req.param("projectId"),
          context.req.param("agentId"),
        );
        return { ok: true };
      }),
  );
  routes.get("/projects/:projectId/artifacts", requireUser, async (context) =>
    workCall(context, async () => ({
      artifacts: (
        await services.projects.listArtifacts(
          context.var.actor,
          context.req.param("projectId"),
        )
      ).map(dateDto),
    })),
  );
  routes.post(
    "/projects/:projectId/artifacts",
    requireUser,
    async (context) => {
      const body = await objectBody(context);
      if (
        !body ||
        typeof body.title !== "string" ||
        typeof body.content !== "string"
      ) {
        return context.json(
          { error: "Artifact title and content are required." },
          400,
        );
      }
      return workCall(
        context,
        async () => ({
          artifact: dateDto(
            await services.projects.createArtifact(
              context.var.actor,
              context.req.param("projectId"),
              {
                title: body.title as string,
                content: body.content as string,
                ...(typeof body.kind === "string" ? { kind: body.kind } : {}),
                ...(typeof body.agentId === "string"
                  ? { agentId: body.agentId }
                  : {}),
                ...(plainObject(body.metadata)
                  ? { metadata: body.metadata }
                  : {}),
              },
            ),
          ),
        }),
        201,
      );
    },
  );

  routes.get("/routines", requireUser, async (context) =>
    context.json({
      routines: (await services.routines.list(context.var.actor)).map(dateDto),
    }),
  );
  routes.post("/routines", requireUser, async (context) => {
    const parsed = routineInput(await objectBody(context), false);
    if (!parsed.ok) return context.json({ error: parsed.error }, 400);
    return workCall(
      context,
      async () => {
        const created = await services.routines.create(
          context.var.actor,
          parsed.value as RoutineInput,
        );
        return {
          routine: dateDto(created.routine),
          ...(created.webhookToken
            ? { webhookToken: created.webhookToken }
            : {}),
        };
      },
      201,
    );
  });
  routes.patch("/routines/:routineId", requireUser, async (context) => {
    const parsed = routineInput(await objectBody(context), true);
    if (!parsed.ok) return context.json({ error: parsed.error }, 400);
    return workCall(context, async () => ({
      routine: dateDto(
        await services.routines.update(
          context.var.actor,
          context.req.param("routineId"),
          parsed.value,
        ),
      ),
    }));
  });
  routes.post("/routines/:routineId/run", requireUser, async (context) =>
    workCall(context, async () => ({
      dispatch: dateDto(
        await services.routines.runNow(
          context.var.actor,
          context.req.param("routineId"),
        ),
      ),
    })),
  );

  routes.get("/delegations", requireUser, async (context) =>
    context.json({
      delegations: (await services.delegations.list(context.var.actor)).map(
        dateDto,
      ),
    }),
  );
  routes.get("/delegations/:delegationId", requireUser, async (context) =>
    workCall(context, async () => ({
      delegation: dateDto(
        await services.delegations.get(
          context.var.actor,
          context.req.param("delegationId"),
        ),
      ),
    })),
  );
  routes.post("/delegations", requireUser, async (context) => {
    const body = await objectBody(context);
    if (
      !body ||
      typeof body.targetAgentId !== "string" ||
      typeof body.title !== "string" ||
      typeof body.instructions !== "string"
    ) {
      return context.json(
        { error: "Target coworker, title, and instructions are required." },
        400,
      );
    }
    const dueAt =
      typeof body.dueAt === "string" ? new Date(body.dueAt) : undefined;
    if (dueAt && Number.isNaN(dueAt.getTime())) {
      return context.json({ error: "Due date is invalid." }, 400);
    }
    return workCall(
      context,
      async () => ({
        delegation: dateDto(
          await services.delegations.create(context.var.actor, {
            targetAgentId: body.targetAgentId as string,
            title: body.title as string,
            instructions: body.instructions as string,
            ...(typeof body.sourceAgentId === "string"
              ? { sourceAgentId: body.sourceAgentId }
              : {}),
            ...(typeof body.sourceChannelId === "string"
              ? { sourceChannelId: body.sourceChannelId }
              : {}),
            ...(typeof body.projectId === "string"
              ? { projectId: body.projectId }
              : {}),
            ...(typeof body.expectedOutput === "string"
              ? { expectedOutput: body.expectedOutput }
              : {}),
            ...(plainObject(body.context) ? { context: body.context } : {}),
            ...(dueAt ? { dueAt } : {}),
          }),
        ),
      }),
      201,
    );
  });
  routes.patch("/delegations/:delegationId", requireUser, async (context) => {
    const body = await objectBody(context);
    if (
      !body ||
      !DELEGATION_STATUSES.includes(body.status as DelegationStatus)
    ) {
      return context.json({ error: "Delegation status is invalid." }, 400);
    }
    return workCall(context, async () => ({
      delegation: dateDto(
        await services.delegations.transition(
          context.var.actor,
          context.req.param("delegationId"),
          body.status as DelegationStatus,
          {
            ...(typeof body.result === "string" ? { result: body.result } : {}),
            ...(typeof body.error === "string" ? { error: body.error } : {}),
          },
        ),
      ),
    }));
  });
  routes.post(
    "/delegations/:delegationId/messages",
    requireUser,
    async (context) => {
      const body = await objectBody(context);
      if (!body || typeof body.body !== "string") {
        return context.json({ error: "Message is required." }, 400);
      }
      return workCall(
        context,
        async () => ({
          message: dateDto(
            await services.delegations.addMessage(
              context.var.actor,
              context.req.param("delegationId"),
              {
                body: body.body as string,
                ...(typeof body.agentId === "string"
                  ? { agentId: body.agentId }
                  : {}),
                ...(typeof body.kind === "string" ? { kind: body.kind } : {}),
              },
            ),
          ),
        }),
        201,
      );
    },
  );

  routes.get("/memory", requireUser, async (context) => {
    const scope = context.req.query("scope");
    if (scope && !MEMORY_SCOPES.includes(scope as MemoryScope)) {
      return context.json({ error: "Memory scope is invalid." }, 400);
    }
    return context.json({
      memory: (
        await services.memory.list(context.var.actor, {
          ...(scope ? { scope: scope as MemoryScope } : {}),
          ...(context.req.query("agentId")
            ? { agentId: context.req.query("agentId") }
            : {}),
          ...(context.req.query("projectId")
            ? { projectId: context.req.query("projectId") }
            : {}),
        })
      ).map(dateDto),
    });
  });
  routes.post("/memory", requireUser, async (context) => {
    const body = await objectBody(context);
    if (
      !body ||
      !MEMORY_SCOPES.includes(body.scope as MemoryScope) ||
      !MEMORY_KINDS.includes(body.kind as MemoryKind) ||
      typeof body.title !== "string" ||
      typeof body.content !== "string"
    ) {
      return context.json(
        { error: "Memory scope, kind, title, and content are required." },
        400,
      );
    }
    return workCall(
      context,
      async () => ({
        memory: dateDto(
          await services.memory.create(context.var.actor, {
            scope: body.scope as MemoryScope,
            kind: body.kind as MemoryKind,
            title: body.title as string,
            content: body.content as string,
            ...(typeof body.agentId === "string"
              ? { agentId: body.agentId }
              : {}),
            ...(typeof body.projectId === "string"
              ? { projectId: body.projectId }
              : {}),
            ...(typeof body.source === "string" ? { source: body.source } : {}),
            ...(typeof body.confidence === "number"
              ? { confidence: body.confidence }
              : {}),
            ...(typeof body.pinned === "boolean"
              ? { pinned: body.pinned }
              : {}),
          }),
        ),
      }),
      201,
    );
  });
  routes.patch("/memory/:memoryId", requireUser, async (context) => {
    const body = await objectBody(context);
    if (!body)
      return context.json({ error: "Memory changes are required." }, 400);
    if (
      body.kind !== undefined &&
      !MEMORY_KINDS.includes(body.kind as MemoryKind)
    ) {
      return context.json({ error: "Memory kind is invalid." }, 400);
    }
    return workCall(context, async () => ({
      memory: dateDto(
        await services.memory.update(
          context.var.actor,
          context.req.param("memoryId"),
          {
            ...(typeof body.title === "string" ? { title: body.title } : {}),
            ...(typeof body.content === "string"
              ? { content: body.content }
              : {}),
            ...(body.kind ? { kind: body.kind as MemoryKind } : {}),
            ...(typeof body.confidence === "number"
              ? { confidence: body.confidence }
              : {}),
            ...(typeof body.pinned === "boolean"
              ? { pinned: body.pinned }
              : {}),
          },
        ),
      ),
    }));
  });
  routes.delete("/memory/:memoryId", requireUser, async (context) =>
    workCall(context, async () => {
      await services.memory.remove(
        context.var.actor,
        context.req.param("memoryId"),
      );
      return { ok: true };
    }),
  );

  routes.get("/notifications", requireUser, async (context) =>
    context.json({
      notifications: (
        await services.notifications.list(
          context.var.actor,
          context.req.query("unread") === "true",
        )
      ).map(dateDto),
    }),
  );
  routes.post(
    "/notifications/:notificationId/read",
    requireUser,
    async (context) =>
      workCall(context, async () => ({
        notification: dateDto(
          await services.notifications.markRead(
            context.var.actor,
            context.req.param("notificationId"),
          ),
        ),
      })),
  );
  routes.post("/notifications/read-all", requireUser, async (context) => {
    await services.notifications.markAllRead(context.var.actor);
    return context.json({ ok: true });
  });

  return routes;
}

export function createRoutineWebhookRoutes(routines: RoutineStore) {
  const routes = new Hono();
  routes.post("/:routineId", async (context) => {
    const authorization = context.req.header("authorization") ?? "";
    const token = authorization.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length).trim()
      : "";
    if (!token)
      return context.json({ error: "Webhook token is required." }, 401);
    try {
      const dispatch = await routines.dispatchWebhook(
        context.req.param("routineId"),
        token,
      );
      return context.json({ accepted: Boolean(dispatch) }, 202);
    } catch (error) {
      if (error instanceof WorkNotFoundError) {
        // Same answer for a wrong id and a wrong token so the endpoint cannot be enumerated.
        return context.json({ error: "Webhook not found." }, 404);
      }
      if (error instanceof WorkConflictError) {
        return context.json({ error: error.message }, 409);
      }
      throw error;
    }
  });
  return routes;
}

function routineInput(
  body: Record<string, unknown> | null,
  partial: boolean,
): { ok: true; value: Partial<RoutineInput> } | { ok: false; error: string } {
  if (!body) return { ok: false, error: "Routine input is required." };
  const required = ["name", "instruction", "agentId", "channelId", "trigger"];
  if (!partial && required.some((field) => typeof body[field] !== "string")) {
    return {
      ok: false,
      error: "Name, instruction, coworker, channel, and trigger are required.",
    };
  }
  if (
    body.trigger !== undefined &&
    !ROUTINE_TRIGGERS.includes(body.trigger as RoutineTrigger)
  ) {
    return { ok: false, error: "Routine trigger is invalid." };
  }
  if (
    body.status !== undefined &&
    !ROUTINE_STATUSES.includes(body.status as RoutineStatus)
  ) {
    return { ok: false, error: "Routine status is invalid." };
  }
  if (body.schedule !== undefined) {
    const schedule = parseRoutineSchedule(body.schedule);
    if (!schedule.ok) return schedule;
    body.schedule = schedule.schedule;
  }
  return { ok: true, value: body as Partial<RoutineInput> };
}

async function objectBody(context: Context) {
  const value = await context.req.json().catch(() => null);
  return plainObject(value) ? value : null;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : null;
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

async function workCall(
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

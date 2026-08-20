import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { ApprovalService, ApprovalStatus } from "../approvals/store";
import {
  ApprovalAlreadyDecidedError,
  ApprovalNotFoundError,
  isApprovalStatus,
} from "../approvals/store";
import type { AppVariables } from "../auth/guards";
import {
  isTaskRunStatus,
  RunNotFoundError,
  RunTransitionError,
  type RunStore,
} from "./store";

export function createRunRoutes(
  store: RunStore,
  approvals: ApprovalService,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.post("/", requireUser, async (context) => {
    const body = (await context.req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (
      typeof body?.channelId !== "string" ||
      typeof body.agentId !== "string" ||
      !body.channelId.trim() ||
      !body.agentId.trim()
    ) {
      return context.json({ error: "Channel and coworker are required." }, 400);
    }
    try {
      const run = await store.create(context.var.actor, {
        channelId: body.channelId.trim(),
        agentId: body.agentId.trim(),
        ...(typeof body.title === "string" ? { title: body.title } : {}),
        ...(typeof body.parentRunId === "string"
          ? { parentRunId: body.parentRunId }
          : {}),
        ...(typeof body.maxAttempts === "number"
          ? { maxAttempts: body.maxAttempts }
          : {}),
        ...(typeof body.maxRuntimeMs === "number"
          ? { maxRuntimeMs: body.maxRuntimeMs }
          : {}),
      });
      return context.json({ run: runDto(run) }, 201);
    } catch (error) {
      return mapRunError(context, error);
    }
  });

  routes.get("/", requireUser, async (context) => {
    const channelId = context.req.query("channelId");
    const limit = Number(context.req.query("limit") ?? "20");
    try {
      const runs = channelId
        ? await store.list(
            context.var.actor,
            channelId,
            Number.isFinite(limit) ? limit : 20,
          )
        : await store.listAll(
            context.var.actor,
            Number.isFinite(limit) ? limit : 50,
          );
      return context.json({ runs: runs.map(runDto) });
    } catch (error) {
      return mapRunError(context, error);
    }
  });

  routes.get("/:runId", requireUser, async (context) => {
    const run = await store.get(context.var.actor, context.req.param("runId"));
    return run
      ? context.json({ run: runDto(run) })
      : context.json({ error: "Task run not found." }, 404);
  });

  routes.get("/:runId/events", requireUser, async (context) => {
    try {
      const events = await store.events(
        context.var.actor,
        context.req.param("runId"),
      );
      return context.json({
        events: events.map((event) => ({
          ...event,
          createdAt: event.createdAt.toISOString(),
        })),
      });
    } catch (error) {
      return mapRunError(context, error);
    }
  });

  routes.patch("/:runId", requireUser, async (context) => {
    const body = (await context.req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!isTaskRunStatus(body?.status)) {
      return context.json({ error: "A valid task status is required." }, 400);
    }
    try {
      const run = await store.transition(
        context.var.actor,
        context.req.param("runId"),
        body.status,
        typeof body.error === "string" ? body.error : undefined,
      );
      return context.json({ run: runDto(run) });
    } catch (error) {
      return mapRunError(context, error);
    }
  });

  routes.get("/:runId/approvals", requireUser, async (context) => {
    const status = context.req.query("status");
    if (status !== undefined && !isApprovalStatus(status)) {
      return context.json({ error: "That approval status is not valid." }, 400);
    }
    const requests = await approvals.list(context.var.actor, {
      runId: context.req.param("runId"),
      ...(status ? { status: status as ApprovalStatus } : {}),
    });
    return context.json({ approvals: requests.map(approvalDto) });
  });

  routes.get("/approvals/:approvalId", requireUser, async (context) => {
    const approval = await approvals.get(
      context.var.actor,
      context.req.param("approvalId"),
    );
    return approval
      ? context.json({ approval: approvalDto(approval) })
      : context.json({ error: "Approval request not found." }, 404);
  });

  routes.post(
    "/approvals/:approvalId/decision",
    requireUser,
    async (context) => {
      const body = (await context.req.json().catch(() => null)) as Record<
        string,
        unknown
      > | null;
      if (body?.decision !== "approved" && body?.decision !== "declined") {
        return context.json({ error: "Approve or decline this request." }, 400);
      }
      try {
        const approval = await approvals.decide(
          context.var.actor,
          context.req.param("approvalId"),
          body.decision,
          typeof body.note === "string" ? body.note : undefined,
        );
        return context.json({ approval: approvalDto(approval) });
      } catch (error) {
        if (error instanceof ApprovalNotFoundError) {
          return context.json({ error: error.message }, 404);
        }
        if (error instanceof ApprovalAlreadyDecidedError) {
          return context.json({ error: error.message }, 409);
        }
        throw error;
      }
    },
  );

  return routes;
}

function runDto(run: Awaited<ReturnType<RunStore["get"]>> & {}) {
  if (!run) throw new RunNotFoundError();
  return {
    ...run,
    startedAt: run.startedAt?.toISOString() ?? null,
    completedAt: run.completedAt?.toISOString() ?? null,
    lastHeartbeatAt: run.lastHeartbeatAt?.toISOString() ?? null,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
  };
}

function approvalDto(
  approval: Awaited<ReturnType<ApprovalService["get"]>> & {},
) {
  if (!approval) throw new ApprovalNotFoundError();
  return {
    ...approval,
    expiresAt: approval.expiresAt.toISOString(),
    decidedAt: approval.decidedAt?.toISOString() ?? null,
    consumedAt: approval.consumedAt?.toISOString() ?? null,
    createdAt: approval.createdAt.toISOString(),
    updatedAt: approval.updatedAt.toISOString(),
  };
}

function mapRunError(
  context: Context<{ Variables: AppVariables }>,
  error: unknown,
) {
  if (error instanceof RunNotFoundError) {
    return context.json({ error: error.message }, 404);
  }
  if (error instanceof RunTransitionError) {
    return context.json({ error: error.message }, 409);
  }
  throw error;
}

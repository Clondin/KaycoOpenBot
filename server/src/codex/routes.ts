import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../auth/guards";
import type { CodexProcessManager } from "./manager";
import {
  CODEX_EFFORT_LEVELS,
  type CodexPreferenceStore,
  isCodexEffort,
} from "./preferences";

export type CodexAccountService = Pick<
  CodexProcessManager,
  | "account"
  | "startDeviceLogin"
  | "cancelLogin"
  | "logout"
  | "rateLimits"
  | "usage"
  | "models"
>;

export function createCodexRoutes(
  manager: CodexAccountService,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  preferences?: CodexPreferenceStore,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.get("/account", requireUser, async (context) => {
    try {
      const snapshot = await manager.account(context.var.actor.id);
      return context.json({
        connected: snapshot.account?.type === "chatgpt",
        account: publicAccount(snapshot.account),
        requiresOpenaiAuth: snapshot.requiresOpenaiAuth,
      });
    } catch (error) {
      return unavailable(context, error);
    }
  });

  routes.post("/login/device", requireUser, async (context) => {
    try {
      const login = await manager.startDeviceLogin(context.var.actor.id);
      if (
        login.type !== "chatgptDeviceCode" ||
        !login.loginId ||
        !login.userCode ||
        !isHttpUrl(login.verificationUrl)
      ) {
        throw new Error("Codex returned an invalid device login response.");
      }
      return context.json({ login });
    } catch (error) {
      return unavailable(context, error);
    }
  });

  routes.post("/login/:loginId/cancel", requireUser, async (context) => {
    const loginId = context.req.param("loginId").trim();
    if (!loginId || loginId.length > 200) {
      return context.json({ error: "A valid login id is required." }, 400);
    }
    try {
      const result = await manager.cancelLogin(context.var.actor.id, loginId);
      return context.json(result);
    } catch (error) {
      return unavailable(context, error);
    }
  });

  routes.delete("/account", requireUser, async (context) => {
    try {
      await manager.logout(context.var.actor.id);
      return context.json({ connected: false });
    } catch (error) {
      return unavailable(context, error);
    }
  });

  routes.get("/limits", requireUser, async (context) => {
    try {
      await requireConnected(manager, context.var.actor.id);
      return context.json(await manager.rateLimits(context.var.actor.id));
    } catch (error) {
      return unavailable(context, error);
    }
  });

  routes.get("/usage", requireUser, async (context) => {
    try {
      await requireConnected(manager, context.var.actor.id);
      return context.json(await manager.usage(context.var.actor.id));
    } catch (error) {
      return unavailable(context, error);
    }
  });

  routes.get("/models", requireUser, async (context) => {
    try {
      await requireConnected(manager, context.var.actor.id);
      return context.json(await manager.models(context.var.actor.id));
    } catch (error) {
      return unavailable(context, error);
    }
  });

  routes.get("/preferences", requireUser, async (context) => {
    if (!preferences) {
      return context.json({ error: "Codex preferences are unavailable." }, 503);
    }
    return context.json({
      preferences: await preferences.get(context.var.actor.id),
      effortLevels: CODEX_EFFORT_LEVELS,
    });
  });

  routes.put("/preferences", requireUser, async (context) => {
    if (!preferences) {
      return context.json({ error: "Codex preferences are unavailable." }, 503);
    }
    const parsed = parsePreferences(await context.req.json().catch(() => null));
    if (!parsed.ok) return context.json({ error: parsed.error }, 400);

    try {
      await requireConnected(manager, context.var.actor.id);
      if (parsed.value.model) {
        const models = await manager.models(context.var.actor.id);
        if (!availableModelIds(models).has(parsed.value.model)) {
          return context.json(
            { error: "That model is not offered by Codex." },
            400,
          );
        }
      }
      return context.json({
        preferences: await preferences.set(context.var.actor.id, parsed.value),
      });
    } catch (error) {
      return unavailable(context, error);
    }
  });

  return routes;
}

function parsePreferences(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false as const, error: "Preferences must be a JSON object." };
  }
  const body = input as { model?: unknown; effort?: unknown };
  const model =
    body.model === null || body.model === ""
      ? null
      : typeof body.model === "string" && body.model.trim().length <= 120
        ? body.model.trim()
        : undefined;
  if (model === undefined) {
    return { ok: false as const, error: "Model must be a model id or null." };
  }
  const effort =
    body.effort === null || body.effort === ""
      ? null
      : isCodexEffort(body.effort)
        ? body.effort
        : undefined;
  if (effort === undefined) {
    return { ok: false as const, error: "Reasoning effort is not supported." };
  }
  return { ok: true as const, value: { model, effort } };
}

function availableModelIds(result: { data: unknown[] }) {
  const ids = new Set<string>();
  for (const item of result.data) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    for (const key of ["id", "model", "slug"] as const) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) ids.add(value.trim());
    }
  }
  return ids;
}

function publicAccount(
  account: Awaited<ReturnType<CodexAccountService["account"]>>["account"],
) {
  if (!account) return null;
  if (account.type === "chatgpt") {
    return {
      type: account.type,
      email: account.email,
      ...(account.planType ? { planType: account.planType } : {}),
    };
  }
  return { type: account.type };
}

async function requireConnected(manager: CodexAccountService, userId: string) {
  const account = await manager.account(userId);
  if (account.account?.type !== "chatgpt") {
    throw new CodexAccountRequiredError();
  }
}

class CodexAccountRequiredError extends Error {}

function unavailable(
  context: Context<{ Variables: AppVariables }>,
  error: unknown,
) {
  if (error instanceof CodexAccountRequiredError) {
    return context.json({ error: "Connect a ChatGPT account first." }, 409);
  }
  return context.json(
    {
      error:
        "The Codex account service is unavailable. Check the server's Codex configuration.",
    },
    503,
  );
}

function isHttpUrl(value: string) {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

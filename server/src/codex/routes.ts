import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../auth/guards";
import type { CodexProcessManager } from "./manager";

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

  return routes;
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

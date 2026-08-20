import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import {
  type CodexAccountService,
  createCodexRoutes,
} from "../src/codex/routes";
import type { CodexPreferenceStore } from "../src/codex/preferences";

const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", {
    id: "user-7",
    email: "person@example.com",
    role: "user",
  });
  await next();
};

function service(overrides: Partial<CodexAccountService> = {}) {
  return {
    account: async () => ({
      account: null,
      requiresOpenaiAuth: true,
    }),
    startDeviceLogin: async () => ({
      type: "chatgptDeviceCode" as const,
      loginId: "login-1",
      verificationUrl: "https://auth.openai.com/device",
      userCode: "ABCD-EFGH",
    }),
    cancelLogin: async () => ({ status: "canceled" }),
    logout: async () => undefined,
    rateLimits: async () => ({}),
    usage: async () => ({}),
    models: async () => ({ data: [] }),
    ...overrides,
  } satisfies CodexAccountService;
}

function preferenceStore(): CodexPreferenceStore & {
  saved: Array<{
    model: string | null;
    effort: "low" | "medium" | "high" | "xhigh" | "max" | null;
  }>;
} {
  const saved: Array<{
    model: string | null;
    effort: "low" | "medium" | "high" | "xhigh" | "max" | null;
  }> = [];
  return {
    saved,
    async get() {
      return saved.at(-1) ?? { model: null, effort: null };
    },
    async set(_userId, preferences) {
      saved.push(preferences);
      return preferences;
    },
  };
}

describe("Codex account routes", () => {
  test("reports connection state without exposing auth tokens", async () => {
    const routes = createCodexRoutes(
      service({
        account: async () => ({
          account: {
            type: "chatgpt",
            email: "person@example.com",
            planType: "plus",
            accessToken: "must-not-reach-the-browser",
          },
          requiresOpenaiAuth: true,
        }),
      }),
      requireUser,
    );
    const response = await routes.request("http://openbot.test/account");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      connected: true,
      account: {
        type: "chatgpt",
        email: "person@example.com",
        planType: "plus",
      },
      requiresOpenaiAuth: true,
    });
  });

  test("starts a device-code login", async () => {
    const routes = createCodexRoutes(service(), requireUser);
    const response = await routes.request("http://openbot.test/login/device", {
      method: "POST",
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      login: { loginId: "login-1", userCode: "ABCD-EFGH" },
    });
  });

  test("requires ChatGPT before reading allowance", async () => {
    const routes = createCodexRoutes(service(), requireUser);
    const response = await routes.request("http://openbot.test/limits");
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Connect a ChatGPT account first.",
    });
  });

  test("validates and saves an offered model and reasoning level", async () => {
    const preferences = preferenceStore();
    const routes = createCodexRoutes(
      service({
        account: async () => ({
          account: { type: "chatgpt" },
          requiresOpenaiAuth: false,
        }),
        models: async () => ({ data: [{ id: "gpt-5.6" }] }),
      }),
      requireUser,
      preferences,
    );

    const response = await routes.request("http://openbot.test/preferences", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6", effort: "high" }),
    });

    expect(response.status).toBe(200);
    expect(preferences.saved).toEqual([{ model: "gpt-5.6", effort: "high" }]);
  });

  test("rejects models Codex does not offer", async () => {
    const preferences = preferenceStore();
    const routes = createCodexRoutes(
      service({
        account: async () => ({
          account: { type: "chatgpt" },
          requiresOpenaiAuth: false,
        }),
        models: async () => ({ data: [{ id: "allowed" }] }),
      }),
      requireUser,
      preferences,
    );

    const response = await routes.request("http://openbot.test/preferences", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "not-allowed", effort: null }),
    });

    expect(response.status).toBe(400);
    expect(preferences.saved).toEqual([]);
  });
});

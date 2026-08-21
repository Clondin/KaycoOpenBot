import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import {
  createAutonomyRoutes,
  createExternalChannelIngressRoutes,
} from "../src/autonomy/routes";
import { WorkConflictError } from "../src/work/access";

function requireActor(
  role: "admin" | "user",
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    context.set("actor", {
      id: "user-1",
      email: "person@openbot.test",
      role,
    });
    await next();
  };
}

function services(overrides: Record<string, unknown> = {}) {
  return {
    channels: {
      list: async () => ({ connections: [], identities: [], messages: [] }),
      create: async () => {
        throw new Error("unexpected create");
      },
      ...((overrides.channels as Record<string, unknown>) ?? {}),
    },
    learning: {
      overview: async () => ({ proposals: [], suggestions: [] }),
    },
    routing: {
      list: async () => [],
      attempts: async () => [],
    },
    results: { list: async () => [] },
  } as never;
}

describe("autonomy routes", () => {
  const bridgeId = "6e23d07c-389a-4d03-a6b8-fccec38cb24b";

  test("keeps external-provider creation administrative", async () => {
    let called = false;
    const routes = createAutonomyRoutes(
      services({
        channels: {
          create: async () => {
            called = true;
          },
        },
      }),
      requireActor("user"),
    );
    const response = await routes.request("http://openbot.test/connections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "webhook",
        name: "Support",
        agentId: "agent-1",
        channelId: "channel-1",
      }),
    });
    expect(response.status).toBe(403);
    expect(called).toBe(false);
  });

  test("passes the exact provider body and headers to signature verification", async () => {
    const seen: Array<{
      connectionId: string;
      rawBody: string;
      secret: string | null;
    }> = [];
    const routes = createExternalChannelIngressRoutes({
      async ingestHttp(connectionId, input) {
        seen.push({
          connectionId,
          rawBody: input.rawBody,
          secret: input.headers.get("x-telegram-bot-api-secret-token"),
        });
        return { accepted: true, duplicate: false, runId: "run-1" };
      },
    } as never);
    const rawBody = '{"update_id":42,"message":{"text":"hello"}}';
    const response = await routes.request(`http://openbot.test/${bridgeId}`, {
      method: "POST",
      headers: { "x-telegram-bot-api-secret-token": "provider-secret" },
      body: rawBody,
    });
    expect(response.status).toBe(202);
    expect(seen).toEqual([
      {
        connectionId: bridgeId,
        rawBody,
        secret: "provider-secret",
      },
    ]);
  });

  test("rejects a valid provider event whose identity is not paired", async () => {
    const routes = createExternalChannelIngressRoutes({
      async ingestHttp() {
        throw new WorkConflictError("This external identity is not paired.");
      },
    } as never);
    const response = await routes.request(`http://openbot.test/${bridgeId}`, {
      method: "POST",
      body: "{}",
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "This external identity is not paired.",
    });
  });

  test("rejects malformed bridge IDs before querying storage", async () => {
    let called = false;
    const routes = createExternalChannelIngressRoutes({
      async ingestHttp() {
        called = true;
        return { accepted: true, duplicate: false, runId: "run-1" };
      },
    } as never);
    const response = await routes.request("http://openbot.test/not-a-uuid", {
      method: "POST",
      body: "{}",
    });
    expect(response.status).toBe(404);
    expect(called).toBe(false);
  });
});

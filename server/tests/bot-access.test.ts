import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { ApprovalRequest } from "../src/approvals/store";
import type { AppVariables } from "../src/auth/guards";
import { createComponentRoutes } from "../src/components/routes";
import { ApprovalRequiredError } from "../src/computer/gateway";
import { createComputerRoutes } from "../src/computer/routes";
import { PluginApprovalRequiredError } from "../src/plugins/store";
import { createPluginRoutes } from "../src/plugins/routes";

/**
 * Whether the person asking may act as the Bot they named.
 *
 * `requireUser` answers "is this a signed-in person", which is a different question and the only one
 * these surfaces used to ask. A Bot id travels in the URL for the computer and in the body for a tool
 * call, so without this a signed-in person acts as any Bot in the deployment, including a private one
 * belonging to somebody else: they reset its browser, drive its pages, and fire its granted MCP tools
 * against the deployment's own credential.
 *
 * The rule itself is not new. `canAccessAgent` has always said public, or owner, or administrator,
 * and the store's read path has always filtered on it. These are the callers that never asked.
 */

/** A signed-in person with the base role, which is the lowest privilege that gets past the guard. */
function signedIn(
  id: string,
  role: "user" | "admin" = "user",
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    context.set("actor", { id, email: `${id}@openbot.test`, role });
    await next();
  };
}

/**
 * Owner sees their own Bot, an administrator sees every Bot, nobody else sees it. Stands in for the
 * store's access filter, which decides the same three ways.
 */
const ownedBy =
  (owner: string) =>
  async (actor: { id: string; role: string }, botId: string) =>
    botId === "sales" && (actor.id === owner || actor.role === "admin");

function pendingApproval(
  overrides: Partial<ApprovalRequest> = {},
): ApprovalRequest {
  const now = new Date("2026-08-20T12:00:00.000Z");
  return {
    id: "approval-1",
    runId: "run-1",
    channelId: "channel-1",
    requestedForUserId: "owner",
    decidedByUserId: null,
    botId: "sales",
    toolName: "computer.navigate",
    policyRule: "tool.name == 'computer.navigate'",
    title: "Open a page",
    summary: "This navigation needs approval.",
    details: [{ label: "Address", value: "https://example.com" }],
    status: "pending",
    note: null,
    expiresAt: new Date("2026-08-20T12:05:00.000Z"),
    decidedAt: null,
    consumedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("the computer surface", () => {
  function app(actorId: string, role: "user" | "admin" = "user") {
    const reached: string[] = [];
    const gateway = {
      computers: async () => {
        reached.push("computers:list");
        return { isolation: "per-bot", computers: [] };
      },
      resetComputer: async (_c: string, botId: string) => {
        reached.push(`reset:${botId}`);
        return { reset: true, botId };
      },
      read: async (botId: string) => {
        reached.push(`read:${botId}`);
        return { text: "a page" };
      },
    } as never;
    const client = {
      forBot: () => ({
        screenshot: async () => {
          reached.push("screenshot");
          return { image: "" };
        },
      }),
      status: async (botId: string) => {
        reached.push(`status:${botId}`);
        return { botId, state: "ready" };
      },
    } as never;

    const routes = createComputerRoutes(
      client,
      gateway,
      { get: () => ({ mode: "enforce", deny: [], allow: [] }) } as never,
      signedIn(actorId, role),
      ownedBy("owner"),
    );
    return {
      reached,
      hono: new Hono().route("/api/computers", routes),
    };
  }

  test("lets the owner act on their own Bot", async () => {
    const { hono, reached } = app("owner");
    const response = await hono.request(
      "http://t/api/computers/sales/computers/reset",
      { method: "POST" },
    );

    expect(response.status).toBe(200);
    expect(reached).toEqual(["reset:sales"]);
  });

  test("refuses somebody else's Bot, and does not act first", async () => {
    const { hono, reached } = app("stranger");
    const response = await hono.request(
      "http://t/api/computers/sales/computers/reset",
      { method: "POST" },
    );

    expect(response.status).toBe(404);
    // The refusal has to happen before the gateway is called. A check that runs after the browser
    // has already been wiped is not a check.
    expect(reached).toEqual([]);
  });

  // Reading is not a lesser question here. A screenshot of somebody's Bot mid-task is the contents
  // of whatever page it is signed into.
  test.each([
    ["/api/computers/sales/read", "GET"],
    ["/api/computers/sales/screenshot", "GET"],
    ["/api/computers/sales/status", "GET"],
  ])("refuses %s for somebody else's Bot", async (path, method) => {
    const { hono, reached } = app("stranger");
    const response = await hono.request(`http://t${path}`, { method });

    expect(response.status).toBe(404);
    expect(reached).toEqual([]);
  });

  // An administrator already reaches every Bot everywhere else in the product. This must not become
  // the one surface where they cannot.
  test("still lets an administrator act on any Bot", async () => {
    const { hono, reached } = app("someone-else", "admin");
    const response = await hono.request(
      "http://t/api/computers/sales/computers/reset",
      { method: "POST" },
    );

    expect(response.status).toBe(200);
    expect(reached).toEqual(["reset:sales"]);
  });

  test("lets an administrator list all computers through the collection placeholder", async () => {
    const { hono, reached } = app("someone-else", "admin");
    const response = await hono.request(
      "http://t/api/computers/openbot-computer/computers",
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      isolation: "per-bot",
      computers: [],
    });
    expect(reached).toEqual(["computers:list"]);
  });

  test("keeps the deployment-wide computer list administrator-only", async () => {
    const { hono, reached } = app("owner");
    const response = await hono.request(
      "http://t/api/computers/openbot-computer/computers",
    );

    expect(response.status).toBe(403);
    expect(reached).toEqual([]);
  });

  test("says nothing about whether that Bot exists", async () => {
    const { hono } = app("stranger");
    const missing = await hono.request(
      "http://t/api/computers/no-such-bot/read",
    );
    const private_ = await hono.request("http://t/api/computers/sales/read");

    // Same answer either way, so the surface is not a way to enumerate other people's Bots.
    expect(private_.status).toBe(missing.status);
    expect(await private_.text()).toBe(await missing.text());
  });

  test("keeps approval context after checking Bot ownership", async () => {
    const actors: unknown[] = [];
    const routes = createComputerRoutes(
      {} as never,
      {
        navigate: async (
          _computerId: string,
          _botId: string,
          actor: unknown,
        ) => {
          actors.push(actor);
          throw new ApprovalRequiredError(pendingApproval());
        },
      } as never,
      { get: () => ({ mode: "enforce", deny: [], allow: [] }) } as never,
      signedIn("owner"),
      ownedBy("owner"),
    );
    const hono = new Hono().route("/api/computers", routes);

    const response = await hono.request(
      "http://t/api/computers/sales/navigate",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-openbot-run-id": "run-1",
          "x-openbot-channel-id": "channel-1",
          "x-openbot-approval-id": "approval-1",
        },
        body: JSON.stringify({ url: "https://example.com" }),
      },
    );

    expect(response.status).toBe(428);
    expect(await response.json()).toMatchObject({
      approvalRequired: true,
      approval: { id: "approval-1", botId: "sales" },
    });
    expect(actors).toEqual([
      {
        id: "owner",
        role: "user",
        userId: "owner",
        runId: "run-1",
        channelId: "channel-1",
        approvalId: "approval-1",
      },
    ]);
  });
});

describe("the computer surface, unauthenticated", () => {
  // The access middleware carries the session guard for everything under a Bot id, so the guard has
  // to still refuse a caller with no session at all, and refuse it before anything is asked about a
  // Bot.
  test("refuses before it asks whose Bot it is", async () => {
    const asked: string[] = [];
    const reached: string[] = [];
    const routes = createComputerRoutes(
      {} as never,
      {
        read: async (botId: string) => {
          reached.push(botId);
          return { text: "" };
        },
      } as never,
      { get: () => ({ mode: "enforce", deny: [], allow: [] }) } as never,
      async (context) =>
        context.json({ error: "Authentication required." }, 401),
      async (_actor, botId) => {
        asked.push(botId);
        return true;
      },
    );
    const hono = new Hono().route("/api/computers", routes);

    const response = await hono.request("http://t/api/computers/sales/read");

    expect(response.status).toBe(401);
    expect(asked).toEqual([]);
    expect(reached).toEqual([]);
  });
});

describe("calling a tool as a Bot", () => {
  function app(actorId: string) {
    const called: string[] = [];
    const store = {
      callTool: async (input: { ref: string; botId: string }) => {
        called.push(`${input.ref}@${input.botId}`);
        return { ok: true };
      },
      listForAgent: async (agentId: string) => {
        called.push(`list:${agentId}`);
        return { mcp: [], skills: [] };
      },
      listServers: async () => [],
      listSkills: async () => [],
    } as never;

    return {
      called,
      hono: new Hono().route(
        "/api/plugins",
        createPluginRoutes(store, signedIn(actorId), ownedBy("owner")),
      ),
    };
  }

  test("lets the owner call a tool as their own Bot", async () => {
    const { hono, called } = app("owner");
    const response = await hono.request("http://t/api/plugins/call", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref: "mcp__slack__post", agentId: "sales" }),
    });

    expect(response.status).toBe(200);
    expect(called).toEqual(["mcp__slack__post@sales"]);
  });

  // What a Bot holds is a fact about that Bot, the same as its components. Left open, this says which
  // tools somebody else's private coworker has been granted.
  test("refuses to list what somebody else's Bot holds", async () => {
    const { hono, called } = app("stranger");
    const response = await hono.request("http://t/api/plugins/for/sales");

    expect(response.status).toBe(404);
    expect(called).toEqual([]);
  });

  test("lets the owner list what their own Bot holds", async () => {
    const { hono } = app("owner");
    const response = await hono.request("http://t/api/plugins/for/sales");

    expect(response.status).toBe(200);
  });

  test("refuses a tool call as somebody else's Bot, and does not call it", async () => {
    const { hono, called } = app("stranger");
    const response = await hono.request("http://t/api/plugins/call", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref: "mcp__slack__post", agentId: "sales" }),
    });

    expect(response.status).toBe(404);
    // The grant belongs to the Bot, so the vendor call would have gone out on the deployment's
    // credential. Nothing may reach the vendor before the caller is checked.
    expect(called).toEqual([]);
  });

  test("keeps approval context after checking Bot ownership", async () => {
    const inputs: unknown[] = [];
    const store = {
      callTool: async (input: unknown) => {
        inputs.push(input);
        throw new PluginApprovalRequiredError(
          pendingApproval({ toolName: "mcp.slack.post" }),
        );
      },
      listServers: async () => [],
      listSkills: async () => [],
    } as never;
    const hono = new Hono().route(
      "/api/plugins",
      createPluginRoutes(store, signedIn("owner"), ownedBy("owner")),
    );

    const response = await hono.request("http://t/api/plugins/call", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-openbot-run-id": "run-1",
        "x-openbot-channel-id": "channel-1",
        "x-openbot-approval-id": "approval-1",
      },
      body: JSON.stringify({
        ref: "mcp__slack__post",
        agentId: "sales",
        args: { text: "hello" },
      }),
    });

    expect(response.status).toBe(428);
    expect(await response.json()).toMatchObject({
      approvalRequired: true,
      approval: { id: "approval-1", botId: "sales" },
    });
    expect(inputs).toEqual([
      {
        ref: "mcp__slack__post",
        args: { text: "hello" },
        botId: "sales",
        actorId: "owner",
        actorRole: "user",
        runId: "run-1",
        channelId: "channel-1",
        approvalId: "approval-1",
      },
    ]);
  });
});

describe("components, which a Bot answers with", () => {
  function app(actorId: string) {
    const touched: string[] = [];
    const store = {
      listForAgent: async (agentId: string) => {
        touched.push(`list:${agentId}`);
        return [{ name: "chart" }];
      },
      decide: async (name: string, agentId: string) => {
        touched.push(`decide:${name}:${agentId}`);
        return { allowed: true };
      },
      mayCall: async () => true,
      callFunction: async () => {
        touched.push("callFunction");
        return { rows: [] };
      },
    } as never;

    return {
      touched,
      hono: new Hono().route(
        "/api/components",
        createComponentRoutes(
          store,
          signedIn(actorId),
          undefined,
          ownedBy("owner"),
        ),
      ),
    };
  }

  test("lets the owner ask about their own Bot", async () => {
    const { hono, touched } = app("owner");
    const response = await hono.request(
      "http://t/api/components/for-agent/sales",
    );

    expect(response.status).toBe(200);
    expect(touched).toEqual(["list:sales"]);
  });

  // What a Bot may draw is a fact about that Bot. Listing it for a coworker somebody else owns says
  // which components they have been granted, which is the same leak the roster refuses.
  test("refuses to list somebody else's Bot components", async () => {
    const { hono, touched } = app("stranger");
    const response = await hono.request(
      "http://t/api/components/for-agent/sales",
    );

    expect(response.status).toBe(404);
    expect(touched).toEqual([]);
  });

  test("refuses a decision asked as somebody else's Bot", async () => {
    const { hono, touched } = app("stranger");
    const response = await hono.request(
      "http://t/api/components/chart/decision",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId: "sales" }),
      },
    );

    expect(response.status).toBe(404);
    expect(touched).toEqual([]);
  });

  // The one that runs something. A grant belongs to the Bot, so without this the caller borrows it.
  test("refuses a data function called as somebody else's Bot", async () => {
    const { hono, touched } = app("stranger");
    const response = await hono.request("http://t/api/components/chart/call", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: "sales", function: "rows", args: {} }),
    });

    expect(response.status).toBe(404);
    expect(touched).toEqual([]);
  });
});

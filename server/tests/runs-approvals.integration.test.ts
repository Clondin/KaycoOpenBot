import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { AgentActor } from "../src/agents/profile-types";
import type { AuditEventInput, AuditStore } from "../src/audit";
import {
  ApprovalContextError,
  createApprovalService,
} from "../src/approvals/store";
import { createDatabase } from "../src/db/client";
import {
  agents,
  channelAgents,
  channelMemberships,
  channels,
  intelligenceChannelMappings,
  users,
} from "../src/db/schema";
import { createRunStore, RunTransitionError } from "../src/runs/store";
import { TEST_POOL } from "./support/database";

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);
const auditRows: AuditEventInput[] = [];
const auditStore: AuditStore = {
  insert: async (event) => void auditRows.push(event),
};
const runStore = createRunStore(database, auditStore);
const approvals = createApprovalService(database, auditStore, runStore);

const prefix = `runs-${randomUUID()}`;
const actor: AgentActor = { id: `${prefix}-user`, role: "user" };
const agentId = `${prefix}-agent`;
const channelId = `${prefix}-channel`;

beforeEach(async () => {
  auditRows.length = 0;
  await database.insert(users).values({
    id: actor.id,
    email: `${actor.id}@example.test`,
    name: "Run Test User",
  });
  await database.insert(agents).values({
    id: agentId,
    name: "Run Test Agent",
    type: "built_in",
    configuration: {},
  });
  await database.insert(channels).values({
    id: channelId,
    name: "Run Test Channel",
    description: "Exercises durable task runs.",
  });
  await database.insert(channelMemberships).values({
    channelId,
    userId: actor.id,
  });
  await database.insert(channelAgents).values({ channelId, agentId });
  await database.insert(intelligenceChannelMappings).values({
    channelId,
    userId: actor.id,
    threadId: `${prefix}-thread`,
  });
});

afterEach(async () => {
  await database.delete(channels).where(eq(channels.id, channelId));
  await database.delete(agents).where(eq(agents.id, agentId));
  await database.delete(users).where(eq(users.id, actor.id));
});

afterAll(async () => {
  await database.$client.close();
});

describe("durable task runs", () => {
  test("records an ordered lifecycle and rejects a transition out of a terminal state", async () => {
    const run = await runStore.create(actor, {
      channelId,
      agentId,
      title: `  Monthly\nclose ${"x".repeat(200)}  `,
    });
    expect(run.status).toBe("queued");
    expect(Array.from(run.title).length).toBeLessThanOrEqual(120);
    expect(run.title).not.toContain("\n");

    await runStore.transition(actor, run.id, "running");
    await runStore.transitionSystem(run.id, "waiting_for_approval");
    await runStore.transitionSystem(run.id, "running");
    const completed = await runStore.transition(actor, run.id, "succeeded");

    expect(completed.completedAt).toBeInstanceOf(Date);
    expect(
      (await runStore.events(actor, run.id)).map((event) => event.type),
    ).toEqual(["created", "status", "status", "status", "status"]);
    await expect(
      runStore.transition(actor, run.id, "running"),
    ).rejects.toBeInstanceOf(RunTransitionError);
  });

  test("links retries without reopening the failed attempt", async () => {
    const failed = await runStore.create(actor, { channelId, agentId });
    await runStore.transition(
      actor,
      failed.id,
      "failed",
      "provider unavailable",
    );
    const retry = await runStore.create(actor, {
      channelId,
      agentId,
      parentRunId: failed.id,
      title: "Retry",
    });

    expect(retry.parentRunId).toBe(failed.id);
    expect((await runStore.get(actor, failed.id))?.status).toBe("failed");
  });
});

describe("exact, resumable approvals", () => {
  test("pauses a run, consumes one exact approval once, and resumes it", async () => {
    const run = await runStore.create(actor, { channelId, agentId });
    await runStore.transition(actor, run.id, "running");
    const requirement = {
      actor: {
        ...actor,
        runId: run.id,
        channelId,
      },
      botId: agentId,
      toolName: "computer_click",
      policyRule: 'contains(element.name, "submit")',
      context: {
        tool: { name: "computer_click" },
        bot: { id: agentId },
        actor: { id: actor.id },
        page: {
          url: "https://example.test/expenses",
          host: "example.test",
        },
        element: { ref: "e9", role: "button", name: "Submit expense" },
      },
    } as const;

    const pending = await approvals.authorize(requirement);
    expect(pending.authorized).toBe(false);
    if (pending.authorized) throw new Error("Expected a pending approval.");
    expect((await runStore.get(actor, run.id))?.status).toBe(
      "waiting_for_approval",
    );

    await approvals.decide(actor, pending.request.id, "approved", "Looks good");
    expect((await runStore.get(actor, run.id))?.status).toBe(
      "waiting_for_approval",
    );

    const authorized = await approvals.authorize({
      ...requirement,
      actor: { ...requirement.actor, approvalId: pending.request.id },
    });
    expect(authorized).toEqual({
      authorized: true,
      approvalId: pending.request.id,
    });
    expect((await runStore.get(actor, run.id))?.status).toBe("running");

    const reused = await approvals.authorize({
      ...requirement,
      actor: { ...requirement.actor, approvalId: pending.request.id },
    });
    expect(reused.authorized).toBe(false);
    if (!reused.authorized)
      expect(reused.request.id).not.toBe(pending.request.id);
  });

  test("rejects a task id that does not belong to the requester and Bot", async () => {
    const run = await runStore.create(actor, { channelId, agentId });
    await expect(
      approvals.authorize({
        actor: { ...actor, runId: run.id, channelId: "not-this-channel" },
        botId: agentId,
        toolName: "computer_click",
        policyRule: "true",
        context: {
          tool: { name: "computer_click" },
          bot: { id: agentId },
          actor: { id: actor.id },
          page: { url: "https://example.test", host: "example.test" },
        },
      }),
    ).rejects.toBeInstanceOf(ApprovalContextError);
  });
});

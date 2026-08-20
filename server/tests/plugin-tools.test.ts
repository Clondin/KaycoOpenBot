import { describe, expect, test } from "bun:test";
import type { ApprovalRequest } from "../src/approvals/store";
import {
  PluginApprovalRequiredError,
  PluginRefusedError,
} from "../src/plugins/store";
import { callToolWithApproval } from "../src/plugins/tools";

function approval(status: ApprovalRequest["status"]): ApprovalRequest {
  const now = new Date("2026-08-20T12:00:00.000Z");
  return {
    id: "approval-1",
    runId: "task-1",
    channelId: "channel-1",
    requestedForUserId: "owner",
    decidedByUserId: status === "approved" ? "owner" : null,
    botId: "sales",
    toolName: "mcp__slack__post",
    policyRule: "mcp.effect == 'write'",
    title: "Post to Slack",
    summary: "Post a message to Slack.",
    details: [{ label: "Tool", value: "post" }],
    status,
    note: null,
    expiresAt: new Date("2026-08-20T12:10:00.000Z"),
    decidedAt: status === "approved" ? now : null,
    consumedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

describe("server-side tool approvals", () => {
  test("waits for the exact decision and retries with the approved request", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const actors: unknown[] = [];
    const store = {
      callTool: async (input: Record<string, unknown>) => {
        calls.push(input);
        if (calls.length === 1) {
          throw new PluginApprovalRequiredError(approval("pending"));
        }
        return { text: "Posted.", isError: false };
      },
    } as never;
    const approvals = {
      get: async (actor: unknown) => {
        actors.push(actor);
        return approval("approved");
      },
    } as never;

    const result = await callToolWithApproval({
      store,
      approvals,
      input: {
        ref: "slack/post",
        args: { text: "hello" },
        botId: "sales",
        actorId: "owner",
        actorRole: "user",
        runId: "task-1",
        channelId: "channel-1",
      },
      pollMs: 0,
      waitMs: 100,
    });

    expect(result).toEqual({ text: "Posted.", isError: false });
    expect(actors).toEqual([{ id: "owner", role: "user" }]);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({
      runId: "task-1",
      channelId: "channel-1",
      approvalId: "approval-1",
    });
  });

  test("fails closed instead of waiting for an invisible unscoped approval", async () => {
    const store = {
      callTool: async () => {
        throw new PluginApprovalRequiredError(approval("pending"));
      },
    } as never;

    await expect(
      callToolWithApproval({
        store,
        approvals: { get: async () => approval("approved") } as never,
        input: {
          ref: "slack/post",
          args: {},
          botId: "sales",
          actorId: "owner",
        },
      }),
    ).rejects.toBeInstanceOf(PluginRefusedError);
  });
});

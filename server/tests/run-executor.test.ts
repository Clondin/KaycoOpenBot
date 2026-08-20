import { describe, expect, test } from "bun:test";
import {
  executeTaskWithAgent,
  startAutomatedTaskExecutor,
} from "../src/runs/executor";
import type {
  AutomatedSettlement,
  AutomatedTask,
  RunStore,
} from "../src/runs/store";

const task: AutomatedTask = {
  run: {
    id: "run-1",
    channelId: "channel-1",
    agentId: "agent-1",
    threadId: "thread-1",
    actorUserId: "user-1",
    title: "Daily brief",
    status: "running",
    parentRunId: null,
    attempt: 1,
    maxAttempts: 3,
    maxRuntimeMs: 900_000,
    leaseOwner: "worker-1",
    leaseExpiresAt: new Date("2026-08-20T12:01:00Z"),
    nextAttemptAt: null,
    output: null,
    error: null,
    startedAt: new Date("2026-08-20T12:00:00Z"),
    completedAt: null,
    lastHeartbeatAt: new Date("2026-08-20T12:00:00Z"),
    createdAt: new Date("2026-08-20T12:00:00Z"),
    updatedAt: new Date("2026-08-20T12:00:00Z"),
  },
  source: { kind: "routine", id: "routine-1", instruction: "Brief me." },
};

describe("automated task executor", () => {
  test("claims, executes, settles, and reports a successful source", async () => {
    const events: string[] = [];
    let available: AutomatedTask | null = task;
    const settled: AutomatedSettlement = {
      run: { ...task.run, status: "succeeded" },
      retryScheduled: false,
    };
    const stop = startAutomatedTaskExecutor({
      runs: queue({
        claim: async () => {
          const claimed = available;
          available = null;
          return claimed;
        },
        settle: async () => settled,
      }),
      execute: async () => {
        events.push("execute");
        return { output: "Done." };
      },
      onStarted: async () => {
        events.push("started");
      },
      onSucceeded: async (_task, result) => {
        events.push(`succeeded:${result.output}`);
      },
      workerId: "worker-1",
      intervalMs: 60_000,
    });

    await eventually(() => events.includes("succeeded:Done."));
    await stop();
    expect(events).toEqual(["started", "execute", "succeeded:Done."]);
  });

  test("does not fail a source while a retry is scheduled", async () => {
    let available: AutomatedTask | null = task;
    let failed = false;
    const stop = startAutomatedTaskExecutor({
      runs: queue({
        claim: async () => {
          const claimed = available;
          available = null;
          return claimed;
        },
        settle: async () => ({
          run: { ...task.run, status: "queued", error: "Temporary" },
          retryScheduled: true,
        }),
      }),
      execute: async () => {
        throw new Error("Temporary");
      },
      onFailed: async () => {
        failed = true;
      },
      workerId: "worker-1",
      intervalMs: 60_000,
    });

    await eventually(() => available === null);
    await stop();
    expect(failed).toBe(false);
  });

  test("passes durable thread and task identity into an AG-UI run", async () => {
    const seen: Record<string, unknown> = {};
    const agent = {
      threadId: "",
      pendingInterrupts: [],
      setMessages(messages: unknown[]) {
        seen.messages = messages;
      },
      async runAgent(parameters: unknown) {
        seen.parameters = parameters;
        return {
          result: undefined,
          newMessages: [
            { id: "answer", role: "assistant", content: "Finished." },
          ],
        };
      },
    };
    const result = await executeTaskWithAgent(task, async () => agent as never);

    expect(agent.threadId).toBe("thread-1");
    expect(seen.messages).toEqual([
      {
        id: "automated:run-1:1",
        role: "user",
        content: "Brief me.",
      },
    ]);
    expect(seen.parameters).toMatchObject({
      runId: "run-1",
      forwardedProps: {
        openbotTaskRunId: "run-1",
        openbotChannelId: "channel-1",
        openbotExecution: "background",
      },
    });
    expect(result.output).toBe("Finished.");
  });
});

function queue(options: {
  claim: () => Promise<AutomatedTask | null>;
  settle: () => Promise<AutomatedSettlement | null>;
}): Pick<
  RunStore,
  | "claimAutomated"
  | "heartbeatAutomated"
  | "settleAutomated"
  | "recoverExpiredAutomated"
> {
  return {
    claimAutomated: options.claim,
    heartbeatAutomated: async () => true,
    settleAutomated: options.settle,
    recoverExpiredAutomated: async () => [],
  };
}

async function eventually(condition: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!condition() && Date.now() < deadline) {
    await Bun.sleep(5);
  }
  expect(condition()).toBe(true);
}

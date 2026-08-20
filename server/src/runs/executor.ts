import type { AbstractAgent, Message } from "@ag-ui/client";
import type { AutomatedSettlement, AutomatedTask, RunStore } from "./store";

export type AutomatedTaskResult = { output: string };

export type AutomatedTaskExecutorOptions = {
  runs: Pick<
    RunStore,
    | "claimAutomated"
    | "heartbeatAutomated"
    | "settleAutomated"
    | "recoverExpiredAutomated"
  >;
  execute: (
    task: AutomatedTask,
    signal: AbortSignal,
  ) => Promise<AutomatedTaskResult>;
  onStarted?: (task: AutomatedTask) => Promise<void>;
  onSucceeded?: (
    task: AutomatedTask,
    result: AutomatedTaskResult,
  ) => Promise<void>;
  onFailed?: (task: AutomatedTask, error: string) => Promise<void>;
  workerId?: string;
  concurrency?: number;
  intervalMs?: number;
  heartbeatMs?: number;
  leaseMs?: number;
  baseRetryMs?: number;
};

/**
 * Starts the server-owned routine/delegation execution loop.
 *
 * The database lease is the authority. An in-memory promise only limits concurrency in this
 * process; another instance can safely claim different rows, and an expired owner cannot complete
 * a run after a replacement has recovered it.
 */
export function startAutomatedTaskExecutor(
  options: AutomatedTaskExecutorOptions,
) {
  const workerId =
    options.workerId ?? `openbot:${process.pid}:${crypto.randomUUID()}`;
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 2, 20));
  const intervalMs = Math.max(1_000, options.intervalMs ?? 5_000);
  const leaseMs = Math.max(10_000, options.leaseMs ?? 90_000);
  const heartbeatMs = Math.max(
    1_000,
    Math.min(options.heartbeatMs ?? 20_000, Math.floor(leaseMs / 2)),
  );
  const baseRetryMs = Math.max(1_000, options.baseRetryMs ?? 15_000);
  const active = new Map<
    string,
    { controller: AbortController; promise: Promise<void> }
  >();
  let stopped = false;
  let ticking = false;

  const sourceHook = async (
    name: "onStarted" | "onSucceeded" | "onFailed",
    task: AutomatedTask,
    value?: AutomatedTaskResult | string,
  ) => {
    try {
      if (name === "onStarted") await options.onStarted?.(task);
      if (name === "onSucceeded") {
        await options.onSucceeded?.(task, value as AutomatedTaskResult);
      }
      if (name === "onFailed") {
        await options.onFailed?.(task, value as string);
      }
    } catch (error) {
      console.error(
        JSON.stringify({
          type: "task-source-hook-error",
          hook: name,
          runId: task.run.id,
          source: task.source.kind,
          message: errorMessage(error),
        }),
      );
      // A source that was cancelled or otherwise cannot enter progress must never execute anyway.
      if (name === "onStarted") throw error;
    }
  };

  const executeClaim = (task: AutomatedTask) => {
    const controller = new AbortController();
    const runtimeBudget = setTimeout(
      () => {
        controller.abort(
          new Error(
            `The task exceeded its ${Math.ceil(task.run.maxRuntimeMs / 60_000)} minute runtime budget.`,
          ),
        );
      },
      Math.max(10_000, task.run.maxRuntimeMs),
    );
    runtimeBudget.unref?.();
    let heartbeatBusy = false;
    const heartbeat = setInterval(() => {
      if (heartbeatBusy || controller.signal.aborted) return;
      heartbeatBusy = true;
      void options.runs
        .heartbeatAutomated(task.run.id, workerId, new Date(), leaseMs)
        .then((owned) => {
          if (!owned) {
            controller.abort(
              new Error("The task lease was cancelled or transferred."),
            );
          }
        })
        .catch((error) => {
          console.error(
            JSON.stringify({
              type: "task-heartbeat-error",
              runId: task.run.id,
              message: errorMessage(error),
            }),
          );
        })
        .finally(() => {
          heartbeatBusy = false;
        });
    }, heartbeatMs);
    heartbeat.unref?.();

    const promise = (async () => {
      try {
        await sourceHook("onStarted", task);
        const result = await options.execute(task, controller.signal);
        if (controller.signal.aborted) throw controller.signal.reason;
        const settled = await options.runs.settleAutomated(
          task.run.id,
          workerId,
          { ok: true, output: result.output },
          new Date(),
          baseRetryMs,
        );
        if (settled) await sourceHook("onSucceeded", task, result);
      } catch (error) {
        const message = errorMessage(error);
        const settled = await options.runs
          .settleAutomated(
            task.run.id,
            workerId,
            { ok: false, error: message },
            new Date(),
            baseRetryMs,
          )
          .catch((settleError) => {
            console.error(
              JSON.stringify({
                type: "task-settlement-error",
                runId: task.run.id,
                message: errorMessage(settleError),
              }),
            );
            return null;
          });
        await finishFailure(settled, task, message, sourceHook);
      } finally {
        clearInterval(heartbeat);
        clearTimeout(runtimeBudget);
      }
    })().finally(() => {
      active.delete(task.run.id);
      if (!stopped) queueMicrotask(() => void tick());
    });

    active.set(task.run.id, { controller, promise });
  };

  const tick = async () => {
    if (stopped || ticking) return;
    ticking = true;
    try {
      const recovered = await options.runs.recoverExpiredAutomated(
        new Date(),
        baseRetryMs,
      );
      for (const item of recovered) {
        if (!item.retryScheduled) {
          await sourceHook(
            "onFailed",
            item.task,
            item.task.run.error ?? "The task executor stopped responding.",
          );
        }
      }

      while (!stopped && active.size < concurrency) {
        const task = await options.runs.claimAutomated(
          workerId,
          new Date(),
          leaseMs,
        );
        if (!task) break;
        executeClaim(task);
      }
    } catch (error) {
      console.error(
        JSON.stringify({
          type: "task-executor-error",
          workerId,
          message: errorMessage(error),
        }),
      );
    } finally {
      ticking = false;
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  void tick();

  return async () => {
    stopped = true;
    clearInterval(timer);
    for (const { controller } of active.values()) {
      controller.abort(new Error("The task executor is shutting down."));
    }
    await Promise.allSettled(
      [...active.values()].map(({ promise }) => promise),
    );
  };
}

async function finishFailure(
  settled: AutomatedSettlement | null,
  task: AutomatedTask,
  message: string,
  hook: (
    name: "onStarted" | "onSucceeded" | "onFailed",
    task: AutomatedTask,
    value?: AutomatedTaskResult | string,
  ) => Promise<void>,
) {
  if (!settled || settled.retryScheduled) return;
  await hook("onFailed", task, message);
}

/** Runs one claimed task through the same AG-UI agent adapters used by interactive chat. */
export async function executeTaskWithAgent(
  task: AutomatedTask,
  resolveAgent: (task: AutomatedTask) => Promise<AbstractAgent | null>,
  signal?: AbortSignal,
) {
  const agent = await resolveAgent(task);
  if (!agent) throw new Error("The assigned coworker is no longer available.");
  agent.threadId = task.run.threadId;
  agent.setMessages([
    {
      id: `automated:${task.run.id}:${task.run.attempt}`,
      role: "user",
      content: task.source.instruction,
    },
  ]);
  const abort = () => agent.abortRun();
  signal?.addEventListener("abort", abort, { once: true });
  let result: Awaited<ReturnType<AbstractAgent["runAgent"]>>;
  try {
    if (signal?.aborted) throw signal.reason;
    result = await agent.runAgent({
      runId: task.run.id,
      forwardedProps: {
        openbotTaskRunId: task.run.id,
        openbotChannelId: task.run.channelId,
        openbotExecution: "background",
      },
    });
  } finally {
    signal?.removeEventListener("abort", abort);
  }
  if (agent.pendingInterrupts.length > 0) {
    throw new Error(
      "The coworker paused for input, but this unattended run has no resume response yet.",
    );
  }
  return {
    output:
      result.newMessages
        .filter((message) => message.role === "assistant")
        .map(messageText)
        .filter(Boolean)
        .join("\n\n")
        .slice(0, 50_000) || "Task completed without a text response.",
  };
}

function messageText(message: Message) {
  if (typeof message.content === "string") return message.content.trim();
  if (!Array.isArray(message.content)) return "";
  return message.content
    .map((part) =>
      part && typeof part === "object" && "text" in part
        ? String(part.text)
        : "",
    )
    .filter(Boolean)
    .join("\n")
    .trim();
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message.slice(0, 500);
  return String(error).slice(0, 500);
}

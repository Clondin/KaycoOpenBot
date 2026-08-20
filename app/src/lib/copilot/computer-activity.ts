import { useSyncExternalStore } from "react";

const QUIET_GAP_MS = 10_000;
const MAX_VISIBLE_STEPS = 8;
export const COMPUTER_RETRY_EVENT = "openbot:computer-retry";

export type ComputerActivityStage =
  | "starting"
  | "opening"
  | "reading"
  | "acting"
  | "waiting"
  | "complete"
  | "error";

export type ActiveComputer = { botId: string; startedAt?: string };

export type ComputerActivity = {
  id: string;
  botId: string;
  epoch: number;
  stage: ComputerActivityStage;
  label: string;
  startedAt: number;
  updatedAt: number;
  elapsedMs?: number;
  code?: string;
  maxRunning?: number;
  activeComputers?: ActiveComputer[];
};

export type ComputerTask = {
  botId: string;
  epoch: number;
  goal?: string;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  status: "active" | "complete" | "error";
  steps: readonly ComputerActivity[];
};

let epoch = 0;
let lastAt = 0;
let lastBot: string | null = null;
const latest = new Map<string, ComputerActivity>();
const tasks = new Map<string, ComputerTask>();
const pendingTasks = new Map<
  string,
  { epoch: number; goal?: string; startedAt: number }
>();
const activeTurnEpochs = new Map<string, number>();
const listeners = new Set<(activity: ComputerActivity) => void>();
const storeListeners = new Set<() => void>();

function notify(): void {
  for (const listener of storeListeners) listener();
}

function publish(activity: ComputerActivity): ComputerActivity {
  latest.set(activity.botId, activity);
  for (const listener of listeners) listener(activity);
  notify();
  return activity;
}

/** Tie every browser step in a user turn to one readable goal. */
export function beginComputerTask(botId: string, goal: string): void {
  const now = Date.now();
  epoch += 1;
  lastAt = now;
  lastBot = botId;
  pendingTasks.set(botId, {
    epoch,
    goal: goal.trim().slice(0, 180) || undefined,
    startedAt: now,
  });
  activeTurnEpochs.set(botId, epoch);
}

/** Mark the current user turn done without erasing the steps that explain what happened. */
export function finishComputerTask(botId: string): void {
  const turnEpoch = activeTurnEpochs.get(botId);
  activeTurnEpochs.delete(botId);
  pendingTasks.delete(botId);
  const task = tasks.get(botId);
  if (task?.status !== "active" || task.epoch !== turnEpoch) return;
  const now = Date.now();
  const last = task.steps.at(-1);
  tasks.set(botId, {
    ...task,
    updatedAt: now,
    finishedAt: now,
    status: last?.stage === "error" ? "error" : "complete",
  });
  notify();
}

/** Ask the owning channel to retry only after a person explicitly freed computer capacity. */
export function requestComputerRetry(botId: string): void {
  window.dispatchEvent(
    new CustomEvent(COMPUTER_RETRY_EVENT, { detail: { botId } }),
  );
}

/** Begin a visible, timed computer step and return its identity for the matching completion. */
export function reportComputerActivity(
  botId: string,
  update: { stage?: ComputerActivityStage; label?: string } = {},
): ComputerActivity {
  const now = Date.now();
  const pending = pendingTasks.get(botId);
  if (pending) pendingTasks.delete(botId);
  let task = tasks.get(botId);
  if (pending) {
    task = {
      botId,
      epoch: pending.epoch,
      goal: pending.goal,
      startedAt: pending.startedAt,
      updatedAt: now,
      status: "active",
      steps: [],
    };
  } else if (
    task?.status !== "active" ||
    (activeTurnEpochs.get(botId) !== task.epoch &&
      (botId !== lastBot || now - lastAt > QUIET_GAP_MS))
  ) {
    epoch += 1;
    task = {
      botId,
      epoch,
      startedAt: now,
      updatedAt: now,
      status: "active",
      steps: [],
    };
  }
  lastAt = now;
  lastBot = botId;

  const activity: ComputerActivity = {
    id: crypto.randomUUID(),
    botId,
    epoch: task.epoch,
    stage: update.stage ?? "acting",
    label: update.label ?? "Using the computer",
    startedAt: now,
    updatedAt: now,
  };
  tasks.set(botId, {
    ...task,
    updatedAt: now,
    steps: [...task.steps, activity].slice(-MAX_VISIBLE_STEPS),
  });
  return publish(activity);
}

export function updateComputerActivity(
  activity: ComputerActivity,
  update: {
    stage: ComputerActivityStage;
    label?: string;
    elapsedMs?: number;
    code?: string;
    maxRunning?: number;
    activeComputers?: ActiveComputer[];
  },
): void {
  const task = tasks.get(activity.botId);
  if (task?.epoch !== activity.epoch) return;
  const now = Date.now();
  const next = { ...activity, ...update, updatedAt: now };
  tasks.set(activity.botId, {
    ...task,
    updatedAt: now,
    steps: task.steps.map((step) => (step.id === activity.id ? next : step)),
  });
  publish(next);
}

export function onComputerActivity(
  listener: (activity: ComputerActivity) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** React view of the latest step without timers or duplicated network polling. */
export function useComputerActivity(botId: string): ComputerActivity | null {
  return useSyncExternalStore(
    (listener) => {
      storeListeners.add(listener);
      return () => storeListeners.delete(listener);
    },
    () => latest.get(botId) ?? null,
    () => null,
  );
}

/** React view of the current browser task and its recent steps. */
export function useComputerTask(botId: string): ComputerTask | null {
  return useSyncExternalStore(
    (listener) => {
      storeListeners.add(listener);
      return () => storeListeners.delete(listener);
    },
    () => tasks.get(botId) ?? null,
    () => null,
  );
}

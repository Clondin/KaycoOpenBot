import { useSyncExternalStore } from "react";

const QUIET_GAP_MS = 10_000;

export type ComputerActivityStage =
  | "starting"
  | "opening"
  | "reading"
  | "acting"
  | "waiting"
  | "complete"
  | "error";

export type ComputerActivity = {
  botId: string;
  epoch: number;
  stage: ComputerActivityStage;
  label: string;
  startedAt: number;
  updatedAt: number;
  elapsedMs?: number;
};

let epoch = 0;
let lastAt = 0;
let lastBot: string | null = null;
const latest = new Map<string, ComputerActivity>();
const listeners = new Set<(activity: ComputerActivity) => void>();
const storeListeners = new Set<() => void>();

function publish(activity: ComputerActivity): ComputerActivity {
  latest.set(activity.botId, activity);
  for (const listener of listeners) listener(activity);
  for (const listener of storeListeners) listener();
  return activity;
}

/** Begin a visible, timed computer step and return the epoch used to finish that same step. */
export function reportComputerActivity(
  botId: string,
  update: { stage?: ComputerActivityStage; label?: string } = {},
): ComputerActivity {
  const now = Date.now();
  if (botId !== lastBot || now - lastAt > QUIET_GAP_MS) epoch += 1;
  lastAt = now;
  lastBot = botId;
  return publish({
    botId,
    epoch,
    stage: update.stage ?? "acting",
    label: update.label ?? "Using the computer",
    startedAt: now,
    updatedAt: now,
  });
}

export function updateComputerActivity(
  activity: ComputerActivity,
  update: {
    stage: ComputerActivityStage;
    label?: string;
    elapsedMs?: number;
  },
): void {
  const current = latest.get(activity.botId);
  if (current?.epoch !== activity.epoch) return;
  publish({
    ...current,
    ...update,
    updatedAt: Date.now(),
  });
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

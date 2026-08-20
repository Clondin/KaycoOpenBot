import { queryOptions } from "@tanstack/react-query";

export type TaskRunStatus =
  | "queued"
  | "running"
  | "waiting_for_approval"
  | "waiting_for_input"
  | "succeeded"
  | "failed"
  | "cancelled";

export type TaskRun = {
  id: string;
  channelId: string;
  agentId: string | null;
  threadId: string;
  title: string;
  status: TaskRunStatus;
  parentRunId: string | null;
  attempt: number;
  maxAttempts: number;
  maxRuntimeMs: number;
  leaseExpiresAt: string | null;
  nextAttemptAt: string | null;
  output: string | null;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  lastHeartbeatAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type TaskRunEvent = {
  id: string;
  runId: string;
  sequence: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type ApprovalStatus =
  | "pending"
  | "approved"
  | "declined"
  | "expired"
  | "cancelled";

export type ApprovalRequest = {
  id: string;
  runId: string | null;
  channelId: string | null;
  botId: string;
  toolName: string;
  title: string;
  summary: string;
  details: Array<{ label: string; value: string }>;
  status: ApprovalStatus;
  note: string | null;
  expiresAt: string;
  decidedAt: string | null;
  consumedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export const runKeys = {
  all: ["task-runs"] as const,
  channel: (channelId: string) => ["task-runs", "channel", channelId] as const,
  detail: (runId: string) => ["task-runs", "detail", runId] as const,
  events: (runId: string) => ["task-runs", runId, "events"] as const,
  approvals: (runId: string) => ["task-runs", runId, "approvals"] as const,
};

export function channelRunsQueryOptions(channelId: string) {
  return queryOptions({
    queryKey: runKeys.channel(channelId),
    queryFn: async (): Promise<TaskRun[]> => {
      const response = await fetch(
        `/api/runs?channelId=${encodeURIComponent(channelId)}&limit=20`,
        { credentials: "include" },
      );
      if (!response.ok) throw new Error("Could not load task runs.");
      return ((await response.json()) as { runs: TaskRun[] }).runs;
    },
    refetchInterval: 2_000,
  });
}

export function runApprovalsQueryOptions(runId: string) {
  return queryOptions({
    queryKey: runKeys.approvals(runId),
    queryFn: async (): Promise<ApprovalRequest[]> => {
      const response = await fetch(
        `/api/runs/${encodeURIComponent(runId)}/approvals`,
        {
          credentials: "include",
        },
      );
      if (!response.ok) throw new Error("Could not load approvals.");
      return ((await response.json()) as { approvals: ApprovalRequest[] })
        .approvals;
    },
    refetchInterval: 1_000,
  });
}

export function runEventsQueryOptions(runId: string) {
  return queryOptions({
    queryKey: runKeys.events(runId),
    queryFn: async (): Promise<TaskRunEvent[]> => {
      const response = await fetch(
        `/api/runs/${encodeURIComponent(runId)}/events`,
        { credentials: "include" },
      );
      if (!response.ok) throw new Error("Could not load task activity.");
      return ((await response.json()) as { events: TaskRunEvent[] }).events;
    },
    refetchInterval: 2_000,
  });
}

export async function createTaskRun(input: {
  channelId: string;
  agentId: string;
  title?: string;
  parentRunId?: string;
  maxAttempts?: number;
  maxRuntimeMs?: number;
}) {
  const response = await fetch("/api/runs", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error("The task could not be recorded.");
  return ((await response.json()) as { run: TaskRun }).run;
}

export async function transitionTaskRun(
  runId: string,
  status: TaskRunStatus,
  error?: string,
) {
  const response = await fetch(`/api/runs/${encodeURIComponent(runId)}`, {
    method: "PATCH",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status, ...(error ? { error } : {}) }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? "The task status could not be saved.");
  }
  return ((await response.json()) as { run: TaskRun }).run;
}

export async function decideApproval(
  approvalId: string,
  decision: "approved" | "declined",
  note?: string,
) {
  const response = await fetch(
    `/api/runs/approvals/${encodeURIComponent(approvalId)}/decision`,
    {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        decision,
        ...(note?.trim() ? { note: note.trim() } : {}),
      }),
    },
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? "That decision could not be saved.");
  }
  return ((await response.json()) as { approval: ApprovalRequest }).approval;
}

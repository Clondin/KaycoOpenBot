import { queryOptions } from "@tanstack/react-query";
import type { TaskRun } from "../runs/queries";

export type Project = {
  id: string;
  name: string;
  description: string;
  status: "active" | "archived";
  role: "owner" | "editor" | "viewer";
  agents: Array<{ id: string; name: string }>;
  artifactCount: number;
  createdAt: string;
  updatedAt: string;
};

export type ProjectArtifact = {
  id: string;
  projectId: string;
  createdByAgentId: string | null;
  title: string;
  kind: string;
  content: string;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type RoutineSchedule =
  | { kind: "every_minutes"; interval: number }
  | { kind: "daily"; time: string }
  | { kind: "weekly"; days: number[]; time: string };

export type Routine = {
  id: string;
  name: string;
  description: string;
  instruction: string;
  agentId: string;
  channelId: string;
  projectId: string | null;
  status: "active" | "paused" | "archived";
  trigger: "manual" | "schedule" | "webhook";
  schedule: RoutineSchedule | null;
  scheduleLabel: string | null;
  timezone: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  latestRun: TaskRun | null;
  createdAt: string;
  updatedAt: string;
};

export type Delegation = {
  id: string;
  sourceAgentId: string | null;
  targetAgentId: string;
  targetName: string;
  sourceChannelId: string | null;
  targetChannelId: string;
  taskRunId: string;
  projectId: string | null;
  title: string;
  instructions: string;
  expectedOutput: string;
  status:
    | "queued"
    | "accepted"
    | "in_progress"
    | "completed"
    | "failed"
    | "cancelled";
  result: string | null;
  error: string | null;
  dueAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type MemoryEntry = {
  id: string;
  scope: "user" | "agent" | "project";
  kind: "preference" | "fact" | "instruction" | "decision";
  agentId: string | null;
  projectId: string | null;
  title: string;
  content: string;
  source: string;
  confidence: number;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
};

export type WorkNotification = {
  id: string;
  kind: "task" | "approval" | "delegation" | "routine" | "system";
  title: string;
  body: string;
  targetUrl: string | null;
  metadata: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
};

export type WorkTemplate = {
  id: string;
  title: string;
  summary: string;
  trigger: "manual" | "schedule" | "webhook";
  integrationLabels: string[];
  agentRole: string;
  instruction: string;
};

export type WorkOverview = {
  templates: WorkTemplate[];
  runs: TaskRun[];
  routines: Routine[];
  delegations: Delegation[];
  projects: Project[];
  notifications: WorkNotification[];
  memory: MemoryEntry[];
};

export const workKeys = {
  all: ["work"] as const,
  overview: () => ["work", "overview"] as const,
};

export function workOverviewQueryOptions() {
  return queryOptions({
    queryKey: workKeys.overview(),
    queryFn: async (): Promise<WorkOverview> => {
      const response = await fetch("/api/work/overview", {
        credentials: "include",
      });
      if (!response.ok) throw new Error("Could not load the work queue.");
      return response.json() as Promise<WorkOverview>;
    },
    refetchInterval: 5_000,
  });
}

export async function workRequest<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`/api/work${path}`, {
    credentials: "include",
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const body = (await response.json().catch(() => null)) as
    | (T & { error?: string })
    | null;
  if (!response.ok) throw new Error(body?.error ?? "That did not work.");
  return body as T;
}

import { queryOptions } from "@tanstack/react-query";

export type ContinuitySnapshot = {
  id: string;
  channelId: string;
  threadId: string;
  throughMessageId: string;
  summary: string;
  tokenEstimate: number;
  sourceMessageCount: number;
  createdAt: string;
};

export type ToolProgram = {
  id: string;
  agentId: string;
  name: string;
  description: string;
  steps: Array<{
    id: string;
    tool: string;
    arguments: Record<string, unknown>;
  }>;
  status: "draft" | "approved";
  revision: number;
  reviewedAt: string | null;
  updatedAt: string;
};

export type ToolProgramRun = {
  id: string;
  programId: string | null;
  agentId: string;
  status: "succeeded" | "failed";
  stepNames: string[];
  output: string | null;
  error: string | null;
  createdAt: string;
};

export type SkillHealth = {
  id: string;
  slug: string;
  title: string;
  origin: string;
  lifecycleStatus: "active" | "archived";
  pinnedVersion: number | null;
  mutable: boolean;
  versionCount: number;
  latestVersion: number | null;
  drifted: boolean;
  usageCount: number;
  lastUsedAt: string | null;
  health: "healthy" | "stale" | "changed" | "archived";
};

export type BotBundle = {
  id: string;
  name: string;
  description: string;
  version: number;
  manifest: Record<string, unknown>;
  contentHash: string;
  status: "active" | "archived";
  updatedAt: string;
};

export type ContinuityOverview = {
  indexedMessageCount: number;
  snapshots: ContinuitySnapshot[];
  programs: ToolProgram[];
  programRuns: ToolProgramRun[];
  skillHealth: SkillHealth[];
  bundles: BotBundle[];
};

export type ContextSearchResult = {
  id: string;
  channelId: string;
  threadId: string;
  messageId: string;
  agentId: string | null;
  role: "user" | "assistant" | "system";
  content: string;
  anchor: Record<string, unknown>;
  occurredAt: string;
};

export const continuityKeys = {
  all: ["continuity"] as const,
  overview: () => ["continuity", "overview"] as const,
  search: (query: string, channelId?: string) =>
    ["continuity", "search", query, channelId] as const,
};

export function continuityOverviewQueryOptions() {
  return queryOptions({
    queryKey: continuityKeys.overview(),
    queryFn: () => continuityRequest<ContinuityOverview>("/overview"),
    refetchInterval: 10_000,
  });
}

export function continuitySearchQueryOptions(
  query: string,
  channelId?: string,
) {
  const search = new URLSearchParams({ q: query });
  if (channelId) search.set("channelId", channelId);
  return queryOptions({
    enabled: query.trim().length > 1,
    queryKey: continuityKeys.search(query, channelId),
    queryFn: async () =>
      (
        await continuityRequest<{ results: ContextSearchResult[] }>(
          `/search?${search.toString()}`,
        )
      ).results,
  });
}

export async function continuityRequest<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`/api/continuity${path}`, {
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
  if (!response.ok)
    throw new Error(body?.error ?? "Continuity request failed.");
  return body as T;
}

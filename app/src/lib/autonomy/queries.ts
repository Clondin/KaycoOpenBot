import { queryOptions } from "@tanstack/react-query";

export type ExternalConnection = {
  id: string;
  kind: "telegram" | "slack" | "discord" | "webhook";
  name: string;
  agentId: string;
  channelId: string;
  credentialId: string | null;
  status: "active" | "paused";
  config: Record<string, unknown>;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ExternalIdentity = {
  id: string;
  connectionId: string;
  externalUserId: string;
  externalConversationId: string | null;
  status: string;
  label: string;
};

export type ExternalMessage = {
  id: string;
  connectionId: string;
  direction: "inbound" | "outbound";
  taskRunId: string | null;
  status: string;
  attempt: number;
  lastError: string | null;
  createdAt: string;
};

export type SkillProposal = {
  id: string;
  sourceRunId: string | null;
  operation: "create" | "update";
  slug: string;
  title: string;
  summary: string;
  instructions: string;
  status:
    | "pending"
    | "quarantined"
    | "stale"
    | "applied"
    | "rejected"
    | "rolled_back";
  scan: {
    findings?: Array<{ id: string; severity: string }>;
    quarantine?: boolean;
  };
  createdAt: string;
  updatedAt: string;
};

export type MemorySuggestion = {
  id: string;
  sourceRunId: string | null;
  scope: "user" | "agent";
  kind: "preference" | "fact" | "instruction" | "decision";
  agentId: string | null;
  title: string;
  content: string;
  confidence: number;
  status: "pending" | "promoted" | "rejected";
  promotedMemoryId: string | null;
  createdAt: string;
};

export type ModelRoute = {
  id: string;
  agentId: string | null;
  name: string;
  candidates: Array<{ provider: string; model: string }>;
  retryableCodes: string[];
  status: "active" | "paused";
  createdAt: string;
  updatedAt: string;
};

export type ModelAttempt = {
  id: string;
  taskRunId: string;
  ordinal: number;
  provider: string;
  model: string;
  outcome: "succeeded" | "failed";
  errorCode: string | null;
  createdAt: string;
};

export type ToolResultSummary = {
  id: string;
  taskRunId: string | null;
  agentId: string;
  toolName: string;
  contentHash: string;
  preview: string;
  createdAt: string;
  expiresAt: string | null;
};

export type AutonomyOverview = {
  connections: ExternalConnection[];
  identities: ExternalIdentity[];
  messages: ExternalMessage[];
  proposals: SkillProposal[];
  suggestions: MemorySuggestion[];
  modelRoutes: ModelRoute[];
  modelAttempts: ModelAttempt[];
  toolResults: ToolResultSummary[];
};

export const autonomyKeys = {
  all: ["autonomy"] as const,
  overview: () => ["autonomy", "overview"] as const,
};

export function autonomyOverviewQueryOptions() {
  return queryOptions({
    queryKey: autonomyKeys.overview(),
    queryFn: async (): Promise<AutonomyOverview> => {
      const response = await fetch("/api/autonomy/overview", {
        credentials: "include",
      });
      if (!response.ok)
        throw new Error("Could not load the autonomy workspace.");
      return response.json() as Promise<AutonomyOverview>;
    },
    refetchInterval: 5_000,
  });
}

export async function autonomyRequest<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`/api/autonomy${path}`, {
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

import { queryOptions } from "@tanstack/react-query";

export type CodexAccount = {
  type: string;
  email?: string;
  planType?: string;
};

export type CodexAccountState = {
  connected: boolean;
  account: CodexAccount | null;
  requiresOpenaiAuth: boolean;
};

export type CodexDeviceLogin = {
  type: "chatgptDeviceCode";
  loginId: string;
  verificationUrl: string;
  userCode: string;
};

export type RateLimitWindow = {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
};

export type RateLimitSnapshot = {
  limitId?: string | null;
  limitName?: string | null;
  primary?: RateLimitWindow | null;
  secondary?: RateLimitWindow | null;
  planType?: string | null;
};

export type CodexRateLimits = {
  rateLimits: RateLimitSnapshot;
  rateLimitsByLimitId?: Record<string, RateLimitSnapshot> | null;
};

export type CodexUsage = {
  summary?: {
    lifetimeTokens?: number | null;
    currentStreakDays?: number | null;
  };
};

export const codexKeys = {
  all: ["codex"] as const,
  account: () => ["codex", "account"] as const,
  limits: () => ["codex", "limits"] as const,
  usage: () => ["codex", "usage"] as const,
};

export function capabilitiesQueryOptions() {
  return queryOptions({
    queryKey: ["runtime-capabilities"],
    queryFn: () => request<{ codex: boolean }>("/api/capabilities"),
    staleTime: 60_000,
  });
}

export function codexAccountQueryOptions(enabled = true) {
  return queryOptions({
    queryKey: codexKeys.account(),
    queryFn: () => request<CodexAccountState>("/api/codex/account"),
    enabled,
    refetchInterval: 3_000,
  });
}

export function codexLimitsQueryOptions(enabled: boolean) {
  return queryOptions({
    queryKey: codexKeys.limits(),
    queryFn: () => request<CodexRateLimits>("/api/codex/limits"),
    enabled,
    refetchInterval: 60_000,
  });
}

export function codexUsageQueryOptions(enabled: boolean) {
  return queryOptions({
    queryKey: codexKeys.usage(),
    queryFn: () => request<CodexUsage>("/api/codex/usage"),
    enabled,
    refetchInterval: 60_000,
  });
}

export function startCodexDeviceLogin() {
  return request<{ login: CodexDeviceLogin }>("/api/codex/login/device", {
    method: "POST",
  }).then(({ login }) => login);
}

export function cancelCodexLogin(loginId: string) {
  return request<{ status: string }>(
    `/api/codex/login/${encodeURIComponent(loginId)}/cancel`,
    { method: "POST" },
  );
}

export function disconnectCodexAccount() {
  return request<{ connected: false }>("/api/codex/account", {
    method: "DELETE",
  });
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: "include", ...init });
  const body = (await response.json().catch(() => null)) as
    | (T & { error?: string })
    | null;
  if (!response.ok) {
    throw new Error(body?.error ?? "The Codex account service did not answer.");
  }
  if (!body) throw new Error("The Codex account service returned no data.");
  return body;
}

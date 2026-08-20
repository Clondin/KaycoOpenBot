import { queryOptions } from "@tanstack/react-query";

export type CredentialStatus = {
  id: string;
  kind: "model" | "connector";
  provider: string;
  keyId: string;
  metadata: Record<string, unknown>;
  revokedAt: string | null;
};

export const credentialKeys = {
  all: ["credentials"] as const,
  list: () => [...credentialKeys.all, "list"] as const,
  model: () => [...credentialKeys.all, "model-status"] as const,
};

export type ModelStatus = {
  provider: string;
  model: string;
  keyId: string;
  configured: boolean;
};

export function credentialListQueryOptions() {
  return queryOptions({
    queryKey: credentialKeys.list(),
    queryFn: async (): Promise<CredentialStatus[]> => {
      const response = await fetch("/api/admin/credentials", {
        credentials: "include",
      });
      if (!response.ok) throw new Error("Could not load credentials");
      return ((await response.json()) as { credentials: CredentialStatus[] })
        .credentials;
    },
  });
}

export function modelStatusQueryOptions() {
  return queryOptions({
    queryKey: credentialKeys.model(),
    queryFn: async (): Promise<ModelStatus> => {
      const response = await fetch("/api/admin/model-status", {
        credentials: "include",
      });
      if (!response.ok) throw new Error("Could not load model status");
      return ((await response.json()) as { model: ModelStatus }).model;
    },
  });
}

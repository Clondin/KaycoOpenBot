import { queryOptions } from "@tanstack/react-query";
import type { ActiveRun } from "@/lib/copilot/active-run";
import { waitForApprovalDecision } from "@/lib/runs/approvals";

/** A tool one server offers, as the Plugins page sees it. */
export type PluginTool = {
  serverId: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** `<serverId>/<name>`. What a grant names. */
  ref: string;
  /** Whether it changes something. Anything not positively known to be a read is a write. */
  effect: "read" | "write";
  grantedTo: string[];
};

export type PluginServer = {
  id: string;
  title: string;
  vendor: string;
  url: string;
  summary: string;
  docsUrl: string;
  /** `first-party` for a reviewed entry, `custom` for one an administrator added by URL. */
  provenance: string;
  hasCredential: boolean;
  authMode: "token" | "oauth";
  toolsRefreshedAt: string | null;
  lastError: string | null;
  addedBy: string | null;
  tools: PluginTool[];
};

export type PluginSkill = {
  id: string;
  slug: string;
  /** Whose it is. Null means the deployment's: an administrator looks after it. */
  ownerUserId: string | null;
  title: string;
  summary: string;
  instructions: string;
  origin: string;
  installedBy: string | null;
  grantedTo: string[];
};

export type CatalogueItem = {
  key: string;
  title: string;
  vendor: string;
  summary: string;
  docsUrl: string;
  needsCredential: boolean;
  /** True for a vendor that gives every customer their own hostname. */
  perInstance: boolean;
};

export type PluginsPage = {
  catalogue: CatalogueItem[];
  servers: PluginServer[];
  skills: PluginSkill[];
};

/** What one Bot holds, which is all the runtime needs to offer it. */
export type GrantedPlugins = {
  tools: {
    ref: string;
    toolName: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }[];
  skills: {
    slug: string;
    title: string;
    summary: string;
    instructions: string;
  }[];
};

export const pluginKeys = {
  all: ["plugins"] as const,
  page: () => ["plugins", "page"] as const,
  forAgent: (agentId: string) => ["plugins", "for-agent", agentId] as const,
};

export function pluginsPageQueryOptions() {
  return queryOptions({
    queryKey: pluginKeys.page(),
    queryFn: async (): Promise<PluginsPage> => {
      const response = await fetch("/api/plugins", { credentials: "include" });
      if (!response.ok) throw new Error("Plugins could not be loaded.");
      return response.json();
    },
  });
}

/**
 * Polled grant snapshot for what the active Bot should be offered; call-time checks still enforce.
 */
export function agentPluginsQueryOptions(agentId: string) {
  return queryOptions({
    queryKey: pluginKeys.forAgent(agentId),
    enabled: agentId.length > 0,
    refetchInterval: 15_000,
    queryFn: async (): Promise<GrantedPlugins> => {
      const response = await fetch(
        `/api/plugins/for/${encodeURIComponent(agentId)}`,
        { credentials: "include" },
      );
      if (!response.ok)
        throw new Error("This Bot's plugins could not be read.");
      return response.json();
    },
  });
}

export type PluginCallOutcome =
  | { ok: true; text: string; isError: boolean }
  /** The deployment decided against it. `rule` names the expression, when one decided. */
  | { ok: false; refused: true; reason: string; rule: string | null }
  /** Remote server failure; distinct from a policy refusal. */
  | { ok: false; refused: false; reason: string };

/**
 * Call a tool as a Bot, with server-side grant and policy rechecks for mid-run revocations.
 */
export async function callPluginTool(
  ref: string,
  args: Record<string, unknown>,
  agentId: string,
  task: ActiveRun,
  signal?: AbortSignal,
): Promise<PluginCallOutcome> {
  const request = (approvalId?: string) => {
    const headers = new Headers({ "content-type": "application/json" });
    if (task.runId) headers.set("X-OpenBot-Run-Id", task.runId);
    if (task.channelId) headers.set("X-OpenBot-Channel-Id", task.channelId);
    if (approvalId) headers.set("X-OpenBot-Approval-Id", approvalId);
    return fetch("/api/plugins/call", {
      method: "POST",
      credentials: "include",
      headers,
      body: JSON.stringify({ ref, args, agentId }),
      ...(signal ? { signal } : {}),
    });
  };

  let response: Response;
  try {
    response = await request();
  } catch {
    return {
      ok: false,
      refused: false,
      reason: signal?.aborted
        ? "The tool call was stopped."
        : "The server did not answer.",
    };
  }

  type ResponseBody = {
    text?: string;
    isError?: boolean;
    error?: string;
    rule?: string | null;
    approvalRequired?: boolean;
    approval?: { id?: string; runId?: string | null };
  };
  let body = (await response.json().catch(() => null)) as ResponseBody | null;

  if (response.status === 428 && body?.approvalRequired) {
    const approvalId = body.approval?.id;
    if (!approvalId || !task.runId || body.approval?.runId !== task.runId) {
      return {
        ok: false,
        refused: true,
        reason:
          "This tool requires approval, but it is not attached to this durable task.",
        rule: body.rule ?? null,
      };
    }

    const decision = await waitForApprovalDecision(approvalId, signal);
    if (decision !== "approved") {
      return {
        ok: false,
        refused: true,
        reason:
          decision === "declined"
            ? "The person declined this tool call."
            : decision === "cancelled"
              ? "The approval wait was stopped."
              : "The approval request expired before it was decided.",
        rule: body.rule ?? null,
      };
    }

    try {
      response = await request(approvalId);
      body = (await response.json().catch(() => null)) as ResponseBody | null;
    } catch {
      return {
        ok: false,
        refused: false,
        reason: signal?.aborted
          ? "The approved tool call was stopped."
          : "The approved tool call could not reach the server.",
      };
    }
  }

  if (response.ok) {
    return {
      ok: true,
      text: body?.text ?? "",
      isError: body?.isError === true,
    };
  }
  if (response.status === 403 || response.status === 409) {
    return {
      ok: false,
      refused: true,
      reason: body?.error ?? "That tool is not allowed here.",
      rule: body?.rule ?? null,
    };
  }
  return {
    ok: false,
    refused: false,
    reason: body?.error ?? "The server did not answer.",
  };
}

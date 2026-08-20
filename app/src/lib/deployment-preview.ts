import type { AgentProfile } from "./agents/queries";
import type { AuthenticatedUser } from "./auth/queries";
import type { ChannelSummary } from "./channels/queries";

/**
 * A frontend-only deployment used while the production API is being built.
 *
 * This never relaxes server authorization: it only replaces same-origin browser requests in a
 * build that explicitly sets VITE_OPENBOT_PREVIEW=true. Production builds leave it off.
 */
export const deploymentPreviewEnabled =
  import.meta.env.VITE_OPENBOT_PREVIEW === "true";

const previewUser: AuthenticatedUser = {
  id: "preview-admin",
  email: "preview@openbot.local",
  name: "Preview Administrator",
  role: "admin",
};

const previewAgents: AgentProfile[] = [
  {
    id: "general-assistant",
    name: "General Assistant",
    title: "Everyday work",
    roleDescription:
      "Draft, research, organize, and help move everyday work forward.",
    avatarSeed: "general-assistant",
    visibility: "public",
    endpoint: null,
    hasAuth: false,
    hasCallbackToken: false,
    hidden: false,
    systemOwned: true,
    canManage: true,
    mine: false,
  },
  {
    id: "knowledge",
    name: "Knowledge",
    title: "Company knowledge",
    roleDescription:
      "Answer company questions from approved sources and cite what it used.",
    avatarSeed: "knowledge",
    visibility: "public",
    endpoint: null,
    hasAuth: false,
    hasCallbackToken: false,
    hidden: false,
    systemOwned: true,
    canManage: true,
    mine: false,
  },
  {
    id: "risk-analyst",
    name: "Risk Analyst",
    title: "Risk and compliance",
    roleDescription:
      "Investigate policies, controls, exceptions, and compliance questions.",
    avatarSeed: "risk-analyst",
    visibility: "public",
    endpoint: null,
    hasAuth: false,
    hasCallbackToken: false,
    hidden: false,
    systemOwned: true,
    canManage: true,
    mine: false,
  },
];

const previewChannels: ChannelSummary[] = [
  {
    id: "preview-policy-review",
    name: "Policy review",
    agentIds: ["knowledge"],
    threadId: "preview-policy-review",
    active: true,
    lastMessage:
      "I found the relevant policy and summarized the approval path.",
    lastMessageAt: "2026-08-19T15:40:00.000Z",
    lastMessageAgentId: "knowledge",
    createdAt: "2026-08-19T15:10:00.000Z",
  },
  {
    id: "preview-weekly-brief",
    name: "Weekly brief",
    agentIds: ["general-assistant"],
    threadId: "preview-weekly-brief",
    active: true,
    lastMessage: "Your draft is ready for review.",
    lastMessageAt: "2026-08-18T19:20:00.000Z",
    lastMessageAgentId: "general-assistant",
    createdAt: "2026-08-18T18:45:00.000Z",
  },
];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function requestUrl(input: RequestInfo | URL) {
  if (input instanceof Request) return input.url;
  return input.toString();
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit) {
  return (
    init?.method ?? (input instanceof Request ? input.method : "GET")
  ).toUpperCase();
}

/** Install the small, read-only API projection that makes the hosted UI preview navigable. */
export function installDeploymentPreviewApi() {
  if (!deploymentPreviewEnabled) return;

  const networkFetch = globalThis.fetch.bind(globalThis);

  const previewFetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(requestUrl(input), window.location.origin);
    if (
      url.origin !== window.location.origin ||
      !url.pathname.startsWith("/api/")
    ) {
      return networkFetch(input, init);
    }

    const method = requestMethod(input, init);
    const path = url.pathname;

    if (method === "GET" && path === "/api/me") {
      return json({ user: previewUser });
    }
    if (method === "GET" && path === "/api/agents") {
      return json({ agents: previewAgents });
    }
    if (method === "GET" && path.startsWith("/api/agents/")) {
      const id = decodeURIComponent(path.slice("/api/agents/".length));
      const agent = previewAgents.find((candidate) => candidate.id === id);
      return agent
        ? json({ agent })
        : json({ error: "That preview coworker does not exist." }, 404);
    }
    if (method === "GET" && path === "/api/channels") {
      return json({ channels: previewChannels });
    }
    if (method === "GET" && path.startsWith("/api/channels/")) {
      const id = decodeURIComponent(path.slice("/api/channels/".length));
      const channel = previewChannels.find((candidate) => candidate.id === id);
      return channel
        ? json({ channel })
        : json({ error: "That preview channel does not exist." }, 404);
    }
    if (method === "PUT" && path === "/api/components/catalogue") {
      return json({ added: [] });
    }
    if (method === "GET" && path.startsWith("/api/components/for-agent/")) {
      return json({ components: [] });
    }
    if (method === "GET" && path.startsWith("/api/plugins/for/")) {
      return json({ tools: [], skills: [] });
    }
    if (method === "GET" && path === "/api/sandboxed/published") {
      return json({ components: [] });
    }

    return json(
      {
        error:
          "This is a frontend preview. The production OpenBot API is not connected yet.",
        preview: true,
      },
      503,
    );
  };

  // Newer DOM libraries attach optional helpers to `fetch`; replacing the value through its
  // descriptor keeps this preview adapter independent of those host-specific extensions.
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: previewFetch,
    writable: true,
  });
}

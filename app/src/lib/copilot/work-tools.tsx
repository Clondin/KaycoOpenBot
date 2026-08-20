import { useFrontendTool } from "@copilotkit/react-core/v2";
import { useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { ToolLine } from "@/components/channels/tool-line";
import { useActiveBotHolder } from "./active-bot";
import { useActiveRunHolder } from "./active-run";
import { workKeys, workRequest } from "../work/queries";

/** Organization-native tools: handoffs, shared artifacts, and inspectable memory. */
export function WorkTools() {
  const bot = useActiveBotHolder();
  const run = useActiveRunHolder();
  const queryClient = useQueryClient();
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: workKeys.all });

  useFrontendTool({
    name: "openbot_list_coworkers_and_projects",
    description:
      "List the OpenBot coworkers and shared projects available to the signed-in person. Call this " +
      "before delegating work or saving a project artifact when you do not already have the target ID.",
    parameters: z.object({}),
    handler: async () => {
      const [agentResponse, projectResponse] = await Promise.all([
        fetch("/api/agents", { credentials: "include" }),
        workRequest<{
          projects: Array<{
            id: string;
            name: string;
            status: string;
            agents: Array<{ id: string; name: string }>;
          }>;
        }>("/projects"),
      ]);
      if (!agentResponse.ok) throw new Error("Coworkers could not be loaded.");
      const agentBody = (await agentResponse.json()) as {
        agents: Array<{ id: string; name: string; title: string }>;
      };
      const coworkers = agentBody.agents
        .map((agent) => `- ${agent.name} (${agent.title}): ${agent.id}`)
        .join("\n");
      const projects = projectResponse.projects
        .filter((project) => project.status === "active")
        .map(
          (project) =>
            `- ${project.name}: ${project.id}; coworkers: ${
              project.agents.map((agent) => agent.name).join(", ") || "none"
            }`,
        )
        .join("\n");
      return `Coworkers:\n${coworkers || "- none"}\n\nProjects:\n${projects || "- none"}`;
    },
    render: ({ status }) => (
      <ToolLine
        label="Listed coworkers and projects"
        running={status !== "complete"}
      />
    ),
  });

  useFrontendTool({
    name: "openbot_delegate_work",
    description:
      "Assign a bounded piece of work to another OpenBot coworker. Use when a different specialist " +
      "should own the next step. The handoff creates a durable task and channel; do not claim the " +
      "target finished until its delegation reports completion.",
    parameters: z.object({
      targetAgentId: z
        .string()
        .describe("ID of the coworker receiving the work"),
      title: z.string().describe("Short outcome-oriented task title"),
      instructions: z
        .string()
        .describe("Complete instructions and necessary context"),
      expectedOutput: z
        .string()
        .optional()
        .describe("What a completed handoff must return"),
      projectId: z
        .string()
        .optional()
        .describe("Optional shared project workspace ID"),
    }),
    handler: async (input) => {
      const response = await workRequest<{
        delegation: { id: string; targetName: string };
      }>("/delegations", {
        method: "POST",
        body: JSON.stringify({
          ...input,
          ...(run.current.channelId
            ? {
                sourceAgentId: bot.current,
                sourceChannelId: run.current.channelId,
              }
            : {}),
        }),
      });
      void refresh();
      return `Assigned to ${response.delegation.targetName}. Handoff ${response.delegation.id} is now in the work queue.`;
    },
    render: ({ args, status }) => (
      <ToolLine
        detail={typeof args?.title === "string" ? args.title : undefined}
        label="Delegated work"
        running={status !== "complete"}
      />
    ),
  });

  useFrontendTool({
    name: "openbot_remember",
    description:
      "Save a durable, inspectable memory only when the person asks you to remember something, or " +
      "when a stable preference, instruction, fact, or decision will materially help later work. " +
      "Never store passwords, tokens, one-time codes, payment data, or transient conversation text.",
    parameters: z.object({
      scope: z.enum(["user", "agent", "project"]),
      kind: z.enum(["preference", "fact", "instruction", "decision"]),
      title: z.string(),
      content: z.string(),
      projectId: z.string().optional(),
      confidence: z.number().int().min(0).max(100).optional(),
    }),
    handler: async (input) => {
      const response = await workRequest<{ memory: { id: string } }>(
        "/memory",
        {
          method: "POST",
          body: JSON.stringify({
            ...input,
            source: `coworker:${bot.current}`,
            ...(input.scope === "agent" ? { agentId: bot.current } : {}),
          }),
        },
      );
      void refresh();
      return `Saved as inspectable memory ${response.memory.id}.`;
    },
    render: ({ args, status }) => (
      <ToolLine
        detail={typeof args?.title === "string" ? args.title : undefined}
        label="Remembered"
        running={status !== "complete"}
      />
    ),
  });

  useFrontendTool({
    name: "openbot_recall",
    description:
      "Read the person's inspectable OpenBot memory before relying on remembered preferences, " +
      "project decisions, or standing instructions. Filter to the current coworker or a project " +
      "when possible.",
    parameters: z.object({
      scope: z.enum(["user", "agent", "project"]).optional(),
      projectId: z.string().optional(),
    }),
    handler: async (input) => {
      const query = new URLSearchParams();
      if (input.scope) query.set("scope", input.scope);
      if (input.projectId) query.set("projectId", input.projectId);
      if (input.scope === "agent") query.set("agentId", bot.current);
      const response = await workRequest<{
        memory: Array<{
          id: string;
          kind: string;
          title: string;
          content: string;
          confidence: number;
        }>;
      }>(`/memory${query.size ? `?${query}` : ""}`);
      if (!response.memory.length)
        return "No matching inspectable memory is stored.";
      return response.memory
        .slice(0, 30)
        .map(
          (item) =>
            `- [${item.kind}] ${item.title}: ${item.content} (confidence ${item.confidence}%, id ${item.id})`,
        )
        .join("\n");
    },
    render: ({ status }) => (
      <ToolLine label="Recalled memory" running={status !== "complete"} />
    ),
  });

  useFrontendTool({
    name: "openbot_save_project_artifact",
    description:
      "Save a meaningful project result—report, checklist, decision, draft, or dataset description—" +
      "into the shared project workspace so another coworker can pick it up. Do not use this for " +
      "temporary progress messages.",
    parameters: z.object({
      projectId: z.string(),
      title: z.string(),
      kind: z.string().optional(),
      content: z.string(),
    }),
    handler: async (input) => {
      const response = await workRequest<{
        artifact: { id: string; version: number };
      }>(`/projects/${encodeURIComponent(input.projectId)}/artifacts`, {
        method: "POST",
        body: JSON.stringify({ ...input, agentId: bot.current }),
      });
      void refresh();
      return `Saved project artifact ${response.artifact.id}, version ${response.artifact.version}.`;
    },
    render: ({ args, status }) => (
      <ToolLine
        detail={typeof args?.title === "string" ? args.title : undefined}
        label="Saved project artifact"
        running={status !== "complete"}
      />
    ),
  });

  return null;
}

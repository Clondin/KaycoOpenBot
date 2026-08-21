import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { AgentActor } from "../agents/profile-types";
import type { Database } from "../db/client";
import { toolResultArtifacts } from "../db/schema";
import type { GrantedTool, ToolRunContext } from "../plugins/tools";
import { WorkNotFoundError } from "../work/access";

const DIRECT_TOOL_LIMIT = 12;
const PROMPT_RESULT_LIMIT = 12_000;
const RESULT_STORAGE_LIMIT = 1_000_000;

export function createToolResultStore(database: Database) {
  return {
    async save(input: {
      actor: AgentActor;
      agentId: string;
      toolName: string;
      run?: ToolRunContext;
      content: string;
    }) {
      const content = Array.from(input.content)
        .slice(0, RESULT_STORAGE_LIMIT)
        .join("");
      const contentHash = await hash(content);
      const preview = compactPreview(content);
      const [artifact] = await database
        .insert(toolResultArtifacts)
        .values({
          ownerUserId: input.actor.id,
          ...(input.run?.runId ? { taskRunId: input.run.runId } : {}),
          agentId: input.agentId,
          toolName: input.toolName,
          contentHash,
          preview,
          content,
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60_000),
        })
        .returning();
      if (!artifact)
        throw new Error("Tool result artifact could not be stored.");
      return artifact;
    },

    async get(actor: AgentActor, artifactId: string) {
      const [artifact] = await database
        .select()
        .from(toolResultArtifacts)
        .where(
          and(
            eq(toolResultArtifacts.id, artifactId),
            eq(toolResultArtifacts.ownerUserId, actor.id),
          ),
        );
      if (!artifact) throw new WorkNotFoundError("Tool result not found.");
      return artifact;
    },

    async list(actor: AgentActor, limit = 30) {
      return database
        .select({
          id: toolResultArtifacts.id,
          taskRunId: toolResultArtifacts.taskRunId,
          agentId: toolResultArtifacts.agentId,
          toolName: toolResultArtifacts.toolName,
          contentHash: toolResultArtifacts.contentHash,
          preview: toolResultArtifacts.preview,
          createdAt: toolResultArtifacts.createdAt,
          expiresAt: toolResultArtifacts.expiresAt,
        })
        .from(toolResultArtifacts)
        .where(eq(toolResultArtifacts.ownerUserId, actor.id))
        .orderBy(desc(toolResultArtifacts.createdAt))
        .limit(Math.max(1, Math.min(limit, 100)));
    },
  };
}

export type ToolResultStore = ReturnType<typeof createToolResultStore>;

/**
 * Keep a small grant set direct. Once it becomes large, replace hundreds of schemas with a
 * searchable catalogue and one dispatcher that still calls the original governed executor.
 */
export function compactToolCatalog(options: {
  tools: GrantedTool[];
  actor: AgentActor;
  agentId: string;
  run?: ToolRunContext;
  results: ToolResultStore;
  directLimit?: number;
}): GrantedTool[] {
  const directLimit = Math.max(1, options.directLimit ?? DIRECT_TOOL_LIMIT);
  const byName = new Map(options.tools.map((tool) => [tool.name, tool]));
  const bounded = (tool: GrantedTool): GrantedTool => ({
    ...tool,
    execute: async (args, execution) =>
      boundResult(await tool.execute(args, execution), tool.name, options),
  });
  if (options.tools.length <= directLimit) return options.tools.map(bounded);

  return [
    {
      name: "openbot_tool_search",
      description:
        "Search the names and descriptions of tools this coworker is allowed to use. Use before describe or call.",
      parameters: z.object({
        query: z.string().min(1).max(200),
        limit: z.number().int().min(1).max(10).optional(),
      }),
      execute: async (args) => {
        const parsed = z
          .object({ query: z.string(), limit: z.number().optional() })
          .parse(args);
        return JSON.stringify(
          searchTools(options.tools, parsed.query, parsed.limit ?? 6),
        );
      },
    },
    {
      name: "openbot_tool_describe",
      description:
        "Read the input schema for one granted tool returned by openbot_tool_search.",
      parameters: z.object({ name: z.string().min(1).max(240) }),
      execute: async (args) => {
        const { name } = z.object({ name: z.string() }).parse(args);
        const tool = byName.get(name);
        if (!tool)
          return "That tool is not in this coworker's granted catalogue.";
        return JSON.stringify({
          name: tool.name,
          description: tool.description,
          parameters: z.toJSONSchema(tool.parameters),
        });
      },
    },
    {
      name: "openbot_tool_call",
      description:
        "Call one granted tool by exact name. The original grant, policy, approval, credential, and audit path still decides the action.",
      parameters: z.object({
        name: z.string().min(1).max(240),
        arguments: z.record(z.string(), z.unknown()).optional(),
      }),
      execute: async (args, execution) => {
        const parsed = z
          .object({
            name: z.string(),
            arguments: z.record(z.string(), z.unknown()).optional(),
          })
          .parse(args);
        const tool = byName.get(parsed.name);
        if (!tool)
          return "That tool is not in this coworker's granted catalogue.";
        return boundResult(
          await tool.execute(parsed.arguments ?? {}, execution),
          tool.name,
          options,
        );
      },
    },
  ];
}

export function searchTools(tools: GrantedTool[], query: string, limit = 6) {
  const terms = tokens(query);
  return tools
    .map((tool) => {
      const name = tool.name.toLocaleLowerCase();
      const description = tool.description.toLocaleLowerCase();
      const score = terms.reduce((total, term) => {
        if (name === term) return total + 20;
        return (
          total +
          (name.includes(term) ? 8 : 0) +
          (description.includes(term) ? 3 : 0)
        );
      }, 0);
      return { name: tool.name, description: tool.description, score };
    })
    .filter((tool) => tool.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score || left.name.localeCompare(right.name),
    )
    .slice(0, Math.max(1, Math.min(limit, 10)))
    .map(({ score: _score, ...tool }) => tool);
}

async function boundResult(
  result: string,
  toolName: string,
  options: {
    actor: AgentActor;
    agentId: string;
    run?: ToolRunContext;
    results: ToolResultStore;
  },
) {
  if (Array.from(result).length <= PROMPT_RESULT_LIMIT) return result;
  const artifact = await options.results.save({
    actor: options.actor,
    agentId: options.agentId,
    toolName,
    ...(options.run ? { run: options.run } : {}),
    content: result,
  });
  const head = Array.from(result)
    .slice(0, PROMPT_RESULT_LIMIT - 700)
    .join("");
  return [
    head,
    "",
    `[Result bounded for context safety. Full result ${artifact.contentHash.slice(0, 12)} is available at /api/autonomy/tool-results/${artifact.id}.]`,
  ].join("\n");
}

function tokens(value: string) {
  return [
    ...new Set(
      value
        .toLocaleLowerCase()
        .split(/[^a-z0-9_-]+/)
        .filter((term) => term.length > 1),
    ),
  ];
}

function compactPreview(value: string) {
  const text = value.replace(/\s+/g, " ").trim();
  return Array.from(text).slice(0, 280).join("");
}

async function hash(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Buffer.from(digest).toString("hex");
}

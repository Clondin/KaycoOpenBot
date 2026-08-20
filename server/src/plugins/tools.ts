import { z } from "zod";
import type { ApprovalService } from "../approvals/store";
import {
  PluginApprovalRequiredError,
  PluginRefusedError,
  type PluginStore,
} from "./store";

/**
 * The tools a Bot may call, as the runtime's own tool definitions, executed on the server.
 *
 * The loop used to run in the browser: every MCP tool was registered with `useFrontendTool` and its
 * handler posted back to `/api/plugins/call`. That made a browser a hard requirement for a Bot to do
 * anything, which rules out an embedded widget, a run nobody is watching, and any surface that is
 * not our own app.
 *
 * Nothing about governance moves with it. `callTool` is still the only path to a vendor: it checks
 * the grant, evaluates the policy, writes the audit row, and only then calls out. This module hands
 * the model a description of what it may call; the store remains what decides whether a call happens.
 *
 * Read at run time rather than captured, so a grant an administrator adds or revokes applies to the
 * next run rather than after a restart.
 */
/**
 * What a refused call answers with.
 *
 * The transcript draws a refusal differently from a result, and it has only the tool's answer to go
 * on. Guessing from the wording would break the first time an administrator rephrased a policy
 * message, so the answer says which it is. The model reads this too, and "Refused." in front of a
 * reason is what it should be told anyway.
 */
export const REFUSAL_MARKER = "Refused.";

export type GrantedTool = {
  name: string;
  description: string;
  parameters: z.ZodType;
  execute: (
    args: unknown,
    execution?: { abortSignal?: AbortSignal },
  ) => Promise<string>;
};

/** Durable task identity supplied by the authenticated OpenBot surface, never by a model prompt. */
export type ToolRunContext = { runId?: string; channelId?: string };

/** Read the authenticated surface's durable task pair; partial or oversized input is discarded. */
export function toolRunContext(forwardedProps: unknown): ToolRunContext {
  if (!forwardedProps || typeof forwardedProps !== "object") return {};
  const props = forwardedProps as Record<string, unknown>;
  const runId = boundedId(props.openbotTaskRunId);
  const channelId = boundedId(props.openbotChannelId);
  return runId && channelId ? { runId, channelId } : {};
}

function boundedId(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 200
    ? value
    : undefined;
}

const APPROVAL_WAIT_MS = 10 * 60_000;
const APPROVAL_POLL_MS = 1_000;

type ToolCallInput = Parameters<PluginStore["callTool"]>[0];

/**
 * Call once, pause on a real approval request, and retry once with that exact approved request.
 *
 * Keeping this beside the server-side adapter gives built-in, Codex and remote callback agents the
 * same behavior. The store remains the authority: it validates the durable run, fingerprints the
 * action, creates the request and atomically consumes it on the retry.
 */
export async function callToolWithApproval(options: {
  store: PluginStore;
  approvals?: ApprovalService;
  input: ToolCallInput;
  signal?: AbortSignal;
  /** Shorter values are injected only by unit tests. */
  waitMs?: number;
  pollMs?: number;
}) {
  const { store, approvals, input, signal } = options;
  try {
    return await store.callTool(input);
  } catch (error) {
    if (!(error instanceof PluginApprovalRequiredError)) throw error;

    // Unscoped requests have nowhere in the task UI to appear. Fail closed instead of holding an
    // invisible call open for ten minutes.
    if (!approvals || !input.runId) {
      throw new PluginRefusedError(
        "This tool call requires approval, but it is not running inside a durable task.",
        error.request.policyRule,
      );
    }

    const deadline =
      Date.now() + Math.max(0, options.waitMs ?? APPROVAL_WAIT_MS);
    const pollMs = Math.max(0, options.pollMs ?? APPROVAL_POLL_MS);
    while (Date.now() <= deadline) {
      if (signal?.aborted) {
        throw new PluginRefusedError(
          "The approval wait was stopped.",
          error.request.policyRule,
        );
      }

      const request = await approvals.get(
        { id: input.actorId, role: input.actorRole ?? "user" },
        error.request.id,
      );
      if (request?.status === "approved") {
        return store.callTool({
          ...input,
          approvalId: request.id,
        });
      }
      if (request?.status === "declined") {
        throw new PluginRefusedError(
          "The person declined this tool call.",
          request.policyRule,
        );
      }
      if (
        !request ||
        request.status === "expired" ||
        request.status === "cancelled"
      ) {
        throw new PluginRefusedError(
          "The approval request expired before it was decided.",
          request?.policyRule ?? error.request.policyRule,
        );
      }

      await wait(pollMs, signal);
    }

    throw new PluginRefusedError(
      "The approval request expired before it was decided.",
      error.request.policyRule,
    );
  }
}

function wait(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted || delayMs === 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, delayMs);
    signal?.addEventListener("abort", finish, { once: true });

    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    }
  });
}

/**
 * A vendor's JSON Schema as something the model can be handed.
 *
 * Anything that is not an object schema describes something other than a tool's arguments, and a
 * schema we cannot read must not stop the tool being offered: an open object lets the model call it
 * and lets the vendor be the one to reject a bad argument, which is where that error belongs.
 */
export function parametersFor(inputSchema: Record<string, unknown>): z.ZodType {
  try {
    const converted = z.fromJSONSchema(inputSchema as never);
    if (converted instanceof z.ZodObject) return converted;
  } catch {}
  return z.object({}).catchall(z.unknown());
}

/**
 * Every MCP tool granted to one Bot, ready to hand to the runtime.
 *
 * A refusal is returned as the tool's result rather than thrown. The model is mid-run and the person
 * is owed a sentence about what was blocked; an exception here ends the run with nothing said, and
 * the refusal is already in the audit trail either way.
 */
export async function grantedTools(options: {
  store: PluginStore;
  botId: string;
  actorId: string;
  actorRole?: "admin" | "user";
  run?: ToolRunContext;
  approvals?: ApprovalService;
}): Promise<GrantedTool[]> {
  const { store, botId, actorId, actorRole, run, approvals } = options;
  const granted = await store.listForAgent(botId);

  return granted.tools.map((tool) => ({
    name: tool.toolName,
    description: tool.description,
    parameters: parametersFor(tool.inputSchema),
    execute: async (args: unknown, execution) => {
      try {
        const result = await callToolWithApproval({
          store,
          approvals,
          input: {
            ref: tool.ref,
            // The runtime hands through whatever the model produced. Anything that is not an object
            // is not a set of arguments, and the vendor should be the one to say so.
            args:
              args && typeof args === "object" && !Array.isArray(args)
                ? (args as Record<string, unknown>)
                : {},
            botId,
            actorId,
            ...(actorRole ? { actorRole } : {}),
            ...(run?.runId ? { runId: run.runId } : {}),
            ...(run?.channelId ? { channelId: run.channelId } : {}),
          },
          ...(execution?.abortSignal ? { signal: execution.abortSignal } : {}),
        });
        return result.text;
      } catch (error) {
        if (error instanceof PluginRefusedError) {
          return `${REFUSAL_MARKER} ${error.message}`;
        }
        // A vendor that failed is not a refusal, and the difference matters to the person reading
        // the answer: one means "not allowed", the other means "it broke".
        return error instanceof Error
          ? `That tool could not be called: ${error.message}`
          : "That tool could not be called.";
      }
    },
  }));
}

import {
  AbstractAgent,
  type BaseEvent,
  type RunAgentInput,
} from "@ag-ui/client";
import { Observable } from "rxjs";
import { z } from "zod";
import type { DeploymentConfig } from "../config";
import {
  type GrantedTool,
  toolRunContext,
  type ToolRunContext,
} from "../plugins/tools";
import {
  CODEX_REQUEST_NOT_HANDLED,
  type CodexAgentClient,
  type CodexClientLeaseManager,
  CodexRpcError,
} from "./protocol";
import type { CodexThreadStore } from "./thread-store";
import type { CodexPreferences } from "./preferences";

type ThreadResponse = { thread: { id: string } };
type TurnResponse = { turn: { id: string } };
type DynamicToolCall = {
  threadId?: string;
  turnId?: string;
  callId?: string;
  tool?: string;
  arguments?: unknown;
};

export type CodexAgentOptions = {
  userId: string;
  agentId: string;
  name: string;
  systemPrompt: string;
  manager: CodexClientLeaseManager;
  threadStore: CodexThreadStore;
  config: NonNullable<DeploymentConfig["codex"]>;
  preferences?: CodexPreferences;
  /** Governed deployment tools execute here; browser and component tools stay with the surface. */
  tools?: GrantedTool[];
  /** Preferred over `tools`: reloads grants and binds approvals to this durable task. */
  loadTools?: (run?: ToolRunContext) => Promise<GrantedTool[]>;
};

/** AG-UI adapter for a built-in coworker driven by the signed-in person's Codex subscription. */
export class CodexAgent extends AbstractAgent {
  constructor(private readonly options: CodexAgentOptions) {
    super({ agentId: options.agentId, description: options.name });
  }

  /** Preserve the per-user App Server dependencies in CopilotKit's per-request clone. */
  override clone(): this {
    return Object.assign(super.clone(), { options: this.options }) as this;
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      let settled = false;
      let active:
        | { client: CodexAgentClient; threadId: string; turnId?: string }
        | undefined;

      subscriber.next({
        type: "RUN_STARTED",
        threadId: input.threadId,
        runId: input.runId,
      } as BaseEvent);

      void this.options.manager
        .withClient(this.options.userId, async (client) => {
          const tools = this.options.loadTools
            ? await this.options.loadTools(toolRunContext(input.forwardedProps))
            : (this.options.tools ?? []);
          const session = await this.thread(client, input, tools);
          active = { client, threadId: session.threadId };
          await this.turn(
            client,
            input,
            session,
            (turnId) => {
              active = { client, threadId: session.threadId, turnId };
            },
            subscriber,
            tools,
          );
        })
        .then(() => {
          settled = true;
          if (subscriber.closed) return;
          subscriber.next({
            type: "RUN_FINISHED",
            threadId: input.threadId,
            runId: input.runId,
          } as BaseEvent);
          subscriber.complete();
        })
        .catch((error) => {
          if (active?.turnId) {
            void active.client
              .request("turn/interrupt", {
                threadId: active.threadId,
                turnId: active.turnId,
              })
              .catch(() => undefined);
          }
          settled = true;
          if (subscriber.closed) return;
          subscriber.next({
            type: "RUN_ERROR",
            message:
              error instanceof Error
                ? error.message
                : "Codex could not complete this turn.",
          } as BaseEvent);
          subscriber.complete();
        });

      return () => {
        if (settled || !active?.turnId) return;
        void active.client
          .request("turn/interrupt", {
            threadId: active.threadId,
            turnId: active.turnId,
          })
          .catch(() => undefined);
      };
    });
  }

  private async thread(
    client: CodexAgentClient,
    input: RunAgentInput,
    tools: GrantedTool[],
  ) {
    const existing = await this.options.threadStore.get(
      this.options.userId,
      this.options.agentId,
      input.threadId,
    );
    if (existing) {
      try {
        await client.request<ThreadResponse>("thread/resume", {
          threadId: existing,
          ...this.threadSettings(),
          dynamicTools: dynamicTools(input, tools),
        });
        return { threadId: existing, restored: true };
      } catch (error) {
        if (!missingThread(error)) throw error;
        // A locally deleted Codex thread is repaired from the AG-UI transcript below.
      }
    }

    const created = await client.request<ThreadResponse>("thread/start", {
      ...this.threadSettings(),
      ephemeral: false,
      dynamicTools: dynamicTools(input, tools),
    });
    if (!created.thread?.id) throw new Error("Codex did not create a thread.");
    await this.options.threadStore.set(
      this.options.userId,
      this.options.agentId,
      input.threadId,
      created.thread.id,
    );
    return { threadId: created.thread.id, restored: false };
  }

  private threadSettings() {
    const model =
      this.options.preferences?.model ?? this.options.config.defaultModel;
    return {
      ...(model ? { model } : {}),
      approvalPolicy: "never",
      sandbox: "read-only",
      developerInstructions: [
        this.options.systemPrompt,
        "You are running as a coworker inside OpenBot. Use only the tools OpenBot provides. Native shell, file mutation, web search, and external apps are unavailable. When you call an OpenBot tool, stop and wait for its result before continuing.",
      ].join("\n\n"),
      config: {
        web_search: "disabled",
        analytics: { enabled: false },
        feedback: { enabled: false },
        features: {
          apps: false,
          shell_tool: false,
          apply_patch_freeform: false,
          web_search: false,
          web_search_request: false,
        },
      },
    };
  }

  private async turn(
    client: CodexAgentClient,
    input: RunAgentInput,
    session: { threadId: string; restored: boolean },
    setTurnId: (turnId: string) => void,
    subscriber: { closed: boolean; next(event: BaseEvent): void },
    tools: GrantedTool[],
  ) {
    let turnId: string | undefined;
    let messageId: string | undefined;
    let textOpen = false;
    let reasoningMessageId: string | undefined;
    let reasoningOpen = false;
    let reasoningHasContent = false;
    let reasoningSegment: string | undefined;
    let delegatedTool = false;
    let resolveCompleted!: () => void;
    let rejectCompleted!: (error: Error) => void;
    const completed = new Promise<void>((resolve, reject) => {
      resolveCompleted = resolve;
      rejectCompleted = reject;
    });

    const closeText = () => {
      if (!textOpen || !messageId || subscriber.closed) return;
      subscriber.next({ type: "TEXT_MESSAGE_END", messageId } as BaseEvent);
      textOpen = false;
    };

    const closeReasoning = () => {
      if (!reasoningOpen || !reasoningMessageId || subscriber.closed) return;
      subscriber.next({
        type: "REASONING_MESSAGE_END",
        messageId: reasoningMessageId,
      } as BaseEvent);
      subscriber.next({
        type: "REASONING_END",
        messageId: reasoningMessageId,
      } as BaseEvent);
      reasoningOpen = false;
      reasoningMessageId = undefined;
      reasoningHasContent = false;
      reasoningSegment = undefined;
    };

    const appendReasoning = (
      itemId: string,
      segment: string,
      delta: string,
    ) => {
      const nextMessageId = `codex-reasoning-${itemId}`;
      if (reasoningOpen && reasoningMessageId !== nextMessageId) {
        closeReasoning();
      }
      if (!reasoningOpen) {
        closeText();
        reasoningMessageId = nextMessageId;
        subscriber.next({
          type: "REASONING_START",
          messageId: nextMessageId,
        } as BaseEvent);
        subscriber.next({
          type: "REASONING_MESSAGE_START",
          messageId: nextMessageId,
          role: "reasoning",
        } as BaseEvent);
        reasoningOpen = true;
      }
      if (
        reasoningHasContent &&
        reasoningSegment !== undefined &&
        reasoningSegment !== segment
      ) {
        subscriber.next({
          type: "REASONING_MESSAGE_CONTENT",
          messageId: nextMessageId,
          delta: "\n\n",
        } as BaseEvent);
      }
      subscriber.next({
        type: "REASONING_MESSAGE_CONTENT",
        messageId: nextMessageId,
        delta,
      } as BaseEvent);
      reasoningHasContent = true;
      reasoningSegment = segment;
    };

    const unsubscribeNotification = client.onNotification(
      ({ method, params }) => {
        const event = asRecord(params);
        if (method === "error") {
          if (
            typeof event.threadId === "string" &&
            event.threadId !== session.threadId
          )
            return;
          rejectCompleted(
            new Error(
              typeof event.message === "string"
                ? event.message
                : "Codex App Server reported an error.",
            ),
          );
          return;
        }
        if (event.threadId !== session.threadId) return;
        const eventTurnId = turnIdFrom(event);
        if (turnId && eventTurnId && eventTurnId !== turnId) return;

        if (
          method === "item/reasoning/summaryTextDelta" ||
          method === "item/reasoning/textDelta"
        ) {
          const delta = typeof event.delta === "string" ? event.delta : "";
          if (!delta || subscriber.closed) return;
          const itemId =
            typeof event.itemId === "string" ? event.itemId : input.runId;
          const index =
            method === "item/reasoning/summaryTextDelta"
              ? event.summaryIndex
              : event.contentIndex;
          appendReasoning(
            itemId,
            `${method}:${typeof index === "number" ? index : 0}`,
            delta,
          );
          return;
        }

        if (method === "item/completed") {
          const item = asRecord(event.item);
          if (
            item.type === "reasoning" &&
            (typeof item.id !== "string" ||
              reasoningMessageId === `codex-reasoning-${item.id}`)
          ) {
            closeReasoning();
          }
          return;
        }

        if (method === "item/agentMessage/delta" && !delegatedTool) {
          const delta = typeof event.delta === "string" ? event.delta : "";
          if (!delta || subscriber.closed) return;
          closeReasoning();
          const nextMessageId =
            typeof event.itemId === "string"
              ? event.itemId
              : `codex-message-${input.runId}`;
          if (textOpen && messageId !== nextMessageId) closeText();
          messageId = nextMessageId;
          if (!textOpen) {
            subscriber.next({
              type: "TEXT_MESSAGE_START",
              messageId,
              role: "assistant",
            } as BaseEvent);
            textOpen = true;
          }
          subscriber.next({
            type: "TEXT_MESSAGE_CONTENT",
            messageId,
            delta,
          } as BaseEvent);
          return;
        }

        if (method === "turn/completed") {
          closeReasoning();
          closeText();
          const turn = asRecord(event.turn);
          if (turn.status === "failed") {
            const turnError = asRecord(turn.error);
            rejectCompleted(
              new Error(
                typeof turn.error === "string"
                  ? turn.error
                  : typeof turnError.message === "string"
                    ? turnError.message
                    : "Codex could not complete this turn.",
              ),
            );
          } else {
            resolveCompleted();
          }
        }
      },
    );

    const unsubscribeTool = client.onRequest("item/tool/call", async (raw) => {
      const call = asRecord(raw) as DynamicToolCall;
      if (call.threadId !== session.threadId) return CODEX_REQUEST_NOT_HANDLED;
      if (turnId && call.turnId !== turnId) return CODEX_REQUEST_NOT_HANDLED;
      if (!call.callId || !call.tool) {
        return {
          success: false,
          contentItems: [
            {
              type: "inputText",
              text: "OpenBot received an invalid tool call.",
            },
          ],
        };
      }

      const deploymentTool = tools.find((tool) => tool.name === call.tool);
      delegatedTool = !deploymentTool;
      closeReasoning();
      closeText();
      if (!subscriber.closed) {
        const parentMessageId = messageId ?? `codex-message-${input.runId}`;
        subscriber.next({
          type: "TOOL_CALL_START",
          toolCallId: call.callId,
          toolCallName: call.tool,
          parentMessageId,
        } as BaseEvent);
        subscriber.next({
          type: "TOOL_CALL_ARGS",
          toolCallId: call.callId,
          delta: JSON.stringify(call.arguments ?? {}),
        } as BaseEvent);
        subscriber.next({
          type: "TOOL_CALL_END",
          toolCallId: call.callId,
        } as BaseEvent);
      }

      if (deploymentTool) {
        const content = await deploymentTool.execute(call.arguments ?? {});
        if (!subscriber.closed) {
          subscriber.next({
            type: "TOOL_CALL_RESULT",
            messageId: `${call.callId}-result`,
            toolCallId: call.callId,
            content,
            role: "tool",
          } as BaseEvent);
        }
        return {
          success: true,
          contentItems: [{ type: "inputText", text: content }],
        };
      }

      queueMicrotask(() => {
        if (!call.turnId) return;
        void client
          .request("turn/interrupt", {
            threadId: session.threadId,
            turnId: call.turnId,
          })
          .catch(() => undefined);
      });
      return {
        success: true,
        contentItems: [
          {
            type: "inputText",
            text: "OpenBot delegated this tool to the user's app and will provide the result in the next turn.",
          },
        ],
      };
    });

    try {
      const started = await client.request<TurnResponse>("turn/start", {
        threadId: session.threadId,
        clientUserMessageId: latestMessageId(input),
        input: [
          {
            type: "text",
            text: turnText(input, !session.restored),
            textElements: [],
          },
        ],
        ...(this.options.preferences?.effort
          ? { effort: this.options.preferences.effort }
          : {}),
      });
      turnId = started.turn?.id;
      if (!turnId) throw new Error("Codex did not start a turn.");
      setTurnId(turnId);
      await withTimeout(completed, 15 * 60_000, "Codex turn timed out.");
    } finally {
      unsubscribeNotification();
      unsubscribeTool();
      closeReasoning();
      closeText();
    }
  }
}

function dynamicTools(
  input: RunAgentInput,
  deploymentTools: GrantedTool[] = [],
) {
  const definitions = new Map(
    (input.tools ?? []).map((tool) => [
      tool.name,
      {
        type: "function",
        name: tool.name,
        description: tool.description || `Run the OpenBot ${tool.name} tool.`,
        inputSchema: tool.parameters ?? { type: "object", properties: {} },
        deferLoading: false,
      },
    ]),
  );
  for (const tool of deploymentTools) {
    definitions.set(tool.name, {
      type: "function",
      name: tool.name,
      description: tool.description,
      inputSchema: z.toJSONSchema(tool.parameters),
      deferLoading: false,
    });
  }
  return [...definitions.values()];
}

function latestMessageId(input: RunAgentInput) {
  return input.messages.at(-1)?.id ?? null;
}

function turnText(input: RunAgentInput, includeHistory: boolean) {
  const messages = input.messages.filter(
    (message) =>
      message.role !== "system" &&
      message.role !== "developer" &&
      message.role !== "reasoning",
  );
  const selected = includeHistory ? messages : messages.slice(-1);
  if (selected.length === 0) return "Continue the OpenBot conversation.";
  return selected
    .map((message) => {
      const content = messageText(message.content);
      if (message.role === "tool") {
        return `OpenBot tool result (${message.toolCallId}):\n${content}\n\nContinue using this result.`;
      }
      const label = message.role === "assistant" ? "Assistant" : "User";
      return `${label}: ${content}`;
    })
    .join("\n\n");
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        const record = asRecord(part);
        if (typeof record.text === "string") return record.text;
        return attachmentText(record);
      })
      .filter(Boolean)
      .join("\n");
  }
  return content === null || content === undefined
    ? ""
    : JSON.stringify(content);
}

const MAX_INLINE_ATTACHMENT_CHARACTERS = 100_000;

function attachmentText(part: Record<string, unknown>) {
  const type = typeof part.type === "string" ? part.type : "file";
  const metadata = asRecord(part.metadata);
  const source = asRecord(part.source);
  const filename =
    typeof part.filename === "string"
      ? part.filename
      : typeof metadata.filename === "string"
        ? metadata.filename
        : "attachment";
  const mimeType =
    typeof part.mimeType === "string"
      ? part.mimeType
      : typeof source.mimeType === "string"
        ? source.mimeType
        : "application/octet-stream";
  const data =
    typeof part.data === "string"
      ? part.data
      : source.type === "data" && typeof source.value === "string"
        ? source.value
        : null;

  if (data && mimeType.startsWith("text/")) {
    const decoded = Buffer.from(data, "base64")
      .toString("utf8")
      .slice(0, MAX_INLINE_ATTACHMENT_CHARACTERS);
    return `Attached text file ${filename} (${mimeType}):\n${decoded}`;
  }
  if (["image", "audio", "video", "document", "binary"].includes(type)) {
    return `[Attached ${type}: ${filename} (${mimeType})]`;
  }
  return "";
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function turnIdFrom(event: Record<string, unknown>) {
  if (typeof event.turnId === "string") return event.turnId;
  const turn = asRecord(event.turn);
  return typeof turn.id === "string" ? turn.id : undefined;
}

function missingThread(error: unknown) {
  return (
    error instanceof CodexRpcError &&
    /(?:thread|rollout).*(?:not found|does not exist|missing)|no rollout/i.test(
      error.message,
    )
  );
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

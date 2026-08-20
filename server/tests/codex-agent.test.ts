import { describe, expect, test } from "bun:test";
import type { BaseEvent, RunAgentInput } from "@ag-ui/client";
import { CodexAgent } from "../src/codex/agent";
import type {
  CodexAgentClient,
  CodexClientLeaseManager,
  CodexNotification,
  CodexServerRequestHandler,
} from "../src/codex/protocol";

describe("Codex AG-UI adapter", () => {
  test("starts a locked-down Codex thread and streams its answer as AG-UI", async () => {
    const client = new FakeCodexClient();
    const mappings = new Map<string, string>();
    const agent = new CodexAgent({
      userId: "user-7",
      agentId: "assistant",
      name: "Assistant",
      systemPrompt: "Be useful.",
      manager: manager(client),
      threadStore: {
        get: async (_user, _agent, thread) => mappings.get(thread) ?? null,
        set: async (_user, _agent, thread, codexThread) => {
          mappings.set(thread, codexThread);
        },
      },
      config: {
        executable: "codex",
        homeRoot: "/private/codex",
        idleMs: 10_000,
      },
    });

    const events = await collect(
      agent.run({
        threadId: "intelligence-thread",
        runId: "run-1",
        state: {},
        messages: [{ id: "user-1", role: "user", content: "Hello" }],
        tools: [
          {
            name: "search_records",
            description: "Search records",
            parameters: { type: "object" },
          },
        ],
        context: [],
        forwardedProps: {},
      } as RunAgentInput),
    );

    expect(events.map((event) => event.type)).toEqual([
      "RUN_STARTED",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "RUN_FINISHED",
    ]);
    expect(events[2]).toMatchObject({ delta: "Hello from Codex." });
    const start = client.requests.find(
      (request) => request.method === "thread/start",
    );
    expect(start?.params).toMatchObject({
      approvalPolicy: "never",
      sandbox: "readOnly",
      config: {
        web_search: "disabled",
        features: { shell_tool: false, apply_patch_freeform: false },
      },
      dynamicTools: [
        {
          type: "function",
          name: "search_records",
          inputSchema: { type: "object" },
        },
      ],
    });
    expect(
      client.requests.some((request) => request.method === "turn/interrupt"),
    ).toBe(false);
  });

  test("delegates Codex dynamic tools to the existing browser tool loop", async () => {
    const client = new FakeCodexClient(true);
    const agent = new CodexAgent({
      userId: "user-7",
      agentId: "assistant",
      name: "Assistant",
      systemPrompt: "Be useful.",
      manager: manager(client),
      threadStore: {
        get: async () => null,
        set: async () => undefined,
      },
      config: {
        executable: "codex",
        homeRoot: "/private/codex",
        idleMs: 10_000,
      },
    });

    const events = await collect(
      agent.run({
        threadId: "intelligence-thread",
        runId: "run-tools",
        state: {},
        messages: [{ id: "user-1", role: "user", content: "Search" }],
        tools: [
          {
            name: "search_records",
            description: "Search records",
            parameters: { type: "object" },
          },
        ],
        context: [],
        forwardedProps: {},
      } as RunAgentInput),
    );

    expect(events.map((event) => event.type)).toEqual([
      "RUN_STARTED",
      "TOOL_CALL_START",
      "TOOL_CALL_ARGS",
      "TOOL_CALL_END",
      "RUN_FINISHED",
    ]);
    expect(events[1]).toMatchObject({
      toolCallId: "call-1",
      toolCallName: "search_records",
    });
    expect(events[2]).toMatchObject({ delta: '{"query":"open"}' });
    expect(client.toolResponse).toMatchObject({ success: true });
    expect(
      client.requests.some((request) => request.method === "turn/interrupt"),
    ).toBe(true);
  });
});

function manager(client: CodexAgentClient): CodexClientLeaseManager {
  return {
    withClient: async (_userId, operation) => operation(client),
  };
}

function collect(stream: ReturnType<CodexAgent["run"]>) {
  return new Promise<BaseEvent[]>((resolve, reject) => {
    const events: BaseEvent[] = [];
    stream.subscribe({
      next: (event) => events.push(event),
      error: reject,
      complete: () => resolve(events),
    });
  });
}

class FakeCodexClient implements CodexAgentClient {
  readonly requests: { method: string; params: unknown }[] = [];
  private readonly notifications = new Set<
    (notification: CodexNotification) => void
  >();
  private readonly requestHandlers = new Map<
    string,
    CodexServerRequestHandler
  >();
  toolResponse: unknown;

  constructor(private readonly callTool = false) {}

  async request<T>(method: string, params?: unknown): Promise<T> {
    this.requests.push({ method, params });
    if (method === "thread/start") {
      return { thread: { id: "codex-thread" } } as T;
    }
    if (method === "turn/start") {
      queueMicrotask(async () => {
        if (this.callTool) {
          this.toolResponse = await this.requestHandlers.get(
            "item/tool/call",
          )?.({
            threadId: "codex-thread",
            turnId: "turn-1",
            callId: "call-1",
            tool: "search_records",
            arguments: { query: "open" },
          });
          this.emit("turn/completed", {
            threadId: "codex-thread",
            turn: { id: "turn-1", status: "interrupted" },
          });
          return;
        }
        this.emit("item/agentMessage/delta", {
          threadId: "codex-thread",
          turnId: "turn-1",
          itemId: "message-1",
          delta: "Hello from Codex.",
        });
        this.emit("turn/completed", {
          threadId: "codex-thread",
          turn: { id: "turn-1", status: "completed" },
        });
      });
      return { turn: { id: "turn-1" } } as T;
    }
    return {} as T;
  }

  onNotification(listener: (notification: CodexNotification) => void) {
    this.notifications.add(listener);
    return () => this.notifications.delete(listener);
  }

  onRequest(method: string, handler: CodexServerRequestHandler) {
    this.requestHandlers.set(method, handler);
    return () => this.requestHandlers.delete(method);
  }

  private emit(method: string, params: unknown) {
    for (const listener of this.notifications) listener({ method, params });
  }
}

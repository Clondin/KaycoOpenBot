import { describe, expect, test } from "bun:test";
import type { BaseEvent, RunAgentInput } from "@ag-ui/client";
import { z } from "zod";
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
      preferences: { model: "gpt-5.6", effort: "high" },
    });

    // CopilotKit clones every registered agent before a web request. The clone must retain the
    // App Server manager, thread store, preferences, and tool loader owned by this adapter.
    const requestAgent = agent.clone();
    const events = await collect(
      requestAgent.run({
        threadId: "intelligence-thread",
        runId: "run-1",
        state: {},
        messages: [
          {
            id: "reasoning-old",
            role: "reasoning",
            content: "Do not resend this visible summary as a user message.",
          },
          {
            id: "user-1",
            role: "user",
            content: [
              { type: "text", text: "Hello" },
              {
                type: "document",
                source: {
                  type: "data",
                  value: "Tm90ZXMgZnJvbSB0aGUgZmlsZS4=",
                  mimeType: "text/plain",
                },
                metadata: { filename: "notes.txt" },
              },
            ],
          },
        ],
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
      model: "gpt-5.6",
      approvalPolicy: "never",
      sandbox: "read-only",
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
    const turn = client.requests.find(
      (request) => request.method === "turn/start",
    );
    expect(turn?.params).toMatchObject({
      effort: "high",
      summary: "detailed",
    });
    expect(JSON.stringify(turn?.params)).toContain(
      "Attached text file notes.txt",
    );
    expect(JSON.stringify(turn?.params)).toContain("Notes from the file.");
    expect(JSON.stringify(turn?.params)).not.toContain(
      "Do not resend this visible summary",
    );
    expect(
      client.requests.some((request) => request.method === "turn/interrupt"),
    ).toBe(false);
  });

  test("streams Codex reasoning summaries as first-class AG-UI reasoning", async () => {
    const client = new FakeCodexClient("reasoning");
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

    agent.setMessages([{ id: "user-1", role: "user", content: "Think first" }]);
    const events: BaseEvent[] = [];
    await agent.runAgent(
      { runId: "run-reasoning" },
      { onEvent: ({ event }) => events.push(event) },
    );

    expect(events.map((event) => event.type)).toEqual([
      "RUN_STARTED",
      "REASONING_START",
      "REASONING_MESSAGE_START",
      "REASONING_MESSAGE_CONTENT",
      "REASONING_MESSAGE_CONTENT",
      "REASONING_MESSAGE_CONTENT",
      "REASONING_MESSAGE_END",
      "REASONING_END",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "RUN_FINISHED",
    ]);
    expect(events.slice(3, 6)).toMatchObject([
      { delta: "Checking the request." },
      { delta: "\n\n" },
      { delta: "Choosing a response." },
    ]);
    expect(agent.messages).toContainEqual({
      id: "codex-reasoning-reasoning-1",
      role: "reasoning",
      content: "Checking the request.\n\nChoosing a response.",
    });
  });

  test("delegates Codex dynamic tools to the existing browser tool loop", async () => {
    const client = new FakeCodexClient("surface");
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

  test("executes governed deployment tools on the server and continues the Codex turn", async () => {
    const client = new FakeCodexClient("server");
    let receivedArguments: unknown;
    let receivedRun: unknown;
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
      loadTools: async (run) => {
        receivedRun = run;
        return [
          {
            name: "mcp__notes__search",
            description: "Search governed notes.",
            parameters: z.object({ query: z.string() }),
            execute: async (args) => {
              receivedArguments = args;
              return "Found the governed note.";
            },
          },
        ];
      },
    });

    const events = await collect(
      agent.run({
        threadId: "intelligence-thread",
        runId: "run-server-tools",
        state: {},
        messages: [{ id: "user-1", role: "user", content: "Search" }],
        tools: [
          {
            name: "show_card",
            description: "Draw a card in the app.",
            parameters: { type: "object" },
          },
        ],
        context: [],
        forwardedProps: {
          openbotTaskRunId: "task-7",
          openbotChannelId: "channel-7",
        },
      } as RunAgentInput),
    );

    expect(receivedArguments).toEqual({ query: "open" });
    expect(receivedRun).toEqual({
      runId: "task-7",
      channelId: "channel-7",
    });
    expect(events.map((event) => event.type)).toEqual([
      "RUN_STARTED",
      "TOOL_CALL_START",
      "TOOL_CALL_ARGS",
      "TOOL_CALL_END",
      "TOOL_CALL_RESULT",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "RUN_FINISHED",
    ]);
    expect(events[4]).toMatchObject({
      toolCallId: "call-1",
      content: "Found the governed note.",
    });
    expect(events[6]).toMatchObject({ delta: "Used the server result." });
    expect(client.toolResponse).toMatchObject({
      success: true,
      contentItems: [{ text: "Found the governed note." }],
    });
    expect(
      client.requests.some((request) => request.method === "turn/interrupt"),
    ).toBe(false);
    const start = client.requests.find(
      (request) => request.method === "thread/start",
    );
    expect(start?.params).toMatchObject({
      dynamicTools: [{ name: "show_card" }, { name: "mcp__notes__search" }],
    });
  });

  test("starts a new AG-UI text message when Codex changes message items", async () => {
    const client = new FakeCodexClient("message-switch");
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
    agent.setMessages([{ id: "user-1", role: "user", content: "Hello" }]);
    const events: BaseEvent[] = [];

    await agent.runAgent(
      { runId: "run-message-switch" },
      { onEvent: ({ event }) => events.push(event) },
    );

    expect(events.map((event) => event.type)).toEqual([
      "RUN_STARTED",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "RUN_FINISHED",
    ]);
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

  constructor(
    private readonly callTool:
      | false
      | "surface"
      | "server"
      | "message-switch"
      | "reasoning" = false,
  ) {}

  async request<T>(method: string, params?: unknown): Promise<T> {
    this.requests.push({ method, params });
    if (method === "thread/start") {
      return { thread: { id: "codex-thread" } } as T;
    }
    if (method === "turn/start") {
      queueMicrotask(async () => {
        if (this.callTool === "reasoning") {
          this.emit("item/reasoning/summaryTextDelta", {
            threadId: "codex-thread",
            turnId: "turn-1",
            itemId: "reasoning-1",
            summaryIndex: 0,
            delta: "Checking the request.",
          });
          this.emit("item/reasoning/summaryTextDelta", {
            threadId: "codex-thread",
            turnId: "turn-1",
            itemId: "reasoning-1",
            summaryIndex: 1,
            delta: "Choosing a response.",
          });
          this.emit("item/completed", {
            threadId: "codex-thread",
            turnId: "turn-1",
            item: { id: "reasoning-1", type: "reasoning" },
          });
          this.emit("item/agentMessage/delta", {
            threadId: "codex-thread",
            turnId: "turn-1",
            itemId: "message-1",
            delta: "Done.",
          });
          this.emit("turn/completed", {
            threadId: "codex-thread",
            turn: { id: "turn-1", status: "completed" },
          });
          return;
        }
        if (this.callTool === "message-switch") {
          this.emit("item/agentMessage/delta", {
            threadId: "codex-thread",
            turnId: "turn-1",
            itemId: "message-1",
            delta: "First response.",
          });
          this.emit("item/agentMessage/delta", {
            threadId: "codex-thread",
            turnId: "turn-1",
            itemId: "message-2",
            delta: "Second response.",
          });
          this.emit("turn/completed", {
            threadId: "codex-thread",
            turn: { id: "turn-1", status: "completed" },
          });
          return;
        }
        if (this.callTool) {
          this.toolResponse = await this.requestHandlers.get(
            "item/tool/call",
          )?.({
            threadId: "codex-thread",
            turnId: "turn-1",
            callId: "call-1",
            tool:
              this.callTool === "server"
                ? "mcp__notes__search"
                : "search_records",
            arguments: { query: "open" },
          });
          if (this.callTool === "server") {
            this.emit("item/agentMessage/delta", {
              threadId: "codex-thread",
              turnId: "turn-1",
              itemId: "message-after-tool",
              delta: "Used the server result.",
            });
            this.emit("turn/completed", {
              threadId: "codex-thread",
              turn: { id: "turn-1", status: "completed" },
            });
            return;
          }
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

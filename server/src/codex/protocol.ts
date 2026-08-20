import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";

type RequestId = number | string;
type RpcError = { code: number; message: string; data?: unknown };
type RpcMessage = {
  id?: RequestId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: RpcError;
};

type PendingRequest = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type CodexNotification = { method: string; params: unknown };
export const CODEX_REQUEST_NOT_HANDLED = Symbol("codex-request-not-handled");
export type CodexServerRequestHandler = (
  params: unknown,
) => Promise<unknown | typeof CODEX_REQUEST_NOT_HANDLED> | unknown;

export type CodexAgentClient = Pick<
  CodexAppServerClient,
  "request" | "onNotification" | "onRequest"
>;

export type CodexClientLeaseManager = {
  withClient<T>(
    userId: string,
    operation: (client: CodexAgentClient) => Promise<T>,
  ): Promise<T>;
};

export class CodexRpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(error: RpcError) {
    super(error.message);
    this.name = "CodexRpcError";
    this.code = error.code;
    this.data = error.data;
  }
}

export type CodexProcessOptions = {
  executable: string;
  cwd: string;
  environment: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
};

/**
 * One line-delimited App Server connection.
 *
 * Codex intentionally omits the JSON-RPC `jsonrpc` field. Requests, responses and server-initiated
 * requests all share stdout, so the method/id shape is what decides which direction a message has.
 */
export class CodexAppServerClient {
  private nextId = 1;
  private readonly pending = new Map<RequestId, PendingRequest>();
  private readonly notifications = new Set<
    (notification: CodexNotification) => void
  >();
  private readonly requestHandlers = new Map<
    string,
    Set<CodexServerRequestHandler>
  >();
  private readonly requestTimeoutMs: number;
  private closed = false;
  private readonly exited: Promise<void>;
  private resolveExited!: () => void;

  private constructor(
    private readonly process: ChildProcessWithoutNullStreams,
    requestTimeoutMs: number,
  ) {
    this.requestTimeoutMs = requestTimeoutMs;
    this.exited = new Promise((resolve) => {
      this.resolveExited = resolve;
    });
    const lines = createInterface({ input: process.stdout });
    lines.on("line", (line) => this.receive(line));
    // Drain diagnostics without retaining them: they can contain account or request details.
    process.stderr.resume();
    process.on("error", (error) => this.fail(error));
    process.on("close", (code, signal) => {
      this.fail(
        new Error(
          `Codex App Server stopped${code === null ? "" : ` with code ${code}`}${
            signal ? ` (${signal})` : ""
          }.`,
        ),
      );
      this.resolveExited();
    });
  }

  static async start(options: CodexProcessOptions) {
    const child = spawn(
      options.executable,
      ["app-server", "--listen", "stdio://"],
      {
        cwd: options.cwd,
        env: options.environment,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    const client = new CodexAppServerClient(
      child,
      options.requestTimeoutMs ?? 30_000,
    );
    try {
      await client.request("initialize", {
        clientInfo: {
          name: "openbot",
          title: "OpenBot",
          version: "1.0.0",
        },
        capabilities: { experimentalApi: true },
      });
      client.notify("initialized");
      return client;
    } catch (error) {
      await client.stop();
      throw error;
    }
  }

  request<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    if (this.closed)
      return Promise.reject(new Error("Codex App Server is not running."));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex App Server timed out during ${method}.`));
      }, timeoutMs ?? this.requestTimeoutMs);
      this.pending.set(id, {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      try {
        this.write({ id, method, ...(params === undefined ? {} : { params }) });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params?: unknown) {
    this.write({ method, ...(params === undefined ? {} : { params }) });
  }

  onNotification(listener: (notification: CodexNotification) => void) {
    this.notifications.add(listener);
    return () => this.notifications.delete(listener);
  }

  onRequest(method: string, handler: CodexServerRequestHandler) {
    const handlers = this.requestHandlers.get(method) ?? new Set();
    handlers.add(handler);
    this.requestHandlers.set(method, handlers);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) this.requestHandlers.delete(method);
    };
  }

  async stop() {
    if (!this.closed) {
      this.closed = true;
      this.process.kill();
      this.fail(new Error("Codex App Server was stopped."));
    }
    await Promise.race([
      this.exited,
      new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
    ]);
  }

  private write(message: RpcMessage) {
    if (this.closed || !this.process.stdin.writable) {
      throw new Error("Codex App Server is not running.");
    }
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private receive(line: string) {
    let message: RpcMessage;
    try {
      message = JSON.parse(line) as RpcMessage;
    } catch {
      return;
    }

    if (message.id !== undefined && message.method === undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new CodexRpcError(message.error));
      else pending.resolve(message.result);
      return;
    }

    if (message.method && message.id !== undefined) {
      void this.answerServerRequest(message.id, message.method, message.params);
      return;
    }

    if (message.method) {
      const notification = { method: message.method, params: message.params };
      for (const listener of this.notifications) listener(notification);
    }
  }

  private async answerServerRequest(
    id: RequestId,
    method: string,
    params: unknown,
  ) {
    try {
      let result: unknown = CODEX_REQUEST_NOT_HANDLED;
      for (const handler of this.requestHandlers.get(method) ?? []) {
        result = await handler(params);
        if (result !== CODEX_REQUEST_NOT_HANDLED) break;
      }
      if (result === CODEX_REQUEST_NOT_HANDLED) {
        result = this.failClosedServerRequest(method);
      }
      this.write({ id, result });
    } catch (error) {
      this.write({
        id,
        error: {
          code: -32_603,
          message:
            error instanceof Error
              ? error.message
              : "OpenBot could not handle the Codex request.",
        },
      });
    }
  }

  private failClosedServerRequest(method: string): unknown {
    if (
      method === "item/commandExecution/requestApproval" ||
      method === "item/fileChange/requestApproval"
    ) {
      return { decision: "cancel" };
    }
    if (method === "item/tool/call") {
      return {
        success: false,
        contentItems: [
          { type: "inputText", text: "This tool is not available in OpenBot." },
        ],
      };
    }
    if (method === "item/tool/requestUserInput") return { answers: {} };
    throw new Error(`Unsupported Codex App Server request: ${method}`);
  }

  private fail(error: Error) {
    if (!this.closed) this.closed = true;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }
}

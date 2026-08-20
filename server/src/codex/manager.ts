import { createHash } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { DeploymentConfig } from "../config";
import { CodexAppServerClient } from "./protocol";

export type CodexAccount =
  | { type: "chatgpt"; email: string; planType?: string }
  | { type: "apiKey" }
  | { type: string; [key: string]: unknown };

export type CodexAccountSnapshot = {
  account: CodexAccount | null;
  requiresOpenaiAuth: boolean;
};

export type CodexDeviceLogin = {
  type: "chatgptDeviceCode";
  loginId: string;
  verificationUrl: string;
  userCode: string;
};

type ClientEntry = {
  client: Promise<CodexAppServerClient>;
  leases: number;
  idleTimer?: ReturnType<typeof setTimeout>;
};

const SAFE_INHERITED_ENVIRONMENT = [
  "PATH",
  "Path",
  "PATHEXT",
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "LANG",
  "LC_ALL",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
] as const;

/** One isolated App Server and credential home per OpenBot user. */
export class CodexProcessManager {
  private readonly clients = new Map<string, ClientEntry>();

  constructor(
    private readonly config: NonNullable<DeploymentConfig["codex"]>,
  ) {}

  async withClient<T>(
    userId: string,
    operation: (client: CodexAppServerClient) => Promise<T>,
  ): Promise<T> {
    const entry = this.getOrStart(userId);
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;
    entry.leases += 1;
    try {
      return await operation(await entry.client);
    } finally {
      entry.leases -= 1;
      if (entry.leases === 0) this.scheduleStop(userId, entry);
    }
  }

  account(userId: string, refreshToken = false) {
    return this.withClient(userId, (client) =>
      client.request<CodexAccountSnapshot>("account/read", {
        ...(refreshToken ? { refreshToken: true } : {}),
      }),
    );
  }

  startDeviceLogin(userId: string) {
    return this.withClient(userId, (client) =>
      client.request<CodexDeviceLogin>("account/login/start", {
        type: "chatgptDeviceCode",
      }),
    );
  }

  cancelLogin(userId: string, loginId: string) {
    return this.withClient(userId, (client) =>
      client.request<{ status: string }>("account/login/cancel", { loginId }),
    );
  }

  async logout(userId: string) {
    await this.withClient(userId, (client) =>
      client.request<Record<string, never>>("account/logout"),
    );
    await this.stop(userId);
  }

  rateLimits(userId: string) {
    return this.withClient(userId, (client) =>
      client.request<Record<string, unknown>>("account/rateLimits/read"),
    );
  }

  usage(userId: string) {
    return this.withClient(userId, (client) =>
      client.request<Record<string, unknown>>("account/usage/read"),
    );
  }

  models(userId: string) {
    return this.withClient(userId, (client) =>
      client.request<{ data: unknown[]; nextCursor?: string | null }>(
        "model/list",
        { cursor: null, limit: null, includeHidden: false },
      ),
    );
  }

  async stop(userId: string) {
    const entry = this.clients.get(userId);
    if (!entry) return;
    this.clients.delete(userId);
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    await (await entry.client.catch(() => null))?.stop();
  }

  async stopAll() {
    await Promise.all(
      [...this.clients.keys()].map((userId) => this.stop(userId)),
    );
  }

  private getOrStart(userId: string): ClientEntry {
    const existing = this.clients.get(userId);
    if (existing) return existing;

    const entry: ClientEntry = {
      client: this.start(userId),
      leases: 0,
    };
    entry.client.catch(() => {
      if (this.clients.get(userId) === entry) this.clients.delete(userId);
    });
    this.clients.set(userId, entry);
    return entry;
  }

  private async start(userId: string) {
    const key = createHash("sha256").update(userId).digest("hex");
    const home = join(this.config.homeRoot, key);
    const workspace = join(home, "workspace");
    const temporary = join(home, "tmp");
    await Promise.all([
      mkdir(home, { recursive: true, mode: 0o700 }),
      mkdir(workspace, { recursive: true, mode: 0o700 }),
      mkdir(temporary, { recursive: true, mode: 0o700 }),
    ]);
    if (process.platform !== "win32") {
      await Promise.all([
        chmod(home, 0o700),
        chmod(workspace, 0o700),
        chmod(temporary, 0o700),
      ]);
    }

    const environment: NodeJS.ProcessEnv = {};
    for (const name of SAFE_INHERITED_ENVIRONMENT) {
      if (process.env[name]) environment[name] = process.env[name];
    }
    Object.assign(environment, {
      CODEX_HOME: home,
      HOME: home,
      USERPROFILE: home,
      TMP: temporary,
      TEMP: temporary,
    });

    return CodexAppServerClient.start({
      executable: this.config.executable,
      cwd: workspace,
      environment,
    });
  }

  private scheduleStop(userId: string, entry: ClientEntry) {
    entry.idleTimer = setTimeout(() => {
      if (entry.leases === 0 && this.clients.get(userId) === entry) {
        void this.stop(userId);
      }
    }, this.config.idleMs);
  }
}

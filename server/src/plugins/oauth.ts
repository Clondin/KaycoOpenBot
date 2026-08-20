import {
  auth,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  type CredentialSecretReader,
  type CredentialStore,
  decryptCredentialForUse,
  encryptSecret,
} from "../credentials";
import { createOutboundFetch } from "../network/outbound";

type OAuthSession = {
  version: 1;
  serverId: string;
  initiatedBy: string;
  redirectUrl: string;
  state: string;
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  discovery?: OAuthDiscoveryState;
};

export type McpOAuthVault = CredentialSecretReader &
  Pick<CredentialStore, "create" | "replaceEncryptedValue">;

/** One SDK OAuth provider backed by one encrypted credential row. */
class VaultOAuthProvider implements OAuthClientProvider {
  authorizationUrl?: URL;

  constructor(
    private session: OAuthSession,
    private readonly persist: (session: OAuthSession) => Promise<void>,
  ) {}

  get redirectUrl() {
    return this.session.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.session.redirectUrl],
      client_name: "Kayco OpenBot",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  state() {
    return this.session.state;
  }

  clientInformation() {
    return this.session.clientInformation;
  }

  async saveClientInformation(value: OAuthClientInformationMixed) {
    await this.update({ clientInformation: value });
  }

  tokens() {
    return this.session.tokens;
  }

  async saveTokens(value: OAuthTokens) {
    await this.update({ tokens: value });
  }

  redirectToAuthorization(url: URL) {
    if (url.protocol !== "https:" && url.hostname !== "localhost") {
      throw new Error("The MCP authorization endpoint must use HTTPS.");
    }
    this.authorizationUrl = url;
  }

  async saveCodeVerifier(value: string) {
    await this.update({ codeVerifier: value });
  }

  codeVerifier() {
    if (!this.session.codeVerifier) {
      throw new Error("The MCP OAuth PKCE verifier is missing.");
    }
    return this.session.codeVerifier;
  }

  async saveDiscoveryState(value: OAuthDiscoveryState) {
    await this.update({ discovery: value });
  }

  discoveryState() {
    return this.session.discovery;
  }

  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ) {
    const next = { ...this.session };
    if (scope === "all" || scope === "client") delete next.clientInformation;
    if (scope === "all" || scope === "tokens") delete next.tokens;
    if (scope === "all" || scope === "verifier") delete next.codeVerifier;
    if (scope === "all" || scope === "discovery") delete next.discovery;
    this.session = next;
    await this.persist(next);
  }

  private async update(values: Partial<OAuthSession>) {
    this.session = { ...this.session, ...values };
    await this.persist(this.session);
  }
}

export async function beginMcpOAuth(input: {
  vault: McpOAuthVault;
  encryptionKey: string;
  serverId: string;
  serverUrl: string;
  redirectUrl: string;
  initiatedBy: string;
  credentialId?: string | null;
  allowPrivateHosts?: boolean;
}) {
  const previous = input.credentialId
    ? await loadSession(input.vault, input.encryptionKey, input.credentialId)
    : null;
  const session: OAuthSession = {
    ...previous,
    version: 1,
    serverId: input.serverId,
    initiatedBy: input.initiatedBy,
    redirectUrl: input.redirectUrl,
    state: `${input.serverId}.${randomToken()}`,
  };
  delete session.codeVerifier;
  const credentialId =
    input.credentialId ??
    (
      await input.vault.create({
        kind: "mcp",
        provider: input.serverId,
        keyId: `mcp-oauth-${input.serverId}`,
        metadata: { server: input.serverId, authentication: "oauth" },
        encryptedValue: await encryptSecret(
          input.encryptionKey,
          JSON.stringify(session),
        ),
      })
    ).id;
  if (input.credentialId) {
    await saveSession(input.vault, input.encryptionKey, credentialId, session);
  }
  const provider = providerFor(
    input.vault,
    input.encryptionKey,
    credentialId,
    session,
  );
  const result = await auth(provider, {
    serverUrl: input.serverUrl,
    fetchFn: createOutboundFetch({
      allowPrivateHosts: input.allowPrivateHosts === true,
    }),
  });
  if (result === "AUTHORIZED") {
    return { credentialId, authorizationUrl: null };
  }
  if (!provider.authorizationUrl) {
    throw new Error("The MCP server did not start an interactive OAuth flow.");
  }
  return {
    credentialId,
    authorizationUrl: provider.authorizationUrl.toString(),
  };
}

export async function finishMcpOAuth(input: {
  vault: McpOAuthVault;
  encryptionKey: string;
  credentialId: string;
  serverId: string;
  serverUrl: string;
  state: string;
  code: string;
  initiatedBy: string;
  allowPrivateHosts?: boolean;
}) {
  const session = await loadSession(
    input.vault,
    input.encryptionKey,
    input.credentialId,
  );
  if (
    session.serverId !== input.serverId ||
    session.initiatedBy !== input.initiatedBy ||
    !constantTimeEqual(session.state, input.state)
  ) {
    throw new Error("The MCP OAuth state is invalid or expired.");
  }
  // Consume state before exchanging the code. A failed provider request requires a fresh start,
  // which is safer than leaving a callback replayable after a partial exchange.
  const consumedSession: OAuthSession = {
    ...session,
    state: `${input.serverId}.${randomToken()}`,
  };
  await saveSession(
    input.vault,
    input.encryptionKey,
    input.credentialId,
    consumedSession,
  );
  const provider = providerFor(
    input.vault,
    input.encryptionKey,
    input.credentialId,
    consumedSession,
  );
  const result = await auth(provider, {
    serverUrl: input.serverUrl,
    authorizationCode: input.code,
    fetchFn: createOutboundFetch({
      allowPrivateHosts: input.allowPrivateHosts === true,
    }),
  });
  if (result !== "AUTHORIZED") {
    throw new Error("The MCP OAuth authorization was not completed.");
  }
}

export async function mcpOAuthProvider(input: {
  vault: McpOAuthVault;
  encryptionKey: string;
  credentialId: string;
}) {
  const session = await loadSession(
    input.vault,
    input.encryptionKey,
    input.credentialId,
  );
  return providerFor(
    input.vault,
    input.encryptionKey,
    input.credentialId,
    session,
  );
}

function providerFor(
  vault: McpOAuthVault,
  encryptionKey: string,
  credentialId: string,
  session: OAuthSession,
) {
  return new VaultOAuthProvider(session, (next) =>
    saveSession(vault, encryptionKey, credentialId, next),
  );
}

async function loadSession(
  vault: McpOAuthVault,
  encryptionKey: string,
  credentialId: string,
) {
  const raw = await decryptCredentialForUse(encryptionKey, vault, credentialId);
  const value = JSON.parse(raw) as Partial<OAuthSession>;
  if (
    value.version !== 1 ||
    typeof value.serverId !== "string" ||
    typeof value.initiatedBy !== "string" ||
    typeof value.redirectUrl !== "string" ||
    typeof value.state !== "string"
  ) {
    throw new Error("The MCP OAuth credential is invalid.");
  }
  return value as OAuthSession;
}

async function saveSession(
  vault: McpOAuthVault,
  encryptionKey: string,
  credentialId: string,
  session: OAuthSession,
) {
  await vault.replaceEncryptedValue(
    credentialId,
    await encryptSecret(encryptionKey, JSON.stringify(session)),
  );
}

function randomToken() {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
    "base64url",
  );
}

function constantTimeEqual(left: string, right: string) {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference === 0;
}

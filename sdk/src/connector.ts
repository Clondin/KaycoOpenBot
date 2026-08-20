import {
  requireExtensionId,
  requireLabel,
  requireVersion,
  unique,
} from "./validation";

export const CONNECTOR_API_VERSION = "2026-08-01" as const;

export type ConnectorUpsert = {
  kind: "upsert";
  sourceId: string;
  title: string;
  canonicalUrl: string;
  contentHash: string;
  metadata: Record<string, unknown>;
  chunks: { position: number; content: string; embedding: number[] }[];
  acls: { principal: string; effect: "allow" | "deny" }[];
};

export type ConnectorDelete = {
  kind: "delete";
  sourceId: string;
};

export type ConnectorChange = ConnectorUpsert | ConnectorDelete;

export type ConnectorBatch = {
  changes: ConnectorChange[];
  nextCursor: string | null;
};

export type ConnectorAdapter = {
  discover: (input: {
    cursor: string | null;
    mode: "sync" | "reconcile";
    signal?: AbortSignal;
  }) => Promise<ConnectorBatch>;
};

export type ConnectorManifest = {
  apiVersion: typeof CONNECTOR_API_VERSION;
  id: string;
  name: string;
  version: string;
  description: string;
  /** Hostnames this connector is expected to contact. Wildcards are deliberately unsupported. */
  networkHosts: string[];
  capabilities: {
    incremental: boolean;
    deletions: boolean;
    sourceAcls: boolean;
  };
};

export type ConnectorDefinition<Configuration = unknown> = {
  manifest: ConnectorManifest;
  create: (configuration: Configuration) => ConnectorAdapter;
};

export class ConnectorContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectorContractError";
  }
}

export function defineConnector<Configuration>(
  definition: ConnectorDefinition<Configuration>,
): ConnectorDefinition<Configuration> {
  validateConnectorManifest(definition.manifest);
  return Object.freeze({
    ...definition,
    manifest: Object.freeze({
      ...definition.manifest,
      networkHosts: Object.freeze([
        ...definition.manifest.networkHosts,
      ]) as unknown as string[],
      capabilities: Object.freeze({ ...definition.manifest.capabilities }),
    }),
  });
}

export function validateConnectorManifest(manifest: ConnectorManifest): void {
  if (manifest.apiVersion !== CONNECTOR_API_VERSION) {
    throw new ConnectorContractError(
      `Unsupported connector API ${manifest.apiVersion}; expected ${CONNECTOR_API_VERSION}.`,
    );
  }
  requireExtensionId(manifest.id, "Connector id");
  requireVersion(manifest.version);
  requireLabel(manifest.name, "Connector name");
  requireLabel(manifest.description, "Connector description");
  unique(manifest.networkHosts, "Connector network hosts");
  for (const host of manifest.networkHosts) {
    if (
      !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host) ||
      !host.includes(".") ||
      host.includes("..")
    ) {
      throw new ConnectorContractError(
        `Connector network host ${host} must be an exact public hostname.`,
      );
    }
  }
}

export function validateConnectorBatch(
  batch: ConnectorBatch,
  limits: { maxChanges?: number; maxChunksPerDocument?: number } = {},
): ConnectorBatch {
  const maxChanges = limits.maxChanges ?? 500;
  const maxChunks = limits.maxChunksPerDocument ?? 2_000;
  if (!Array.isArray(batch.changes)) {
    throw new ConnectorContractError(
      "A connector batch needs a changes array.",
    );
  }
  if (batch.changes.length > maxChanges) {
    throw new ConnectorContractError(
      `A connector batch may contain at most ${maxChanges} changes.`,
    );
  }
  if (batch.nextCursor !== null && typeof batch.nextCursor !== "string") {
    throw new ConnectorContractError(
      "A connector cursor must be a string or null.",
    );
  }
  if (batch.nextCursor && Array.from(batch.nextCursor).length > 4_096) {
    throw new ConnectorContractError("A connector cursor is too large.");
  }

  const sourceIds = new Set<string>();
  for (const change of batch.changes) {
    requireLabel(change.sourceId, "Connector source id");
    if (sourceIds.has(change.sourceId)) {
      throw new ConnectorContractError(
        `Source ${change.sourceId} appears more than once in one batch.`,
      );
    }
    sourceIds.add(change.sourceId);
    if (change.kind === "delete") continue;
    requireLabel(change.title, "Document title");
    requireLabel(change.contentHash, "Document content hash");
    const canonical = safeUrl(change.canonicalUrl);
    if (!canonical || !["https:", "http:"].includes(canonical.protocol)) {
      throw new ConnectorContractError(
        `Document ${change.sourceId} needs an http or https canonical URL.`,
      );
    }
    if (change.chunks.length > maxChunks) {
      throw new ConnectorContractError(
        `Document ${change.sourceId} has more than ${maxChunks} chunks.`,
      );
    }
    const positions = change.chunks.map((chunk) => chunk.position);
    if (
      positions.some(
        (position) => !Number.isSafeInteger(position) || position < 0,
      ) ||
      new Set(positions).size !== positions.length
    ) {
      throw new ConnectorContractError(
        `Document ${change.sourceId} has invalid or duplicate chunk positions.`,
      );
    }
    for (const chunk of change.chunks) {
      if (!chunk.content.trim()) {
        throw new ConnectorContractError(
          `Document ${change.sourceId} contains an empty chunk.`,
        );
      }
      if (chunk.embedding.some((value) => !Number.isFinite(value))) {
        throw new ConnectorContractError(
          `Document ${change.sourceId} contains a non-finite embedding value.`,
        );
      }
    }
    for (const acl of change.acls) {
      requireLabel(acl.principal, "ACL principal");
    }
  }
  return batch;
}

function safeUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

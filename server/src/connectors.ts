export type ConnectorStatus = {
  id: string;
  type: "google_drive" | "onedrive";
  name: string;
  roots: string[];
  configured: boolean;
  status?: "pending" | "running" | "succeeded" | "failed";
  lastSyncAt?: string | null;
  nextSyncAt?: string | null;
  lastError?: string | null;
};

export type ConnectorAdminService = {
  list: () => Promise<ConnectorStatus[]>;
  requestSync?: (
    type: ConnectorStatus["type"],
    actorUserId: string,
  ) => Promise<boolean>;
  configureGoogleDrive?: (input: {
    serviceAccountJson: string;
    impersonationSubject: string;
    actorUserId: string;
  }) => Promise<ConnectorStatus>;
};

type KnowledgeSource = {
  type: "google-drive" | "microsoft-onedrive";
  roots: string[];
};

export function createConnectorCatalogService(
  sources: KnowledgeSource[],
): ConnectorAdminService {
  return {
    list: async () =>
      sources.map((source) =>
        source.type === "google-drive"
          ? {
              id: "google-drive",
              type: "google_drive",
              name: "Google Drive",
              roots: source.roots,
              configured: false,
            }
          : {
              id: "microsoft-onedrive",
              type: "onedrive",
              name: "Microsoft OneDrive",
              roots: source.roots,
              configured: false,
            },
      ),
  };
}

export function createConnectorAdminService(
  sources: KnowledgeSource[],
  database: Database,
  credentials: CredentialAdminService,
  audit: AuditStore,
): ConnectorAdminService {
  const catalog = createConnectorCatalogService(sources);
  return {
    /**
     * The catalogue, with each entry told whether this deployment has configured it.
     *
     * `knowledge.yaml` says what a deployment may connect to rather than what it has, so whether a
     * connector is configured is read from the instances table instead.
     */
    list: async () => {
      const instances = new Map(
        (
          await database
            .select({
              type: connectorInstances.type,
              status: connectorInstances.status,
              lastSyncAt: connectorInstances.lastSyncAt,
              nextSyncAt: connectorInstances.nextSyncAt,
              lastError: connectorInstances.lastError,
            })
            .from(connectorInstances)
        ).map((row) => [row.type, row]),
      );
      return (await catalog.list()).map((connector) => {
        const instance = instances.get(connector.type);
        return {
          ...connector,
          configured: Boolean(instance),
          ...(instance
            ? {
                status: instance.status,
                lastSyncAt: instance.lastSyncAt?.toISOString() ?? null,
                nextSyncAt: instance.nextSyncAt?.toISOString() ?? null,
                lastError: instance.lastError,
              }
            : {}),
        };
      });
    },
    configureGoogleDrive: async (input) => {
      const source = sources.find((item) => item.type === "google-drive");
      if (!source)
        throw new Error("Google Drive is not enabled by knowledge.yaml");
      const credential = await credentials.create({
        kind: "connector",
        provider: "google_drive",
        keyId: input.impersonationSubject,
        metadata: {},
        plaintext: input.serviceAccountJson,
        actorUserId: input.actorUserId,
      });
      const sourceMetadata = {
        roots: source.roots,
        impersonationSubject: input.impersonationSubject,
      };
      const [existing] = await database
        .select({ id: connectorInstances.id })
        .from(connectorInstances)
        .where(eq(connectorInstances.type, "google_drive"));
      if (existing) {
        await database
          .update(connectorInstances)
          .set({
            credentialId: credential.id,
            sourceMetadata,
            status: "pending",
            nextSyncAt: new Date(),
            leaseOwner: null,
            leaseExpiresAt: null,
            lastError: null,
            updatedAt: new Date(),
          })
          .where(eq(connectorInstances.id, existing.id));
      } else {
        await database.insert(connectorInstances).values({
          type: "google_drive",
          credentialId: credential.id,
          sourceMetadata,
        });
      }
      return {
        id: "google-drive",
        type: "google_drive",
        name: "Google Drive",
        roots: source.roots,
        configured: true,
        status: "pending",
        lastSyncAt: null,
        nextSyncAt: new Date().toISOString(),
        lastError: null,
      };
    },
    requestSync: async (type, actorUserId) => {
      const [queued] = await database
        .update(connectorInstances)
        .set({ nextSyncAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(connectorInstances.type, type),
            ne(connectorInstances.status, "running"),
          ),
        )
        .returning({ id: connectorInstances.id });
      if (queued) {
        await recordAuditEvent(audit, {
          actorUserId,
          eventType: "connector.sync_requested",
          targetType: "connector",
          targetId: queued.id,
          payload: { type },
        });
      }
      return Boolean(queued);
    },
  };
}

import { and, eq, ne } from "drizzle-orm";
import { type AuditStore, recordAuditEvent } from "./audit";
import type { CredentialAdminService } from "./credentials";
import type { Database } from "./db/client";
import { connectorInstances } from "./db/schema";

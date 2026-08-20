import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { getTableName } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  accounts,
  agentPreferences,
  agentProfiles,
  agents,
  approvalRequests,
  agentVisibility,
  auditEvents,
  channelAgents,
  channelMemberships,
  channels,
  chunks,
  codexThreadMappings,
  codexUserPreferences,
  connectorCursors,
  connectorInstances,
  credentials,
  delegationMessages,
  delegations,
  documentAcls,
  documents,
  intelligenceChannelMappings,
  memoryEntries,
  messageReactions,
  notifications,
  projectAgents,
  projectArtifacts,
  projectMembers,
  projects,
  routineDispatches,
  routines,
  sessions,
  syncRuns,
  taskRunEvents,
  taskRuns,
  userRoles,
  users,
  verifications,
} from "../src/db/schema";

describe("OpenBot database schema", () => {
  test("defines the core runtime records", () => {
    expect(
      [
        users,
        sessions,
        accounts,
        verifications,
        userRoles,
        agents,
        channels,
        channelMemberships,
        channelAgents,
        credentials,
        connectorInstances,
        connectorCursors,
        syncRuns,
        documents,
        chunks,
        codexThreadMappings,
        documentAcls,
        auditEvents,
        intelligenceChannelMappings,
        taskRuns,
        taskRunEvents,
        approvalRequests,
      ].map(getTableName),
    ).toEqual([
      "users",
      "sessions",
      "accounts",
      "verifications",
      "user_roles",
      "agents",
      "channels",
      "channel_memberships",
      "channel_agents",
      "credentials",
      "connector_instances",
      "connector_cursors",
      "sync_runs",
      "documents",
      "chunks",
      "codex_thread_mappings",
      "document_acls",
      "audit_events",
      "intelligence_channel_mappings",
      "task_runs",
      "task_run_events",
      "approval_requests",
    ]);
  });

  test("defines durable shared work and inspectable memory records", () => {
    expect(
      [
        projects,
        projectMembers,
        projectAgents,
        projectArtifacts,
        routines,
        routineDispatches,
        delegations,
        delegationMessages,
        memoryEntries,
        notifications,
      ].map(getTableName),
    ).toEqual([
      "projects",
      "project_members",
      "project_agents",
      "project_artifacts",
      "routines",
      "routine_dispatches",
      "delegations",
      "delegation_messages",
      "memory_entries",
      "notifications",
    ]);

    expect(Object.keys(routines)).toEqual(
      expect.arrayContaining([
        "agentId",
        "channelId",
        "trigger",
        "schedule",
        "webhookTokenHash",
        "nextRunAt",
      ]),
    );
    expect(Object.keys(memoryEntries)).toEqual(
      expect.arrayContaining([
        "ownerUserId",
        "scope",
        "kind",
        "confidence",
        "pinned",
      ]),
    );
  });

  test("keeps document embeddings and ACLs separate from document metadata", () => {
    expect(Object.keys(documents)).toEqual(
      expect.arrayContaining([
        "id",
        "connectorInstanceId",
        "sourceId",
        "canonicalUrl",
      ]),
    );
    expect(Object.keys(chunks)).toEqual(
      expect.arrayContaining(["documentId", "embedding"]),
    );
    expect(Object.keys(documentAcls)).toEqual(
      expect.arrayContaining(["documentId", "principal", "effect"]),
    );
  });

  test("includes Better Auth's verified Google identity records", () => {
    expect(Object.keys(users)).toContain("emailVerified");
    expect(Object.keys(sessions)).toEqual(
      expect.arrayContaining(["ipAddress", "userAgent"]),
    );
    expect(Object.keys(accounts)).toEqual(
      expect.arrayContaining(["userId", "providerId", "accountId"]),
    );
  });

  test("maps each user's Intelligence threads to isolated Codex threads", async () => {
    expect(getTableName(codexThreadMappings)).toBe("codex_thread_mappings");
    const migration = await readFile(
      new URL("../drizzle/0003_codex_thread_mappings.sql", import.meta.url),
      "utf8",
    );
    expect(migration).toContain('CREATE TABLE "codex_thread_mappings"');
    expect(migration).toContain(
      'PRIMARY KEY("user_id","agent_id","intelligence_thread_id")',
    );
  });

  test("stores user Codex choices and channel-scoped reactions", async () => {
    expect([codexUserPreferences, messageReactions].map(getTableName)).toEqual([
      "codex_user_preferences",
      "message_reactions",
    ]);
    const migration = await readFile(
      new URL("../drizzle/0004_stormy_wild_pack.sql", import.meta.url),
      "utf8",
    );
    expect(migration).toContain('CREATE TABLE "codex_user_preferences"');
    expect(migration).toContain('CREATE TABLE "message_reactions"');
    expect(migration).toContain(
      'PRIMARY KEY("channel_id","message_id","emoji","user_id")',
    );
  });

  test("defines the exact agent profile and roster preference contracts", () => {
    expect([agentProfiles, agentPreferences].map(getTableName)).toEqual([
      "agent_profiles",
      "agent_preferences",
    ]);
    expect(agentVisibility.enumName).toBe("agent_visibility");
    expect(agentVisibility.enumValues).toEqual(["public", "private"]);

    const profileConfig = getTableConfig(agentProfiles);
    const preferenceConfig = getTableConfig(agentPreferences);

    expect(
      profileConfig.columns.map((column) => ({
        name: column.name,
        notNull: column.notNull,
        hasDefault: column.hasDefault,
        primary: column.primary,
      })),
    ).toEqual([
      { name: "agent_id", notNull: true, hasDefault: false, primary: true },
      {
        name: "owner_user_id",
        notNull: false,
        hasDefault: false,
        primary: false,
      },
      { name: "title", notNull: true, hasDefault: false, primary: false },
      {
        name: "role_description",
        notNull: true,
        hasDefault: false,
        primary: false,
      },
      {
        name: "avatar_seed",
        notNull: true,
        hasDefault: false,
        primary: false,
      },
      {
        name: "visibility",
        notNull: true,
        hasDefault: false,
        primary: false,
      },
      {
        name: "callback_token_hash",
        notNull: false,
        hasDefault: false,
        primary: false,
      },
      {
        name: "callback_token_issued_at",
        notNull: false,
        hasDefault: false,
        primary: false,
      },
      {
        name: "deleted_at",
        notNull: false,
        hasDefault: false,
        primary: false,
      },
      {
        name: "created_at",
        notNull: true,
        hasDefault: true,
        primary: false,
      },
      {
        name: "updated_at",
        notNull: true,
        hasDefault: true,
        primary: false,
      },
    ]);

    expect(
      preferenceConfig.columns.map((column) => ({
        name: column.name,
        sqlType: column.getSQLType(),
        notNull: column.notNull,
        hasDefault: column.hasDefault,
        primary: column.primary,
      })),
    ).toEqual([
      {
        name: "user_id",
        sqlType: "text",
        notNull: true,
        hasDefault: false,
        primary: false,
      },
      {
        name: "agent_id",
        sqlType: "text",
        notNull: true,
        hasDefault: false,
        primary: false,
      },
      {
        name: "hidden_at",
        sqlType: "timestamp with time zone",
        notNull: false,
        hasDefault: false,
        primary: false,
      },
    ]);

    expect(
      [...profileConfig.foreignKeys, ...preferenceConfig.foreignKeys].map(
        (foreignKey) => {
          const reference = foreignKey.reference();
          return {
            sourceColumns: reference.columns.map((column) => column.name),
            targetTable: getTableName(reference.foreignTable),
            targetColumns: reference.foreignColumns.map(
              (column) => column.name,
            ),
            onDelete: foreignKey.onDelete,
            onUpdate: foreignKey.onUpdate,
          };
        },
      ),
    ).toEqual([
      {
        sourceColumns: ["agent_id"],
        targetTable: "agents",
        targetColumns: ["id"],
        onDelete: "cascade",
        onUpdate: "no action",
      },
      {
        sourceColumns: ["owner_user_id"],
        targetTable: "users",
        targetColumns: ["id"],
        onDelete: "set null",
        onUpdate: "no action",
      },
      {
        sourceColumns: ["user_id"],
        targetTable: "users",
        targetColumns: ["id"],
        onDelete: "cascade",
        onUpdate: "no action",
      },
      {
        sourceColumns: ["agent_id"],
        targetTable: "agents",
        targetColumns: ["id"],
        onDelete: "cascade",
        onUpdate: "no action",
      },
    ]);

    expect(
      preferenceConfig.primaryKeys.map((primaryKey) => ({
        name: primaryKey.getName(),
        columns: primaryKey.columns.map((column) => column.name),
      })),
    ).toEqual([
      {
        name: "agent_preferences_user_id_agent_id_pk",
        columns: ["user_id", "agent_id"],
      },
    ]);

    expect(
      profileConfig.indexes.map((index) => ({
        name: index.config.name,
        columns: index.config.columns.map((column) =>
          "name" in column ? column.name : undefined,
        ),
        unique: index.config.unique,
        method: index.config.method,
      })),
    ).toEqual([
      {
        name: "agent_profiles_visibility_deleted_idx",
        columns: ["visibility", "deleted_at"],
        unique: false,
        method: "btree",
      },
      {
        name: "agent_profiles_callback_token_hash_idx",
        columns: ["callback_token_hash"],
        unique: true,
        method: "btree",
      },
    ]);
  });

  test("keeps the agent profile migration aligned with the schema", async () => {
    const migration = await readFile(
      new URL("../drizzle/0000_schema.sql", import.meta.url),
      "utf8",
    );
    const callbackMigration = await readFile(
      new URL("../drizzle/0005_futuristic_blue_shield.sql", import.meta.url),
      "utf8",
    );
    const normalizedMigration = migration.replace(/\s+/g, " ").trim();
    const normalizedCallbackMigration = callbackMigration
      .replace(/\s+/g, " ")
      .trim();

    expect(normalizedMigration).toContain(
      `CREATE TYPE "public"."agent_visibility" AS ENUM('public', 'private')`,
    );
    expect(normalizedMigration).toContain(
      `"agent_id" text PRIMARY KEY NOT NULL, "owner_user_id" text, "title" text NOT NULL, "role_description" text NOT NULL, "avatar_seed" text NOT NULL, "visibility" "agent_visibility" NOT NULL, "deleted_at" timestamp with time zone, "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL`,
    );
    expect(normalizedMigration).toContain(
      `CREATE TABLE "agent_preferences" ( "user_id" text NOT NULL, "agent_id" text NOT NULL, "hidden_at" timestamp with time zone,`,
    );
    expect(normalizedMigration).toContain(
      `CONSTRAINT "agent_preferences_user_id_agent_id_pk" PRIMARY KEY("user_id","agent_id")`,
    );
    expect(normalizedMigration).toContain(
      `ALTER TABLE "agent_profiles" ADD CONSTRAINT "agent_profiles_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action`,
    );
    expect(normalizedMigration).toContain(
      `ALTER TABLE "agent_profiles" ADD CONSTRAINT "agent_profiles_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action`,
    );
    expect(normalizedMigration).toContain(
      `ALTER TABLE "agent_preferences" ADD CONSTRAINT "agent_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action`,
    );
    expect(normalizedMigration).toContain(
      `ALTER TABLE "agent_preferences" ADD CONSTRAINT "agent_preferences_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action`,
    );
    expect(normalizedMigration).toContain(
      `CREATE INDEX "agent_profiles_visibility_deleted_idx" ON "agent_profiles" USING btree ("visibility","deleted_at")`,
    );
    expect(normalizedCallbackMigration).toContain(
      `ALTER TABLE "agent_profiles" ADD COLUMN "callback_token_hash" text`,
    );
    expect(normalizedCallbackMigration).toContain(
      `ALTER TABLE "agent_profiles" ADD COLUMN "callback_token_issued_at" timestamp with time zone`,
    );
    expect(normalizedCallbackMigration).toContain(
      `CREATE UNIQUE INDEX "agent_profiles_callback_token_hash_idx" ON "agent_profiles" USING btree ("callback_token_hash")`,
    );
  });
});

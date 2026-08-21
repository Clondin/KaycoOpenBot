/**
 * The autonomy layer around a governed OpenBot run.
 *
 * These rows deliberately describe ingress, delivery, review, and routing rather than introducing
 * a second agent runtime. External messages and proactive checks become ordinary task runs, tool
 * calls still pass through Plugins, and anything learned remains a proposal until a person applies
 * it. That keeps the security boundary in OpenBot while adding the useful always-on parts of an
 * assistant gateway.
 */
import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agents, channels, credentials, users } from "./core";
import { jsonb } from "./json";
import { skills } from "./plugins";
import { taskRuns } from "./runs";
import { memoryEntries } from "./work";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

/** One reviewed bridge between an external chat surface and one OpenBot coworker/channel. */
export const externalChannelConnections = pgTable(
  "external_channel_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    /** A bot token or provider-specific JSON envelope, encrypted by the existing vault. */
    credentialId: uuid("credential_id").references(() => credentials.id, {
      onDelete: "set null",
    }),
    /** Hash of the inbound secret. The plaintext is returned once when the bridge is created. */
    inboundSecretHash: text("inbound_secret_hash").notNull(),
    status: text("status").notNull().default("active"),
    config: jsonb("config").notNull().default({}),
    lastInboundAt: timestamp("last_inbound_at", { withTimezone: true }),
    lastOutboundAt: timestamp("last_outbound_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("external_connections_owner_status_idx").on(
      table.ownerUserId,
      table.status,
    ),
    index("external_connections_channel_idx").on(table.channelId),
  ],
);

/** Explicit pairing: unknown external identities never inherit the connection owner's authority. */
export const externalIdentityLinks = pgTable(
  "external_identity_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => externalChannelConnections.id, {
        onDelete: "cascade",
      }),
    externalUserId: text("external_user_id").notNull(),
    externalConversationId: text("external_conversation_id"),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("active"),
    label: text("label").notNull().default(""),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("external_identity_connection_user_idx").on(
      table.connectionId,
      table.externalUserId,
    ),
    index("external_identity_openbot_user_idx").on(table.userId),
  ],
);

/** Durable idempotency receipt and outbox item for a message crossing a bridge. */
export const externalMessages = pgTable(
  "external_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => externalChannelConnections.id, {
        onDelete: "cascade",
      }),
    direction: text("direction").notNull(),
    externalMessageId: text("external_message_id"),
    externalUserId: text("external_user_id"),
    externalConversationId: text("external_conversation_id").notNull(),
    taskRunId: uuid("task_run_id").references(() => taskRuns.id, {
      onDelete: "set null",
    }),
    body: text("body").notNull(),
    metadata: jsonb("metadata").notNull().default({}),
    status: text("status").notNull().default("pending"),
    attempt: integer("attempt").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    lastError: text("last_error"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("external_message_provider_id_idx").on(
      table.connectionId,
      table.direction,
      table.externalMessageId,
    ),
    index("external_message_task_idx").on(table.taskRunId),
    index("external_message_outbox_idx").on(
      table.direction,
      table.status,
      table.nextAttemptAt,
    ),
  ],
);

/** Hash-bound draft produced by self-learning; applying it is a separate, audited decision. */
export const skillProposals = pgTable(
  "skill_proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sourceRunId: uuid("source_run_id").references(() => taskRuns.id, {
      onDelete: "set null",
    }),
    targetSkillId: text("target_skill_id").references(() => skills.id, {
      onDelete: "set null",
    }),
    operation: text("operation").notNull(),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    instructions: text("instructions").notNull(),
    status: text("status").notNull().default("pending"),
    baseHash: text("base_hash"),
    proposalHash: text("proposal_hash").notNull(),
    evidence: jsonb("evidence").notNull().default({}),
    scan: jsonb("scan").notNull().default({}),
    appliedSkillId: text("applied_skill_id").references(() => skills.id, {
      onDelete: "set null",
    }),
    reviewedByUserId: text("reviewed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("skill_proposals_owner_status_idx").on(
      table.ownerUserId,
      table.status,
      table.createdAt,
    ),
    index("skill_proposals_source_run_idx").on(table.sourceRunId),
  ],
);

/** A possible memory remains reviewable before it enters the prompt-building memory store. */
export const memorySuggestions = pgTable(
  "memory_suggestions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sourceRunId: uuid("source_run_id").references(() => taskRuns.id, {
      onDelete: "set null",
    }),
    scope: text("scope").notNull(),
    kind: text("kind").notNull(),
    agentId: text("agent_id").references(() => agents.id, {
      onDelete: "cascade",
    }),
    title: text("title").notNull(),
    content: text("content").notNull(),
    confidence: integer("confidence").notNull().default(70),
    status: text("status").notNull().default("pending"),
    promotedMemoryId: uuid("promoted_memory_id").references(
      () => memoryEntries.id,
      { onDelete: "set null" },
    ),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("memory_suggestions_owner_status_idx").on(
      table.ownerUserId,
      table.status,
      table.createdAt,
    ),
  ],
);

/** Per-person fallback policy. A null agent id is the person's deployment default. */
export const modelRoutes = pgTable(
  "model_routes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agentId: text("agent_id").references(() => agents.id, {
      onDelete: "cascade",
    }),
    name: text("name").notNull().default("Default route"),
    candidates: jsonb("candidates").notNull().default({ items: [] }),
    retryableCodes: jsonb("retryable_codes").notNull().default({ items: [] }),
    status: text("status").notNull().default("active"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("model_routes_owner_agent_idx").on(table.ownerUserId, table.agentId),
  ],
);

/** One visible routing decision for an unattended run. No credential or prompt is stored here. */
export const modelRouteAttempts = pgTable(
  "model_route_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    routeId: uuid("route_id").references(() => modelRoutes.id, {
      onDelete: "set null",
    }),
    taskRunId: uuid("task_run_id")
      .notNull()
      .references(() => taskRuns.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    outcome: text("outcome").notNull(),
    errorCode: text("error_code"),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("model_route_attempt_run_ordinal_idx").on(
      table.taskRunId,
      table.ordinal,
    ),
  ],
);

/** Full, addressable result for a tool response whose prompt-facing view was bounded. */
export const toolResultArtifacts = pgTable(
  "tool_result_artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    taskRunId: uuid("task_run_id").references(() => taskRuns.id, {
      onDelete: "cascade",
    }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    toolName: text("tool_name").notNull(),
    contentHash: text("content_hash").notNull(),
    preview: text("preview").notNull(),
    content: text("content").notNull(),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (table) => [
    index("tool_result_artifacts_owner_created_idx").on(
      table.ownerUserId,
      table.createdAt,
    ),
    index("tool_result_artifacts_run_idx").on(table.taskRunId),
  ],
);

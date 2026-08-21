/**
 * Continuity primitives inspired by Hermes, implemented inside OpenBot's trust boundaries.
 *
 * Conversation rows are a derived, owner-scoped recall index. Intelligence remains the canonical
 * transcript. Programs still call the ordinary granted tool executors, and bundles intentionally
 * contain configuration rather than credentials, grants, history, or memory.
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
import { channels, users } from "./core";
import { jsonb } from "./json";
import { skills } from "./plugins";
import { taskRuns } from "./runs";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

/** Searchable projection of a person's Intelligence transcript. */
export const continuityMessages = pgTable(
  "continuity_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    threadId: text("thread_id").notNull(),
    messageId: text("message_id").notNull(),
    agentId: text("agent_id"),
    role: text("role").notNull(),
    content: text("content").notNull(),
    contentHash: text("content_hash").notNull(),
    /** Jump target and source metadata; never trusted as authorization. */
    anchor: jsonb("anchor").notNull().default({}),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    indexedAt: createdAt(),
  },
  (table) => [
    uniqueIndex("continuity_messages_owner_thread_message_key").on(
      table.ownerUserId,
      table.threadId,
      table.messageId,
    ),
    index("continuity_messages_owner_channel_time_idx").on(
      table.ownerUserId,
      table.channelId,
      table.occurredAt,
    ),
  ],
);

/** Inspectable context compaction/recovery point; never replaces the original transcript. */
export const continuitySnapshots = pgTable(
  "continuity_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    threadId: text("thread_id").notNull(),
    throughMessageId: text("through_message_id").notNull(),
    summary: text("summary").notNull(),
    anchors: jsonb("anchors").notNull().default({ items: [] }),
    tokenEstimate: integer("token_estimate").notNull().default(0),
    sourceMessageCount: integer("source_message_count").notNull().default(0),
    createdAt: createdAt(),
  },
  (table) => [
    index("continuity_snapshots_owner_channel_created_idx").on(
      table.ownerUserId,
      table.channelId,
      table.createdAt,
    ),
  ],
);

/** Reviewed, reusable sequence of already-granted tools. */
export const toolPrograms = pgTable(
  "tool_programs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agentId: text("agent_id").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    steps: jsonb("steps").notNull().default({ items: [] }),
    status: text("status").notNull().default("draft"),
    revision: integer("revision").notNull().default(1),
    reviewedByUserId: text("reviewed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("tool_programs_owner_agent_name_key").on(
      table.ownerUserId,
      table.agentId,
      table.name,
    ),
    index("tool_programs_owner_status_idx").on(table.ownerUserId, table.status),
  ],
);

/** One bounded execution; intermediate results are retained here, not injected into model context. */
export const toolProgramRuns = pgTable(
  "tool_program_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    programId: uuid("program_id").references(() => toolPrograms.id, {
      onDelete: "set null",
    }),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agentId: text("agent_id").notNull(),
    taskRunId: uuid("task_run_id").references(() => taskRuns.id, {
      onDelete: "set null",
    }),
    status: text("status").notNull(),
    stepNames: jsonb("step_names").notNull().default({ items: [] }),
    trace: jsonb("trace").notNull().default({ items: [] }),
    output: text("output"),
    error: text("error"),
    createdAt: createdAt(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    index("tool_program_runs_owner_created_idx").on(
      table.ownerUserId,
      table.createdAt,
    ),
  ],
);

/** Immutable skill ledger for provenance, pinning, and rollback. */
export const skillVersions = pgTable(
  "skill_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    skillId: text("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    contentHash: text("content_hash").notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    instructions: text("instructions").notNull(),
    provenance: jsonb("provenance").notNull().default({}),
    scan: jsonb("scan").notNull().default({}),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("skill_versions_skill_version_key").on(
      table.skillId,
      table.version,
    ),
    index("skill_versions_hash_idx").on(table.contentHash),
  ],
);

export const skillUsageEvents = pgTable(
  "skill_usage_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    skillId: text("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    agentId: text("agent_id"),
    channelId: text("channel_id").references(() => channels.id, {
      onDelete: "set null",
    }),
    taskRunId: uuid("task_run_id").references(() => taskRuns.id, {
      onDelete: "set null",
    }),
    outcome: text("outcome").notNull().default("invoked"),
    usedAt: createdAt(),
  },
  (table) => [
    index("skill_usage_owner_used_idx").on(table.ownerUserId, table.usedAt),
    index("skill_usage_skill_used_idx").on(table.skillId, table.usedAt),
  ],
);

/** Portable Bot configuration. Secrets, grants, transcripts, and memory are forbidden by service validation. */
export const botBundles = pgTable(
  "bot_bundles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    version: integer("version").notNull().default(1),
    manifest: jsonb("manifest").notNull().default({}),
    contentHash: text("content_hash").notNull(),
    status: text("status").notNull().default("active"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("bot_bundles_owner_name_version_key").on(
      table.ownerUserId,
      table.name,
      table.version,
    ),
    index("bot_bundles_owner_status_idx").on(table.ownerUserId, table.status),
  ],
);

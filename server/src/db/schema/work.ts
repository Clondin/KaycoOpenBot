/**
 * Durable team work: projects, routines, delegations, scoped memory, and notifications.
 *
 * Conversations remain in Intelligence and individual attempts remain in task_runs. These tables
 * describe the work around those attempts so schedules, handoffs, and shared results survive a
 * browser closing or the API process restarting.
 */
import {
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agents, channels, users } from "./core";
import { jsonb } from "./json";
import { taskRuns } from "./runs";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export const projectStatus = pgEnum("project_status", ["active", "archived"]);
export const projectMemberRole = pgEnum("project_member_role", [
  "owner",
  "editor",
  "viewer",
]);
export const routineStatus = pgEnum("routine_status", [
  "active",
  "paused",
  "archived",
]);
export const routineTrigger = pgEnum("routine_trigger", [
  "manual",
  "schedule",
  "webhook",
]);
export const delegationStatus = pgEnum("delegation_status", [
  "queued",
  "accepted",
  "in_progress",
  "completed",
  "failed",
  "cancelled",
]);
export const memoryScope = pgEnum("memory_scope", ["user", "agent", "project"]);
export const memoryKind = pgEnum("memory_kind", [
  "preference",
  "fact",
  "instruction",
  "decision",
]);
export const notificationKind = pgEnum("notification_kind", [
  "task",
  "approval",
  "delegation",
  "routine",
  "system",
]);

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    status: projectStatus("status").notNull().default("active"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("projects_owner_status_idx").on(table.ownerUserId, table.status),
  ],
);

export const projectMembers = pgTable(
  "project_members",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: projectMemberRole("role").notNull(),
    createdAt: createdAt(),
  },
  (table) => [primaryKey({ columns: [table.projectId, table.userId] })],
);

export const projectAgents = pgTable(
  "project_agents",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    addedByUserId: text("added_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
  },
  (table) => [primaryKey({ columns: [table.projectId, table.agentId] })],
);

export const projectArtifacts = pgTable(
  "project_artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdByAgentId: text("created_by_agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    title: text("title").notNull(),
    kind: text("kind").notNull().default("note"),
    content: text("content").notNull(),
    metadata: jsonb("metadata").notNull().default({}),
    version: integer("version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("project_artifacts_project_updated_idx").on(
      table.projectId,
      table.updatedAt,
    ),
  ],
);

export const routines = pgTable(
  "routines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    instruction: text("instruction").notNull(),
    /** `monitor` adds quiet-result semantics while using the same durable routine queue. */
    mode: text("mode").notNull().default("routine"),
    quietToken: text("quiet_token").notNull().default("NO_ACTION"),
    /** Optional notification/external delivery preferences; never contains a secret. */
    delivery: jsonb("delivery").notNull().default({}),
    /** Reviewed execution constraints: tool allowlist, pinned model, or deterministic program. */
    safeguards: jsonb("safeguards").notNull().default({}),
    /** Small per-routine scratchpad carried between dispatches, never a credential store. */
    notepad: text("notepad").notNull().default(""),
    blueprintId: text("blueprint_id"),
    preflightStatus: text("preflight_status").notNull().default("pending"),
    preflightMessage: text("preflight_message"),
    status: routineStatus("status").notNull().default("active"),
    trigger: routineTrigger("trigger").notNull().default("manual"),
    /** Reviewed, user-facing recurrence rather than an opaque command-like cron string. */
    schedule: jsonb("schedule").notNull().default({}),
    timezone: text("timezone").notNull().default("UTC"),
    webhookTokenHash: text("webhook_token_hash"),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("routines_owner_status_idx").on(table.ownerUserId, table.status),
    index("routines_due_idx").on(table.status, table.nextRunAt),
  ],
);

/** One idempotent dispatch of a routine into the ordinary durable task queue. */
export const routineDispatches = pgTable(
  "routine_dispatches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    routineId: uuid("routine_id")
      .notNull()
      .references(() => routines.id, { onDelete: "cascade" }),
    /** Null only while the dispatcher owns the idempotency reservation. */
    taskRunId: uuid("task_run_id").references(() => taskRuns.id, {
      onDelete: "cascade",
    }),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
    reason: text("reason").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("routine_dispatches_routine_scheduled_idx").on(
      table.routineId,
      table.scheduledFor,
    ),
    uniqueIndex("routine_dispatches_task_run_idx").on(table.taskRunId),
  ],
);

export const delegations = pgTable(
  "delegations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorUserId: text("actor_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sourceAgentId: text("source_agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    targetAgentId: text("target_agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    sourceChannelId: text("source_channel_id").references(() => channels.id, {
      onDelete: "set null",
    }),
    targetChannelId: text("target_channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    taskRunId: uuid("task_run_id")
      .notNull()
      .references(() => taskRuns.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    parentDelegationId: uuid("parent_delegation_id"),
    depth: integer("depth").notNull().default(0),
    maxDepth: integer("max_depth").notNull().default(3),
    maxChildren: integer("max_children").notNull().default(4),
    maxParallel: integer("max_parallel").notNull().default(2),
    budgetMinutes: integer("budget_minutes").notNull().default(30),
    steeringStatus: text("steering_status").notNull().default("open"),
    reviewRequired: boolean("review_required").notNull().default(false),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    title: text("title").notNull(),
    instructions: text("instructions").notNull(),
    context: jsonb("context").notNull().default({}),
    expectedOutput: text("expected_output").notNull().default(""),
    status: delegationStatus("status").notNull().default("queued"),
    result: text("result"),
    error: text("error"),
    dueAt: timestamp("due_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("delegations_actor_status_idx").on(table.actorUserId, table.status),
    index("delegations_target_status_idx").on(
      table.targetAgentId,
      table.status,
    ),
    index("delegations_parent_idx").on(table.parentDelegationId),
  ],
);

export const delegationMessages = pgTable(
  "delegation_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    delegationId: uuid("delegation_id")
      .notNull()
      .references(() => delegations.id, { onDelete: "cascade" }),
    senderUserId: text("sender_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    senderAgentId: text("sender_agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    kind: text("kind").notNull().default("note"),
    body: text("body").notNull(),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: createdAt(),
  },
  (table) => [
    index("delegation_messages_delegation_created_idx").on(
      table.delegationId,
      table.createdAt,
    ),
  ],
);

export const memoryEntries = pgTable(
  "memory_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    scope: memoryScope("scope").notNull(),
    kind: memoryKind("kind").notNull(),
    agentId: text("agent_id").references(() => agents.id, {
      onDelete: "cascade",
    }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "cascade",
    }),
    title: text("title").notNull(),
    content: text("content").notNull(),
    source: text("source").notNull().default("user"),
    confidence: integer("confidence").notNull().default(100),
    pinned: boolean("pinned").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("memory_entries_owner_scope_updated_idx").on(
      table.ownerUserId,
      table.scope,
      table.updatedAt,
    ),
    index("memory_entries_agent_idx").on(table.agentId),
    index("memory_entries_project_idx").on(table.projectId),
  ],
);

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: notificationKind("kind").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    targetUrl: text("target_url"),
    metadata: jsonb("metadata").notNull().default({}),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    index("notifications_user_read_created_idx").on(
      table.userId,
      table.readAt,
      table.createdAt,
    ),
  ],
);

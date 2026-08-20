/**
 * Durable work: one run per assigned turn, its progress events, and approvals that gate actions.
 *
 * Kept separate from channels because a channel is the conversation while a run is one attempt at
 * doing work. A channel survives many runs; a retry creates a new run linked to the old one.
 */
import {
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agents, channels } from "./core";
import { jsonb } from "./json";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export const taskRunStatus = pgEnum("task_run_status", [
  "queued",
  "running",
  "waiting_for_approval",
  "waiting_for_input",
  "succeeded",
  "failed",
  "cancelled",
]);

export const approvalStatus = pgEnum("approval_status", [
  "pending",
  "approved",
  "declined",
  "expired",
  "cancelled",
]);

export const taskRuns = pgTable(
  "task_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    agentId: text("agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    /** The Intelligence thread this attempt belongs to, copied so a run remains self-describing. */
    threadId: text("thread_id").notNull(),
    /** Kept as an id without a foreign key so deleting a user cannot erase the work record. */
    actorUserId: text("actor_user_id").notNull(),
    /** A safe label, never the request body or prompt. */
    title: text("title").notNull(),
    status: taskRunStatus("status").notNull().default("queued"),
    parentRunId: uuid("parent_run_id"),
    /** Number of server-owned execution attempts already started for this run. */
    attempt: integer("attempt").notNull().default(0),
    /** A hard retry ceiling so a poison task cannot run forever. */
    maxAttempts: integer("max_attempts").notNull().default(3),
    /** Wall-clock ceiling for one attempt, including tool and approval waits. */
    maxRuntimeMs: integer("max_runtime_ms").notNull().default(900_000),
    /** The executor currently entitled to finish this attempt. */
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    /** Backoff gate for a retry. Null means the queued run is immediately eligible. */
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    /** Server-produced result for unattended work; prompts remain in their source records. */
    output: text("output"),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("task_runs_channel_created_idx").on(table.channelId, table.createdAt),
    index("task_runs_actor_status_idx").on(table.actorUserId, table.status),
    index("task_runs_queue_idx").on(table.status, table.nextAttemptAt),
    index("task_runs_lease_idx").on(table.status, table.leaseExpiresAt),
  ],
);

export const taskRunEvents = pgTable(
  "task_run_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => taskRuns.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    type: text("type").notNull(),
    /** Structured progress only. Routes never accept arbitrary prompt or tool content here. */
    payload: jsonb("payload").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("task_run_events_run_sequence_idx").on(
      table.runId,
      table.sequence,
    ),
  ],
);

export const approvalRequests = pgTable(
  "approval_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").references(() => taskRuns.id, {
      onDelete: "cascade",
    }),
    channelId: text("channel_id").references(() => channels.id, {
      onDelete: "cascade",
    }),
    requestedForUserId: text("requested_for_user_id").notNull(),
    decidedByUserId: text("decided_by_user_id"),
    botId: text("bot_id").notNull(),
    toolName: text("tool_name").notNull(),
    /** Hash of the server-resolved policy context. An approval is valid only for this exact action. */
    fingerprint: text("fingerprint").notNull(),
    policyRule: text("policy_rule"),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    details: jsonb("details").notNull(),
    status: approvalStatus("status").notNull().default("pending"),
    note: text("note"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("approval_requests_user_status_idx").on(
      table.requestedForUserId,
      table.status,
    ),
    index("approval_requests_run_status_idx").on(table.runId, table.status),
    index("approval_requests_fingerprint_idx").on(
      table.requestedForUserId,
      table.botId,
      table.fingerprint,
    ),
  ],
);

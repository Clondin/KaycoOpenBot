/** Durable correspondence between a person's Intelligence thread and their private Codex thread. */
import { pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { agents, users } from "./core";

export const codexThreadMappings = pgTable(
  "codex_thread_mappings",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    intelligenceThreadId: text("intelligence_thread_id").notNull(),
    codexThreadId: text("codex_thread_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.userId, table.agentId, table.intelligenceThreadId],
    }),
  ],
);

/** Per-person Codex choices. Null means let the deployment/App Server choose its default. */
export const codexUserPreferences = pgTable("codex_user_preferences", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  model: text("model"),
  effort: text("effort"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

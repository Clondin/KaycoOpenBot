import { and, desc, eq, isNull } from "drizzle-orm";
import type { AgentActor } from "../agents/profile-types";
import type { Database } from "../db/client";
import { notifications } from "../db/schema";
import { safeBody, safeLine, WorkNotFoundError } from "./access";

export type NotificationKind =
  | "task"
  | "approval"
  | "delegation"
  | "routine"
  | "system";

export function createNotificationStore(database: Database) {
  return {
    async create(input: {
      userId: string;
      kind: NotificationKind;
      title: string;
      body: string;
      targetUrl?: string;
      metadata?: Record<string, unknown>;
    }) {
      const [notification] = await database
        .insert(notifications)
        .values({
          userId: input.userId,
          kind: input.kind,
          title: safeLine(input.title, "Notification title", 160),
          body: safeBody(input.body, "Notification", 2_000),
          ...(input.targetUrl
            ? { targetUrl: localTarget(input.targetUrl) }
            : {}),
          metadata: input.metadata ?? {},
        })
        .returning();
      if (!notification) throw new Error("Notification could not be created.");
      return notification;
    },

    async list(actor: AgentActor, unreadOnly = false, limit = 50) {
      return database
        .select()
        .from(notifications)
        .where(
          and(
            eq(notifications.userId, actor.id),
            unreadOnly ? isNull(notifications.readAt) : undefined,
          ),
        )
        .orderBy(desc(notifications.createdAt))
        .limit(Math.max(1, Math.min(limit, 100)));
    },

    async markRead(actor: AgentActor, notificationId: string) {
      const [notification] = await database
        .update(notifications)
        .set({ readAt: new Date() })
        .where(
          and(
            eq(notifications.id, notificationId),
            eq(notifications.userId, actor.id),
          ),
        )
        .returning();
      if (!notification) throw new WorkNotFoundError("Notification not found.");
      return notification;
    },

    async markAllRead(actor: AgentActor) {
      await database
        .update(notifications)
        .set({ readAt: new Date() })
        .where(
          and(eq(notifications.userId, actor.id), isNull(notifications.readAt)),
        );
    },
  };
}

function localTarget(value: string) {
  if (!value.startsWith("/") || value.startsWith("//")) {
    throw new Error("Notification links must stay inside OpenBot.");
  }
  return Array.from(value).slice(0, 500).join("");
}

export type NotificationStore = ReturnType<typeof createNotificationStore>;

import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { codexThreadMappings } from "../db/schema";

export type CodexThreadStore = {
  get(
    userId: string,
    agentId: string,
    intelligenceThreadId: string,
  ): Promise<string | null>;
  set(
    userId: string,
    agentId: string,
    intelligenceThreadId: string,
    codexThreadId: string,
  ): Promise<void>;
};

export function createCodexThreadStore(database: Database): CodexThreadStore {
  return {
    async get(userId, agentId, intelligenceThreadId) {
      const [mapping] = await database
        .select({ codexThreadId: codexThreadMappings.codexThreadId })
        .from(codexThreadMappings)
        .where(
          and(
            eq(codexThreadMappings.userId, userId),
            eq(codexThreadMappings.agentId, agentId),
            eq(codexThreadMappings.intelligenceThreadId, intelligenceThreadId),
          ),
        );
      return mapping?.codexThreadId ?? null;
    },

    async set(userId, agentId, intelligenceThreadId, codexThreadId) {
      const now = new Date();
      await database
        .insert(codexThreadMappings)
        .values({
          userId,
          agentId,
          intelligenceThreadId,
          codexThreadId,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            codexThreadMappings.userId,
            codexThreadMappings.agentId,
            codexThreadMappings.intelligenceThreadId,
          ],
          set: { codexThreadId, updatedAt: now },
        });
    },
  };
}

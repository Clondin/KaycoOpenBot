import { eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { codexUserPreferences } from "../db/schema";

export const CODEX_EFFORT_LEVELS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type CodexEffort = (typeof CODEX_EFFORT_LEVELS)[number];

export type CodexPreferences = {
  model: string | null;
  effort: CodexEffort | null;
};

export type CodexPreferenceStore = {
  get(userId: string): Promise<CodexPreferences>;
  set(userId: string, preferences: CodexPreferences): Promise<CodexPreferences>;
};

const DEFAULT_PREFERENCES: CodexPreferences = { model: null, effort: null };

export function isCodexEffort(value: unknown): value is CodexEffort {
  return (
    typeof value === "string" &&
    (CODEX_EFFORT_LEVELS as readonly string[]).includes(value)
  );
}

export function createCodexPreferenceStore(
  database: Database,
): CodexPreferenceStore {
  return {
    async get(userId) {
      const [row] = await database
        .select({
          model: codexUserPreferences.model,
          effort: codexUserPreferences.effort,
        })
        .from(codexUserPreferences)
        .where(eq(codexUserPreferences.userId, userId));
      if (!row) return DEFAULT_PREFERENCES;
      return {
        model: row.model,
        effort: isCodexEffort(row.effort) ? row.effort : null,
      };
    },

    async set(userId, preferences) {
      const updatedAt = new Date();
      await database
        .insert(codexUserPreferences)
        .values({ userId, ...preferences, updatedAt })
        .onConflictDoUpdate({
          target: codexUserPreferences.userId,
          set: { ...preferences, updatedAt },
        });
      return preferences;
    },
  };
}

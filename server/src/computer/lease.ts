import type { SupervisorClient } from "./supervisor";

/**
 * A short-lived address lease for a Bot's computer.
 *
 * The supervisor's `locate` call is an ensure operation: it may inspect Docker, start a container,
 * and wait for health. Repeating that before every click turns a fast browser action into an
 * orchestration round trip. A lease keeps that work on the cold path while stop/reset still clear it
 * immediately.
 */
export function createLeasedSupervisor(
  supervisor: SupervisorClient,
  options: { ttlMs?: number; now?: () => number } = {},
) {
  const ttlMs = options.ttlMs ?? 60_000;
  const now = options.now ?? Date.now;
  const locations = new Map<string, { url: string; expiresAt: number }>();
  const locating = new Map<string, Promise<string>>();

  const invalidate = (botId: string): void => {
    locations.delete(botId);
    locating.delete(botId);
  };

  return {
    async locate(botId: string): Promise<string> {
      const cached = locations.get(botId);
      if (cached && cached.expiresAt > now()) return cached.url;

      const pending = locating.get(botId);
      if (pending) return pending;

      const request = supervisor.locate(botId).then((url) => {
        locations.set(botId, { url, expiresAt: now() + ttlMs });
        return url;
      });
      locating.set(botId, request);
      try {
        return await request;
      } finally {
        locating.delete(botId);
      }
    },

    async stop(botId: string): Promise<void> {
      invalidate(botId);
      await supervisor.stop(botId);
    },

    async reset(botId: string): Promise<void> {
      invalidate(botId);
      await supervisor.reset(botId);
    },

    list: () => supervisor.list(),
    invalidate,
  };
}

export type LeasedSupervisor = ReturnType<typeof createLeasedSupervisor>;

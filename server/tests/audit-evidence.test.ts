import { describe, expect, test } from "bun:test";
import {
  createAuditEvidenceBundle,
  type AuditEvent,
  type AuditReader,
} from "../src/audit";

const event = (id: string, payload: Record<string, unknown>): AuditEvent => ({
  id,
  actorUserId: "user-1",
  eventType: "computer.action_allowed",
  targetType: "computer",
  targetId: "bot-1",
  payload,
  createdAt: "2026-08-20T12:00:00.000Z",
});

function reader(events: AuditEvent[]): AuditReader {
  return {
    list: async ({ cursor }) => ({
      events: cursor ? events.slice(1) : events.slice(0, 1),
      ...(events.length > 1 && !cursor ? { nextCursor: "page-2" } : {}),
    }),
  };
}

describe("audit evidence bundles", () => {
  test("chains every page and retains the active filters", async () => {
    const bundle = await createAuditEvidenceBundle(
      reader([event("one", { allowed: true }), event("two", { rule: "x" })]),
      { limit: 50, eventType: "computer.action_allowed" },
    );
    expect(bundle.eventCount).toBe(2);
    expect(bundle.query).toEqual({ eventType: "computer.action_allowed" });
    expect(bundle.events[0]?.evidenceHash).toHaveLength(64);
    expect(bundle.integrity.chainRoot).toBe(bundle.events[1]?.evidenceHash);
  });

  test("the integrity root changes when evidence changes", async () => {
    const first = await createAuditEvidenceBundle(
      reader([event("one", { allowed: true })]),
      { limit: 50 },
    );
    const changed = await createAuditEvidenceBundle(
      reader([event("one", { allowed: false })]),
      { limit: 50 },
    );
    expect(first.integrity.chainRoot).not.toBe(changed.integrity.chainRoot);
  });
});

import { describe, expect, test } from "bun:test";
import {
  nextScheduledAt,
  parseRoutineSchedule,
  scheduleLabel,
  validTimeZone,
} from "../src/work/schedule";

describe("routine schedules", () => {
  test("validates bounded user-facing recurrences", () => {
    expect(
      parseRoutineSchedule({ kind: "every_minutes", interval: 4 }).ok,
    ).toBe(false);
    expect(parseRoutineSchedule({ kind: "daily", time: "24:00" }).ok).toBe(
      false,
    );
    expect(
      parseRoutineSchedule({ kind: "weekly", days: [1, 3, 3], time: "08:30" }),
    ).toEqual({
      ok: true,
      schedule: { kind: "weekly", days: [1, 3], time: "08:30" },
    });
  });

  test("computes daily wall-clock time in the selected timezone", () => {
    expect(validTimeZone("America/New_York")).toBe(true);
    const next = nextScheduledAt(
      { kind: "daily", time: "08:30" },
      "America/New_York",
      new Date("2026-08-19T12:31:00.000Z"),
    );
    expect(next.toISOString()).toBe("2026-08-20T12:30:00.000Z");
    expect(
      scheduleLabel({ kind: "daily", time: "08:30" }, "America/New_York"),
    ).toBe("Daily at 08:30 America/New_York");
  });

  test("keeps interval schedules strictly after the supplied instant", () => {
    expect(
      nextScheduledAt(
        { kind: "every_minutes", interval: 15 },
        "UTC",
        new Date("2026-08-19T12:00:30.000Z"),
      ).toISOString(),
    ).toBe("2026-08-19T12:15:00.000Z");
  });
});

export type RoutineSchedule =
  | { kind: "every_minutes"; interval: number }
  | { kind: "daily"; time: string }
  | { kind: "weekly"; days: number[]; time: string };

const MAX_INTERVAL_MINUTES = 7 * 24 * 60;

export function parseRoutineSchedule(
  value: unknown,
): { ok: true; schedule: RoutineSchedule } | { ok: false; error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "A schedule is required." };
  }
  const input = value as Record<string, unknown>;
  if (input.kind === "every_minutes") {
    const interval = Number(input.interval);
    if (
      !Number.isInteger(interval) ||
      interval < 5 ||
      interval > MAX_INTERVAL_MINUTES
    ) {
      return {
        ok: false,
        error: "The interval must be between 5 minutes and 7 days.",
      };
    }
    return { ok: true, schedule: { kind: "every_minutes", interval } };
  }
  if (input.kind === "daily") {
    return validClock(input.time)
      ? { ok: true, schedule: { kind: "daily", time: input.time } }
      : { ok: false, error: "Daily routines need a time such as 08:30." };
  }
  if (input.kind === "weekly") {
    if (!validClock(input.time)) {
      return { ok: false, error: "Weekly routines need a time such as 08:30." };
    }
    if (!Array.isArray(input.days)) {
      return { ok: false, error: "Choose at least one day of the week." };
    }
    const days = [...new Set(input.days.map(Number))].sort((a, b) => a - b);
    if (
      days.length === 0 ||
      days.some((day) => !Number.isInteger(day) || day < 0 || day > 6)
    ) {
      return { ok: false, error: "Days must be numbers from 0 to 6." };
    }
    return {
      ok: true,
      schedule: { kind: "weekly", days, time: input.time },
    };
  }
  return { ok: false, error: "Choose an interval, daily, or weekly schedule." };
}

export function validTimeZone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

/**
 * Find the first matching wall-clock minute after `after`.
 *
 * Iterating minutes makes daylight-saving gaps and repeated hours explicit through Intl rather than
 * pretending a local time is a UTC offset that never changes. The weekly horizon is at most 10,081
 * checks and runs only when a routine is created or dispatched, not on every scheduler tick.
 */
export function nextScheduledAt(
  schedule: RoutineSchedule,
  timezone: string,
  after: Date,
): Date {
  if (!validTimeZone(timezone)) throw new Error("That timezone is not valid.");
  const firstMinute = new Date(
    Math.floor(after.getTime() / 60_000) * 60_000 + 60_000,
  );
  if (schedule.kind === "every_minutes") {
    return new Date(firstMinute.getTime() + (schedule.interval - 1) * 60_000);
  }

  const [hour, minute] = schedule.time.split(":").map(Number);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  });
  const weekday = new Map([
    ["Sun", 0],
    ["Mon", 1],
    ["Tue", 2],
    ["Wed", 3],
    ["Thu", 4],
    ["Fri", 5],
    ["Sat", 6],
  ]);
  const maximum = 8 * 24 * 60;
  for (let offset = 0; offset <= maximum; offset += 1) {
    const candidate = new Date(firstMinute.getTime() + offset * 60_000);
    const parts = Object.fromEntries(
      formatter
        .formatToParts(candidate)
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, part.value]),
    );
    const matchesTime =
      Number(parts.hour) === hour && Number(parts.minute) === minute;
    const matchesDay =
      schedule.kind === "daily" ||
      schedule.days.includes(weekday.get(parts.weekday) ?? -1);
    if (matchesTime && matchesDay) return candidate;
  }
  throw new Error("The next scheduled time could not be calculated.");
}

export function scheduleLabel(schedule: RoutineSchedule, timezone: string) {
  if (schedule.kind === "every_minutes") {
    if (schedule.interval % 1_440 === 0)
      return `Every ${schedule.interval / 1_440} day${schedule.interval === 1_440 ? "" : "s"}`;
    if (schedule.interval % 60 === 0)
      return `Every ${schedule.interval / 60} hour${schedule.interval === 60 ? "" : "s"}`;
    return `Every ${schedule.interval} minutes`;
  }
  if (schedule.kind === "daily") return `Daily at ${schedule.time} ${timezone}`;
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return `${schedule.days.map((day) => names[day]).join(", ")} at ${schedule.time} ${timezone}`;
}

function validClock(value: unknown): value is string {
  return typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

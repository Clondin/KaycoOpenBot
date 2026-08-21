export type ActiveHours = { start: string; end: string };
export type RoutineSchedule = (
  | { kind: "every_minutes"; interval: number }
  | { kind: "daily"; time: string }
  | { kind: "weekly"; days: number[]; time: string }
) & { activeHours?: ActiveHours };

const MAX_INTERVAL_MINUTES = 7 * 24 * 60;

export function parseRoutineSchedule(
  value: unknown,
): { ok: true; schedule: RoutineSchedule } | { ok: false; error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "A schedule is required." };
  }
  const input = value as Record<string, unknown>;
  const activeHours = parseActiveHours(input.activeHours);
  if (!activeHours.ok) return activeHours;
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
    return {
      ok: true,
      schedule: {
        kind: "every_minutes",
        interval,
        ...(activeHours.value ? { activeHours: activeHours.value } : {}),
      },
    };
  }
  if (input.kind === "daily") {
    return validClock(input.time)
      ? {
          ok: true,
          schedule: {
            kind: "daily",
            time: input.time,
            ...(activeHours.value ? { activeHours: activeHours.value } : {}),
          },
        }
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
      schedule: {
        kind: "weekly",
        days,
        time: input.time,
        ...(activeHours.value ? { activeHours: activeHours.value } : {}),
      },
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
    const due = new Date(
      firstMinute.getTime() + (schedule.interval - 1) * 60_000,
    );
    if (!schedule.activeHours) return due;
    return firstActiveMinute(due, timezone, schedule.activeHours);
  }

  const [hour, minute] = schedule.time.split(":").map(Number);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
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
    if (
      matchesTime &&
      matchesDay &&
      (!schedule.activeHours ||
        isActiveClock(
          `${parts.hour.padStart(2, "0")}:${parts.minute}`,
          schedule.activeHours,
        ))
    )
      return candidate;
  }
  throw new Error("The next scheduled time could not be calculated.");
}

export function scheduleLabel(schedule: RoutineSchedule, timezone: string) {
  const active = schedule.activeHours
    ? ` · active ${schedule.activeHours.start}–${schedule.activeHours.end} ${timezone}`
    : "";
  if (schedule.kind === "every_minutes") {
    if (schedule.interval % 1_440 === 0)
      return `Every ${schedule.interval / 1_440} day${schedule.interval === 1_440 ? "" : "s"}${active}`;
    if (schedule.interval % 60 === 0)
      return `Every ${schedule.interval / 60} hour${schedule.interval === 60 ? "" : "s"}${active}`;
    return `Every ${schedule.interval} minutes${active}`;
  }
  if (schedule.kind === "daily")
    return `Daily at ${schedule.time} ${timezone}${active}`;
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return `${schedule.days.map((day) => names[day]).join(", ")} at ${schedule.time} ${timezone}${active}`;
}

function validClock(value: unknown): value is string {
  return typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function parseActiveHours(
  value: unknown,
): { ok: true; value: ActiveHours | null } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      ok: false,
      error: "Active hours must include a start and end time.",
    };
  }
  const input = value as Record<string, unknown>;
  if (!validClock(input.start) || !validClock(input.end)) {
    return {
      ok: false,
      error: "Active hours need times such as 08:00 and 18:00.",
    };
  }
  if (input.start === input.end) {
    return { ok: false, error: "Active hours must cover part of the day." };
  }
  return { ok: true, value: { start: input.start, end: input.end } };
}

function clockMinutes(clock: string) {
  const [hour, minute] = clock.split(":").map(Number);
  return hour * 60 + minute;
}

/** Supports ordinary daytime windows and overnight windows such as 22:00–06:00. */
export function isActiveClock(clock: string, active: ActiveHours) {
  const current = clockMinutes(clock);
  const start = clockMinutes(active.start);
  const end = clockMinutes(active.end);
  return start < end
    ? current >= start && current < end
    : current >= start || current < end;
}

function firstActiveMinute(due: Date, timezone: string, active: ActiveHours) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  });
  for (let offset = 0; offset <= 8 * 24 * 60; offset += 1) {
    const candidate = new Date(due.getTime() + offset * 60_000);
    const parts = Object.fromEntries(
      formatter
        .formatToParts(candidate)
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, part.value]),
    );
    if (
      isActiveClock(`${parts.hour.padStart(2, "0")}:${parts.minute}`, active)
    ) {
      return candidate;
    }
  }
  throw new Error("The next active time could not be calculated.");
}

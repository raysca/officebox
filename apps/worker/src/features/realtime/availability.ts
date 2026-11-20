import {
  dndScheduleSchema,
  type DerivedAvailability,
  type DndSchedule,
  type DndWeekday,
  type PresenceState,
} from "@officebox/shared";
import { Database, expectOk } from "../../core/db";

/**
 * Derived availability (Notifications §5.4, §5.6–§5.7, §7; TDD §3.1).
 *
 * Precedence (highest first):
 * 1. `away` — active time-off (`user_availability.away_until` date in user's zone > now), label `"Away"`
 * 2. `dnd` — manual Do Not Disturb (`user_preferences.dnd_until > now`), label `"Do Not Disturb"`
 * 3. `focus` — active focus-time event (`user_availability.focus_until > now`), label `"Focus time"`
 * 4. `scheduled_dnd` — within user's recurring DND schedule (`user_preferences.dnd_schedule` or
 *    `user_availability.schedule_dnd_until > now`), label `"Do Not Disturb"` (Notifications §5.4)
 * 5. `online` | `idle` | `offline` — raw presence state
 */

export interface AvailabilityInputs {
  presence: PresenceState;
  dndUntil: number | null;
  awayUntil: string | null;
  awayTimeOffId: string | null;
  focusUntil: number | null;
  focusEventId: string | null;
  scheduleDndUntil: number | null;
  timezone: string;
  dndSchedule: DndSchedule | null;
}

const WEEKDAY_MAP: Readonly<Record<string, DndWeekday>> = {
  Mon: "mon",
  Tue: "tue",
  Wed: "wed",
  Thu: "thu",
  Fri: "fri",
  Sat: "sat",
  Sun: "sun",
};

const PREV_WEEKDAY: Readonly<Record<DndWeekday, DndWeekday>> = {
  mon: "sun",
  tue: "mon",
  wed: "tue",
  thu: "wed",
  fri: "thu",
  sat: "fri",
  sun: "sat",
};

function sanitizeTimezone(timezone: string): string {
  try {
    Intl.DateTimeFormat("en-GB", { timeZone: timezone });
    return timezone;
  } catch {
    return "UTC";
  }
}

function parseHhMm(hhmm: string): { hour: number; minute: number; totalMinutes: number } {
  const [h, m] = hhmm.split(":");
  const hour = Number(h);
  const minute = Number(m);
  return { hour, minute, totalMinutes: hour * 60 + minute };
}

interface LocalDateTimeParts {
  year: number;
  month: number;
  day: number;
  weekday: DndWeekday;
  hour: number;
  minute: number;
}

function getLocalParts(utcMs: number, tz: string): LocalDateTimeParts {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = formatter.formatToParts(new Date(utcMs));
  const read = (type: string) => parts.find((p) => p.type === type)?.value ?? "0";
  const weekdayShort = parts.find((p) => p.type === "weekday")?.value ?? "Mon";
  return {
    year: Number(read("year")),
    month: Number(read("month")),
    day: Number(read("day")),
    weekday: WEEKDAY_MAP[weekdayShort] ?? "mon",
    hour: Number(read("hour")),
    minute: Number(read("minute")),
  };
}

/**
 * Converts a local wall-clock date/time (`year-month-day hour:minute:00.000`) in `tz` to UTC epoch
 * ms, accounting for DST offsets by two-pass refinement.
 */
export function zonedWallTimeToUtcMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timezone: string,
): number {
  const tz = sanitizeTimezone(timezone);
  const targetAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let guess = targetAsUtc;
  for (let i = 0; i < 2; i++) {
    const actual = getLocalParts(guess, tz);
    const actualAsUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, 0, 0);
    const diff = targetAsUtc - actualAsUtc;
    if (diff === 0) break;
    guess += diff;
  }
  return guess;
}

function addCalendarDays(
  year: number,
  month: number,
  day: number,
  deltaDays: number,
): {
  year: number;
  month: number;
  day: number;
} {
  const d = new Date(Date.UTC(year, month - 1, day + deltaDays));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** Converts an ISO `YYYY-MM-DD` `away_until` (first working day back) into UTC ms at 00:00 in `tz`. */
export function awayUntilToUtcMs(awayUntil: string | null, timezone: string): number | null {
  if (!awayUntil) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(awayUntil);
  if (!match) return null;
  return zonedWallTimeToUtcMs(Number(match[1]), Number(match[2]), Number(match[3]), 0, 0, timezone);
}

/**
 * Checks whether `now` (UTC epoch ms) falls inside `schedule` (`{ mon: [["19:00","08:00"]], ... }`)
 * in `timezone`. Handles same-day windows (`start < end`) and overnight windows (`start > end`),
 * returning the exact UTC ms end boundary in `timezone` (seconds/ms zeroed, DST-accurate).
 */
export function evaluateScheduledDnd(
  schedule: DndSchedule | null,
  timezone: string,
  now: number,
): { active: boolean; until: number | null } {
  if (!schedule) return { active: false, until: null };
  const tz = sanitizeTimezone(timezone);
  const local = getLocalParts(now, tz);
  const currentMinutes = local.hour * 60 + local.minute;

  let activeUntil: number | null = null;
  const considerUntil = (candidate: number) => {
    if (candidate > now && (activeUntil === null || candidate > activeUntil)) {
      activeUntil = candidate;
    }
  };

  // Windows starting today.
  for (const [startStr, endStr] of schedule[local.weekday] ?? []) {
    const start = parseHhMm(startStr);
    const end = parseHhMm(endStr);
    if (start.totalMinutes === end.totalMinutes) continue;
    if (start.totalMinutes < end.totalMinutes) {
      if (currentMinutes >= start.totalMinutes && currentMinutes < end.totalMinutes) {
        considerUntil(zonedWallTimeToUtcMs(local.year, local.month, local.day, end.hour, end.minute, tz));
      }
    } else if (currentMinutes >= start.totalMinutes) {
      const next = addCalendarDays(local.year, local.month, local.day, 1);
      considerUntil(zonedWallTimeToUtcMs(next.year, next.month, next.day, end.hour, end.minute, tz));
    }
  }

  // Overnight windows that started yesterday and carry into this morning.
  const prevDay = PREV_WEEKDAY[local.weekday];
  for (const [startStr, endStr] of schedule[prevDay] ?? []) {
    const start = parseHhMm(startStr);
    const end = parseHhMm(endStr);
    if (start.totalMinutes > end.totalMinutes && currentMinutes < end.totalMinutes) {
      considerUntil(zonedWallTimeToUtcMs(local.year, local.month, local.day, end.hour, end.minute, tz));
    }
  }

  return activeUntil !== null ? { active: true, until: activeUntil } : { active: false, until: null };
}

/** Pure derivation of a user's availability state from D1 facts and live presence. */
export function computeDerivedAvailability(inputs: AvailabilityInputs, now: number): DerivedAvailability {
  const awayUntilMs = awayUntilToUtcMs(inputs.awayUntil, inputs.timezone);
  if (awayUntilMs !== null && awayUntilMs > now) {
    return {
      state: "away",
      label: "Away",
      until: awayUntilMs,
      source: "time_off",
    };
  }
  if (inputs.dndUntil !== null && inputs.dndUntil > now) {
    return {
      state: "dnd",
      label: "Do Not Disturb",
      until: inputs.dndUntil,
      source: "manual_dnd",
    };
  }
  if (inputs.focusUntil !== null && inputs.focusUntil > now) {
    return {
      state: "focus",
      label: "Focus time",
      until: inputs.focusUntil,
      source: "focus",
    };
  }
  const scheduled = evaluateScheduledDnd(inputs.dndSchedule, inputs.timezone, now);
  const scheduledUntil =
    scheduled.active && scheduled.until !== null
      ? scheduled.until
      : inputs.scheduleDndUntil !== null && inputs.scheduleDndUntil > now
        ? inputs.scheduleDndUntil
        : null;
  if (scheduledUntil !== null) {
    return {
      state: "scheduled_dnd",
      label: "Do Not Disturb",
      until: scheduledUntil,
      source: "dnd_schedule",
    };
  }
  const label = inputs.presence === "online" ? "Online" : inputs.presence === "idle" ? "Idle" : "Offline";
  return {
    state: inputs.presence,
    label,
    until: null,
    source: "presence",
  };
}

/**
 * Next UTC epoch ms at which time-bounded availability (`away`, `dnd`, `focus`, or active
 * `scheduled_dnd`) expires and needs to be re-derived by `UserHub`'s timer, or `null` if none.
 */
export function nextAvailabilityBoundary(inputs: AvailabilityInputs, now: number): number | null {
  const candidates: number[] = [];
  const awayUntilMs = awayUntilToUtcMs(inputs.awayUntil, inputs.timezone);
  if (awayUntilMs !== null && awayUntilMs > now) candidates.push(awayUntilMs);
  if (inputs.dndUntil !== null && inputs.dndUntil > now) candidates.push(inputs.dndUntil);
  if (inputs.focusUntil !== null && inputs.focusUntil > now) candidates.push(inputs.focusUntil);
  if (inputs.scheduleDndUntil !== null && inputs.scheduleDndUntil > now) candidates.push(inputs.scheduleDndUntil);
  const scheduled = evaluateScheduledDnd(inputs.dndSchedule, inputs.timezone, now);
  if (scheduled.active && scheduled.until !== null && scheduled.until > now) {
    candidates.push(scheduled.until);
  }
  if (candidates.length === 0) return null;
  return Math.min(...candidates);
}

export function parseDndSchedule(raw: string | null): DndSchedule | null {
  if (!raw) return null;
  try {
    const parsed = dndScheduleSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Loads a user's availability, preference and timezone rows from D1 (Notifications §7). */
export async function loadAvailabilityInputs(
  db: D1Database,
  userId: string,
  presence: PresenceState,
): Promise<AvailabilityInputs> {
  const database = new Database(db);
  const [availRow, prefRow, userRow] = await Promise.all([
    database.first<{
      away_until: string | null;
      away_time_off_id: string | null;
      focus_until: number | null;
      focus_event_id: string | null;
      schedule_dnd_until: number | null;
    }>(
      `SELECT away_until, away_time_off_id, focus_until, focus_event_id, schedule_dnd_until
         FROM user_availability WHERE user_id = ?`,
      userId,
    ),
    database.first<{ dnd_until: number | null; dnd_schedule: string | null }>(
      "SELECT dnd_until, dnd_schedule FROM user_preferences WHERE user_id = ?",
      userId,
    ),
    database.first<{ timezone: string | null }>("SELECT timezone FROM users WHERE id = ?", userId),
  ]);
  const avail = expectOk(availRow);
  const pref = expectOk(prefRow);
  const user = expectOk(userRow);
  return {
    presence,
    dndUntil: pref?.dnd_until ?? null,
    awayUntil: avail?.away_until ?? null,
    awayTimeOffId: avail?.away_time_off_id ?? null,
    focusUntil: avail?.focus_until ?? null,
    focusEventId: avail?.focus_event_id ?? null,
    scheduleDndUntil: avail?.schedule_dnd_until ?? null,
    timezone: user?.timezone ?? "UTC",
    dndSchedule: parseDndSchedule(pref?.dnd_schedule ?? null),
  };
}

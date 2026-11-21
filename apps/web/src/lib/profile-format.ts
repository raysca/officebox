import { WEEKDAYS, type Weekday, type WorkingHours } from "@officebox/shared";

/**
 * Display helpers for profiles and the directory (M1d). Pure apart from `Intl`, so they're unit-tested.
 */

/** "Sam Lee" → "SL"; one letter for a single name; "?" for nothing usable. */
export function initials(name: string): string {
  const words = name
    .trim()
    .split(/\s+/)
    .filter((w) => w !== "");
  const letters = words.length > 1 ? [words[0]!, words[words.length - 1]!] : words.slice(0, 1);
  const result = letters.map((w) => [...w][0]!.toUpperCase()).join("");
  return result === "" ? "?" : result;
}

/** The time now in `timeZone` ("14:05"), or null when the zone is unknown to this browser. */
export function localTime(timeZone: string, now: Date, locale?: string): string | null {
  try {
    return new Intl.DateTimeFormat(locale, { timeZone, hour: "2-digit", minute: "2-digit" }).format(now);
  } catch {
    return null;
  }
}

const DAY_LABELS: Record<Weekday, string> = {
  mon: "Mon",
  tue: "Tue",
  wed: "Wed",
  thu: "Thu",
  fri: "Fri",
  sat: "Sat",
  sun: "Sun",
};
const DAY_NAMES: Record<Weekday, string> = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
};

export function dayName(day: Weekday): string {
  return DAY_NAMES[day];
}

function dayText(hours: WorkingHours, day: Weekday): string {
  return hours[day].map(([start, end]) => `${start}–${end}`).join(", ");
}

/**
 * Working hours in a line, grouping consecutive days with the same hours: "Mon–Fri 09:00–17:00",
 * "Mon–Thu 08:00–16:00 · Fri 08:00–12:00". "No working hours set" when every day is empty.
 */
export function workingHoursSummary(hours: WorkingHours): string {
  const groups: { from: Weekday; to: Weekday; text: string }[] = [];
  for (const day of WEEKDAYS) {
    const text = dayText(hours, day);
    if (text === "") continue;
    const last = groups[groups.length - 1];
    const previous = WEEKDAYS[WEEKDAYS.indexOf(day) - 1];
    if (last && last.text === text && previous === last.to) last.to = day;
    else groups.push({ from: day, to: day, text });
  }
  if (groups.length === 0) return "No working hours set";
  return groups
    .map((g) => `${g.from === g.to ? DAY_LABELS[g.from] : `${DAY_LABELS[g.from]}–${DAY_LABELS[g.to]}`} ${g.text}`)
    .join(" · ");
}

/** Every IANA zone this browser knows, with UTC first; falls back to a short list on old browsers. */
export function timeZoneOptions(current?: string): string[] {
  let zones: string[];
  try {
    zones = Intl.supportedValuesOf("timeZone");
  } catch {
    zones = [];
  }
  const all = new Set(["UTC", ...zones]);
  if (current) all.add(current);
  return [...all];
}

/** This browser's time zone, or null. */
export function browserTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/** The country's name in the browser's language ("GB" → "United Kingdom"), or the code. */
export function countryName(code: string, locale?: string): string {
  try {
    return new Intl.DisplayNames(locale ? [locale] : undefined, { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** "GB-ENG" → "United Kingdom (ENG)"; null stays null. */
export function regionLabel(region: string | null, locale?: string): string | null {
  if (!region) return null;
  const [country, subdivision] = region.split("-");
  const name = countryName(country!, locale);
  return subdivision ? `${name} (${subdivision})` : name;
}

/**
 * A region to suggest for someone who hasn't set one: the country of the browser's language tag
 * ("en-GB" → "GB"), if it has one **(default)**. Browsers don't expose the time zone database's country
 * table, so this stands in for "pre-filled from the time zone" (Identity §4.3).
 */
export function suggestedRegion(languages: readonly string[]): string | null {
  for (const tag of languages) {
    try {
      const region = new Intl.Locale(tag).maximize().region;
      if (region && /^[A-Z]{2}$/.test(region)) return region;
    } catch {
      // try the next one
    }
  }
  return null;
}

/** When "clear after" choices end, from `now` (epoch ms); null for "don't clear". */
export type ClearAfter = "never" | "30m" | "1h" | "4h" | "today";

export function clearAfterTime(choice: ClearAfter, now: Date): number | null {
  switch (choice) {
    case "never":
      return null;
    case "30m":
      return now.getTime() + 30 * 60_000;
    case "1h":
      return now.getTime() + 60 * 60_000;
    case "4h":
      return now.getTime() + 4 * 60 * 60_000;
    case "today": {
      const end = new Date(now);
      end.setHours(23, 59, 0, 0);
      // In the last minute before midnight, "today" has nothing left: clear it a minute from now.
      return end.getTime() > now.getTime() ? end.getTime() : now.getTime() + 60_000;
    }
  }
}

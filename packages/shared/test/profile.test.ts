import { describe, expect, it } from "vitest";
import {
  assistantDerivedHandle,
  DEFAULT_WORKING_HOURS,
  directoryQuerySchema,
  effectiveStatus,
  handleShapeProblem,
  isSingleEmoji,
  isValidRegion,
  isValidTimeZone,
  normaliseHandle,
  parseWorkingHours,
  regionSchema,
  setStatusBodySchema,
  statusLine,
  updateProfileBodySchema,
  timeZoneSchema,
  workingHoursInputSchema,
} from "../src/profile";
import { updateRealtimePreferencesBodySchema } from "../src/realtime";

describe("time zones (Identity §4.7: IANA names)", () => {
  it.each(["Europe/Berlin", "America/Argentina/Buenos_Aires", "UTC", "Etc/GMT+5", "Asia/Kolkata"])("accepts %s", (tz) =>
    expect(isValidTimeZone(tz)).toBe(true),
  );
  it.each([
    "",
    "Mars/Olympus",
    "+05:00",
    "Europe/",
    "europe berlin",
    "../etc/passwd",
    "A".repeat(65),
    "Europe//Berlin",
  ])("refuses %j", (tz) => expect(isValidTimeZone(tz)).toBe(false));
});

describe("canonical time zones", () => {
  it("stores one spelling per zone", () => {
    expect(timeZoneSchema.parse("europe/berlin")).toBe("Europe/Berlin");
    expect(timeZoneSchema.parse(" utc ")).toBe("UTC");
  });
  it("PATCH /me/preferences uses the same rule", () => {
    expect(updateRealtimePreferencesBodySchema.safeParse({ timezone: "+05:00" }).success).toBe(false);
    expect(updateRealtimePreferencesBodySchema.parse({ timezone: "asia/tokyo" }).timezone).toBe("Asia/Tokyo");
  });
});

describe("working hours", () => {
  it("fills left-out weekdays with no hours", () => {
    const parsed = workingHoursInputSchema.parse({
      mon: [
        ["08:30", "12:00"],
        ["13:00", "16:30"],
      ],
    });
    expect(parsed.mon).toHaveLength(2);
    expect(parsed.tue).toEqual([]);
    expect(Object.keys(parsed)).toEqual(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
  });

  it("accepts an interval that ends at midnight", () => {
    expect(workingHoursInputSchema.safeParse({ sat: [["20:00", "24:00"]] }).success).toBe(true);
  });

  it.each([
    [{ mon: [["17:00", "09:00"]] }, "end before start"],
    [{ mon: [["09:00", "09:00"]] }, "empty interval"],
    [
      {
        mon: [
          ["09:00", "13:00"],
          ["12:00", "17:00"],
        ],
      },
      "overlapping",
    ],
    [
      {
        mon: [
          ["13:00", "17:00"],
          ["09:00", "12:00"],
        ],
      },
      "out of order",
    ],
    [{ mon: [["9:00", "17:00"]] }, "not HH:MM"],
    [{ mon: [["24:00", "24:00"]] }, "starts at 24:00"],
    [{ funday: [] }, "unknown day"],
    [{ mon: Array.from({ length: 5 }, (_, i) => [`0${i}:00`, `0${i}:30`]) }, "too many intervals"],
  ] as [unknown, string][])("refuses %j (%s)", (input) => {
    expect(workingHoursInputSchema.safeParse(input).success).toBe(false);
  });

  it("falls back to Mon–Fri 09:00–17:00 when nothing (or junk) is stored", () => {
    expect(parseWorkingHours(null)).toEqual({ hours: DEFAULT_WORKING_HOURS, defaulted: true });
    expect(parseWorkingHours("not json")).toEqual({ hours: DEFAULT_WORKING_HOURS, defaulted: true });
    const stored = JSON.stringify({ ...DEFAULT_WORKING_HOURS, sat: [["10:00", "12:00"]] });
    expect(parseWorkingHours(stored).defaulted).toBe(false);
  });
});

describe("regions (ISO 3166-1/-2)", () => {
  it.each(["GB", "GB-ENG", "US-CA", "DE-BY", "FR-75"])("accepts %s", (r) => expect(isValidRegion(r)).toBe(true));
  it.each(["XX", "UK", "gb", "GB-", "GB-ENGL", "GBR", ""])("refuses %j", (r) => expect(isValidRegion(r)).toBe(false));
  it("upper-cases input", () => expect(regionSchema.parse(" gb-eng ")).toBe("GB-ENG"));
});

describe("status (Identity §4.7)", () => {
  it.each(["🌴", "👍🏽", "🇬🇧", "👩‍💻", "1️⃣", "❤️"])("accepts %s as one emoji", (e) => expect(isSingleEmoji(e)).toBe(true));
  it.each(["", "a", "🌴🌴", "🌴 ", "hi 🌴", "<script>", "1"])("refuses %j", (e) =>
    expect(isSingleEmoji(e)).toBe(false),
  );

  it("normalises empty values to null", () => {
    expect(setStatusBodySchema.parse({ emoji: "", text: "  ", expiresAt: null })).toEqual({
      emoji: null,
      text: null,
      expiresAt: null,
    });
  });

  it("refuses text over 100 characters and unknown fields", () => {
    expect(setStatusBodySchema.safeParse({ emoji: null, text: "x".repeat(101), expiresAt: null }).success).toBe(false);
    expect(setStatusBodySchema.safeParse({ emoji: null, text: "ok", expiresAt: null, extra: 1 }).success).toBe(false);
  });

  it("hides an expired status", () => {
    const stored = { emoji: "📅", text: "In a meeting", expiresAt: 1000 };
    expect(effectiveStatus(stored, 999)).toEqual(stored);
    expect(effectiveStatus(stored, 1000)).toBeNull();
    expect(effectiveStatus({ emoji: null, text: null, expiresAt: null }, 0)).toBeNull();
    expect(statusLine(effectiveStatus(stored, 0))).toBe("📅 In a meeting");
    expect(statusLine({ emoji: null, text: "Away", expiresAt: null })).toBe("Away");
  });
});

describe("handles (Identity §4.8)", () => {
  it("normalises what people type", () => expect(normaliseHandle("  @Sam.Lee ")).toBe("sam.lee"));
  it.each([
    ["sam", null],
    ["s", "invalid"],
    ["-sam", "invalid"],
    ["sam lee", "invalid"],
    ["a".repeat(33), "invalid"],
    ["everyone", "reserved"],
    ["assistant", "reserved"],
  ] as const)("%s → %s", (handle, problem) => expect(handleShapeProblem(handle)).toBe(problem));

  it("derives the assistant's handle from its display name", () => {
    expect(assistantDerivedHandle("Butler")).toBe("butler");
    expect(assistantDerivedHandle("Señor Bot 2")).toBe("senorbot2");
    expect(assistantDerivedHandle("!")).toBeNull();
  });
});

describe("profile and directory bodies", () => {
  it("clears optional text with an empty string or null", () => {
    expect(updateProfileBodySchema.parse({ jobTitle: "", team: null, pronouns: " they/them " })).toEqual({
      jobTitle: null,
      team: null,
      pronouns: "they/them",
    });
  });

  it("lower-cases a requested handle and refuses unknown fields", () => {
    expect(updateProfileBodySchema.parse({ handle: "@Ana" }).handle).toBe("ana");
    expect(updateProfileBodySchema.safeParse({ email: "x@example.com" }).success).toBe(false);
    expect(updateProfileBodySchema.safeParse({ role: "owner" }).success).toBe(false);
  });

  it("defaults the directory query", () => {
    expect(directoryQuerySchema.parse({})).toEqual({ filter: "active", limit: 50 });
    expect(directoryQuerySchema.safeParse({ filter: "deleted" }).success).toBe(false);
    expect(directoryQuerySchema.safeParse({ limit: "500" }).success).toBe(false);
  });
});

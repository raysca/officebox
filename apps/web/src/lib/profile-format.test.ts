import { DEFAULT_WORKING_HOURS, type WorkingHours } from "@officebox/shared";
import { describe, expect, it } from "vitest";
import {
  clearAfterTime,
  initials,
  localTime,
  regionLabel,
  suggestedRegion,
  timeZoneOptions,
  workingHoursSummary,
} from "./profile-format";

describe("profile display helpers (M1d)", () => {
  it("makes initials", () => {
    expect(initials("Sam Lee")).toBe("SL");
    expect(initials("  ana  maria  diaz ")).toBe("AD");
    expect(initials("Prince")).toBe("P");
    expect(initials("   ")).toBe("?");
  });

  it("formats the local time in a zone, and gives up on an unknown zone", () => {
    const at = new Date(Date.UTC(2026, 0, 15, 12, 30));
    expect(localTime("Asia/Tokyo", at, "en-GB")).toBe("21:30");
    expect(localTime("Mars/Olympus", at)).toBeNull();
  });

  it("summarises working hours, grouping days with the same hours", () => {
    expect(workingHoursSummary(DEFAULT_WORKING_HOURS)).toBe("Mon–Fri 09:00–17:00");
    const split: WorkingHours = {
      ...DEFAULT_WORKING_HOURS,
      fri: [["09:00", "12:00"]],
      sat: [
        ["10:00", "12:00"],
        ["14:00", "16:00"],
      ],
    };
    expect(workingHoursSummary(split)).toBe("Mon–Thu 09:00–17:00 · Fri 09:00–12:00 · Sat 10:00–12:00, 14:00–16:00");
    const gap: WorkingHours = { ...DEFAULT_WORKING_HOURS, wed: [] };
    expect(workingHoursSummary(gap)).toBe("Mon–Tue 09:00–17:00 · Thu–Fri 09:00–17:00");
    const none: WorkingHours = { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] };
    expect(workingHoursSummary(none)).toBe("No working hours set");
  });

  it("lists time zones with UTC first and keeps the current one", () => {
    const zones = timeZoneOptions("Custom/Zone");
    expect(zones[0]).toBe("UTC");
    expect(zones).toContain("Custom/Zone");
    expect(new Set(zones).size).toBe(zones.length);
  });

  it("names regions and suggests one from the browser's languages", () => {
    expect(regionLabel("GB-ENG", "en")).toBe("United Kingdom (ENG)");
    expect(regionLabel(null)).toBeNull();
    expect(suggestedRegion(["en-GB", "en"])).toBe("GB");
    expect(suggestedRegion(["not a tag", "de-AT"])).toBe("AT");
  });

  it("works out when a status clears", () => {
    const now = new Date(2026, 5, 1, 10, 0);
    expect(clearAfterTime("never", now)).toBeNull();
    expect(clearAfterTime("30m", now)).toBe(now.getTime() + 30 * 60_000);
    expect(clearAfterTime("4h", now)).toBe(now.getTime() + 4 * 3600_000);
    expect(new Date(clearAfterTime("today", now)!).getHours()).toBe(23);
    const lateNight = new Date(2026, 5, 1, 23, 59, 30);
    expect(clearAfterTime("today", lateNight)).toBe(lateNight.getTime() + 60_000);
  });
});

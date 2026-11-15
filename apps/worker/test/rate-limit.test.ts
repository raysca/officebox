import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { CoreContext } from "../src/core/context";
import { createLogger } from "../src/core/log";
import {
  checkLimit,
  defineLimit,
  LIMITS,
  pruneRateCounters,
  RATE_COUNTER_RETENTION_MS,
  startOfDay,
  windowFor,
} from "../src/core/rate-limit";

const quiet = createLogger({}, () => {});
const at = (now: number): CoreContext => ({ env, log: quiet, now: () => now });
const key = () => crypto.randomUUID();
const HOUR = 3_600_000;

describe("D1 counter limits", () => {
  const perHour = defineLimit({
    mechanism: "d1",
    name: "test_per_hour",
    limit: 3,
    window: { kind: "fixed", seconds: 3600 },
  });

  it("allows up to the limit in a window, then refuses with a retry-after, without counting refusals", async () => {
    const k = key();
    const start = Math.floor(Date.now() / HOUR) * HOUR;
    const now = start + 10 * 60_000; // 10 minutes into the window
    for (let i = 0; i < 3; i++) expect((await checkLimit(at(now), perHour, k)).ok).toBe(true);

    const refused = await checkLimit(at(now), perHour, k);
    expect(refused).toEqual({
      ok: false,
      error: { code: "rate_limited", message: expect.any(String) as string, retryAfterSeconds: 50 * 60 },
    });
    await checkLimit(at(now), perHour, k);
    const row = await env.DB.prepare("SELECT count FROM rate_counters WHERE scope = ? AND key = ?")
      .bind("test_per_hour", k)
      .first<{ count: number }>();
    expect(row?.count).toBe(3);

    // The next window starts afresh.
    expect((await checkLimit(at(start + HOUR), perHour, k)).ok).toBe(true);
    // Other keys are independent.
    expect((await checkLimit(at(now), perHour, key())).ok).toBe(true);
  });

  it("counts concurrent hits exactly", async () => {
    const k = key();
    const now = Date.now();
    const results = await Promise.all(Array.from({ length: 6 }, () => checkLimit(at(now), perHour, k)));
    expect(results.filter((r) => r.ok).length).toBe(3);
  });

  it("uses daily windows in the member's time zone", async () => {
    const daily = defineLimit({ mechanism: "d1", name: "test_daily", limit: 1, window: { kind: "day" } });
    const k = key();
    // 23:30 on 1 March 2026 in New York (UTC-5) is 04:30 UTC on 2 March.
    const lateEvening = Date.UTC(2026, 2, 2, 4, 30);
    const tz = { timeZone: "America/New_York" };
    expect((await checkLimit(at(lateEvening), daily, k, tz)).ok).toBe(true);
    const refused = await checkLimit(at(lateEvening + 60_000), daily, k, tz);
    expect(!refused.ok && refused.error.retryAfterSeconds).toBe(29 * 60);
    // Just after local midnight: a new day.
    expect((await checkLimit(at(Date.UTC(2026, 2, 2, 5, 1)), daily, k, tz)).ok).toBe(true);
  });

  it("refuses definitions that belong to the binding", () => {
    expect(() =>
      defineLimit({ mechanism: "d1", name: "too_short", limit: 5, window: { kind: "fixed", seconds: 60 } }),
    ).toThrow(/binding/);
  });

  it("prunes counters older than the retention period", async () => {
    const k = key();
    const old = Date.now() - RATE_COUNTER_RETENTION_MS - HOUR;
    await env.DB.prepare("INSERT INTO rate_counters (scope, key, window_start, count) VALUES ('test_old', ?, ?, 1)")
      .bind(k, old)
      .run();
    expect(await pruneRateCounters(at(Date.now()))).toBeGreaterThanOrEqual(1);
    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM rate_counters WHERE key = ?")
      .bind(k)
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
  });
});

describe("day windows", () => {
  it("start at local midnight, including across DST changes", () => {
    // New York springs forward on 8 March 2026: that day is 23 hours long.
    const noon = Date.UTC(2026, 2, 8, 16, 0);
    const { start, end } = windowFor({ kind: "day" }, noon, "America/New_York");
    expect(start).toBe(Date.UTC(2026, 2, 8, 5, 0));
    expect(end).toBe(Date.UTC(2026, 2, 9, 4, 0));
    expect(startOfDay(Date.UTC(2026, 0, 1, 12), "UTC")).toBe(Date.UTC(2026, 0, 1));
    expect(startOfDay(Date.UTC(2026, 0, 1, 12), "Asia/Kolkata")).toBe(Date.UTC(2025, 11, 31, 18, 30));
  });
});

describe("day windows across time-zone rules", () => {
  const day = (at: number, tz: string) => windowFor({ kind: "day" }, at, tz);

  it("handles a 25-hour fall-back day", () => {
    // New York falls back on 1 November 2026.
    const { start, end } = day(Date.UTC(2026, 10, 1, 17), "America/New_York");
    expect(start).toBe(Date.UTC(2026, 10, 1, 4));
    expect(end).toBe(Date.UTC(2026, 10, 2, 5));
    expect(end - start).toBe(25 * HOUR);
  });

  it("starts the day at 01:00 where midnight doesn't exist", () => {
    // Cuba springs forward at 00:00 on 8 March 2026: the day starts at 01:00 CDT (UTC-4).
    const havana = day(Date.UTC(2026, 2, 8, 16), "America/Havana");
    expect(havana.start).toBe(Date.UTC(2026, 2, 8, 5));
    expect(havana.end - havana.start).toBe(23 * HOUR);
    // São Paulo sprang forward at 00:00 on 4 November 2018 (UTC-3 to UTC-2).
    const saoPaulo = day(Date.UTC(2018, 10, 4, 15), "America/Sao_Paulo");
    expect(saoPaulo.start).toBe(Date.UTC(2018, 10, 4, 3));
  });

  it("handles Lord Howe's half-hour DST change", () => {
    // Lord Howe goes from UTC+11 to UTC+10:30 at 02:00 on 5 April 2026: a 24.5-hour day.
    const { start, end } = day(Date.UTC(2026, 3, 5, 0), "Australia/Lord_Howe");
    expect(start).toBe(Date.UTC(2026, 3, 4, 13));
    expect(end).toBe(Date.UTC(2026, 3, 5, 13, 30));
  });

  it("falls back to UTC for an unknown zone", async () => {
    expect(day(Date.UTC(2026, 0, 1, 12), "Mars/Olympus_Mons")).toEqual({
      start: Date.UTC(2026, 0, 1),
      end: Date.UTC(2026, 0, 2),
    });
    const daily = defineLimit({ mechanism: "d1", name: "test_bad_zone", limit: 1, window: { kind: "day" } });
    const lines: string[] = [];
    const log = createLogger({}, (_l, line) => lines.push(line));
    const result = await checkLimit({ env, log, now: () => Date.now() }, daily, key(), { timeZone: "Not/AZone" });
    expect(result.ok).toBe(true);
    expect(lines.join("")).toContain("unknown time zone");
  });
});

describe("Rate Limiting binding", () => {
  it("allows 5 sign-in attempts per minute per key, then refuses", async () => {
    const k = key();
    const results = [];
    for (let i = 0; i < 6; i++) results.push(await checkLimit(at(Date.now()), LIMITS.auth, k));
    expect(results.slice(0, 5).every((r) => r.ok)).toBe(true);
    expect(results[5]).toEqual({
      ok: false,
      error: { code: "rate_limited", message: expect.any(String) as string, retryAfterSeconds: 60 },
    });
    // Namespaced per limit and key.
    expect((await checkLimit(at(Date.now()), LIMITS.auth, key())).ok).toBe(true);
  });
});

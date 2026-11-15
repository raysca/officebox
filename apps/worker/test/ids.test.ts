import { ULID_PATTERN } from "@officebox/shared";
import { describe, expect, it } from "vitest";
import { createUlidGenerator, ulid, ulidTime } from "../src/core/ids";

describe("ULID", () => {
  it("has the ULID shape and encodes the creation time", () => {
    const before = Date.now();
    const id = ulid();
    expect(id).toMatch(ULID_PATTERN);
    expect(ulidTime(id)).toBeGreaterThanOrEqual(before);
    expect(ulidTime(id)).toBeLessThanOrEqual(Date.now());
  });

  it("encodes a known time", () => {
    const next = createUlidGenerator({ now: () => 1_469_918_176_385, random: (b) => b.fill(0) });
    expect(next()).toBe("01ARYZ6S410000000000000000");
  });

  it("is monotonic within a millisecond", () => {
    const next = createUlidGenerator({ now: () => 1_700_000_000_000 });
    const ids = Array.from({ length: 1000 }, () => next());
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(1000);
    expect(new Set(ids.map((id) => id.slice(0, 10))).size).toBe(1);
  });

  it("stays monotonic when the clock steps backwards", () => {
    let t = 1_700_000_000_000;
    const next = createUlidGenerator({ now: () => t });
    const a = next();
    t -= 5000;
    const b = next();
    expect(b > a).toBe(true);
    expect(ulidTime(b)).toBe(ulidTime(a));
  });

  it("increments with carry and rolls into the next millisecond on overflow", () => {
    const next = createUlidGenerator({ now: () => 1_000, random: (b) => b.fill(31) });
    const first = next();
    expect(first.slice(10)).toBe("ZZZZZZZZZZZZZZZZ");
    const second = next();
    expect(ulidTime(second)).toBe(1_001);
    expect(second > first).toBe(true);
  });

  it("sorts across milliseconds", () => {
    let t = 1_700_000_000_000;
    const next = createUlidGenerator({ now: () => t++ });
    const ids = Array.from({ length: 50 }, () => next());
    expect([...ids].sort()).toEqual(ids);
  });
});

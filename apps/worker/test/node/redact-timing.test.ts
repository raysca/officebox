import { describe, expect, it } from "vitest";
import { redact, redactString } from "../../src/core/redact";

const opts = { email: () => "[email]" };

describe("redaction cost", () => {
  it("redacts hostile strings of 1 MB and of the post-cut size (about 2 KB) in under 50 ms", () => {
    const hostile = [
      "a".repeat(1_000_000),
      `${"a.".repeat(500_000)}@`,
      `${"x".repeat(999_990)}@b.c`,
      "@".repeat(1_000_000),
      `${"a-".repeat(500_000)}@${"b.".repeat(10)}`,
      `Bearer ${"a".repeat(1_000_000)}`,
      `eyJ${"a".repeat(1_000_000)}`,
      `?token=${"a".repeat(1_000_000)}`,
      "0123456789abcdef".repeat(65_536),
      // About the size the patterns actually see after the cut, crafted to make them backtrack.
      `${"a".repeat(2200)}_`,
      `${"aB1".repeat(733)}!`,
      `${"x".repeat(64)}@${"a-".repeat(1000)}`,
      `${"a.".repeat(1100)}@`,
      `eyJ${"a".repeat(1100)}.${"b".repeat(1100)}`,
    ];
    for (const value of hostile) {
      const started = performance.now();
      redactString(value, opts);
      expect(performance.now() - started).toBeLessThan(50);
    }
  });

  it("redacts a large object quickly", () => {
    const big = Object.fromEntries(Array.from({ length: 10_000 }, (_, i) => [`k${i}`, "x@".repeat(10_000)]));
    const started = performance.now();
    redact(big, opts);
    expect(performance.now() - started).toBeLessThan(200);
  });
});

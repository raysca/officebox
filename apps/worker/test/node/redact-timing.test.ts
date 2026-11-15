import { describe, expect, it } from "vitest";
import { redact, redactString } from "../../src/core/redact";

const opts = { email: () => "[email]" };

describe("redaction cost", () => {
  it("redacts a hostile 1 MB string in under 50 ms", () => {
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

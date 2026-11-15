import { describe, expect, it } from "vitest";
import { dummyVerify, hashPassword, verifyPassword, type PepperSet } from "../../src/features/identity/password";

/**
 * No account enumeration by timing (Identity §4.4): every refusal path costs one full derivation, the
 * same as a real check. Runs in Node because the Workers runtime's clock only advances on I/O.
 *
 * The fastest of several runs of each path must be within 0.5–2× the fastest real verification. The
 * band is loose enough to be stable on a shared CI machine, and tight enough to catch an early return
 * (around 0×) or a different iteration count (10× for 1M iterations).
 */

const pepperSet: PepperSet = { peppers: { "1": "timing-pepper-0123456789abcdefghijklmnop" }, currentId: "1" };
const RUNS = 7;

async function fastest(work: () => Promise<unknown>): Promise<number> {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < RUNS; i++) {
    const start = performance.now();
    await work();
    best = Math.min(best, performance.now() - start);
  }
  return best;
}

describe("password verification timing parity", () => {
  it("unknown accounts, malformed rows, bad iterations and missing peppers cost the same as a real check", async () => {
    const stored = await hashPassword("correct horse battery", pepperSet);
    const [scheme, , iterations, salt, hash] = stored.split("$");
    await verifyPassword(stored, "warm-up", pepperSet);

    const real = await fastest(() => verifyPassword(stored, "wrong password", pepperSet));
    const paths: Record<string, () => Promise<unknown>> = {
      "unknown account": () => verifyPassword(null, "wrong password", pepperSet),
      "malformed row": () => verifyPassword("garbage", "wrong password", pepperSet),
      "iterations out of range": () => verifyPassword(`${scheme}$1$5000000$${salt}$${hash}`, "x", pepperSet),
      "missing pepper": () => verifyPassword(`${scheme}$9$${iterations}$${salt}$${hash}`, "x", pepperSet),
      "dummy verify": () => dummyVerify("x"),
    };
    for (const [name, work] of Object.entries(paths)) {
      const ratio = (await fastest(work)) / real;
      expect(ratio, `${name}: ${ratio.toFixed(2)}× a real verification`).toBeGreaterThan(0.5);
      expect(ratio, `${name}: ${ratio.toFixed(2)}× a real verification`).toBeLessThan(2);
    }
  }, 30_000);
});

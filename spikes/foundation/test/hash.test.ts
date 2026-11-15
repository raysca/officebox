// Q1: PBKDF2 iteration limits and fallbacks, in the local Workers runtime (workerd via vitest-plugin).
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { argon2, argon2Check, dummyVerify, OWASP_ARGON2ID, pbkdf2, pepperedPbkdf2, scrypt, verifyPeppered } from "../src/hash";

const PW = "correct horse battery staple";

// Timings: performance.now() inside workerd. Locally the clock advances during computation (production Workers
// freeze it during CPU work, which is why the probe Worker measures from the client side instead).
function report(label: string, r: { ok: boolean; ms: number; error?: string }) {
  console.log(`${label.padEnd(44)} ${r.ok ? "ok   " : "FAIL "} ${r.ms.toFixed(1).padStart(8)} ms${r.ok ? "" : `  ${r.error}`}`);
}

describe("PBKDF2-SHA256 via WebCrypto (local workerd)", () => {
  for (const iterations of [100_000, 100_001, 600_000]) {
    it(`derives with ${iterations.toLocaleString("en")} iterations`, async () => {
      await pbkdf2(PW, 1000); // warm up
      const runs = [];
      for (let i = 0; i < 3; i++) runs.push(await pbkdf2(PW, iterations));
      for (const r of runs) report(`pbkdf2 ${iterations}`, r);
      // Local workerd uses a limit enforcer with no PBKDF2 cap, so all three succeed here.
      // In production the default enforcer caps at 100,000 (see README); the probe checks that.
      expect(runs.every((r) => r.ok)).toBe(true);
    });
  }

  it("the Worker route returns the versioned hash format", async () => {
    const res = await exports.default.fetch("http://x/bench/pbkdf2?iterations=600000");
    const body = await res.json<{ ok: boolean; hash: string }>();
    expect(body.ok).toBe(true);
    expect(body.hash).toMatch(/^pbkdf2-sha256\$600000\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/);
  });
});

describe("Fallback A: HMAC pepper + PBKDF2 100k", () => {
  it("hashes and verifies, rejects a wrong password and a wrong or missing pepper", async () => {
    const peppers = { "1": env.PEPPER_1 as string, "2": env.PEPPER_2 as string };
    const r = await pepperedPbkdf2(PW, peppers["1"], "1");
    report("pbkdf2 100k + HMAC pepper", r);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.hash).toMatch(/^pbkdf2-sha256-hmac\$1\$100000\$/);
    expect(await verifyPeppered(r.hash, PW, peppers)).toBe(true);
    expect(await verifyPeppered(r.hash, "wrong password", peppers)).toBe(false);
    expect(await verifyPeppered(r.hash, PW, { "1": peppers["2"] })).toBe(false); // wrong secret
    expect(await verifyPeppered(r.hash, PW, { "2": peppers["2"] })).toBe(false); // pepper id unknown
  });

  it("refuses stored iteration counts outside 100k..1M, so a tampered row can't burn CPU", async () => {
    const peppers = { "1": env.PEPPER_1 as string };
    const r = await pepperedPbkdf2(PW, peppers["1"], "1");
    if (!r.ok) throw new Error(r.error);
    // Out of range, or not a plain decimal integer ("1e5" and "100000.0" are numerically 100000 but refused).
    for (const iter of ["999999999", "1000", "1e5x", "-1", "1e5", "100000.0", " 100000", "0x186a0"]) {
      expect(await verifyPeppered(r.hash.replace("$100000$", `$${iter}$`), PW, peppers)).toBe(false);
    }
  });

  it("refuses a pepper shorter than 32 bytes, when hashing and when verifying", async () => {
    expect((await pepperedPbkdf2(PW, "too-short", "1")).ok).toBe(false);
    const r = await pepperedPbkdf2(PW, env.PEPPER_1 as string, "1");
    if (!r.ok) throw new Error(r.error);
    // Same id, but the configured secret is too short: refused rather than used.
    expect(await verifyPeppered(r.hash, PW, { "1": "too-short" })).toBe(false);
  });

  it("returns false (never throws) on malformed base64 or a malformed row", async () => {
    const peppers = { "1": env.PEPPER_1 as string };
    const r = await pepperedPbkdf2(PW, peppers["1"], "1");
    if (!r.ok) throw new Error(r.error);
    const [scheme, id, iter, salt, hash] = r.hash.split("$");
    const bad = [
      `${scheme}$${id}$${iter}$!!!not-base64!!!$${hash}`,
      `${scheme}$${id}$${iter}$${salt}$%%%`,
      `${scheme}$${id}$${iter}$${salt}`,
      `${scheme}$${id}$${iter}$${salt}$${hash}$extra`,
      "",
      "garbage",
    ];
    for (const row of bad) await expect(verifyPeppered(row, PW, peppers)).resolves.toBe(false);
  });

  it("never resolves inherited keys such as __proto__ or constructor as a pepper id", async () => {
    const peppers = { "1": env.PEPPER_1 as string };
    const r = await pepperedPbkdf2(PW, peppers["1"], "1");
    if (!r.ok) throw new Error(r.error);
    for (const id of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      await expect(verifyPeppered(r.hash.replace("$1$", `$${id}$`), PW, peppers)).resolves.toBe(false);
    }
  });

  it("refusal paths and the unknown-user path cost about as much as a real verify", async () => {
    // Timing parity check. workerd's clock has 1 ms resolution and a real verify takes ~12 ms here, so it compares
    // the minimum of 7 runs (least affected by a loaded machine) with a wide window, 0.4x..3x of the real verify.
    // It still fails if a path returns early (~0 ms) or derives at a different iteration count (600k is ~6x).
    const peppers = { "1": env.PEPPER_1 as string };
    const r = await pepperedPbkdf2(PW, peppers["1"], "1");
    if (!r.ok) throw new Error(r.error);
    const time = async (fn: () => Promise<boolean>) => {
      const ms: number[] = [];
      for (let i = 0; i < 7; i++) {
        const t0 = performance.now();
        await fn();
        ms.push(performance.now() - t0);
      }
      return Math.min(...ms);
    };
    const real = await time(() => verifyPeppered(r.hash, "wrong password", peppers));
    const paths = {
      unknownUser: await time(() => dummyVerify(PW)),
      retiredPepper: await time(() => verifyPeppered(r.hash.replace("$1$", "$9$"), PW, peppers)),
      tamperedIterations: await time(() => verifyPeppered(r.hash.replace("$100000$", "$999999999$"), PW, peppers)),
      malformed: await time(() => verifyPeppered("garbage", PW, peppers)),
    };
    console.log(`real verify ${real} ms; refusal paths ${JSON.stringify(paths)}`);
    for (const [name, ms] of Object.entries(paths)) {
      expect(ms, name).toBeGreaterThanOrEqual(real * 0.4);
      expect(ms, name).toBeLessThanOrEqual(real * 3);
    }
  });
});

describe("Fallback B: Argon2id via hash-wasm", () => {
  it("runs with the OWASP minimum (m=19 MiB, t=2, p=1) and verifies", async () => {
    const runs = [];
    for (let i = 0; i < 3; i++) runs.push(await argon2(PW, OWASP_ARGON2ID));
    for (const r of runs) report("argon2id m=19MiB t=2 p=1", r);
    const first = runs[0]!;
    expect(first.ok, first.ok ? "" : first.error).toBe(true);
    if (!first.ok) return;
    expect(first.hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await argon2Check(PW, first.hash)).toBe(true);
    expect(await argon2Check("wrong password", first.hash)).toBe(false);
  });

  it("runs with the OWASP alternative (m=46 MiB, t=1, p=1)", async () => {
    const r = await argon2(PW, { memoryKiB: 46 * 1024, iterations: 1, parallelism: 1 });
    report("argon2id m=46MiB t=1 p=1", r);
    expect(r.ok).toBe(true);
  });
});

describe("Bonus: native scrypt via node:crypto", () => {
  it("runs at the OWASP minimum N=2^17, r=8, p=1 (cost exactly at workerd's default 2^20 cap)", async () => {
    const r = await scrypt(PW, 1 << 17);
    report("scrypt N=2^17 r=8 p=1", r);
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
  });

  it("is refused above the cost cap (N=2^18, r=8)", async () => {
    const r = await scrypt(PW, 1 << 18);
    report("scrypt N=2^18 r=8 p=1", r);
    // Unlike PBKDF2, local workerd does apply the scrypt cap (its server limit enforcer only lifts the PBKDF2 one).
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/cost exceeds maximum \(1048576\)/);
  });
});

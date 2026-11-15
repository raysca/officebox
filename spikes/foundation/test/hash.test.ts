// Q1: PBKDF2 iteration limits and fallbacks, in the local Workers runtime (workerd via vitest-plugin).
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { argon2, argon2Check, OWASP_ARGON2ID, pbkdf2, pepperedPbkdf2, scrypt, verifyPeppered } from "../src/hash";

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

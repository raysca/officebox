// Q1: hash-wasm used as published fails in Workers. Separate file because hash-wasm caches the rejected
// compile promise per module instance, so the shimmed tests in hash.test.ts must not share its module state.
import { describe, expect, it } from "vitest";
import { argon2, OWASP_ARGON2ID } from "../src/hash";

describe("hash-wasm argon2id without the shim", () => {
  it("is refused: Workers forbid compiling WASM from bytes at runtime", async () => {
    const r = await argon2("correct horse battery staple", OWASP_ARGON2ID, false);
    console.log("argon2id unshimmed:", r.ok ? "ok" : r.error);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/Wasm code generation disallowed by embedder/);
  });
});

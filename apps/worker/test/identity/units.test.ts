import { describe, expect, it } from "vitest";
import { csrfFailure } from "../../src/core/csrf";
import { createLogger } from "../../src/core/log";
import { authorize } from "../../src/core/permissions";
import { ACCESS_TOKEN_TTL_MS, signAccessToken, verifyAccessToken } from "../../src/features/identity/access-token";
import { base64url, fromBase64url, timingSafeEqual } from "../../src/features/identity/crypto";
import { approxLocation, deviceLabel } from "../../src/features/identity/device";
import {
  dummyVerify,
  hashPassword,
  MAX_STORED_ITERATIONS,
  peppersFromEnv,
  verifyPassword,
  type PepperSet,
} from "../../src/features/identity/password";
import { identitySecrets } from "../../src/features/identity/secrets";
import { throttleDelayMs } from "../../src/features/identity/sign-in";

const P1 = "unit-pepper-one-0123456789abcdefghijklmnop";
const P2 = "unit-pepper-two-0123456789abcdefghijklmnop";
const one: PepperSet = { peppers: { "1": P1 }, currentId: "1" };
const both: PepperSet = { peppers: { "1": P1, "2": P2 }, currentId: "2" };
const quiet = createLogger({}, () => {});

describe("password hashing (Identity §4.4)", () => {
  it("stores the versioned format and verifies the right password only", async () => {
    const stored = await hashPassword("correct horse battery", one);
    expect(stored).toMatch(/^pbkdf2-sha256-hmac\$1\$100000\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
    expect(await verifyPassword(stored, "correct horse battery", one)).toEqual({
      valid: true,
      needsRehash: false,
      unknownPepper: false,
    });
    expect((await verifyPassword(stored, "correct horse batterY", one)).valid).toBe(false);
    // A fresh salt every time.
    expect(await hashPassword("correct horse battery", one)).not.toBe(stored);
  });

  it("a different pepper secret gives a different hash (a D1 dump alone can't be attacked)", async () => {
    const stored = await hashPassword("pw-pw-pw-pw", one);
    const otherSecret: PepperSet = { peppers: { "1": P2 }, currentId: "1" };
    expect((await verifyPassword(stored, "pw-pw-pw-pw", otherSecret)).valid).toBe(false);
  });

  it("asks for a re-hash when a newer pepper exists, and reports a missing pepper", async () => {
    const old = await hashPassword("pw-pw-pw-pw", one);
    expect(await verifyPassword(old, "pw-pw-pw-pw", both)).toEqual({
      valid: true,
      needsRehash: true,
      unknownPepper: false,
    });
    const retired: PepperSet = { peppers: { "2": P2 }, currentId: "2" };
    expect(await verifyPassword(old, "pw-pw-pw-pw", retired)).toEqual({
      valid: false,
      needsRehash: false,
      unknownPepper: true,
    });
    // New hashes use the newest pepper.
    expect(await hashPassword("x", both)).toMatch(/^pbkdf2-sha256-hmac\$2\$/);
  });

  it("refuses out-of-range iterations and malformed rows without throwing", async () => {
    const good = await hashPassword("pw-pw-pw-pw", one);
    const [scheme, id, , salt, hash] = good.split("$");
    const variants = [
      `${scheme}$${id}$99999$${salt}$${hash}`,
      `${scheme}$${id}$${MAX_STORED_ITERATIONS + 1}$${salt}$${hash}`,
      `${scheme}$${id}$1e5$${salt}$${hash}`,
      `${scheme}$${id}$100000$${salt}`,
      `${scheme}$${id}$100000$!!!$${hash}`,
      `${scheme}$${id}$100000$${salt}$${hash}AA`,
      `pbkdf2-sha256$${id}$100000$${salt}$${hash}`,
      `${scheme}$__proto__$100000$${salt}$${hash}`,
      `${scheme}$constructor$100000$${salt}$${hash}`,
      "",
      "garbage",
    ];
    for (const stored of variants) {
      expect((await verifyPassword(stored, "pw-pw-pw-pw", one)).valid).toBe(false);
    }
    expect((await verifyPassword(null, "pw-pw-pw-pw", one)).valid).toBe(false);
    expect(await dummyVerify("anything")).toBe(false);
  });

  it("reads PEPPER_<n> secrets, ignoring short ones and picking the highest number", () => {
    expect(peppersFromEnv({ PEPPER_1: P1, PEPPER_3: P2, PEPPER_2: "short", OTHER: P1, PEPPER_X: P1 })).toEqual({
      set: { peppers: { "1": P1, "3": P2 }, currentId: "3" },
      invalid: ["PEPPER_2"],
    });
    expect(peppersFromEnv({ PEPPER_1: "" }).set).toBeNull();
    expect(peppersFromEnv({}).set).toBeNull();
  });
});

describe("identity secrets", () => {
  const strong = "k".repeat(32);
  it("needs a signing key, a token hash key and a pepper, each at least 32 bytes", () => {
    const base = { SESSION_SIGNING_KEY: strong, TOKEN_HASH_KEY: strong, PEPPER_1: P1 };
    const env = (extra: object) => ({ ...base, ...extra }) as unknown as Parameters<typeof identitySecrets>[0];
    expect(identitySecrets(env({}), quiet).ok).toBe(true);
    expect(identitySecrets(env({ SESSION_SIGNING_KEY: "short" }), quiet).ok).toBe(false);
    expect(identitySecrets(env({ TOKEN_HASH_KEY: undefined }), quiet).ok).toBe(false);
    expect(identitySecrets(env({ PEPPER_1: undefined }), quiet).ok).toBe(false);
    const rotating = identitySecrets(env({ SESSION_SIGNING_KEY_PREVIOUS: "p".repeat(32) }), quiet);
    expect(rotating.ok && rotating.value.sessionKeys).toEqual([strong, "p".repeat(32)]);
  });

  it("never logs a secret's value", () => {
    const lines: string[] = [];
    const log = createLogger({}, (_level, line) => lines.push(line));
    identitySecrets({ SESSION_SIGNING_KEY: "tiny-secret", PEPPER_1: "tiny-pepper" } as never, log);
    expect(lines.join("\n")).not.toContain("tiny-secret");
    expect(lines.join("\n")).not.toContain("tiny-pepper");
    expect(lines.join("\n")).toContain("SESSION_SIGNING_KEY");
  });
});

describe("access tokens", () => {
  const key = "signing-key-0123456789abcdefghijklmnop";
  const claims = { userId: "01JABCDEFGHJKMNPQRSTVWXYZ0", sessionId: "01JABCDEFGHJKMNPQRSTVWXYZ1", epoch: 3 };

  it("round-trips and expires after 15 minutes", async () => {
    const token = await signAccessToken(key, claims, 1_000);
    expect(await verifyAccessToken([key], token, 1_000 + ACCESS_TOKEN_TTL_MS - 1)).toMatchObject({
      uid: claims.userId,
      sid: claims.sessionId,
      ep: 3,
    });
    expect(await verifyAccessToken([key], token, 1_000 + ACCESS_TOKEN_TTL_MS)).toBeNull();
  });

  it("accepts the previous key during a rotation, refuses unknown keys and tampering", async () => {
    const token = await signAccessToken(key, claims, 0);
    expect(await verifyAccessToken(["new-key-0123456789abcdefghijklmnopq", key], token, 1)).not.toBeNull();
    expect(await verifyAccessToken(["other-key-0123456789abcdefghijklmnop"], token, 1)).toBeNull();
    const [body = "", sig = ""] = token.split(".");
    const forgedBody = base64url(
      new TextEncoder().encode(
        JSON.stringify({ v: 1, uid: claims.userId, sid: claims.sessionId, ep: 99, iat: 0, exp: 9e12 }),
      ),
    );
    expect(await verifyAccessToken([key], `${forgedBody}.${sig}`, 1)).toBeNull();
    expect(await verifyAccessToken([key], `${body}.${sig}.extra`, 1)).toBeNull();
    expect(await verifyAccessToken([key], "", 1)).toBeNull();
    expect(await verifyAccessToken([key], "x".repeat(2000), 1)).toBeNull();
  });
});

describe("crypto helpers", () => {
  it("compares in constant time, including different lengths", () => {
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
    expect(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 0]))).toBe(false);
    expect(timingSafeEqual(new Uint8Array([]), new Uint8Array([]))).toBe(true);
  });

  it("round-trips base64url and refuses malformed input", () => {
    const bytes = crypto.getRandomValues(new Uint8Array(33));
    expect(fromBase64url(base64url(bytes))).toEqual(bytes);
    expect(fromBase64url("not base64!")).toBeNull();
  });
});

describe("sign-in throttle schedule (Identity §4.4)", () => {
  it("is free for five attempts, then 1, 2, 4, 8, 16 s, capped at 30 s", () => {
    expect([0, 1, 2, 3, 4].map(throttleDelayMs)).toEqual([0, 0, 0, 0, 0]);
    expect([5, 6, 7, 8, 9, 10, 11, 50].map(throttleDelayMs)).toEqual([
      1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000,
    ]);
  });
});

describe("device details", () => {
  it("labels common browsers and systems", () => {
    expect(
      deviceLabel(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
      ),
    ).toBe("Chrome on macOS");
    expect(
      deviceLabel(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36 Edg/131.0",
      ),
    ).toBe("Edge on Windows");
    expect(
      deviceLabel(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      ),
    ).toBe("Safari on iOS");
    expect(deviceLabel("Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0")).toBe(
      "Firefox on Linux",
    );
    expect(deviceLabel("curl/8.0")).toBeNull();
    expect(deviceLabel(null)).toBeNull();
  });

  it("formats the approximate location", () => {
    expect(approxLocation({ city: "London", country: "GB" })).toBe("London, GB");
    expect(approxLocation({ country: "DE" })).toBe("DE");
    expect(approxLocation({ country: "XX" })).toBeNull();
    expect(approxLocation(undefined)).toBeNull();
  });
});

describe("CSRF check (TDD §8.2)", () => {
  const req = (method: string, headers: Record<string, string>) =>
    new Request("https://work.example/api/x", { method, headers });

  it("lets safe methods through and checks every other method", () => {
    expect(csrfFailure(req("GET", {}))).toBeNull();
    expect(csrfFailure(req("HEAD", {}))).toBeNull();
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(csrfFailure(req(method, {}))).toBe("missing_header");
      expect(csrfFailure(req(method, { "X-Officebox-Request": "1" }))).toBe("missing_origin");
      expect(csrfFailure(req(method, { "X-Officebox-Request": "1", Origin: "https://evil.example" }))).toBe(
        "origin_mismatch",
      );
      expect(csrfFailure(req(method, { "X-Officebox-Request": "1", Origin: "http://work.example" }))).toBe(
        "origin_mismatch",
      );
      expect(csrfFailure(req(method, { "X-Officebox-Request": "0", Origin: "https://work.example" }))).toBe(
        "missing_header",
      );
      expect(csrfFailure(req(method, { "X-Officebox-Request": "1", Origin: "https://work.example" }))).toBeNull();
    }
  });
});

describe("authorize (Worker side of the permission engine)", () => {
  const admin = { userId: "a", role: "admin" as const, status: "active" as const };
  const owner = { userId: "o", role: "owner" as const, status: "active" as const };

  it("maps denials to typed forbidden errors, or not_found when hiding existence", () => {
    expect(authorize({ log: quiet }, owner, { action: "audit.view" })).toEqual({ ok: true, value: undefined });
    expect(
      authorize({ log: quiet }, admin, {
        action: "member.disable",
        target: owner,
        activeOwnerCount: 2,
      }),
    ).toEqual({ ok: false, error: { code: "forbidden", message: "An owner must do this." } });
    expect(authorize({ log: quiet }, admin, { action: "devices.sign_out", ownerId: "o" }, { hideAs404: true })).toEqual(
      {
        ok: false,
        error: { code: "not_found", message: "Not found." },
      },
    );
  });
});

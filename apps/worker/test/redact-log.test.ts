import { describe, expect, it } from "vitest";
import { createLogger, type LogLevel } from "../src/core/log";
import { logUnredacted } from "../src/core/log-unredacted";
import { isSensitiveKey, redact, redactString, REDACTED } from "../src/core/redact";

const opts = { email: () => "[email]" };

describe("redactString", () => {
  it("caps the output length of huge input (timing is checked in test/node)", () => {
    expect(redactString("z ".repeat(500_000), opts).length).toBe(2001);
  });

  it("removes tokens, credential query parameters and hex secrets, keeping IDs", () => {
    const token = "Zx9QmT4rLk2Vb8Nw1Yc7Hd3Fg6Js5Pa0Qw8Er2Ty"; // base64url of random bytes
    expect(redactString(`token ${token} end`, opts)).toBe(`token ${REDACTED} end`);
    expect(redactString("hash 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08", opts)).toBe(
      `hash ${REDACTED}`,
    );
    expect(redactString("/invite?code=abc123&next=/home&ticket=t1#x", opts)).toBe(
      `/invite?code=${REDACTED}&next=/home&ticket=${REDACTED}#x`,
    );
    expect(redactString("authorization: BEARER abcdefgh.ijk", opts)).toBe(`authorization: BEARER ${REDACTED}`);
    expect(redactString("bearer of bad news", opts)).toBe("bearer of bad news");
    expect(redactString("user 01J9ZQ8V6N3X2K4M5P7R8S9T0V did it", opts)).toBe("user 01J9ZQ8V6N3X2K4M5P7R8S9T0V did it");
    expect(redactString("mail alice@example.com now", opts)).toBe("mail [email] now");
  });
});

describe("isSensitiveKey", () => {
  it("matches secret names without catching ordinary ones", () => {
    for (const key of [
      "password",
      "setupToken",
      "api_key",
      "key",
      "code",
      "otp",
      "mfaOtp",
      "session",
      "sid",
      "jwt",
      "csrfToken",
      "pin",
      "signingKey",
      "encryptionKey",
      "hmacSecret",
      "pepper",
      "Authorization",
      "set-cookie",
    ]) {
      expect(isSensitiveKey(key), key).toBe(true);
    }
    for (const key of ["errorCode", "statusCode", "id", "userId", "name", "keyCount", "count", "durationMs"]) {
      expect(isSensitiveKey(key), key).toBe(false);
    }
  });
});

describe("redact", () => {
  it("redacts keys that are emails, and handles Date, Map, Set and shared references", () => {
    const shared = { n: 1 };
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    const out = redact(
      {
        "bob@example.com": "x",
        when: new Date(0),
        map: new Map<string, unknown>([
          ["token", "t"],
          ["k", 1],
        ]),
        set: new Set(["carol@example.net"]),
        first: shared,
        second: shared,
        cyclic,
      },
      opts,
    );
    expect(out).toEqual({
      "[email]": "x",
      when: "1970-01-01T00:00:00.000Z",
      map: { token: REDACTED, k: 1 },
      set: ["[email]"],
      first: { n: 1 },
      second: { n: 1 },
      cyclic: { a: 1, self: "[circular]" },
    });
  });
});

describe("logger", () => {
  const capture = () => {
    const lines: Array<{ level: LogLevel; record: Record<string, unknown> }> = [];
    const log = createLogger({}, (level, line) =>
      lines.push({ level, record: JSON.parse(line) as Record<string, unknown> }),
    );
    return { log, lines };
  };

  it("never lets fields overwrite level or message", () => {
    const { log, lines } = capture();
    log.info("real", { level: "error", message: "forged" });
    expect(lines[0]?.record).toMatchObject({ level: "info", message: "real" });
  });

  it("has a narrow unredacted escape hatch", () => {
    const lines: Array<{ level: LogLevel; record: Record<string, unknown> }> = [];
    logUnredacted("setup token generated", { token: "Zx9QmT4rLk2Vb8Nw1Yc7Hd3Fg6Js5Pa0Qw8Er2Ty" }, (level, line) =>
      lines.push({ level, record: JSON.parse(line) as Record<string, unknown> }),
    );
    expect(lines[0]?.record).toMatchObject({
      level: "warn",
      message: "setup token generated",
      unredacted: true,
      token: "Zx9QmT4rLk2Vb8Nw1Yc7Hd3Fg6Js5Pa0Qw8Er2Ty",
    });
  });
});

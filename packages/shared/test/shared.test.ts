import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  apiError,
  apiErrorBodySchema,
  defineMessage,
  defineMessageSet,
  envelopeSchema,
  err,
  errorMessage,
  errorMessageSchema,
  ok,
  validationError,
  type Result,
} from "../src";

describe("Result", () => {
  it("narrows on ok", () => {
    const parse = (input: string): Result<number, "not_a_number"> => {
      const n = Number(input);
      return Number.isNaN(n) ? err("not_a_number") : ok(n);
    };
    const good = parse("42");
    const bad = parse("x");
    expect(good).toEqual({ ok: true, value: 42 });
    expect(bad).toEqual({ ok: false, error: "not_a_number" });
    expect(ok()).toEqual({ ok: true, value: undefined });
  });
});

describe("API error body", () => {
  it("accepts a known code and rejects an unknown one", () => {
    const body = { error: apiError("rate_limited", "Slow down", { retryAfterSeconds: 30 }) };
    expect(apiErrorBodySchema.parse(body)).toEqual(body);
    expect(apiErrorBodySchema.safeParse({ error: { code: "teapot", message: "no" } }).success).toBe(false);
  });
});

describe("WebSocket envelope", () => {
  it("keeps payload fields and requires a well-formed type", () => {
    expect(envelopeSchema.parse({ type: "chat.send", id: "r1", body: "hi" })).toEqual({
      type: "chat.send",
      id: "r1",
      body: "hi",
    });
    expect(envelopeSchema.safeParse({ type: "Chat Send" }).success).toBe(false);
    expect(envelopeSchema.safeParse({ id: "r1" }).success).toBe(false);
  });

  it("defines strict concrete messages", () => {
    const ping = defineMessage("system.ping", { at: z.number() });
    expect(ping.parse({ type: "system.ping", at: 1 })).toEqual({ type: "system.ping", at: 1 });
    expect(ping.safeParse({ type: "system.pong", at: 1 }).success).toBe(false);
    expect(ping.safeParse({ type: "system.ping", at: 1, extra: true }).success).toBe(false);
  });
});

describe("message sets", () => {
  const send = defineMessage("chat.send", { body: z.string().max(10) });
  const typing = defineMessage("chat.typing", {});
  const messages = defineMessageSet([send, typing]);

  it("parses into the union by type", () => {
    const parsed = messages.parseText('{"type":"chat.send","id":"r1","body":"hi"}');
    expect(parsed).toEqual({ ok: true, value: { type: "chat.send", id: "r1", body: "hi" } });
    expect(messages.types).toEqual(["chat.send", "chat.typing"]);
  });

  it("explains refusals and keeps the id for correlation", () => {
    const reason = (text: string) => {
      const r = messages.parseText(text, 64);
      return r.ok ? null : r.error.reason;
    };
    expect(reason("{oops")).toBe("invalid_json");
    expect(reason('{"id":"x"}')).toBe("invalid_envelope");
    expect(reason('{"type":"chat.nope"}')).toBe("unknown_type");
    expect(reason(`{"type":"chat.send","body":"${"x".repeat(80)}"}`)).toBe("too_large");
    const invalid = messages.parse({ type: "chat.send", id: "r9", body: "far too long" });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.error).toMatchObject({ reason: "invalid_payload", type: "chat.send", id: "r9" });
      expect(invalid.error.error.code).toBe("validation_failed");
      expect(Object.keys(invalid.error.error.fields ?? {})).toEqual(["body"]);
    }
  });

  it("refuses duplicate types and builds error messages", () => {
    expect(() => defineMessageSet([send, send])).toThrow(/Duplicate/);
    const error = apiError("forbidden", "No");
    expect(errorMessageSchema.parse(errorMessage(error, "r1"))).toEqual({ type: "error", id: "r1", error });
  });
});

describe("validationError", () => {
  it("keys messages by dotted path", () => {
    const schema = z.object({ a: z.object({ b: z.number() }) });
    const result = schema.safeParse({ a: { b: "x" } });
    if (result.success) throw new Error("expected failure");
    expect(Object.keys(validationError(result.error).fields ?? {})).toEqual(["a.b"]);
  });
});

describe("normaliseEmail (Identity §4.4)", () => {
  it("trims, applies NFKC before and after lower-casing", async () => {
    const { normaliseEmail } = await import("../src/identity");
    expect(normaliseEmail("  Sam@Example.COM ")).toBe("sam@example.com");
    expect(normaliseEmail("\u210c@x.com")).toBe("h@x.com"); // ℌ folds to H, then lower-cases
    expect(normaliseEmail("SAM\uff20EXAMPLE.COM")).toBe("sam@example.com"); // fullwidth @
    expect(normaliseEmail("\u0130@x.com")).toBe("i\u0307@x.com".normalize("NFKC"));
  });
});

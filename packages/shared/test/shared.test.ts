import { describe, expect, it } from "vitest";
import { z } from "zod";
import { apiError, apiErrorBodySchema, defineMessage, envelopeSchema, err, ok, type Result } from "../src";

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

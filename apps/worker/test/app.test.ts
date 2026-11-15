import { apiError, apiErrorBodySchema, err, ok, ULID_PATTERN } from "@officebox/shared";
import { env, exports } from "cloudflare:workers";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createApp, defineFeature } from "../src/core/app";
import type { AppEnv } from "../src/core/context";
import { HTTP_STATUS, readJson, respond } from "../src/core/errors";
import type { LogLevel } from "../src/core/log";

const ORIGIN = "http://officebox.test";

const bodySchema = z.strictObject({ name: z.string().min(1) });

// A sample feature exercising the result-to-HTTP mapping.
const sample = new Hono<AppEnv>()
  .get("/ok", (c) => respond(c, ok({ hello: "world" })))
  .post("/items", async (c) => {
    const body = await readJson(c, bodySchema, 64);
    if (!body.ok) return respond(c, body);
    return respond(c, ok({ created: body.value.name }), 201);
  })
  .get("/denied", (c) => respond(c, err(apiError("forbidden", "Not allowed."))))
  .get("/limited", (c) => respond(c, err(apiError("rate_limited", "Slow down.", { retryAfterSeconds: 7 }))))
  .get("/boom", () => {
    throw new Error("database password=hunter2 exploded for alice@example.com");
  });

function makeApp() {
  const lines: Array<{ level: LogLevel; line: string }> = [];
  const app = createApp({
    features: [defineFeature("sample", sample)],
    logSink: (level, line) => lines.push({ level, line }),
  });
  const call = (path: string, init?: RequestInit) => app.request(`${ORIGIN}${path}`, init, env);
  return { call, lines };
}

describe("feature routes and typed results", () => {
  it("mounts features under /api/<name> and returns values as JSON", async () => {
    const { call } = makeApp();
    const res = await call("/api/sample/ok");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hello: "world" });
    expect(res.headers.get("X-Request-Id")).toMatch(ULID_PATTERN);
  });

  it("maps error codes to statuses with a typed body carrying the request ID", async () => {
    const { call } = makeApp();
    const res = await call("/api/sample/denied");
    expect(res.status).toBe(403);
    const body = apiErrorBodySchema.parse(await res.json());
    expect(body.error).toEqual({ code: "forbidden", message: "Not allowed." });
    expect(body.requestId).toBe(res.headers.get("X-Request-Id"));
  });

  it("sets Retry-After for rate_limited", async () => {
    const { call } = makeApp();
    const res = await call("/api/sample/limited");
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("7");
  });

  it("validates JSON bodies with Zod and reports fields", async () => {
    const { call } = makeApp();
    const post = (body: string) =>
      call("/api/sample/items", { method: "POST", body, headers: { "Content-Type": "application/json" } });

    expect((await post('{"name":"x"}')).status).toBe(201);

    const invalid = await post('{"name":"","extra":1}');
    expect(invalid.status).toBe(400);
    const body = apiErrorBodySchema.parse(await invalid.json());
    expect(body.error.code).toBe("validation_failed");
    expect(Object.keys(body.error.fields ?? {}).sort()).toEqual(["", "name"]);

    const malformed = await post("{nope");
    expect(apiErrorBodySchema.parse(await malformed.json()).error.code).toBe("validation_failed");

    const tooLarge = await post(JSON.stringify({ name: "x".repeat(100) }));
    expect(tooLarge.status).toBe(413);
  });

  it("turns unexpected exceptions into a 500 with a request ID and logs them without secrets", async () => {
    const { call, lines } = makeApp();
    const res = await call("/api/sample/boom");
    expect(res.status).toBe(500);
    const body = apiErrorBodySchema.parse(await res.json());
    expect(body.error).toEqual({ code: "internal", message: "Something went wrong." });
    expect(body.requestId).toMatch(ULID_PATTERN);

    const errorLine = lines.find((l) => l.level === "error");
    expect(errorLine).toBeDefined();
    const record = JSON.parse(errorLine?.line ?? "{}") as Record<string, unknown>;
    expect(record.requestId).toBe(body.requestId);
    expect(errorLine?.line).not.toContain("alice@example.com");
    expect(errorLine?.line).toContain("[email]");
  });

  it("logs one structured line per API request without the query string", async () => {
    const { call, lines } = makeApp();
    await call("/api/sample/ok?token=abc123secret");
    const record = JSON.parse(lines.find((l) => l.line.includes('"request"'))?.line ?? "{}") as Record<string, unknown>;
    expect(record).toMatchObject({ level: "info", message: "request", method: "GET", status: 200 });
    expect(typeof record.durationMs).toBe("number");
    expect(JSON.stringify(lines)).not.toContain("abc123secret");
  });

  it("returns a typed 404 for unknown /api routes", async () => {
    const { call } = makeApp();
    for (const path of ["/api", "/api/nope", "/api/sample/nope"]) {
      const res = await call(path);
      expect(res.status).toBe(404);
      expect(apiErrorBodySchema.parse(await res.json()).error.code).toBe("not_found");
    }
  });

  it("maps every error code to a status", () => {
    for (const status of Object.values(HTTP_STATUS)) expect(status).toBeGreaterThanOrEqual(400);
  });
});

describe("the deployed Worker", () => {
  it("serves a typed 404 for unknown API paths", async () => {
    const res = await exports.default.fetch(new Request(`${ORIGIN}/api/does-not-exist`));
    expect(res.status).toBe(404);
    expect(apiErrorBodySchema.parse(await res.json()).error.code).toBe("not_found");
  });
});

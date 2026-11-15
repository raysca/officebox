import {
  API_CONTENT_SECURITY_POLICY,
  apiError,
  apiErrorBodySchema,
  APP_CONTENT_SECURITY_POLICY,
  COMMON_SECURITY_HEADERS,
  err,
  ok,
  ULID_PATTERN,
} from "@officebox/shared";
import { env, exports } from "cloudflare:workers";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createApp, defineFeature } from "../src/core/app";
import type { AppEnv } from "../src/core/context";
import { HTTP_STATUS, readBodyText, readJson, respond } from "../src/core/errors";
import type { LogLevel } from "../src/core/log";

const ORIGIN = "http://officebox.test";

const bodySchema = z.strictObject({ name: z.string().min(1) });

// A sample feature exercising the result-to-HTTP mapping.
const sample = new Hono<AppEnv>()
  .get("/ok", (c) => respond(c, ok({ hello: "world" })))
  .get("/raw", (c) => c.json({ raw: true }))
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

describe("request body limits", () => {
  const post = (body: BodyInit, headers: Record<string, string> = {}) =>
    readBodyText(new Request(`${ORIGIN}/x`, { method: "POST", body, headers, duplex: "half" } as RequestInit), 64);

  const stream = (...chunks: string[]) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    });

  it("reads a chunked body with no Content-Length within the limit", async () => {
    expect(await post(stream('{"a":', "1}"))).toEqual({ ok: true, value: '{"a":1}' });
  });

  it("stops reading a chunked body once it passes the limit", async () => {
    const result = await post(stream("x".repeat(40), "y".repeat(40), "z".repeat(1000)));
    expect(!result.ok && result.error.code).toBe("payload_too_large");
  });

  it("refuses a declared size over the limit before reading", async () => {
    const result = await post("small", { "Content-Length": "100000" });
    expect(!result.ok && result.error.code).toBe("payload_too_large");
  });

  it("counts real bytes when the header understates the size", async () => {
    const request = new Request(`${ORIGIN}/x`, {
      method: "POST",
      body: stream("x".repeat(500)),
      duplex: "half",
    } as RequestInit);
    // Headers on a streamed request are what the client claimed; the runtime doesn't check them.
    const lying = new Request(request, { headers: { "Content-Length": "10" } });
    const result = await readBodyText(lying, 64);
    expect(!result.ok && result.error.code).toBe("payload_too_large");
  });

  it("refuses a malformed or negative Content-Length", async () => {
    for (const value of ["-1", "abc", "1e3", "Infinity"]) {
      const headers = new Headers();
      const request = new Request(`${ORIGIN}/x`, { method: "POST", body: stream("{}"), duplex: "half" } as RequestInit);
      headers.set("Content-Length", value);
      const result = await readBodyText(new Request(request, { headers }), 64);
      expect(!result.ok && result.error.code, value).toBe("validation_failed");
    }
  });

  it("refuses invalid UTF-8", async () => {
    const bytes = new Uint8Array([0x7b, 0xff, 0x7d]);
    const result = await post(bytes);
    expect(!result.ok && result.error.code).toBe("validation_failed");
  });
});

describe("API caching", () => {
  it("marks every API response no-store, whichever helper built it", async () => {
    const { call } = makeApp();
    for (const path of ["/api/sample/ok", "/api/sample/raw", "/api/sample/denied", "/api/nope"]) {
      expect((await call(path)).headers.get("Cache-Control"), path).toBe("no-store");
    }
  });
});

describe("security headers", () => {
  it("sets the API CSP and the common headers on API and health responses", async () => {
    const { call } = makeApp();
    for (const path of ["/api/sample/ok", "/api/nope", "/health"]) {
      const res = await call(path);
      expect(res.headers.get("Content-Security-Policy"), path).toBe(API_CONTENT_SECURITY_POLICY);
      for (const [name, value] of Object.entries(COMMON_SECURITY_HEADERS)) {
        expect(res.headers.get(name), `${path} ${name}`).toBe(value);
      }
    }
  });

  it("sets the app CSP on assets the Worker passes through", async () => {
    const assets = {
      fetch: () => Promise.resolve(new Response("<!doctype html>", { headers: { "Content-Type": "text/html" } })),
    };
    const app = createApp({ features: [], logSink: () => {} });
    const res = await app.request(`${ORIGIN}/some/file.js`, {}, { ...env, ASSETS: assets as unknown as Fetcher });
    expect(res.headers.get("Content-Security-Policy")).toBe(APP_CONTENT_SECURITY_POLICY);
    expect(res.headers.get("X-Request-Id")).toMatch(ULID_PATTERN);
  });
});

describe("the deployed Worker", () => {
  it("serves a typed 404 for unknown API paths", async () => {
    const res = await exports.default.fetch(new Request(`${ORIGIN}/api/does-not-exist`));
    expect(res.status).toBe(404);
    expect(apiErrorBodySchema.parse(await res.json()).error.code).toBe("not_found");
  });
});

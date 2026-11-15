import { healthResponseSchema } from "@officebox/shared";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/core/app";
import { checkHealth } from "../src/core/health";
import { createLogger } from "../src/core/log";

const ORIGIN = "http://officebox.test";
const quiet = createLogger({}, () => {});

describe("GET /health", () => {
  it("reports ok with the build version and each check", async () => {
    const res = await exports.default.fetch(new Request(`${ORIGIN}/health`));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = healthResponseSchema.parse(await res.json());
    expect(body.status).toBe("ok");
    expect(body.version).toBe(env.OFFICEBOX_VERSION);
    expect(Object.keys(body.checks).sort()).toEqual(["d1", "durableObjects", "queues"]);
    expect(Object.values(body.checks).every((c) => c.ok)).toBe(true);
  });

  it("returns 503 with details, and no error text, when a dependency fails", async () => {
    const secret = "postgres://admin:s3cretPassw0rdValue@db";
    const brokenDb = {
      prepare: () => {
        throw new Error(`connection failed: ${secret}`);
      },
    } as unknown as D1Database;
    const app = createApp({ features: [], logSink: () => {} });
    const res = await app.request(`${ORIGIN}/health`, {}, { ...env, DB: brokenDb, EMAIL_QUEUE: undefined });
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(text).not.toContain("s3cret");
    const body = healthResponseSchema.parse(JSON.parse(text));
    expect(body.status).toBe("error");
    expect(body.checks.d1).toMatchObject({ ok: false, detail: "unreachable" });
    expect(body.checks.queues).toEqual({ ok: false, detail: "binding missing" });
    expect(body.checks.durableObjects?.ok).toBe(true);
  });

  it("reports a check that hangs as timed out", async () => {
    const hangingDb = {
      prepare: () => ({ first: () => new Promise(() => {}) }),
    } as unknown as D1Database;
    const body = await checkHealth({ ...env, DB: hangingDb }, quiet, 50);
    expect(body.status).toBe("error");
    expect(body.checks.d1).toMatchObject({ ok: false, detail: "timed out" });
  });
});

describe("health cache", () => {
  it("reuses a result for a few seconds per isolate", async () => {
    let queries = 0;
    const countingDb = {
      prepare: () => ({
        first: () => {
          queries += 1;
          return Promise.resolve({ ok: 1 });
        },
      }),
    } as unknown as D1Database;
    const e = { ...env, DB: countingDb };
    await checkHealth(e, quiet);
    await checkHealth(e, quiet);
    expect(queries).toBe(1);
  });
});

describe("bindings", () => {
  it("applied the D1 migrations", async () => {
    const row = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'installation'",
    ).first<{ name: string }>();
    expect(row?.name).toBe("installation");
  });

  it("reaches the system Durable Object over RPC, migrated to its schema", async () => {
    const stub = env.SYSTEM.getByName(`test-${crypto.randomUUID()}`);
    expect(await stub.ping()).toEqual({ ok: true, value: { schemaVersion: 1 } });
  });
});

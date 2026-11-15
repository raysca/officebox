import { apiErrorBodySchema, healthResponseSchema } from "@officebox/shared";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const ORIGIN = "http://officebox.test";

function call(path: string, init?: RequestInit): Promise<Response> {
  return exports.default.fetch(new Request(`${ORIGIN}${path}`, init));
}

describe("GET /health", () => {
  it("reports ok and the build version", async () => {
    const res = await call("/health");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = healthResponseSchema.parse(await res.json());
    expect(body).toEqual({ status: "ok", version: env.OFFICEBOX_VERSION });
  });
});

describe("unknown API paths", () => {
  it("return a typed not_found error body", async () => {
    const res = await call("/api/does-not-exist");
    expect(res.status).toBe(404);
    const body = apiErrorBodySchema.parse(await res.json());
    expect(body.error.code).toBe("not_found");
  });
});

describe("bindings", () => {
  it("applied the D1 migrations", async () => {
    const row = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'installation'",
    ).first<{
      name: string;
    }>();
    expect(row?.name).toBe("installation");
  });

  it("reaches the system Durable Object over RPC", async () => {
    const stub = env.SYSTEM.getByName(`test-${crypto.randomUUID()}`);
    expect(await stub.ping()).toEqual({ ok: true });
  });
});

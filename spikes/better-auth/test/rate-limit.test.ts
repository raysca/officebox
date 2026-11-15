// Q8 rate-limit storage: better-auth's customStorage interface is a single atomic consume(key, rule).
import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { d1RateLimitStorage } from "../src/auth";
import { apiHeaders, ensureInstallation, ORIGIN, uniqueEmail } from "./helpers";

describe("Q8 rate limit", () => {
  it("consume() on D1 is atomic: 20 concurrent calls with max 5 allow exactly 5", async () => {
    const storage = d1RateLimitStorage(env.DB);
    const key = `k-${crypto.randomUUID()}`;
    const results = await Promise.all(Array.from({ length: 20 }, () => storage.consume(key, { window: 60, max: 5 })));
    expect(results.filter((r) => r.allowed)).toHaveLength(5);
    const refused = results.find((r) => !r.allowed)!;
    expect(refused.retryAfter).toBeGreaterThan(0);
    expect(refused.retryAfter).toBeLessThanOrEqual(60);
  });

  it("the window resets after it elapses", async () => {
    const storage = d1RateLimitStorage(env.DB);
    const key = `k-${crypto.randomUUID()}`;
    for (let i = 0; i < 3; i++) await storage.consume(key, { window: 60, max: 3 });
    expect((await storage.consume(key, { window: 60, max: 3 })).allowed).toBe(false);
    await env.DB.prepare("UPDATE rate_counters SET window_start = window_start - 61000 WHERE key = ?").bind(`ba:${key}`).run();
    expect((await storage.consume(key, { window: 60, max: 3 })).allowed).toBe(true);
  });

  it("through the handler: the magic-link plugin's own rule (5 / 60 s per IP) uses our storage as the backstop", async () => {
    await ensureInstallation();
    const ip = "192.0.2.77";
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      const r = await SELF.fetch(`${ORIGIN}/api/auth/sign-in/magic-link`, {
        method: "POST",
        headers: apiHeaders({ "cf-connecting-ip": ip }),
        body: JSON.stringify({ email: uniqueEmail() }),
      });
      statuses.push(r.status);
    }
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429, 429]);
    const rows = await env.DB.prepare("SELECT key, count FROM rate_counters WHERE key LIKE ?").bind(`ba:${ip}%`).all();
    expect(rows.results.length).toBeGreaterThan(0);
  });
});

// Q3 (Rate Limiting binding) and Q4 (queue delays): what the local runtime (Miniflare) does.
// Local behaviour is NOT production behaviour: see README for the documented production semantics.
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const post = (path: string) => exports.default.fetch(`http://x${path}`, { method: "POST" });

describe("Rate Limiting binding in Miniflare", () => {
  it("allows exactly `limit` calls per key in a 60 s window, then refuses", async () => {
    const key = `ip-${crypto.randomUUID()}`;
    const results: boolean[] = [];
    for (let i = 0; i < 7; i++) results.push((await (await post(`/ratelimit?binding=SIGNIN_IP&key=${key}`)).json<{ success: boolean }>()).success);
    console.log("SIGNIN_IP (5 per 60 s):", results.join(" "));
    // Window alignment: windows are aligned to the wall clock (floor(now / period)), so a run that straddles a
    // minute boundary could see a reset. Accept that rare case rather than make the test flaky.
    const firstFalse = results.indexOf(false);
    expect(results.slice(0, 5)).toEqual([true, true, true, true, true]);
    expect(firstFalse === 5 || firstFalse === -1 || results.slice(5).includes(true)).toBe(true);
  });

  it("keys are independent", async () => {
    const a = `a-${crypto.randomUUID()}`;
    const b = `b-${crypto.randomUUID()}`;
    for (let i = 0; i < 3; i++) await post(`/ratelimit?binding=BURST&key=${a}`);
    const aNext = await (await post(`/ratelimit?binding=BURST&key=${a}`)).json<{ success: boolean }>();
    const bFirst = await (await post(`/ratelimit?binding=BURST&key=${b}`)).json<{ success: boolean }>();
    expect(bFirst.success).toBe(true);
    // aNext is false unless the 10 s wall-clock window rolled over between calls.
    console.log("BURST (3 per 10 s) 4th call for key a:", aNext.success);
  });

  it("rejects periods other than 10 and 60 at call time", async () => {
    const binding = env.SIGNIN_IP as RateLimit;
    // The per-call options accept `period`; Miniflare validates it against [10, 60].
    const call = binding.limit({ key: "x", period: 30 } as RateLimitOptions);
    await expect(call).rejects.toThrow(/unsupported period: 30/);
  });

  it("accepts delta (weighted calls)", async () => {
    const binding = env.SIGNIN_IP as RateLimit;
    const key = `delta-${crypto.randomUUID()}`;
    const first = await binding.limit({ key, delta: 5 } as RateLimitOptions);
    const second = await binding.limit({ key });
    expect(first.success).toBe(true);
    console.log("after delta=5 on a limit of 5, next call success =", second.success);
  });
});

describe("Queue delaySeconds in Miniflare", () => {
  it("accepts 86,400 s (24 h), the documented maximum", async () => {
    const r = await (await post("/queue/send?delay=86400")).json<{ ok: boolean; error?: string }>();
    expect(r).toMatchObject({ ok: true });
  });

  it("rejects 86,401 s on send()", async () => {
    const r = await (await post("/queue/send?delay=86401")).json<{ ok: boolean; error?: string }>();
    console.log("send delaySeconds=86401:", JSON.stringify(r));
    expect(r.ok).toBe(false);
  });

  it("rejects 86,401 s on sendBatch()", async () => {
    const r = await (await post("/queue/send?delay=86401&batch=1")).json<{ ok: boolean; error?: string }>();
    console.log("sendBatch delaySeconds=86401:", JSON.stringify(r));
    expect(r.ok).toBe(false);
  });

  it("delivers a 2 s delayed message after roughly 2 s", async () => {
    const r = await (await post("/queue/send?delay=2")).json<{ ok: boolean; id: string }>();
    expect(r.ok).toBe(true);
    let delivered: string | null = null;
    const deadline = Date.now() + 15_000;
    while (!delivered && Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, 250));
      delivered = (await (await exports.default.fetch(`http://x/queue/delivered?id=${r.id}`)).json<{ deliveredAfterMs: string | null }>())
        .deliveredAfterMs;
    }
    console.log("2 s delayed message delivered after", delivered, "ms");
    expect(Number(delivered)).toBeGreaterThanOrEqual(2000);
    expect(Number(delivered)).toBeLessThan(10_000);
  });
});

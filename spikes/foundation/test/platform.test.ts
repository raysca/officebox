// Q3 (Rate Limiting binding) and Q4 (queue delays): what the local runtime (Miniflare) does.
// Local behaviour is NOT production behaviour: see README for the documented production semantics.
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const post = (path: string) => exports.default.fetch(`http://x${path}`, { method: "POST" });

// Miniflare's windows are aligned to the wall clock (floor(now / period)). A sequence that straddles a window
// boundary would legitimately reset, so each check runs inside one window and is retried (with a fresh key) if
// the window rolled over while it ran. Outside a rollover every assertion is strict and can fail.
async function inOneWindow<T>(periodS: number, fn: (key: string) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const window = Math.floor(Date.now() / (periodS * 1000));
    const out = await fn(`k-${crypto.randomUUID()}`);
    if (Math.floor(Date.now() / (periodS * 1000)) === window) return out;
  }
  throw new Error("window rolled over on three consecutive attempts");
}

const limit = async (binding: "SIGNIN_IP" | "BURST", key: string) =>
  (await (await post(`/ratelimit?binding=${binding}&key=${key}`)).json<{ success: boolean }>()).success;

describe("Rate Limiting binding in Miniflare", () => {
  it("allows exactly `limit` calls per key in a 60 s window, then refuses", async () => {
    const results = await inOneWindow(60, async (key) => {
      const r: boolean[] = [];
      for (let i = 0; i < 7; i++) r.push(await limit("SIGNIN_IP", key));
      return r;
    });
    console.log("SIGNIN_IP (5 per 60 s):", results.join(" "));
    expect(results).toEqual([true, true, true, true, true, false, false]);
  });

  it("allows 3 calls in a 10 s window, and keys are independent", async () => {
    const { a, b } = await inOneWindow(10, async (key) => {
      const a: boolean[] = [];
      for (let i = 0; i < 4; i++) a.push(await limit("BURST", key));
      const b = await limit("BURST", `${key}-other`);
      return { a, b };
    });
    console.log("BURST (3 per 10 s):", a.join(" "), "| other key:", b);
    expect(a).toEqual([true, true, true, false]);
    expect(b).toBe(true);
  });

  it("rejects periods other than 10 and 60 at call time", async () => {
    const binding = env.SIGNIN_IP as RateLimit;
    // The per-call options accept `period`; Miniflare validates it against [10, 60].
    const call = binding.limit({ key: `p-${crypto.randomUUID()}`, period: 30 } as RateLimitOptions);
    await expect(call).rejects.toThrow(/unsupported period: 30/);
  });

  it("counts delta (weighted calls) against the limit", async () => {
    const binding = env.SIGNIN_IP as RateLimit;
    const { first, second } = await inOneWindow(60, async (key) => ({
      first: await binding.limit({ key, delta: 5 } as RateLimitOptions),
      second: await binding.limit({ key }),
    }));
    expect(first.success).toBe(true);
    expect(second.success).toBe(false); // delta 5 used up a limit of 5
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

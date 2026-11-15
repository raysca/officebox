// Production probe: answers the foundation-spike questions that only a real Cloudflare deployment can.
// Every route returns JSON and never throws; failures are reported as data. Every cost parameter is capped, and
// every route needs the PROBE_TOKEN secret (compared in constant time), so the public URL can't be used to burn CPU.
import { argon2, pbkdf2, pepperedPbkdf2, scrypt } from "../../src/hash";

interface Env {
  PROBE_TOKEN: string;
  RL_60: RateLimit;
  RL_10: RateLimit;
  PROBE_QUEUE: Queue<{ sentAt: number; delay: number }>;
}

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

/** Integer query parameter clamped to [min, max]; missing or malformed values fall back to `d`. */
function intParam(q: URLSearchParams, name: string, d: number, min: number, max: number): number {
  const v = Number.parseInt(q.get(name) ?? "", 10);
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d;
}

async function tokenMatches(given: string | null, expected: string | undefined): Promise<boolean> {
  if (!given || !expected) return false;
  // Hash both sides so the comparison is over equal-length values, then compare in constant time.
  const [a, b] = await Promise.all([given, expected].map((s) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))));
  return crypto.subtle.timingSafeEqual(a!, b!);
}

// 32+ bytes, as the pepper format requires. A fixed value is fine here: the probe only measures cost.
const PROBE_PEPPER = "probe-pepper-0123456789abcdef0123456789abcdef";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const q = url.searchParams;
    if (!(await tokenMatches(req.headers.get("x-probe-token"), env.PROBE_TOKEN))) return json({ error: "forbidden" }, 403);
    const colo = (req.cf as { colo?: string } | undefined)?.colo ?? null;
    const t0 = Date.now();
    const meta = () => ({ colo, serverClockMs: Date.now() - t0 }); // Date.now() is frozen during CPU work in production

    switch (url.pathname) {
      case "/pbkdf2":
        return json({ ...(await pbkdf2("probe password", intParam(q, "iterations", 100_000, 1, 1_000_000))), ...meta() });
      case "/pepper":
        return json({ ...(await pepperedPbkdf2("probe password", PROBE_PEPPER)), ...meta() });
      case "/argon2":
        return json({
          ...(await argon2("probe password", {
            memoryKiB: intParam(q, "m", 19 * 1024, 1024, 64 * 1024),
            iterations: intParam(q, "t", 2, 1, 4),
            parallelism: intParam(q, "p", 1, 1, 1),
          })),
          ...meta(),
        });
      case "/wasm-compile": {
        // Runtime compilation of an (empty, valid) module: expected to be refused in production as in workerd.
        // The shim only intercepts hash-wasm's two binaries (matched by length), so this reaches the real API.
        const wasm = WebAssembly as unknown as { compile(b: BufferSource): Promise<WebAssembly.Module> };
        try {
          await wasm.compile(new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]));
          return json({ ok: true });
        } catch (e) {
          return json({ ok: false, error: (e as Error).message });
        }
      }
      case "/scrypt":
        return json({ ...(await scrypt("probe password", intParam(q, "N", 1 << 17, 1 << 10, 1 << 18))), ...meta() });

      case "/ratelimit": {
        // `count` calls in one request against one key; the check script also spreads calls over separate requests.
        const binding = q.get("period") === "10" ? env.RL_10 : env.RL_60;
        const key = (q.get("key") ?? "probe").slice(0, 100);
        const out: boolean[] = [];
        for (let i = 0; i < intParam(q, "count", 1, 1, 50); i++) out.push((await binding.limit({ key })).success);
        return json({ key, results: out, ...meta() });
      }
      case "/ratelimit-period": {
        // Is a per-call period other than 10/60 accepted in production? (Miniflare rejects it.)
        try {
          const r = await env.RL_60.limit({ key: "period-probe", period: intParam(q, "period", 30, 1, 3600) } as RateLimitOptions);
          return json({ accepted: true, result: r });
        } catch (e) {
          return json({ accepted: false, error: (e as Error).message });
        }
      }

      case "/queue": {
        // Deliberately not clamped to 86,400: probing the limit is the point. Bounded to a sane range anyway.
        const delay = intParam(q, "delay", 0, 0, 200_000);
        const batch = q.get("batch");
        if (batch !== null && batch !== "1") return json({ ok: false, error: "batch must be 1 or absent" }, 400);
        try {
          if (batch === "1") await env.PROBE_QUEUE.sendBatch([{ body: { sentAt: Date.now(), delay } }], { delaySeconds: delay });
          else await env.PROBE_QUEUE.send({ sentAt: Date.now(), delay }, { delaySeconds: delay });
          return json({ ok: true, delay });
        } catch (e) {
          return json({ ok: false, delay, error: (e as Error).message });
        }
      }
    }
    return json({ error: "not_found" }, 404);
  },

  async queue(batch: MessageBatch<{ sentAt: number; delay: number }>): Promise<void> {
    for (const m of batch.messages) {
      console.log(JSON.stringify({ delivered: true, requestedDelayS: m.body.delay, actualDelayMs: Date.now() - m.body.sentAt }));
      m.ack();
    }
  },
} satisfies ExportedHandler<Env, { sentAt: number; delay: number }>;

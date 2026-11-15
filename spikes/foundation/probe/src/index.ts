// Production probe: answers the foundation-spike questions that only a real Cloudflare deployment can.
// Every route returns JSON and never throws; failures are reported as data.
import { argon2, pbkdf2, pepperedPbkdf2, scrypt } from "../../src/hash";

interface Env {
  PROBE_TOKEN: string;
  RL_60: RateLimit;
  RL_10: RateLimit;
  PROBE_QUEUE: Queue<{ sentAt: number; delay: number }>;
}

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
const int = (v: string | null, d: number) => (v === null ? d : Number.parseInt(v, 10));

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const q = url.searchParams;
    if (!env.PROBE_TOKEN || req.headers.get("x-probe-token") !== env.PROBE_TOKEN) return json({ error: "forbidden" }, 403);
    const colo = (req.cf as { colo?: string } | undefined)?.colo ?? null;
    const t0 = Date.now();
    const meta = () => ({ colo, serverClockMs: Date.now() - t0 }); // Date.now() is frozen during CPU work in production

    switch (url.pathname) {
      case "/pbkdf2":
        return json({ ...(await pbkdf2("probe password", int(q.get("iterations"), 100_000))), ...meta() });
      case "/pepper":
        return json({ ...(await pepperedPbkdf2("probe password", "probe-pepper")), ...meta() });
      case "/argon2":
        return json({
          ...(await argon2("probe password", { memoryKiB: int(q.get("m"), 19 * 1024), iterations: int(q.get("t"), 2), parallelism: int(q.get("p"), 1) })),
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
        return json({ ...(await scrypt("probe password", int(q.get("N"), 1 << 17))), ...meta() });

      case "/ratelimit": {
        // `count` calls in one request against one key; the check script also spreads calls over separate requests.
        const binding = q.get("period") === "10" ? env.RL_10 : env.RL_60;
        const key = q.get("key") ?? "probe";
        const out: boolean[] = [];
        for (let i = 0; i < int(q.get("count"), 1); i++) out.push((await binding.limit({ key })).success);
        return json({ key, results: out, ...meta() });
      }
      case "/ratelimit-period": {
        // Is a per-call period other than 10/60 accepted in production? (Miniflare rejects it.)
        try {
          const r = await env.RL_60.limit({ key: "period-probe", period: int(q.get("period"), 30) } as RateLimitOptions);
          return json({ accepted: true, result: r });
        } catch (e) {
          return json({ accepted: false, error: (e as Error).message });
        }
      }

      case "/queue": {
        const delay = int(q.get("delay"), 0);
        try {
          if (q.get("batch")) await env.PROBE_QUEUE.sendBatch([{ body: { sentAt: Date.now(), delay } }], { delaySeconds: delay });
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

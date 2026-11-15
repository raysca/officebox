// M0d foundation spike Worker. Local only: wrangler dev / vitest-plugin. Not production code.
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { argon2, pbkdf2, pepperedPbkdf2, scrypt } from "./hash";
import {
  authenticationOptions,
  credentialCounter,
  registrationOptions,
  verifyAuthentication,
  verifyRegistration,
  type WebAuthnEnv,
} from "./webauthn";

export interface Env extends WebAuthnEnv {
  SIGNIN_IP: RateLimit;
  BURST: RateLimit;
  DELAYED: Queue<QueueBody>;
  PEPPER_1?: string;
}

interface QueueBody {
  id: string;
  sentAt: number;
  delay: number;
}

const json = (body: unknown, status = 200) => Response.json(body, { status });
const int = (v: string | null, d: number) => (v === null ? d : Number.parseInt(v, 10));

const HARNESS = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>WebAuthn harness</title></head>
<body><main><h1>WebAuthn harness</h1><p>Driven by scripts/webauthn-e2e.mjs.</p></main></body></html>`;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const q = url.searchParams;
    const route = `${req.method} ${url.pathname}`;

    switch (route) {
      case "GET /":
        return new Response(HARNESS, { headers: { "content-type": "text/html; charset=utf-8" } });

      // ---- Q1: password hashing ----
      case "GET /bench/pbkdf2":
        return json(await pbkdf2("correct horse battery staple", int(q.get("iterations"), 100_000)));
      case "GET /bench/pepper":
        if (!env.PEPPER_1) return json({ ok: false, error: "PEPPER_1 not set" }, 500);
        return json(await pepperedPbkdf2("correct horse battery staple", env.PEPPER_1));
      case "GET /bench/argon2":
        return json(
          await argon2("correct horse battery staple", {
            memoryKiB: int(q.get("m"), 19 * 1024),
            iterations: int(q.get("t"), 2),
            parallelism: int(q.get("p"), 1),
          }),
        );
      case "GET /bench/scrypt":
        return json(await scrypt("correct horse battery staple", int(q.get("N"), 1 << 17), int(q.get("r"), 8), int(q.get("p"), 1)));

      // ---- Q2: WebAuthn ----
      case "POST /webauthn/register/options": {
        const { username } = await req.json<{ username: string }>();
        return json(await registrationOptions(env, username));
      }
      case "POST /webauthn/register/verify": {
        const { flowId, response } = await req.json<{ flowId: string; response: RegistrationResponseJSON }>();
        const r = await verifyRegistration(env, flowId, response);
        return json(r, r.ok ? 200 : 400);
      }
      case "POST /webauthn/login/options":
        return json(await authenticationOptions(env));
      case "POST /webauthn/login/verify": {
        const { flowId, response } = await req.json<{ flowId: string; response: AuthenticationResponseJSON }>();
        const r = await verifyAuthentication(env, flowId, response);
        return json(r, r.ok ? 200 : r.error === "clone_detected" ? 403 : 400);
      }
      case "GET /webauthn/credential":
        return json({ counter: await credentialCounter(env, q.get("id") ?? "") });

      // ---- Q3: Rate Limiting binding ----
      case "POST /ratelimit": {
        const binding = q.get("binding") === "BURST" ? env.BURST : env.SIGNIN_IP;
        return json(await binding.limit({ key: q.get("key") ?? "k" }));
      }

      // ---- Q4: Queue delays ----
      case "POST /queue/send": {
        const delay = int(q.get("delay"), 0);
        const id = crypto.randomUUID();
        try {
          if (q.get("batch")) await env.DELAYED.sendBatch([{ body: { id, sentAt: Date.now(), delay } }], { delaySeconds: delay });
          else await env.DELAYED.send({ id, sentAt: Date.now(), delay }, { delaySeconds: delay });
          return json({ ok: true, id, delay });
        } catch (e) {
          return json({ ok: false, delay, error: (e as Error).message });
        }
      }
      case "GET /queue/delivered":
        return json({ deliveredAfterMs: await env.WEBAUTHN_KV.get(`queue:${q.get("id")}`) });
    }
    return json({ error: "not_found" }, 404);
  },

  async queue(batch: MessageBatch<QueueBody>, env: Env): Promise<void> {
    for (const m of batch.messages) {
      const after = Date.now() - m.body.sentAt;
      console.log(`delivered after ${after} ms (requested delay ${m.body.delay} s)`);
      await env.WEBAUTHN_KV.put(`queue:${m.body.id}`, String(after), { expirationTtl: 3600 });
      m.ack();
    }
  },
} satisfies ExportedHandler<Env, QueueBody>;

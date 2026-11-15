// The Hono app around better-auth: CSRF + same-origin middleware, the default-deny allowlist, the token-stripping
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
// response filter, and our own routes that call better-auth on the server (setup, magic-link confirm, step-up).
import { APIError } from "better-auth/api";
import { Hono, type Context } from "hono";
import { ulid } from "ulid";
import { authFor, ENROL_COOKIE, normaliseEmail, SESSION_COOKIE, tokenHash, type Env, type Installation } from "./auth";
import { requestStore } from "./context";

type HonoEnv = { Bindings: Env; Variables: { inst: Installation } };

/** Exactly these better-auth endpoints are reachable from outside (method + normalised path). */
export const ALLOWED = new Set([
  "POST /api/auth/sign-out",
  "POST /api/auth/sign-in/magic-link",
  "GET /api/auth/passkey/generate-authenticate-options",
  "POST /api/auth/passkey/verify-authentication",
  "GET /api/auth/passkey/generate-register-options",
  "POST /api/auth/passkey/verify-registration",
]);

/** Normalise like the allowlist requires: decode, collapse slashes, drop a trailing slash, lowercase; reject dot segments. */
export function normalisePath(raw: string): string | null {
  let p: string;
  try {
    p = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (p.includes("\\") || p.split("/").some((s) => s === "." || s === "..")) return null;
  p = p.replace(/\/{2,}/g, "/").toLowerCase();
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p;
}

async function loadInstallation(db: D1Database): Promise<Installation | null> {
  const row = await db.prepare("SELECT workspace_name, canonical_origin FROM installation WHERE id = 1").first<{ workspace_name: string; canonical_origin: string | null }>();
  if (!row?.canonical_origin) return null;
  return { workspaceName: row.workspace_name, canonicalOrigin: row.canonical_origin };
}

/** Removes `token` fields and any string equal to a session token, at any depth (TDD §8.1). */
export function stripTokens(value: unknown, tokens: Set<string>): unknown {
  if (Array.isArray(value)) return value.map((v) => stripTokens(v, tokens));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === "token") continue;
      if (typeof v === "string" && tokens.has(v)) continue;
      out[k] = stripTokens(v, tokens);
    }
    return out;
  }
  return value;
}

/** Session tokens named by Set-Cookie headers (the cookie value is `<token>.<signature>`). */
function tokensFromSetCookie(headers: Headers): Set<string> {
  const out = new Set<string>();
  for (const sc of headers.getSetCookie()) {
    const [pair] = sc.split(";");
    const [name, ...rest] = (pair ?? "").split("=");
    if (name?.trim().endsWith("session_token")) {
      const value = decodeURIComponent(rest.join("="));
      if (value) out.add(value.split(".")[0] ?? value);
    }
  }
  return out;
}

async function filterResponse(res: Response): Promise<Response> {
  if (!(res.headers.get("content-type") ?? "").includes("application/json")) return res;
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return new Response(text, res);
  }
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  return new Response(JSON.stringify(stripTokens(body, tokensFromSetCookie(res.headers))), { status: res.status, headers });
}

function forwardSetCookies(from: Headers | null | undefined, c: Context<HonoEnv>): void {
  for (const sc of from?.getSetCookie() ?? []) c.header("set-cookie", sc, { append: true });
}

export function createApp() {
  const app = new Hono<HonoEnv>();

  // Request store for server-set markers (Q4). Every request gets its own.
  app.use("*", async (c, next) => {
    let waitUntil: ((p: Promise<unknown>) => void) | undefined;
    try {
      const ec = c.executionCtx;
      waitUntil = (p) => ec.waitUntil(p);
    } catch {
      // no ExecutionContext (in-process calls in tests)
    }
    return requestStore.run({ waitUntil }, () => next());
  });

  // Installation + canonical origin, then CSRF: X-Officebox-Request and Origin == canonical origin on state changes.
  // The options endpoints are GETs with side effects (challenge cookie + verification row), so they need the header too.
  app.use("/api/*", async (c, next) => {
    const inst = await loadInstallation(c.env.DB);
    if (!inst) return c.json({ error: "not_configured" }, 503);
    c.set("inst", inst);
    if (new URL(c.req.url).origin !== inst.canonicalOrigin) return c.json({ error: "wrong_host" }, 421);
    const stateChanging = c.req.method !== "GET" && c.req.method !== "HEAD";
    const isAuthOptions = c.req.path.includes("/passkey/generate-");
    if (stateChanging || isAuthOptions) {
      if (c.req.header("x-officebox-request") !== "1") return c.json({ error: "csrf" }, 403);
      if (stateChanging && c.req.header("origin") !== inst.canonicalOrigin) return c.json({ error: "csrf" }, 403);
    }
    await next();
  });

  // ---- our routes (registered before the better-auth mount) ----

  // Setup claim (spike subset): creates the owner through better-auth with the server-set marker, sets an enrolment ticket.
  app.post("/api/setup", async (c) => {
    const { email, name, role } = await c.req.json<{ email: string; name: string; role?: string }>();
    const auth = authFor(c.env, c.get("inst"));
    const ctx = await auth.$context;
    const s = requestStore.getStore()!;
    s.create = { kind: "setup", attemptId: ulid() };
    let user;
    try {
      user = await ctx.internalAdapter.createUser({ email, name, emailVerified: true }, { method: "officebox-setup" });
    } finally {
      s.create = undefined;
    }
    if (!user) return c.json({ error: "refused" }, 403);
    if (role) await c.env.DB.prepare("UPDATE users SET role = ? WHERE id = ?").bind(role, user.id).run();
    const ticket = crypto.randomUUID() + crypto.randomUUID();
    await c.env.DB.prepare("INSERT INTO auth_tokens (token_hash, user_id, kind, expires_at, created_at) VALUES (?, ?, 'passkey_enrol', ?, ?)")
      .bind(await tokenHash(c.env.TOKEN_HASH_KEY, ticket), user.id, Date.now() + 900_000, Date.now())
      .run();
    c.header("set-cookie", `${ENROL_COOKIE}=${ticket}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=900`);
    return c.json({ userId: user.id });
  });

  // Magic-link confirmation POST: our compare-and-set, then better-auth's verify in-process; forward only its cookie.
  app.post("/api/sign-in/link", async (c) => {
    const { token } = await c.req.json<{ token: string }>();
    const now = Date.now();
    const hash = await tokenHash(c.env.TOKEN_HASH_KEY, token);
    const row = await c.env.DB.prepare(
      `UPDATE magic_link_issues SET consumed_at = ?1
        WHERE token_hash = ?2 AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > ?1
          AND user_id IN (SELECT id FROM users WHERE role = 'member' AND status = 'active')
        RETURNING user_id`,
    )
      .bind(now, hash)
      .first<{ user_id: string }>();
    if (!row) return c.json({ error: "invalid_link" }, 400);
    const auth = authFor(c.env, c.get("inst"));
    try {
      const { headers, response } = await auth.api.magicLinkVerify({ query: { token }, headers: c.req.raw.headers, returnHeaders: true });
      forwardSetCookies(headers, c);
      const r = response as { user?: { id: string } };
      return c.json({ ok: true, userId: r.user?.id ?? null });
    } catch (e) {
      if (e instanceof APIError) return c.json({ error: "invalid_link" }, 400);
      throw e;
    }
  });

  app.get("/api/me", async (c) => {
    const auth = authFor(c.env, c.get("inst"));
    const s = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!s) return c.json({ error: "unauthenticated" }, 401);
    const user = s.user as typeof s.user & { role: string; status: string };
    if (user.status !== "active") return c.json({ error: "unauthenticated" }, 401);
    const sess = s.session as typeof s.session & { freshAuthAt: number | null; freshAuthMethod: string | null };
    return c.json({
      id: user.id,
      email: user.email,
      role: user.role,
      sessionId: sess.id,
      freshAuthAt: sess.freshAuthAt,
      freshAuthMethod: sess.freshAuthMethod,
    });
  });

  // Step-up (Q10): passkey options for the signed-in user, then verify without keeping a second session.
  app.post("/api/me/reauth/options", async (c) => {
    const auth = authFor(c.env, c.get("inst"));
    const s = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!s) return c.json({ error: "unauthenticated" }, 401);
    const { headers, response } = await auth.api.generatePasskeyAuthenticationOptions({ headers: c.req.raw.headers, returnHeaders: true });
    forwardSetCookies(headers, c);
    return c.json(response);
  });

  app.post("/api/me/reauth", async (c) => {
    const auth = authFor(c.env, c.get("inst"));
    const current = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!current) return c.json({ error: "unauthenticated" }, 401);
    const body = await c.req.json<{ response: AuthenticationResponseJSON }>();
    const st = requestStore.getStore()!;
    st.reauth = { userId: current.user.id };
    let refusal: string | null = null;
    try {
      const { headers } = await auth.api.verifyPasskeyAuthentication({ body, headers: c.req.raw.headers, returnHeaders: true });
      // Not reached in practice: the session-create hook vetoes, so better-auth throws UNABLE_TO_CREATE_SESSION.
      void headers;
      refusal = "unexpected_session";
    } catch (e) {
      if (!(e instanceof APIError)) throw e;
      const code = (e.body as { code?: string } | undefined)?.code;
      if (code !== "UNABLE_TO_CREATE_SESSION" || !st.reauth.verifiedUserId) refusal = code ?? "reauth_failed";
    }
    if (refusal) return c.json({ error: "reauth_failed", detail: refusal }, 401);
    if (st.reauth.verifiedUserId !== current.user.id) return c.json({ error: "reauth_failed", detail: "other_user" }, 401);
    await c.env.DB.prepare("UPDATE sessions SET fresh_auth_at = ?, fresh_auth_method = 'passkey' WHERE id = ?").bind(Date.now(), current.session.id).run();
    return c.json({ ok: true });
  });

  // ---- spike-only helpers for the end-to-end script ----
  app.get("/test/passkey", async (c) => {
    if (c.env.SPIKE_TEST_ROUTES !== "1") return c.notFound();
    const row = await c.env.DB.prepare("SELECT id, user_id, sign_count, created_via FROM passkeys WHERE credential_id = ?").bind(c.req.query("credentialId") ?? "").first();
    return c.json(row);
  });
  app.get("/test/sessions", async (c) => {
    if (c.env.SPIKE_TEST_ROUTES !== "1") return c.notFound();
    const { results } = await c.env.DB.prepare("SELECT id, fresh_auth_at, fresh_auth_method FROM sessions WHERE user_id = ? ORDER BY created_at").bind(c.req.query("userId") ?? "").all();
    return c.json(results);
  });
  app.get("/test/notices", async (c) => {
    if (c.env.SPIKE_TEST_ROUTES !== "1") return c.notFound();
    const { results } = await c.env.DB.prepare("SELECT kind, details FROM security_notices WHERE user_id = ? AND kind != 'spike_session_deleted' ORDER BY id").bind(c.req.query("userId") ?? "").all();
    return c.json(results);
  });
  app.post("/test/install", async (c) => {
    if (c.env.SPIKE_TEST_ROUTES !== "1") return c.notFound();
    const { origin } = await c.req.json<{ origin: string }>();
    await c.env.DB.prepare(
      "INSERT INTO installation (id, workspace_name, canonical_origin) VALUES (1, 'Spike Workspace', ?) ON CONFLICT(id) DO UPDATE SET canonical_origin = excluded.canonical_origin",
    )
      .bind(origin)
      .run();
    return c.json({ ok: true });
  });
  app.post("/test/enrol", async (c) => {
    if (c.env.SPIKE_TEST_ROUTES !== "1") return c.notFound();
    const { userId } = await c.req.json<{ userId: string }>();
    const ticket = crypto.randomUUID() + crypto.randomUUID();
    await c.env.DB.prepare("INSERT INTO auth_tokens (token_hash, user_id, kind, expires_at, created_at) VALUES (?, ?, 'passkey_enrol', ?, ?)")
      .bind(await tokenHash(c.env.TOKEN_HASH_KEY, ticket), userId, Date.now() + 900_000, Date.now())
      .run();
    c.header("set-cookie", `${ENROL_COOKIE}=${ticket}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=900`);
    return c.json({ ok: true });
  });
  app.get("/test/authlog", async (c) => {
    if (c.env.SPIKE_TEST_ROUTES !== "1") return c.notFound();
    const { authLog } = await import("./auth");
    return c.json(authLog.filter((l) => l.level === "error").map((l) => ({ message: l.message, detail: l.args.map((a) => (a instanceof Error ? a.message : String(a))) })));
  });
  app.get("/test/session-tokens", async (c) => {
    if (c.env.SPIKE_TEST_ROUTES !== "1") return c.notFound();
    const { results } = await c.env.DB.prepare("SELECT token FROM sessions").all<{ token: string }>();
    return c.json(results.map((r) => r.token));
  });

  // ---- the better-auth mount: default-deny allowlist, then the token filter ----
  app.all("/api/auth/*", async (c) => {
    const url = new URL(c.req.url);
    const path = normalisePath(url.pathname);
    if (!path || !ALLOWED.has(`${c.req.method} ${path}`) || path !== url.pathname) return c.json({ error: "not_found" }, 404);
    const auth = authFor(c.env, c.get("inst"));
    return filterResponse(await auth.handler(c.req.raw));
  });

  app.get("/", (c) => c.html("<!doctype html><title>better-auth spike</title><p>spike</p>"));
  return app;
}

export { normaliseEmail, SESSION_COOKIE };

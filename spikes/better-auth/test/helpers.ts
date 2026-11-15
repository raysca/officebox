import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { ulid } from "ulid";
import { createAuth, type AuthVariant, type Installation } from "../src/auth";
import { requestStore } from "../src/context";

// A reserved test domain (RFC 6761 .test), never a real one (AGENTS §4.1).
export const ORIGIN = "https://officebox.test";
export const INST: Installation = { workspaceName: "Spike Workspace", canonicalOrigin: ORIGIN };

export async function ensureInstallation(origin = ORIGIN): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO installation (id, workspace_name, canonical_origin) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET canonical_origin = excluded.canonical_origin",
  )
    .bind(INST.workspaceName, origin)
    .run();
}

export const uniqueEmail = (tag = "user") => `${tag}-${ulid().toLowerCase()}@officebox.test`;

/** A random client IP per request, so better-auth's per-IP backstop limits don't couple unrelated tests. */
export const randomIp = () => `10.${(Math.random() * 255) | 0}.${(Math.random() * 255) | 0}.${(Math.random() * 255) | 0}`;

export const apiHeaders = (extra: Record<string, string> = {}) => ({
  "content-type": "application/json",
  "x-officebox-request": "1",
  origin: ORIGIN,
  "cf-connecting-ip": randomIp(),
  ...extra,
});

/** Creates a user through POST /api/setup (the server-set marker path). Returns the id and the enrolment cookie. */
export async function createUser(email = uniqueEmail(), role = "member"): Promise<{ userId: string; email: string; enrolCookie: string }> {
  await ensureInstallation();
  const res = await SELF.fetch(`${ORIGIN}/api/setup`, { method: "POST", headers: apiHeaders(), body: JSON.stringify({ email, name: "Test User", role }) });
  if (res.status !== 200) throw new Error(`setup failed ${res.status} ${await res.text()}`);
  const { userId } = await res.json<{ userId: string }>();
  const enrolCookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  return { userId, email, enrolCookie };
}

/** Requests a magic link and returns the token our sendMagicLink captured. */
export async function requestMagicLink(email: string): Promise<{ res: Response; token: string | null }> {
  const res = await SELF.fetch(`${ORIGIN}/api/auth/sign-in/magic-link`, { method: "POST", headers: apiHeaders(), body: JSON.stringify({ email }) });
  const row = await env.DB.prepare("SELECT token FROM spike_outbox WHERE email = ? ORDER BY id DESC LIMIT 1").bind(email).first<{ token: string }>();
  return { res, token: row?.token ?? null };
}

/** Full magic-link sign-in through our confirmation POST. Returns the session cookie pair ("name=value"). */
export async function signInWithMagicLink(email: string): Promise<{ cookie: string; setCookie: string; body: unknown }> {
  const { token } = await requestMagicLink(email);
  if (!token) throw new Error("no magic link sent");
  const res = await SELF.fetch(`${ORIGIN}/api/sign-in/link`, { method: "POST", headers: apiHeaders(), body: JSON.stringify({ token }) });
  const setCookie = res.headers.get("set-cookie") ?? "";
  const body = await res.json();
  if (res.status !== 200) throw new Error(`confirm failed ${res.status} ${JSON.stringify(body)}`);
  return { cookie: setCookie.split(";")[0] ?? "", setCookie, body };
}

/** An in-process auth instance (same configuration as the Worker), for tests that call auth.api / internalAdapter. */
export function testAuth(variant: AuthVariant = {}, inst: Installation = INST) {
  return createAuth(env, inst, variant);
}

/** Runs fn with the setup marker set, as our setup route does. */
export function withCreateMarker<T>(fn: () => Promise<T>): Promise<T> {
  return requestStore.run({ create: { kind: "setup", attemptId: ulid() } }, fn);
}
export function withStore<T>(fn: () => Promise<T>): Promise<T> {
  return requestStore.run({}, fn);
}

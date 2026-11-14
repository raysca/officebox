// Session cookies, Origin checks and one-time WebSocket tickets (TDD §3.1).
import type { Env } from "./env";

const enc = new TextEncoder();
const dec = new TextDecoder();

export const SESSION_COOKIE = "ob_session";
export const SESSION_TTL_MS = 15 * 60 * 1000;
export const TICKET_TTL_MS = 30 * 1000;

export interface Session {
  uid: string;
  sid: string;
  exp: number;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  if (!secret || secret.length < 32) throw new HttpError(500, "SESSION_SECRET must be at least 32 characters");
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

export async function signSession(session: Session, secret: string): Promise<string> {
  const payload = b64url(enc.encode(JSON.stringify(session)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(payload));
  return `${payload}.${b64url(new Uint8Array(sig))}`;
}

export async function verifySession(token: string, secret: string, now = Date.now()): Promise<Session | null> {
  const [payload, sig, extra] = token.split(".");
  if (!payload || !sig || extra !== undefined) return null;
  let sigBytes: Uint8Array;
  try {
    sigBytes = fromB64url(sig);
  } catch {
    return null;
  }
  // crypto.subtle.verify compares in constant time.
  const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), sigBytes, enc.encode(payload));
  if (!ok) return null;
  const session = JSON.parse(dec.decode(fromB64url(payload))) as Session;
  if (typeof session.uid !== "string" || typeof session.exp !== "number" || session.exp < now) return null;
  return session;
}

export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`;
}

export function getCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(value)));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function expectedOrigin(request: Request, env: Env): string {
  return env.APP_ORIGIN ?? new URL(request.url).origin;
}

/** Cookie session for ordinary HTTP requests. State-changing calls also need the CSRF header and Origin. */
export async function requireSession(request: Request, env: Env, opts: { stateChanging?: boolean } = {}) {
  if (opts.stateChanging) {
    if (request.headers.get("X-Officebox-Request") !== "1") throw new HttpError(403, "Missing CSRF header");
    const origin = request.headers.get("Origin");
    if (origin !== null && origin !== expectedOrigin(request, env)) throw new HttpError(403, "Cross-origin request");
  }
  const token = getCookie(request, SESSION_COOKIE);
  const session = token ? await verifySession(token, env.SESSION_SECRET) : null;
  if (!session) throw new HttpError(401, "Not signed in");
  await requireActiveUser(env, session.uid);
  return session;
}

export async function requireActiveUser(env: Env, userId: string): Promise<void> {
  const user = await env.DB.prepare("SELECT status FROM users WHERE id = ?").bind(userId).first<{ status: string }>();
  if (!user || user.status !== "active") throw new HttpError(401, "Account is not active");
}

/**
 * Authenticates a WebSocket upgrade for `target` (e.g. "channels:general").
 * Browsers: session cookie plus an Origin that matches the installation (blocks cross-site WebSocket hijacking).
 * Other clients: a single-use ticket bound to the target.
 */
export async function authenticateUpgrade(request: Request, env: Env, target: string): Promise<string> {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") throw new HttpError(426, "Expected WebSocket upgrade");
  const ticket = new URL(request.url).searchParams.get("ticket");
  if (ticket) {
    const row = await env.DB.prepare(
      `UPDATE ws_tickets SET used_at = ?1
        WHERE token_hash = ?2 AND used_at IS NULL AND expires_at > ?1
        RETURNING user_id, target`,
    )
      .bind(Date.now(), await sha256Hex(ticket))
      .first<{ user_id: string; target: string }>();
    if (!row || row.target !== target) throw new HttpError(401, "Invalid or used ticket");
    await requireActiveUser(env, row.user_id);
    return row.user_id;
  }
  const token = getCookie(request, SESSION_COOKIE);
  const session = token ? await verifySession(token, env.SESSION_SECRET) : null;
  if (!session) throw new HttpError(401, "Not signed in");
  if (request.headers.get("Origin") !== expectedOrigin(request, env)) throw new HttpError(403, "Origin not allowed");
  await requireActiveUser(env, session.uid);
  return session.uid;
}

export async function issueTicket(env: Env, userId: string, target: string): Promise<string> {
  const raw = b64url(crypto.getRandomValues(new Uint8Array(32)));
  await env.DB.prepare("INSERT INTO ws_tickets (token_hash, user_id, target, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256Hex(raw), userId, target, Date.now() + TICKET_TTL_MS)
    .run();
  return raw;
}

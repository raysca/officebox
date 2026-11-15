import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { ulid } from "../../src/core/ids";
import { clearSetupCache } from "../../src/features/identity/setup-state";
import worker from "../../src/index";
import type { Env } from "../../src/env";
import { b64url, SoftAuthenticator } from "./authenticator";

/** A reserved test domain (RFC 6761 `.test`), never a real one (AGENTS §4.1). */
export const ORIGIN = "https://officebox.test";
export const SETUP_TOKEN = "test-setup-token-0123456789abcdefghijklmnop";

export const uniqueEmail = (tag = "user") => `${tag}-${ulid().toLowerCase()}@officebox.test`;
export const uniqueHandle = (tag = "u") => `${tag}${ulid().toLowerCase().slice(-12)}`;
export const randomIp = () =>
  `10.${(Math.random() * 255) | 0}.${(Math.random() * 255) | 0}.${(Math.random() * 255) | 0}`;

/** Calls the real Worker (with optional env overrides) and waits for its `waitUntil` work. */
export async function callWorker(request: Request, overrides: Partial<Env> = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, { ...env, ...overrides } as Env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

export interface CallOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** Leave out the CSRF header and Origin (CSRF tests). */
  noCsrf?: boolean;
  origin?: string;
  /** Request URL origin (host tests); defaults to ORIGIN. */
  baseUrl?: string;
  env?: Partial<Env>;
}

/** A browser-like client: a cookie jar, the CSRF header and Origin, a stable client IP. */
export class Browser {
  readonly cookies = new Map<string, string>();
  readonly ip = randomIp();
  /** Every response body this browser received (the token-exposure test reads them). */
  readonly bodies: string[] = [];

  constructor(readonly userAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/130.0 Safari/537.36") {}

  cookieHeader(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  store(response: Response): void {
    for (const cookie of response.headers.getSetCookie()) {
      const [pair, ...attrs] = cookie.split(";");
      const [name, ...rest] = (pair ?? "").split("=");
      if (!name) continue;
      const value = rest.join("=");
      const maxAge = attrs.map((a) => a.trim().toLowerCase()).find((a) => a.startsWith("max-age="));
      if (value === "" || maxAge === "max-age=0") this.cookies.delete(name.trim());
      else this.cookies.set(name.trim(), value);
    }
  }

  async call(path: string, options: CallOptions = {}): Promise<Response> {
    const method = options.method ?? (options.body === undefined ? "GET" : "POST");
    const headers: Record<string, string> = {
      "cf-connecting-ip": this.ip,
      "user-agent": this.userAgent,
      ...(options.noCsrf ? {} : { "x-officebox-request": "1", origin: options.origin ?? ORIGIN }),
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...options.headers,
    };
    const cookie = this.cookieHeader();
    if (cookie) headers.cookie = cookie;
    const request = new Request(`${options.baseUrl ?? ORIGIN}${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      redirect: "manual",
    });
    const response = await callWorker(request, options.env);
    this.store(response);
    const text = await response.clone().text();
    this.bodies.push(text);
    return response;
  }

  async json<T = Record<string, unknown>>(path: string, options: CallOptions = {}): Promise<{ status: number; body: T }> {
    const response = await this.call(path, options);
    const text = await response.text();
    return { status: response.status, body: (text ? JSON.parse(text) : null) as T };
  }

  get sessionCookie(): string | undefined {
    return this.cookies.get("__Host-officebox.session_token");
  }
}

/** Puts the installation back to "never set up", for tests that run setup themselves. */
export async function resetInstallation(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions"),
    env.DB.prepare("DELETE FROM passkeys"),
    env.DB.prepare("DELETE FROM auth_tokens"),
    env.DB.prepare("DELETE FROM auth_verifications"),
    env.DB.prepare("DELETE FROM handles"),
    env.DB.prepare("DELETE FROM users WHERE status != 'system'"),
    env.DB.prepare("DELETE FROM installation"),
    env.DB.prepare("DELETE FROM rate_counters"),
  ]);
  clearSetupCache(env.DB);
}

/** Stores a known generated setup token (generated-token mode: no SETUP_TOKEN secret in tests). */
export async function seedSetupToken(token = SETUP_TOKEN, expiresAt = Date.now() + 24 * 60 * 60 * 1000): Promise<void> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  await env.DB.prepare(
    `INSERT INTO installation (id, installation_id, name, setup_token_hash, setup_token_expires_at)
     VALUES (1, ?, '', ?, ?)
     ON CONFLICT (id) DO UPDATE SET setup_token_hash = excluded.setup_token_hash,
       setup_token_expires_at = excluded.setup_token_expires_at`,
  )
    .bind(ulid(), b64url(digest), expiresAt)
    .run();
}

export interface OwnerDetails {
  email: string;
  name: string;
  handle: string;
  workspace: string;
}

export function ownerDetails(): OwnerDetails {
  return { email: uniqueEmail("owner"), name: "Sam Lee", handle: uniqueHandle("sam"), workspace: "Acme Studio" };
}

export async function claim(browser: Browser, owner: OwnerDetails = ownerDetails(), token = SETUP_TOKEN) {
  return browser.json("/api/setup", {
    body: {
      token,
      workspaceName: owner.workspace,
      ownerName: owner.name,
      ownerHandle: owner.handle,
      ownerEmail: owner.email,
    },
  });
}

/** Registration options, the authenticator's answer, and the verify call. */
export async function registerPasskey(
  browser: Browser,
  authenticator: SoftAuthenticator,
  overrides: Parameters<SoftAuthenticator["register"]>[2] = {},
  verifyBody: Record<string, unknown> = {},
) {
  const options = await browser.json<{ challenge: string; rp: { id: string; name: string }; user: { id: string; name: string } }>(
    "/api/auth/passkey/generate-register-options",
  );
  if (options.status !== 200) return { options, verify: null, credentialId: null };
  const { response } = await authenticator.register(options.body, ORIGIN, overrides);
  const verify = await browser.json("/api/auth/passkey/verify-registration", { body: { response, ...verifyBody } });
  return { options, verify, credentialId: response.id };
}

export async function signInWithPasskey(
  browser: Browser,
  authenticator: SoftAuthenticator,
  overrides: Parameters<SoftAuthenticator["authenticate"]>[2] = {},
) {
  const options = await browser.json<{ challenge: string; rpId: string; userVerification: string }>(
    "/api/auth/passkey/generate-authenticate-options",
  );
  const response = await authenticator.authenticate(options.body, ORIGIN, overrides);
  const verify = await browser.json("/api/auth/passkey/verify-authentication", { body: { response } });
  return { options, verify, response };
}

export async function reauth(
  browser: Browser,
  authenticator: SoftAuthenticator,
  overrides: Parameters<SoftAuthenticator["authenticate"]>[2] = {},
) {
  const options = await browser.json<{ challenge: string; rpId: string; allowCredentials?: { id: string }[] }>(
    "/api/me/reauth/options",
    { body: {} },
  );
  const response = await authenticator.authenticate(options.body, ORIGIN, overrides);
  return browser.json("/api/me/reauth", { body: { response } });
}

export interface Workspace {
  owner: OwnerDetails;
  ownerId: string;
  browser: Browser;
  authenticator: SoftAuthenticator;
}

/** A fresh, completed setup: the owner claimed, registered a passkey and is signed in. */
export async function setupWorkspace(): Promise<Workspace> {
  await resetInstallation();
  await seedSetupToken();
  const browser = new Browser();
  const authenticator = new SoftAuthenticator();
  const owner = ownerDetails();
  const claimed = await claim(browser, owner);
  if (claimed.status !== 201) throw new Error(`claim failed: ${claimed.status} ${JSON.stringify(claimed.body)}`);
  const reg = await registerPasskey(browser, authenticator);
  if (reg.verify?.status !== 200) throw new Error(`registration failed: ${JSON.stringify(reg)}`);
  const row = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(owner.email).first<{ id: string }>();
  return { owner, ownerId: row!.id, browser, authenticator };
}

/**
 * A further active member with one passkey, created directly in D1 (invitations arrive in M1b), then
 * signed in on a new browser with a new authenticator. Uses an enrolment ticket like every first passkey.
 */
export async function addMember(role: "owner" | "admin" | "member" = "member") {
  const id = ulid();
  const email = uniqueEmail(role);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO users (id, email, email_normalised, display_name, role, status, email_verified, created_at, updated_at)
     VALUES (?, ?, ?, 'Pat Doe', ?, 'active', 1, ?, ?)`,
  )
    .bind(id, email, email, role, now, now)
    .run();
  const browser = new Browser();
  const authenticator = new SoftAuthenticator();
  await giveTicket(browser, id, "invitation");
  const reg = await registerPasskey(browser, authenticator);
  if (reg.verify?.status !== 200) throw new Error(`member registration failed: ${JSON.stringify(reg)}`);
  return { id, email, browser, authenticator };
}

/** Issues an enrolment ticket for a user straight into a browser's cookie jar. */
export async function giveTicket(browser: Browser, userId: string, via: "invitation" | "setup" = "invitation") {
  const { issueTicket, ENROL_COOKIE } = await import("../../src/features/identity/enrolment");
  const ticket = await issueTicket(env.DB, env.TOKEN_HASH_KEY!, userId, via, null, Date.now());
  browser.cookies.set(ENROL_COOKIE, ticket.token);
  return ticket;
}

/** Makes a session's last passkey assertion old, so step-up is needed again. */
export async function staleFreshAuth(userId: string, minutesAgo = 11): Promise<void> {
  await env.DB.prepare("UPDATE sessions SET fresh_auth_at = ? WHERE user_id = ?")
    .bind(Date.now() - minutesAgo * 60_000, userId)
    .run();
}

export async function sessionTokens(): Promise<string[]> {
  const { results } = await env.DB.prepare("SELECT token FROM sessions").all<{ token: string }>();
  return results.map((r) => r.token);
}

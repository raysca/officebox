import { env } from "cloudflare:workers";
import { createApp } from "../../src/core/app";
import { ulid } from "../../src/core/ids";
import { clearSettingsCache } from "../../src/core/settings";
import { features } from "../../src/features";
import { hashPassword, peppersFromEnv } from "../../src/features/identity/password";
import { clearSessionCache } from "../../src/features/identity/sessions";
import { clearSetupCache } from "../../src/features/identity/setup-state";

export const ORIGIN = "http://officebox.test";
export const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
export const FIREFOX_WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0";

/** A fresh, unique IP per call, so the per-IP binding limits of different tests never interact. */
export function uniqueIp(): string {
  const n = crypto.getRandomValues(new Uint8Array(4));
  return `10.${n[0]}.${n[1]}.${n[2]}`;
}

export function uniqueEmail(prefix = "user"): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 12)}@example.com`;
}

/** A mutable clock for `createApp({ now })`. */
export class Clock {
  constructor(public value = Date.now()) {}
  readonly now = (): number => this.value;
  advance(ms: number): void {
    this.value += ms;
  }
}

/** Minimal cookie jar: keeps the last value of each cookie, drops deleted ones. */
export class CookieJar {
  readonly values = new Map<string, string>();

  absorb(response: Response): void {
    for (const header of response.headers.getSetCookie()) {
      const [pair = ""] = header.split(";");
      const index = pair.indexOf("=");
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      if (value === "" || /max-age=0/i.test(header)) this.values.delete(name);
      else this.values.set(name, value);
    }
  }

  header(): string {
    return [...this.values].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  get(name: string): string | undefined {
    return this.values.get(name);
  }

  clone(): CookieJar {
    const copy = new CookieJar();
    for (const [k, v] of this.values) copy.values.set(k, v);
    return copy;
  }
}

export interface CallOptions {
  jar?: CookieJar;
  ip?: string;
  userAgent?: string;
  /** Leave out the CSRF header and Origin (or override them). */
  csrf?: boolean;
  origin?: string | null;
  headers?: Record<string, string>;
  env?: Cloudflare.Env;
}

export function makeApp(clock: Clock = new Clock()) {
  const app = createApp({ features, now: clock.now, logSink: () => {} });
  const call = async (method: string, path: string, body?: unknown, options: CallOptions = {}): Promise<Response> => {
    const headers: Record<string, string> = {
      "CF-Connecting-IP": options.ip ?? uniqueIp(),
      "User-Agent": options.userAgent ?? CHROME_MAC,
      ...options.headers,
    };
    if (method !== "GET" && options.csrf !== false) headers["X-Officebox-Request"] = "1";
    const origin = options.origin === undefined ? (method === "GET" ? null : ORIGIN) : options.origin;
    if (origin !== null) headers.Origin = origin;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const cookie = options.jar?.header();
    if (cookie) headers.Cookie = cookie;
    const response = await app.request(
      `${ORIGIN}${path}`,
      { method, headers, body: body === undefined ? undefined : JSON.stringify(body) },
      options.env ?? env,
    );
    options.jar?.absorb(response);
    return response;
  };
  return { app, clock, call };
}

/** Forgets every per-isolate cache identity tests can affect. */
export function clearCaches(): void {
  clearSetupCache(env.DB);
  clearSessionCache(env.DB);
  clearSettingsCache(env.DB);
}

/** Deletes the installation and identity rows: back to a fresh deploy. */
export async function resetInstallation(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions"),
    env.DB.prepare("DELETE FROM handles"),
    env.DB.prepare("DELETE FROM users"),
    env.DB.prepare("DELETE FROM installation"),
  ]);
  clearCaches();
}

/** A completed installation, created directly (tests of setup itself use the API). Idempotent. */
export async function ensureInstalled(name = "Test workspace"): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO installation (id, installation_id, name, setup_completed_at) VALUES (1, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET setup_completed_at = COALESCE(setup_completed_at, excluded.setup_completed_at)`,
  )
    .bind(ulid(), name, Date.now())
    .run();
}

export interface TestUser {
  id: string;
  email: string;
  password: string;
}

/** Creates a user directly with a hashed password. */
export async function createUser(
  options: { role?: string; status?: string; password?: string; pepperEnv?: object } = {},
): Promise<TestUser> {
  const id = ulid();
  const email = uniqueEmail(options.role ?? "member");
  const password = options.password ?? `pw-${crypto.randomUUID()}`;
  const { set } = peppersFromEnv(options.pepperEnv ?? env);
  if (!set) throw new Error("no pepper in test env");
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO users (id, email, display_name, password_hash, role, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      email,
      "Test User",
      await hashPassword(password, set),
      options.role ?? "member",
      options.status ?? "active",
      now,
      now,
    )
    .run();
  return { id, email, password };
}

/** Signs `user` in through the API and returns the jar holding their cookies. */
export async function signIn(
  call: ReturnType<typeof makeApp>["call"],
  user: TestUser,
  options: CallOptions = {},
): Promise<CookieJar> {
  const jar = options.jar ?? new CookieJar();
  const res = await call(
    "POST",
    "/api/auth/password",
    { email: user.email, password: user.password },
    { ...options, jar },
  );
  if (res.status !== 200) throw new Error(`sign-in failed: ${res.status} ${await res.text()}`);
  return jar;
}

export async function errorCode(res: Response): Promise<string | undefined> {
  const body: { error?: { code?: string } } = await res.json();
  return body.error?.code;
}

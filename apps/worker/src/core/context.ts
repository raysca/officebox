import type { UserStatus, WorkspaceRole } from "@officebox/shared";
import type { Context } from "hono";
import type { Env } from "../env";
import type { Logger } from "./log";

/** Per-request values set by the core middleware (`app.ts`). */
export interface RequestVariables {
  /** ULID for this request; returned in `X-Request-Id` and in error bodies, and on every log line. */
  requestId: string;
  /** `Date.now()` when the request reached the Worker. */
  startedAt: number;
  /** Logger carrying `requestId`. */
  log: Logger;
  /** The request's clock (epoch ms). `Date.now` unless the app was created with another (tests). */
  now: () => number;
  /**
   * The signed-in person, set by the identity feature's `requireAuth` middleware once the session
   * has been checked (Identity §4.5). Absent on public routes. Read it with `authOf(c)`.
   */
  auth?: AuthContext;
}

/** Who is making an authenticated request: checked against D1 (cached at most 60 s) on every request. */
export interface AuthContext {
  userId: string;
  sessionId: string;
  role: WorkspaceRole;
  status: UserStatus;
}

/** Hono environment for every route in the Worker. Feature routers are `new Hono<AppEnv>()`. */
export interface AppEnv {
  Bindings: Env;
  Variables: RequestVariables;
}

export type AppContext = Context<AppEnv>;

/**
 * What core services need from their caller, independent of Hono, so the same service runs in a route,
 * a queue consumer, a cron job or a Durable Object.
 */
export interface CoreContext {
  env: Env;
  log: Logger;
  /** Set when the work belongs to an HTTP request. */
  requestId?: string;
  /** Clock in epoch milliseconds; injectable for tests. */
  now: () => number;
}

/** The `CoreContext` of an HTTP request. */
export function coreContext(c: AppContext): CoreContext {
  return { env: c.env, log: c.var.log, requestId: c.var.requestId, now: c.var.now };
}

/** The signed-in person on a route behind `requireAuth`. Throws if the middleware wasn't applied (a bug). */
export function authOf(c: AppContext): AuthContext {
  const auth = c.var.auth;
  if (!auth) throw new Error("authOf() used on a route without requireAuth");
  return auth;
}

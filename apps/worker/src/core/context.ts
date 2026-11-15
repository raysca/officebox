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
  return { env: c.env, log: c.var.log, requestId: c.var.requestId, now: Date.now };
}

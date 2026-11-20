import {
  API_CONTENT_SECURITY_POLICY,
  apiError,
  APP_CONTENT_SECURITY_POLICY,
  COMMON_SECURITY_HEADERS,
  FRAGMENT_PAGE_HEADERS,
  FRAGMENT_PAGES,
} from "@officebox/shared";
import { Hono, type MiddlewareHandler } from "hono";
import type { AppEnv } from "./context";
import { csrfProtection } from "./csrf";
import { errorResponse, INTERNAL_ERROR } from "./errors";
import { checkHealth } from "./health";
import { ulid } from "./ids";
import { createLogger, rootLogger, type LogSink } from "./log";

/**
 * The Worker's HTTP app.
 *
 * - **Request context:** every request gets a ULID request ID (`X-Request-Id`), a start time and a
 *   logger carrying the ID (`c.var.requestId`, `c.var.startedAt`, `c.var.log`).
 * - **Request log:** one line per request with method, route path (never the query string, which can
 *   carry tokens), status and duration. No headers, bodies or IP addresses.
 * - **Errors:** routes return typed results through `respond` (`errors.ts`); an unexpected exception
 *   becomes a 500 with the request ID and is logged with its stack.
 * - **Features** are Hono routers mounted under `/api/<name>` (see `defineFeature`).
 * - **Before features:** the `apiMiddleware` the caller passes (identity's host guard, which sets
 *   `c.var.canonicalOrigin`), then **CSRF** on every state-changing `/api` request (`csrf.ts`,
 *   TDD §8.2). No CORS headers are ever sent.
 * - Unknown `/api` paths get a typed 404; everything else falls through to the web app in Assets.
 * - **Security headers** (TDD §8.2) on every response the Worker produces: HSTS, `nosniff`, the
 *   referrer policy, and a CSP: `default-src 'none'; frame-ancestors 'none'` for API responses, the
 *   app CSP for assets. Assets answered without running the Worker get the same headers from
 *   `apps/web/public/_headers`; both come from `packages/shared/src/security.ts`.
 * - `X-Request-Id` is set on every response the Worker produces, including assets it fetches on the
 *   fall-through route; assets that Workers Assets serves before the Worker runs have none.
 */

export interface Feature {
  /** Lower-case path segment: the feature is served at `/api/<name>`. */
  name: string;
  routes: Hono<AppEnv>;
}

/**
 * Declares a feature's routes. Each feature folder (`src/features/<feature>/`) exports one, built with
 * `new Hono<AppEnv>()`, and is listed in `src/features/index.ts`.
 */
export function defineFeature(name: string, routes: Hono<AppEnv>): Feature {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`Invalid feature name: ${name}`);
  return { name, routes };
}

/**
 * Whether a route's own Cache-Control may stay on an API response (TDD §8.2). The header is parsed
 * into directive names (split on commas, trimmed, the name before any `=`, lower-cased). It is kept
 * only if it has a bare `private` (no `=` qualifier) or `no-store`, and no `public` or `s-maxage`.
 * Everything else, including no header and `no-cache` alone (which still allows shared caches to
 * store the response), is replaced with `no-store`.
 */
export function keepsApiCacheControl(value: string | null): boolean {
  if (value === null) return false;
  const directives = value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  const names = new Set(directives.map((part) => (part.split("=", 1)[0] ?? "").trim().toLowerCase()));
  const barePrivate = directives.some((part) => part.toLowerCase() === "private");
  return (barePrivate || names.has("no-store")) && !names.has("public") && !names.has("s-maxage");
}

export interface AppOptions {
  features: readonly Feature[];
  /** Log destination; tests capture lines with it. */
  logSink?: LogSink;
  /** Clock for every request (epoch ms); tests inject one. Defaults to `Date.now`. */
  now?: () => number;
  /** Middleware for `/api/*`, run before CSRF and the features (identity's host guard). */
  apiMiddleware?: readonly MiddlewareHandler<AppEnv>[];
}

export function createApp(options: AppOptions): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const baseLog = options.logSink ? createLogger({}, options.logSink) : rootLogger;
  const clock = options.now ?? Date.now;

  app.use("*", async (c, next) => {
    const requestId = ulid();
    const startedAt = Date.now();
    const log = baseLog.child({ requestId });
    c.set("requestId", requestId);
    c.set("startedAt", startedAt);
    c.set("log", log);
    c.set("now", clock);
    await next();
    // Request ID and security headers are skipped on 101 Switching Protocols responses, whose
    // headers are immutable in the Workers runtime.
    if (c.res.status === 101) return;
    const path = new URL(c.req.url).pathname;
    c.header("X-Request-Id", requestId);
    for (const [name, value] of Object.entries(COMMON_SECURITY_HEADERS)) c.header(name, value);
    const isApi = path === "/api" || path.startsWith("/api/") || path.startsWith("/ws/") || path === "/health";
    c.header("Content-Security-Policy", isApi ? API_CONTENT_SECURITY_POLICY : APP_CONTENT_SECURITY_POLICY);
    // API responses carry user data: never stored by shared caches (TDD §8.2).
    if (isApi && !keepsApiCacheControl(c.res.headers.get("Cache-Control"))) c.header("Cache-Control", "no-store");
    // Pages whose links carry a token in the fragment: no Referer, never cached (Platform §10).
    if (FRAGMENT_PAGES.includes(path))
      for (const [name, value] of Object.entries(FRAGMENT_PAGE_HEADERS)) c.header(name, value);
    // Assets fall-through and health probes are noisy and carry nothing worth keeping.
    if (path.startsWith("/api/") || path === "/api" || path.startsWith("/ws/")) {
      log.info("request", {
        method: c.req.method,
        route: c.req.routePath,
        status: c.res.status,
        durationMs: Date.now() - startedAt,
      });
    }
  });

  app.get("/health", async (c) => {
    const body = await checkHealth(c.env, c.var.log);
    return c.json(body, body.status === "ok" ? 200 : 503, { "Cache-Control": "no-store" });
  });

  for (const middleware of options.apiMiddleware ?? []) {
    app.use("/api/*", middleware);
    app.use("/ws/*", middleware);
  }
  // CSRF defence for every state-changing API request (TDD §8.2), before any feature route runs.
  app.use("/api/*", csrfProtection);

  const names = new Set<string>();
  for (const feature of options.features) {
    if (names.has(feature.name)) throw new Error(`Feature ${feature.name} mounted twice`);
    names.add(feature.name);
    app.route(`/api/${feature.name}`, feature.routes);
    if (feature.name === "ws") {
      app.route("/ws", feature.routes);
    }
  }

  app.all("/api", (c) => errorResponse(c, apiError("not_found", "No such endpoint.")));
  app.all("/api/*", (c) => errorResponse(c, apiError("not_found", "No such endpoint.")));
  app.all("/ws/*", (c) => errorResponse(c, apiError("not_found", "No such endpoint.")));

  // Static files and SPA navigations are served by Workers Assets before the Worker runs. Requests that
  // reach the Worker anyway (for example a non-navigation request for a missing file) go back to Assets,
  // which applies the SPA fallback.
  // The response is copied so its headers are mutable for the middleware above.
  app.all("*", async (c) => {
    const res = await c.env.ASSETS.fetch(c.req.raw);
    return new Response(res.body, res);
  });

  app.onError((error, c) => {
    c.var.log.error("unhandled error", { error, method: c.req.method, route: c.req.routePath });
    return errorResponse(c, INTERNAL_ERROR);
  });

  return app;
}

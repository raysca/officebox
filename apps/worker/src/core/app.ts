import { apiError } from "@officebox/shared";
import { Hono } from "hono";
import type { AppEnv } from "./context";
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
 * - Unknown `/api` paths get a typed 404; everything else falls through to the web app in Assets.
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

export interface AppOptions {
  features: readonly Feature[];
  /** Log destination; tests capture lines with it. */
  logSink?: LogSink;
}

export function createApp(options: AppOptions): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const baseLog = options.logSink ? createLogger({}, options.logSink) : rootLogger;

  app.use("*", async (c, next) => {
    const requestId = ulid();
    const startedAt = Date.now();
    const log = baseLog.child({ requestId });
    c.set("requestId", requestId);
    c.set("startedAt", startedAt);
    c.set("log", log);
    await next();
    c.header("X-Request-Id", requestId);
    const path = new URL(c.req.url).pathname;
    // Assets fall-through and health probes are noisy and carry nothing worth keeping.
    if (path.startsWith("/api/") || path === "/api") {
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

  const names = new Set<string>();
  for (const feature of options.features) {
    if (names.has(feature.name)) throw new Error(`Feature ${feature.name} mounted twice`);
    names.add(feature.name);
    app.route(`/api/${feature.name}`, feature.routes);
  }

  app.all("/api", (c) => errorResponse(c, apiError("not_found", "No such endpoint.")));
  app.all("/api/*", (c) => errorResponse(c, apiError("not_found", "No such endpoint.")));

  // Static files and SPA navigations are served by Workers Assets before the Worker runs. Requests that
  // reach the Worker anyway (for example a non-navigation request for a missing file) go back to Assets,
  // which applies the SPA fallback.
  app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

  app.onError((error, c) => {
    c.var.log.error("unhandled error", { error, method: c.req.method, route: c.req.routePath });
    return errorResponse(c, INTERNAL_ERROR);
  });

  return app;
}

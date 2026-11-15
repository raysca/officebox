import { apiError, type ApiErrorBody, type HealthResponse } from "@officebox/shared";
import { Hono } from "hono";
import type { Env } from "./env";

export { SystemObject } from "./system-object";

/**
 * Worker entry. M0a serves only `/health`; everything else that isn't an API path falls through to
 * the web app in Workers Assets. M0b replaces this with the core router (request context, logging,
 * Result-to-HTTP mapping) and feature routes under `src/features/`.
 */
const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => {
  const body: HealthResponse = { status: "ok", version: c.env.OFFICEBOX_VERSION };
  return c.json(body, 200, { "Cache-Control": "no-store" });
});

app.all("/api/*", (c) => {
  const body: ApiErrorBody = { error: apiError("not_found", "No such endpoint.") };
  return c.json(body, 404);
});

// Static files and SPA navigations are served by Workers Assets before the Worker runs. Requests that
// reach the Worker anyway (for example a non-navigation request for a missing file) go back to Assets,
// which applies the SPA fallback.
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

app.onError((error, c) => {
  console.error(JSON.stringify({ level: "error", message: "unhandled error", error: String(error) }));
  const body: ApiErrorBody = { error: apiError("internal", "Something went wrong.") };
  return c.json(body, 500);
});

export default {
  fetch: app.fetch,

  // Cron Triggers (every 5 minutes, hourly, daily). M0b adds the dispatcher that runs named jobs
  // (TDD §7.8). Until then, a trigger is acknowledged and does nothing.
  scheduled(controller) {
    console.log(JSON.stringify({ level: "info", message: "cron trigger", cron: controller.cron }));
  },

  // Queue consumer. M0b adds the consumer framework. Until then, nothing produces messages; any that
  // arrive are retried so that they end in the dead-letter queue instead of being lost.
  queue(batch) {
    console.warn(JSON.stringify({ level: "warn", message: "no queue consumer yet", queue: batch.queue }));
    batch.retryAll();
  },
} satisfies ExportedHandler<Env>;

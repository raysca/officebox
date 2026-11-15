import type { HealthCheck, HealthResponse } from "@officebox/shared";
import type { Env } from "../env";
import type { Logger } from "./log";

/**
 * `GET /health` checks (TDD §7.1, M0 subset): D1 reachable, the system Durable Object reachable, and
 * the queue binding present (configured, not yet its depth). M7 adds R2, storage levels, projection lag, DLQ depth and releases.
 *
 * Failures report a fixed phrase (`unreachable`, `timed out`, `missing`), never the error itself, so
 * the public endpoint can't leak secrets or internals; the error is logged instead.
 */

export const HEALTH_CHECK_TIMEOUT_MS = 3000;

export type HealthEnv = Pick<Env, "OFFICEBOX_VERSION" | "DB" | "SYSTEM" | "EMAIL_QUEUE">;

class Timeout extends Error {}

async function timed(
  name: string,
  log: Logger,
  check: () => Promise<boolean>,
  timeoutMs: number,
): Promise<HealthCheck> {
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const healthy = await Promise.race([
      check(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Timeout()), timeoutMs);
      }),
    ]);
    const latencyMs = Date.now() - started;
    return healthy ? { ok: true, latencyMs } : { ok: false, latencyMs, detail: "unhealthy" };
  } catch (error) {
    const timedOut = error instanceof Timeout;
    log.error("health check failed", { check: name, timedOut, error: timedOut ? undefined : error });
    return { ok: false, latencyMs: Date.now() - started, detail: timedOut ? "timed out" : "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

/** Results are cached per isolate for this long, so a burst of probes costs one round of checks. */
export const HEALTH_CACHE_MS = 5000;

interface CachedHealth {
  at: number;
  result: Promise<HealthResponse>;
}

// Keyed by the D1 binding object: one entry per environment (tests pass broken fakes).
const cache = new WeakMap<object, CachedHealth>();

/** Runs the checks, or returns this isolate's result from the last `HEALTH_CACHE_MS`. */
export function checkHealth(env: HealthEnv, log: Logger, timeoutMs = HEALTH_CHECK_TIMEOUT_MS): Promise<HealthResponse> {
  const now = Date.now();
  const hit = cache.get(env.DB);
  if (hit && now - hit.at < HEALTH_CACHE_MS) return hit.result;
  const result = runChecks(env, log, timeoutMs);
  cache.set(env.DB, { at: now, result });
  return result;
}

async function runChecks(env: HealthEnv, log: Logger, timeoutMs: number): Promise<HealthResponse> {
  const [d1, durableObjects] = await Promise.all([
    timed("d1", log, async () => (await env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>())?.ok === 1, timeoutMs),
    timed(
      "durableObjects",
      log,
      async () => {
        const result = await env.SYSTEM.getByName("system").ping();
        return result.ok;
      },
      timeoutMs,
    ),
  ]);
  // Only checks that the producer binding is configured; queue health (DLQ depth) arrives in M7.
  const queues: HealthCheck =
    typeof env.EMAIL_QUEUE?.send === "function"
      ? { ok: true, detail: "binding present" }
      : { ok: false, detail: "binding missing" };

  const checks = { d1, durableObjects, queues };
  const healthy = Object.values(checks).every((c) => c.ok);
  return { status: healthy ? "ok" : "error", version: env.OFFICEBOX_VERSION, checks };
}

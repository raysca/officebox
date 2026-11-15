import type { HealthCheck, HealthResponse } from "@officebox/shared";
import type { Env } from "../env";
import type { Logger } from "./log";

/**
 * `GET /health` checks (TDD §7.1, M0 subset): D1 reachable, the system Durable Object reachable, and
 * the queue binding present. M7 adds R2, storage levels, projection lag, DLQ depth and releases.
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

export async function checkHealth(
  env: HealthEnv,
  log: Logger,
  timeoutMs = HEALTH_CHECK_TIMEOUT_MS,
): Promise<HealthResponse> {
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
  const queues: HealthCheck =
    typeof env.EMAIL_QUEUE?.send === "function" ? { ok: true } : { ok: false, detail: "missing" };

  const checks = { d1, durableObjects, queues };
  const healthy = Object.values(checks).every((c) => c.ok);
  return { status: healthy ? "ok" : "error", version: env.OFFICEBOX_VERSION, checks };
}

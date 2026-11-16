import type { SetupService, SetupServiceId, SetupServiceProblem } from "@officebox/shared";
import type { Logger } from "../../core/log";
import type { Env } from "../../env";
import { resolveBetterAuthSecret, resolveTokenHashKey } from "./secrets";

/**
 * The required-services check before setup (Identity §4.1; TDD §6.8; product-owner decision
 * 16 Nov 2026, M1b-1). `GET /setup` and `POST /setup` run it first; setup is blocked, and the open
 * claim window doesn't start, while any service fails.
 *
 * | Service | Check **(default)** |
 * |---|---|
 * | `d1` | `SELECT 1`, then the `installation` table with its newest setup column exists (migrations ran) |
 * | `durable_objects` | the SystemObject's `ping()` |
 * | `queues` | the `EMAIL_QUEUE` binding is present (nothing is sent) |
 * | `r2` | the `FILES` binding is present and `head` of a fixed probe key answers (absent is fine) |
 * | `better_auth_secret`, `token_hash_key` | the key resolves: a valid Worker secret, or a generated key read from the SystemObject |
 *
 * Each check has a 3-second timeout; results are cached per isolate for 5 seconds, like `/health`.
 * Only fixed problem codes leave the Worker (`missing`, `unreachable`, `migrations_pending`,
 * `invalid_secret`); raw errors go to the Worker log, never a value, length, account or resource ID.
 */

export const SERVICE_CHECK_TIMEOUT_MS = 3000;
export const SERVICE_CACHE_MS = 5000;
/** The fixed key `head`ed to prove R2 answers. It never needs to exist. */
export const R2_PROBE_KEY = "officebox/setup-probe";

export type ServicesEnv = Pick<
  Env,
  "DB" | "SYSTEM" | "EMAIL_QUEUE" | "FILES" | "BETTER_AUTH_SECRET" | "BETTER_AUTH_SECRETS" | "TOKEN_HASH_KEY"
>;

export interface ServicesReport {
  services: SetupService[];
  allOk: boolean;
  /** D1 works and is migrated, so the setup state can be read. */
  d1Ok: boolean;
}

class Timeout extends Error {}

type Outcome = SetupServiceProblem | null;

async function timed(id: SetupServiceId, log: Logger, check: () => Promise<Outcome>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const problem = await Promise.race([
      check(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Timeout()), timeoutMs);
      }),
    ]);
    return problem;
  } catch (error) {
    const timedOut = error instanceof Timeout;
    log.error("setup service check failed", { service: id, timedOut, error: timedOut ? undefined : error });
    return "unreachable" as const;
  } finally {
    clearTimeout(timer);
  }
}

const MISSING_SCHEMA = /no such (table|column)/i;

async function checkD1(env: ServicesEnv, log: Logger): Promise<Outcome> {
  if (!env.DB || typeof env.DB.prepare !== "function") return "missing";
  const row = await env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
  if (row?.ok !== 1) return "unreachable";
  try {
    // Compiling this fails if the table or the newest setup column (M1b-1) is missing.
    await env.DB.prepare("SELECT setup_opened_at FROM installation LIMIT 0").all();
  } catch (error) {
    if (error instanceof Error && MISSING_SCHEMA.test(error.message)) {
      log.error("setup service check: D1 migrations haven't been applied", { service: "d1" });
      return "migrations_pending";
    }
    throw error;
  }
  return null;
}

async function checkDurableObjects(env: ServicesEnv): Promise<Outcome> {
  if (!env.SYSTEM || typeof env.SYSTEM.getByName !== "function") return "missing";
  const result = await env.SYSTEM.getByName("system").ping();
  return result.ok ? null : "unreachable";
}

function checkQueues(env: ServicesEnv): Promise<Outcome> {
  return Promise.resolve(typeof env.EMAIL_QUEUE?.send === "function" ? null : "missing");
}

async function checkR2(env: ServicesEnv): Promise<Outcome> {
  if (!env.FILES || typeof env.FILES.head !== "function") return "missing";
  await env.FILES.head(R2_PROBE_KEY); // null (absent) is fine; a throw is unreachable
  return null;
}

async function runChecks(env: ServicesEnv, log: Logger, timeoutMs: number): Promise<ServicesReport> {
  const [d1, durableObjects, queues, r2, betterAuth, tokenHash] = await Promise.all([
    timed("d1", log, () => checkD1(env, log), timeoutMs),
    timed("durable_objects", log, () => checkDurableObjects(env), timeoutMs),
    timed("queues", log, () => checkQueues(env), timeoutMs),
    timed("r2", log, () => checkR2(env), timeoutMs),
    timed(
      "better_auth_secret",
      log,
      async () => {
        const key = await resolveBetterAuthSecret(env, log);
        return key.ok ? null : key.error;
      },
      timeoutMs,
    ),
    timed(
      "token_hash_key",
      log,
      async () => {
        const key = await resolveTokenHashKey(env, log);
        return key.ok ? null : key.error;
      },
      timeoutMs,
    ),
  ]);
  const outcomes: [SetupServiceId, Outcome][] = [
    ["d1", d1],
    ["durable_objects", durableObjects],
    ["queues", queues],
    ["r2", r2],
    ["better_auth_secret", betterAuth],
    ["token_hash_key", tokenHash],
  ];
  const services = outcomes.map(([id, problem]): SetupService =>
    problem ? { id, ok: false, problem } : { id, ok: true },
  );
  return { services, allOk: services.every((s) => s.ok), d1Ok: d1 === null };
}

interface CachedReport {
  at: number;
  /** The bindings and secrets the report was made with: a hit needs every one to be the same. */
  inputs: readonly unknown[];
  report: Promise<ServicesReport>;
}

// Keyed by the D1 binding object, like /health; tests pass other bindings, which miss.
const cache = new WeakMap<object, CachedReport>();
const FALLBACK_KEY = {};

function inputsOf(env: ServicesEnv): readonly unknown[] {
  return [
    env.DB,
    env.SYSTEM,
    env.EMAIL_QUEUE,
    env.FILES,
    env.BETTER_AUTH_SECRET,
    env.BETTER_AUTH_SECRETS,
    env.TOKEN_HASH_KEY,
  ];
}

/** Forgets this isolate's cached reports (tests). */
export function clearServicesCache(env: Pick<Env, "DB">): void {
  cache.delete(env.DB ?? FALLBACK_KEY);
}

/** Runs the checks, or returns this isolate's report from the last `SERVICE_CACHE_MS`. */
export function checkSetupServices(
  env: ServicesEnv,
  log: Logger,
  now = Date.now(),
  timeoutMs = SERVICE_CHECK_TIMEOUT_MS,
): Promise<ServicesReport> {
  const key = (env.DB as object | undefined) ?? FALLBACK_KEY;
  const inputs = inputsOf(env);
  const hit = cache.get(key);
  if (hit && now - hit.at < SERVICE_CACHE_MS && hit.at <= now && hit.inputs.every((v, i) => v === inputs[i])) {
    return hit.report;
  }
  const report = runChecks(env, log, timeoutMs);
  cache.set(key, { at: now, inputs, report });
  return report;
}

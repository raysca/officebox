import { apiError, err, ok, type ApiError, type Result } from "@officebox/shared";
import type { Env } from "../env";
import type { CoreContext } from "./context";
import { Database, expectOk } from "./db";

/**
 * Rate limiting with one interface over two mechanisms (Platform §8). Each limit names its mechanism:
 *
 * - **`binding`**: the Workers Rate Limiting binding. Windows of 10 or 60 seconds, configured in
 *   `wrangler.jsonc`; counted per Cloudflare location and approximate. For abuse protection.
 * - **`d1`**: a counter row in `rate_counters` keyed `(scope, key, window_start)`, for windows longer
 *   than 60 seconds and daily quotas. Exact, fixed windows. Daily windows start at midnight in the
 *   member's time zone.
 *
 * (The third mechanism, a counter inside the Durable Object that owns the action, lives in that object.)
 *
 * `checkLimit` returns `Ok` when the action may go ahead and counts it, or `Err` with a `rate_limited`
 * error and `retryAfterSeconds`. It never throws for a limit being hit (AGENTS §4.1).
 */

/** Rate Limiting bindings declared in `wrangler.jsonc`. */
export type RateLimitBindingName = { [K in keyof Env]-?: Env[K] extends RateLimit ? K : never }[keyof Env];

export interface BindingLimit {
  mechanism: "binding";
  /** Namespaces the key, so two limits can share a binding. */
  name: string;
  binding: RateLimitBindingName;
  /** The binding's configured period, used as the retry-after hint. */
  periodSeconds: 10 | 60;
}

export type CounterWindow = { kind: "fixed"; seconds: number } | { kind: "day" };

export interface CounterLimit {
  mechanism: "d1";
  /** `rate_counters.scope`. */
  name: string;
  limit: number;
  window: CounterWindow;
}

export type LimitDefinition = BindingLimit | CounterLimit;

export interface CheckOptions {
  /**
   * IANA time zone for `day` windows; defaults to UTC, and an unknown zone falls back to UTC.
   *
   * Pass the member's **stored** zone, never one from the request. Windows are keyed by their UTC
   * start, so a member who changes zone mid-day starts a new window and can get up to one extra
   * day's quota per change. M1 bounds this by rate-limiting time-zone changes **(default)**.
   */
  timeZone?: string;
}

const NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

export function defineLimit<L extends LimitDefinition>(definition: L): L {
  if (!NAME_PATTERN.test(definition.name)) throw new Error(`Invalid limit name: ${definition.name}`);
  if (definition.mechanism === "d1") {
    if (!Number.isInteger(definition.limit) || definition.limit < 1)
      throw new Error("Limit must be a positive integer");
    if (definition.window.kind === "fixed" && definition.window.seconds <= 60) {
      throw new Error(`${definition.name}: windows of 60 s or less use the binding (Platform §8)`);
    }
  }
  return definition;
}

/** Limits defined in M0. Features add theirs next to their code, using `defineLimit`. */
export const LIMITS = {
  /** Sign-in, setup, recovery and invitation acceptance: 5 per minute per IP. */
  auth: defineLimit({ mechanism: "binding", name: "auth", binding: "AUTH_RATE_LIMITER", periodSeconds: 60 }),
  /** General API: 300 per minute per session (default). */
  api: defineLimit({ mechanism: "binding", name: "api", binding: "API_RATE_LIMITER", periodSeconds: 60 }),
};

/** Longest D1 window kept by the prune job: 31 days covers "per 30 days" limits and daily quotas. */
export const RATE_COUNTER_RETENTION_MS = 31 * 24 * 60 * 60 * 1000;

function rateLimited(retryAfterSeconds: number): ApiError {
  return apiError("rate_limited", "Too many requests. Try again later.", {
    retryAfterSeconds: Math.max(1, Math.ceil(retryAfterSeconds)),
  });
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Whether `timeZone` is an IANA zone this runtime knows. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** The local calendar date of `at` in `timeZone`, as a sortable number `yyyymmdd`. */
function localDate(at: number, timeZone: string): number {
  const parts = formatter(timeZone).formatToParts(new Date(at));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return get("year") * 10_000 + get("month") * 100 + get("day");
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * UTC ms of the first instant of the local day containing `at` in `timeZone`. Found by binary search
 * on the local date rather than by offset arithmetic, so it is exact on DST days of any length (23,
 * 24.5 or 25 hours) and where midnight doesn't exist (the day then starts at 01:00).
 */
export function startOfDay(at: number, timeZone: string): number {
  const day = localDate(at, timeZone);
  // Days are at most 25 hours long, so 27 hours earlier is always on an earlier local date.
  let lo = at - 27 * HOUR_MS; // local date < day
  let hi = at; // local date === day
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (localDate(mid, timeZone) < day) lo = mid;
    else hi = mid;
  }
  return hi;
}

/**
 * The `[start, end)` window containing `now`. Day windows use `timeZone`; an unknown zone falls back
 * to UTC (`checkLimit` logs it).
 */
export function windowFor(window: CounterWindow, now: number, timeZone = "UTC"): { start: number; end: number } {
  if (window.kind === "fixed") {
    const size = window.seconds * 1000;
    const start = Math.floor(now / size) * size;
    return { start, end: start + size };
  }
  const zone = isValidTimeZone(timeZone) ? timeZone : "UTC";
  const start = startOfDay(now, zone);
  // The next day starts 23–25 hours later, so 36 hours on is always inside it.
  return { start, end: startOfDay(start + 36 * HOUR_MS, zone) };
}

async function checkCounter(
  ctx: CoreContext,
  limit: CounterLimit,
  key: string,
  options: CheckOptions,
): Promise<Result<void, ApiError>> {
  const now = ctx.now();
  if (options.timeZone !== undefined && !isValidTimeZone(options.timeZone)) {
    ctx.log.warn("unknown time zone for a daily limit; using UTC", { limit: limit.name });
  }
  const { start, end } = windowFor(limit.window, now, options.timeZone);
  // One atomic statement: insert the first hit, or count another while under the limit. When the
  // limit is reached the conflict update's WHERE fails, nothing is returned, and the count stays put.
  const row = expectOk(
    await new Database(ctx.env.DB).first<{ count: number }>(
      `INSERT INTO rate_counters (scope, key, window_start, count) VALUES (?, ?, ?, 1)
       ON CONFLICT (scope, key, window_start) DO UPDATE SET count = count + 1 WHERE count < ?
       RETURNING count`,
      limit.name,
      key,
      start,
      limit.limit,
    ),
  );
  if (row) return ok();
  return err(rateLimited((end - now) / 1000));
}

async function checkBinding(ctx: CoreContext, limit: BindingLimit, key: string): Promise<Result<void, ApiError>> {
  const binding = ctx.env[limit.binding];
  const { success } = await binding.limit({ key: `${limit.name}:${key}` });
  return success ? ok() : err(rateLimited(limit.periodSeconds));
}

/**
 * Counts one action against `limit` for `key` (a user ID, IP or workspace) and says whether it may go
 * ahead. A refused action is not counted.
 */
export function checkLimit(
  ctx: CoreContext,
  limit: LimitDefinition,
  key: string,
  options: CheckOptions = {},
): Promise<Result<void, ApiError>> {
  return limit.mechanism === "binding" ? checkBinding(ctx, limit, key) : checkCounter(ctx, limit, key, options);
}

/** Deletes counter rows whose windows ended before the retention period. Run by the daily cron. */
export async function pruneRateCounters(ctx: CoreContext): Promise<number> {
  const meta = expectOk(
    await new Database(ctx.env.DB).run(
      "DELETE FROM rate_counters WHERE window_start < ?",
      ctx.now() - RATE_COUNTER_RETENTION_MS,
    ),
  );
  return meta.changes;
}

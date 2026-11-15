import { apiErrorBodySchema, err, ok, type ApiError, type Result } from "@officebox/shared";
import type { z } from "zod";
import { messages } from "../../app/messages";

/**
 * Typed fetch wrapper for the Officebox API.
 *
 * - Same-origin cookies are always sent (`credentials: "same-origin"`): the `HttpOnly` session cookies
 *   (TDD §3.1), which this code never sees.
 * - State-changing requests carry `X-Officebox-Request: 1`, which the Worker requires as part of its
 *   CSRF defence (TDD §8.2); the browser adds `Origin`.
 * - **Session refresh:** the access cookie lasts 15 minutes. When a request is refused as
 *   `unauthenticated`, the client calls `POST /api/auth/refresh` once (shared by every request that
 *   failed at the same moment, so the refresh token rotates once) and retries the request. If the
 *   refresh fails too, the original 401 is returned and the query client's `onUnauthorized` sends the
 *   person to sign-in.
 * - Every outcome is a typed `Result`; nothing here throws for an expected failure (AGENTS §4.1).
 *   TanStack Query wants query functions that throw, so `unwrap` converts a failed result into an
 *   `ApiRequestError` at that boundary only.
 */

export const CSRF_HEADER = "X-Officebox-Request";
export const DEFAULT_TIMEOUT_MS = 15_000;

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export type ApiClientError =
  /** The server answered with the standard error body (`{ error: { code, message } }`). */
  | { kind: "api"; status: number; error: ApiError; retryAfterSeconds?: number }
  /** A non-2xx response without a valid error body (a proxy page, an empty 502, ...). */
  | { kind: "http"; status: number; retryAfterSeconds?: number }
  /** A 2xx response whose body didn't match the expected schema. */
  | { kind: "invalid_response"; status: number }
  /** The request never got a response: offline, DNS, connection reset, CORS. */
  | { kind: "network" }
  /** No response within the timeout. */
  | { kind: "timeout"; timeoutMs: number }
  /** The caller aborted the request (for example TanStack Query cancelling a stale query). */
  | { kind: "aborted" };

export interface ApiRequestOptions<S extends z.ZodType> {
  method?: string;
  /** Sent as JSON. */
  body?: unknown;
  /** Validates a successful response body. Omit for responses without one (204). */
  schema?: S;
  signal?: AbortSignal;
  timeoutMs?: number;
  headers?: Record<string, string>;
  /** Injected in tests; defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Try a session refresh and one retry on `unauthenticated` (default true; auth endpoints never do). */
  refresh?: boolean;
}

type Output<S> = S extends z.ZodType ? z.output<S> : undefined;

export const REFRESH_PATH = "/api/auth/refresh";

/** Paths whose 401 means "not signed in" by design, so a refresh would never help. */
function refreshable(path: string): boolean {
  return !path.startsWith("/api/auth/") && !path.startsWith("/api/setup");
}

// One refresh at a time per page: concurrent 401s wait for the same attempt.
let refreshing: Promise<boolean> | null = null;

function refreshSession(doFetch: typeof fetch): Promise<boolean> {
  refreshing ??= send(REFRESH_PATH, { method: "POST", fetch: doFetch })
    .then((result) => result.ok)
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

function isSessionExpired(error: ApiClientError): boolean {
  return error.kind === "api" && error.error.code === "unauthenticated";
}

export async function apiRequest<S extends z.ZodType>(
  path: string,
  options: ApiRequestOptions<S> = {},
): Promise<Result<Output<S>, ApiClientError>> {
  const first = await send(path, options);
  if (first.ok || options.refresh === false || !refreshable(path) || !isSessionExpired(first.error)) return first;
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  if (!(await refreshSession(doFetch))) return first;
  return send(path, options);
}

async function send<S extends z.ZodType>(
  path: string,
  options: ApiRequestOptions<S>,
): Promise<Result<Output<S>, ApiClientError>> {
  if (options.signal?.aborted) return err({ kind: "aborted" });

  const method = (options.method ?? "GET").toUpperCase();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);

  const headers: Record<string, string> = { Accept: "application/json", ...options.headers };
  if (!SAFE_METHODS.has(method)) headers[CSRF_HEADER] = "1";
  if (options.body !== undefined) headers["Content-Type"] = "application/json";

  // One controller for both the timeout and the caller's signal. AbortSignal.any() would be neater,
  // but Safari on iOS 16.4 (a supported browser, PRD §18) doesn't have it.
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onCallerAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onCallerAbort, { once: true });

  try {
    let response: Response;
    try {
      response = await doFetch(path, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        credentials: "same-origin",
        signal: controller.signal,
      });
    } catch {
      if (timedOut) return err({ kind: "timeout", timeoutMs });
      if (controller.signal.aborted) return err({ kind: "aborted" });
      return err({ kind: "network" });
    }

    if (!response.ok) {
      const body = await readJson(response);
      const parsed = apiErrorBodySchema.safeParse(body);
      // The body's retryAfterSeconds wins over the Retry-After header when both are present.
      const retryAfterSeconds =
        (parsed.success ? parsed.data.error.retryAfterSeconds : undefined) ??
        parseRetryAfter(response.headers.get("Retry-After"));
      const extra = retryAfterSeconds === undefined ? {} : { retryAfterSeconds };
      if (parsed.success) return err({ kind: "api", status: response.status, error: parsed.data.error, ...extra });
      return err({ kind: "http", status: response.status, ...extra });
    }

    if (!options.schema) return ok(undefined as Output<S>);

    const body = await readJson(response);
    const parsed = options.schema.safeParse(body);
    if (!parsed.success) return err({ kind: "invalid_response", status: response.status });
    return ok(parsed.data as Output<S>);
  } catch {
    // Reading the body can fail if the connection drops mid-response or the timeout fires.
    if (timedOut) return err({ kind: "timeout", timeoutMs });
    if (controller.signal.aborted) return err({ kind: "aborted" });
    return err({ kind: "network" });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onCallerAbort);
  }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH = `(${MONTHS.join("|")})`;
const TIME = "(\\d{2}):(\\d{2}):(\\d{2})";

/** The three HTTP-date forms recipients must accept (RFC 9110 §5.6.7). */
const HTTP_DATE_FORMS: { pattern: RegExp; fields: (m: RegExpExecArray) => [string, string, string] }[] = [
  // IMF-fixdate, the preferred form: "Sun, 06 Nov 1994 08:49:37 GMT"
  {
    pattern: new RegExp(`^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\\d{2}) ${MONTH} (\\d{4}) ${TIME} GMT$`),
    fields: (m) => [m[3]!, m[2]!, m[1]!],
  },
  // RFC 850 (obsolete): "Sunday, 06-Nov-94 08:49:37 GMT"
  {
    pattern: new RegExp(
      `^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (\\d{2})-${MONTH}-(\\d{2}) ${TIME} GMT$`,
    ),
    fields: (m) => [m[3]!, m[2]!, m[1]!],
  },
  // asctime (obsolete): "Sun Nov  6 08:49:37 1994"
  {
    pattern: new RegExp(`^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) ${MONTH} ( \\d|\\d{2}) ${TIME} (\\d{4})$`),
    fields: (m) => [m[6]!, m[1]!, m[2]!.trim()],
  },
];

/**
 * Parses an HTTP-date as UTC, by hand: Date.parse reads asctime as local time, accepts many
 * non-HTTP formats, and treats two-digit years its own way.
 */
export function parseHttpDate(value: string, now = Date.now()): number | undefined {
  for (const { pattern, fields } of HTTP_DATE_FORMS) {
    const match = pattern.exec(value);
    if (!match) continue;
    const [yearText, monthName, dayText] = fields(match);
    const timeMatch = new RegExp(TIME).exec(value);
    if (!timeMatch) return undefined;
    let year = Number(yearText);
    if (yearText.length === 2) {
      // RFC 9110: a two-digit year more than 50 years in the future means the most recent past year
      // with the same last two digits.
      const nowYear = new Date(now).getUTCFullYear();
      year += Math.floor(nowYear / 100) * 100;
      if (year > nowYear + 50) year -= 100;
    }
    const [hours, minutes, seconds] = [timeMatch[1], timeMatch[2], timeMatch[3]].map(Number) as [
      number,
      number,
      number,
    ];
    const day = Number(dayText);
    if (day < 1 || day > 31 || hours > 23 || minutes > 59 || seconds > 60) return undefined;
    return Date.UTC(year, MONTHS.indexOf(monthName), day, hours, minutes, seconds);
  }
  return undefined;
}

/**
 * Seconds from a Retry-After header: delay-seconds (digits only) or an HTTP-date in any of the three
 * forms. Anything else ("-5", "1.5", "1e3", which Date.parse would happily read as a date) is
 * undefined, so the normal backoff applies.
 */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  const trimmed = value?.trim() ?? "";
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const date = parseHttpDate(trimmed, now);
  if (date === undefined) return undefined;
  return Math.max(0, Math.ceil((date - now) / 1000));
}

/** Parses a JSON body, or returns undefined when the body is empty or not JSON. */
async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === "") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Thrown only by `unwrap`, for TanStack Query. Carries the typed error. */
export class ApiRequestError extends Error {
  readonly detail: ApiClientError;

  constructor(detail: ApiClientError) {
    // A developer-facing summary for logs. Show people describeApiError(detail) instead.
    super(developerSummary(detail));
    this.name = "ApiRequestError";
    this.detail = detail;
  }

  /** The HTTP status, when the server answered. */
  get status(): number | undefined {
    return "status" in this.detail ? this.detail.status : undefined;
  }
}

function developerSummary(detail: ApiClientError): string {
  switch (detail.kind) {
    case "api":
      return `API error ${detail.status} ${detail.error.code}: ${detail.error.message}`;
    case "http":
    case "invalid_response":
      return `${detail.kind} (HTTP ${detail.status})`;
    case "timeout":
      return `timeout after ${detail.timeoutMs} ms`;
    case "network":
    case "aborted":
      return detail.kind;
  }
}

/**
 * Whether a failure means the session is missing or expired, so the person must sign in again. A
 * wrong password at sign-in (`invalid_credentials`, also a 401) is not.
 */
export function isUnauthorized(error: ApiClientError): boolean {
  if (error.kind === "api") return error.error.code === "unauthenticated";
  return "status" in error && error.status === 401;
}

/** The API error code of a failure, when the server sent one. */
export function errorCodeOf(error: unknown): ApiError["code"] | undefined {
  const detail = error instanceof ApiRequestError ? error.detail : null;
  return detail?.kind === "api" ? detail.error.code : undefined;
}

/** Returns the value or throws an `ApiRequestError`. Use inside query and mutation functions only. */
export function unwrap<T>(result: Result<T, ApiClientError>): T {
  if (result.ok) return result.value;
  throw new ApiRequestError(result.error);
}

/**
 * Whether the failed request was a query (reading) or a mutation (changing something). For a
 * mutation that timed out or lost its connection, the change may or may not have happened.
 */
export type RequestOperation = "query" | "mutation";

/**
 * A short message that is safe to show to the person. Server errors are described by their code,
 * never by the server's `message`, which is for logs and developers (packages/shared errors.ts).
 */
export function describeApiError(error: ApiClientError, operation: RequestOperation = "query"): string {
  const copy = messages.errors;
  switch (error.kind) {
    case "api":
      return copy.byCode[error.error.code] ?? copy.generic;
    case "http":
      if (error.status === 401) return copy.byCode.unauthenticated;
      if (error.status === 403) return copy.byCode.forbidden;
      if (error.status === 404) return copy.byCode.not_found;
      if (error.status === 429) return copy.byCode.rate_limited;
      return error.status >= 500 ? copy.server : copy.generic;
    case "invalid_response":
      return copy.invalidResponse;
    case "network":
      return operation === "mutation" ? copy.outcomeUnknown : copy.network;
    case "timeout":
      return operation === "mutation" ? copy.outcomeUnknown : copy.timeout;
    case "aborted":
      return copy.aborted;
  }
}

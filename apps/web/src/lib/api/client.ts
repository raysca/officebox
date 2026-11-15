import { apiErrorBodySchema, err, ok, type ApiError, type Result } from "@officebox/shared";
import type { z } from "zod";

/**
 * Typed fetch wrapper for the Officebox API.
 *
 * - Same-origin cookies are always sent (`credentials: "same-origin"`); the session cookie arrives in M1.
 * - State-changing requests carry `X-Officebox-Request: 1`, which the Worker requires as part of its
 *   CSRF defence (TDD §8).
 * - Every outcome is a typed `Result`; nothing here throws for an expected failure (AGENTS §4.1).
 *   TanStack Query wants query functions that throw, so `unwrap` converts a failed result into an
 *   `ApiRequestError` at that boundary only.
 */

export const CSRF_HEADER = "X-Officebox-Request";
export const DEFAULT_TIMEOUT_MS = 15_000;

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export type ApiClientError =
  /** The server answered with the standard error body (`{ error: { code, message } }`). */
  | { kind: "api"; status: number; error: ApiError }
  /** A non-2xx response without a valid error body (a proxy page, an empty 502, ...). */
  | { kind: "http"; status: number }
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
}

type Output<S> = S extends z.ZodType ? z.output<S> : undefined;

export async function apiRequest<S extends z.ZodType>(
  path: string,
  options: ApiRequestOptions<S> = {},
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
      if (parsed.success) return err({ kind: "api", status: response.status, error: parsed.data.error });
      return err({ kind: "http", status: response.status });
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
    super(describeApiError(detail));
    this.name = "ApiRequestError";
    this.detail = detail;
  }

  /** The HTTP status, when the server answered. */
  get status(): number | undefined {
    return "status" in this.detail ? this.detail.status : undefined;
  }
}

/** Returns the value or throws an `ApiRequestError`. Use inside query and mutation functions only. */
export function unwrap<T>(result: Result<T, ApiClientError>): T {
  if (result.ok) return result.value;
  throw new ApiRequestError(result.error);
}

/** A short message that is safe to show to the person. */
export function describeApiError(error: ApiClientError): string {
  switch (error.kind) {
    case "api":
      return error.error.message;
    case "http":
      return error.status >= 500
        ? "The server had a problem. Try again in a moment."
        : `The request failed (HTTP ${error.status}).`;
    case "invalid_response":
      return "The server sent an unexpected response.";
    case "network":
      return "Can't reach the server. Check your connection and try again.";
    case "timeout":
      return "The server took too long to respond. Try again.";
    case "aborted":
      return "The request was cancelled.";
  }
}

import {
  apiError,
  validationError,
  type ApiError,
  type ApiErrorBody,
  type ErrorCode,
  type Result,
  err,
  ok,
} from "@officebox/shared";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { z } from "zod";
import type { AppContext } from "./context";

/**
 * Errors as typed results (AGENTS §4.1). Services return `Result<T, ApiError>`; routes turn results
 * into responses with `respond`. This is the **single mapping** from error code to HTTP status.
 */
export const HTTP_STATUS: Readonly<Record<ErrorCode, ContentfulStatusCode>> = {
  validation_failed: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  method_not_allowed: 405,
  conflict: 409,
  gone: 410,
  payload_too_large: 413,
  rate_limited: 429,
  // A refused write, not a missing permission: 409 tells clients that retrying won't help until the
  // state (protective mode, a read-only setting) changes. (default)
  read_only: 409,
  internal: 500,
  unavailable: 503,
};

export type AppResult<T> = Result<T, ApiError>;

/** Builds the JSON error response for `error`, with the request ID and `Retry-After` when relevant. */
export function errorResponse(c: AppContext, error: ApiError): Response {
  const body: ApiErrorBody = { error, requestId: c.var.requestId };
  const headers: Record<string, string> = { "Cache-Control": "no-store" };
  if (error.code === "rate_limited" && error.retryAfterSeconds !== undefined) {
    headers["Retry-After"] = String(error.retryAfterSeconds);
  }
  return c.json(body, HTTP_STATUS[error.code], headers);
}

/** Turns a service result into a response: `value` as JSON on success, the error body otherwise. */
export function respond<T>(c: AppContext, result: AppResult<T>, status: ContentfulStatusCode = 200): Response {
  if (!result.ok) return errorResponse(c, result.error);
  return c.json(result.value ?? null, status);
}

/** The body of the 500 response for an unexpected exception; details go to the log, never the client. */
export const INTERNAL_ERROR: ApiError = apiError("internal", "Something went wrong.");

const DEFAULT_MAX_JSON_BYTES = 1024 * 1024;

/**
 * Reads and validates a JSON request body against a Zod schema from `packages/shared` (AGENTS §4.1).
 * Bodies larger than `maxBytes` are refused with `payload_too_large` before parsing.
 */
export async function readJson<S extends z.ZodType>(
  c: AppContext,
  schema: S,
  maxBytes = DEFAULT_MAX_JSON_BYTES,
): Promise<AppResult<z.infer<S>>> {
  const declared = Number(c.req.header("Content-Length") ?? "0");
  if (declared > maxBytes) return err(apiError("payload_too_large", "The request body is too large."));
  const text = await c.req.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    return err(apiError("payload_too_large", "The request body is too large."));
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return err(apiError("validation_failed", "The request body is not valid JSON."));
  }
  const parsed = schema.safeParse(value);
  return parsed.success ? ok(parsed.data) : err(validationError(parsed.error));
}

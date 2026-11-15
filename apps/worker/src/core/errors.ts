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

/**
 * Turns a service result into a response: `value` as JSON on success, the error body otherwise. API
 * responses carry user data, so neither is cached (`Cache-Control: no-store`).
 */
export function respond<T>(c: AppContext, result: AppResult<T>, status: ContentfulStatusCode = 200): Response {
  if (!result.ok) return errorResponse(c, result.error);
  return c.json(result.value ?? null, status, { "Cache-Control": "no-store" });
}

/** The body of the 500 response for an unexpected exception; details go to the log, never the client. */
export const INTERNAL_ERROR: ApiError = apiError("internal", "Something went wrong.");

const DEFAULT_MAX_JSON_BYTES = 1024 * 1024;

const TOO_LARGE: ApiError = apiError("payload_too_large", "The request body is too large.");

/**
 * Reads a request body as UTF-8 text, refusing it once more than `maxBytes` have arrived. The count
 * is kept while streaming, so a missing (chunked) or understated `Content-Length` can't make the
 * Worker buffer more than `maxBytes`. A malformed or negative `Content-Length` is refused outright.
 * The body is consumed here: read it once per request.
 */
export async function readBodyText(request: Request, maxBytes: number): Promise<AppResult<string>> {
  const header = request.headers.get("Content-Length");
  if (header !== null) {
    if (!/^\s*\d{1,15}\s*$/.test(header)) {
      return err(apiError("validation_failed", "The Content-Length header is not valid."));
    }
    if (Number(header) > maxBytes) return err(TOO_LARGE);
  }
  if (!request.body) return ok("");
  // Request bodies are byte streams; the Workers types declare the reader loosely.
  const reader = (request.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return err(TOO_LARGE);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return ok(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    return err(apiError("validation_failed", "The request body is not valid UTF-8."));
  }
}

/**
 * Reads and validates a JSON request body against a Zod schema from `packages/shared` (AGENTS §4.1).
 * The size is bounded while streaming (`readBodyText`), before anything is parsed.
 */
export async function readJson<S extends z.ZodType>(
  c: AppContext,
  schema: S,
  maxBytes = DEFAULT_MAX_JSON_BYTES,
): Promise<AppResult<z.infer<S>>> {
  const text = await readBodyText(c.req.raw, maxBytes);
  if (!text.ok) return text;
  let value: unknown;
  try {
    value = JSON.parse(text.value);
  } catch {
    return err(apiError("validation_failed", "The request body is not valid JSON."));
  }
  const parsed = schema.safeParse(value);
  return parsed.success ? ok(parsed.data) : err(validationError(parsed.error));
}

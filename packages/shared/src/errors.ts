import { z } from "zod";

/**
 * Error codes shared by the Worker and the web app. Every expected failure carries one of these.
 *
 * The list is a starting set **(default)**; features add codes here, never ad hoc strings.
 * Mapping codes to HTTP statuses lives in the Worker core (M0b).
 */
export const ERROR_CODES = [
  "validation_failed", // the request body or message failed its Zod schema
  "unauthenticated", // no valid session
  "forbidden", // signed in, but the permission engine denied the action
  "not_found",
  "conflict", // a concurrent change or a uniqueness rule
  "gone", // existed once: deleted, expired or revoked
  "payload_too_large",
  "rate_limited", // carries retryAfterSeconds (Platform §8)
  "read_only", // protective mode or a read-only setting refuses writes
  "unavailable", // a dependency is down or not configured yet
  "internal", // a real failure; details are logged, never returned
] as const;

export const errorCodeSchema = z.enum(ERROR_CODES);

export type ErrorCode = z.infer<typeof errorCodeSchema>;

/** The error carried by a typed result, and the `error` member of an API error body. */
export const apiErrorSchema = z.object({
  code: errorCodeSchema,
  /** Human-readable and safe to show; never contains secrets or internal detail. */
  message: z.string(),
  /** Field-level problems for `validation_failed`, keyed by a dotted path. */
  fields: z.record(z.string(), z.array(z.string())).optional(),
  /** Seconds until the action may be retried; set for `rate_limited`. */
  retryAfterSeconds: z.number().int().nonnegative().optional(),
});

export type ApiError = z.infer<typeof apiErrorSchema>;

/** Body of every non-2xx JSON response: `{ "error": { "code": ..., "message": ... } }`. */
export const apiErrorBodySchema = z.object({
  error: apiErrorSchema,
});

export type ApiErrorBody = z.infer<typeof apiErrorBodySchema>;

export function apiError(code: ErrorCode, message: string, extra: Omit<ApiError, "code" | "message"> = {}): ApiError {
  return { code, message, ...extra };
}

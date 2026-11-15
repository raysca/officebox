import { z } from "zod";

/**
 * Error codes shared by the Worker and the web app. Every expected failure carries one of these.
 *
 * The list is a starting set **(default)**; features add codes here, never ad hoc strings.
 * The single mapping from code to HTTP status lives in the Worker core (`apps/worker/src/core/errors.ts`).
 */
export const ERROR_CODES = [
  "validation_failed", // the request body or message failed its Zod schema, or wasn't valid JSON
  "unauthenticated", // no valid session
  "forbidden", // signed in, but the permission engine denied the action (`reason` says why)
  "reauth_required", // step-up: a sensitive action needs a passkey assertion within 10 minutes (Identity §4.5)
  "csrf_failed", // a state-changing request without X-Officebox-Request or a canonical Origin (TDD §8.2)
  "setup_required", // first-run setup has not completed: the web app goes to /setup (TDD §6.8)
  "not_found",
  "method_not_allowed", // the path exists but not with this HTTP method
  "conflict", // a concurrent change or a uniqueness rule
  "gone", // existed once: deleted, expired or revoked
  "payload_too_large",
  "rate_limited", // carries retryAfterSeconds (Platform §8)
  "read_only", // protective mode or a read-only setting refuses writes
  "unavailable", // a dependency is down or not configured yet (also: a DO schema migration failed)
  "internal", // a real failure; details are logged, never returned
] as const;

export const errorCodeSchema = z.enum(ERROR_CODES);

export type ErrorCode = z.infer<typeof errorCodeSchema>;

/** The error carried by a typed result, and the `error` member of an API error body. */
export const apiErrorSchema = z.object({
  code: errorCodeSchema,
  /**
   * A human-readable description for logs and developers. It never contains secrets or internal
   * detail, but clients don't show it to people verbatim: they map `code` to their own translatable
   * copy, with a generic fallback.
   */
  message: z.string(),
  /** Field-level problems for `validation_failed`, keyed by a dotted path (`""` for the whole value). */
  fields: z.record(z.string(), z.array(z.string())).optional(),
  /**
   * Why the permission engine refused, for `forbidden` and `reauth_required`: a `DenialReason` from
   * `permissions.ts`. Typed as a string so an older client tolerates reasons added later
   * (expand/contract); clients map known reasons to their own copy and fall back to the code's.
   */
  reason: z.string().optional(),
  /** Seconds until the action may be retried; set for `rate_limited`. */
  retryAfterSeconds: z.number().int().nonnegative().optional(),
});

export type ApiError = z.infer<typeof apiErrorSchema>;

/**
 * Body of every non-2xx JSON response: `{ "error": { "code": ..., "message": ... }, "requestId": ... }`.
 * `requestId` matches the `X-Request-Id` response header and the Worker's log lines for the request.
 */
export const apiErrorBodySchema = z.object({
  error: apiErrorSchema,
  requestId: z.string().optional(),
});

export type ApiErrorBody = z.infer<typeof apiErrorBodySchema>;

export function apiError(code: ErrorCode, message: string, extra: Omit<ApiError, "code" | "message"> = {}): ApiError {
  return { code, message, ...extra };
}

/**
 * Converts a Zod error into a `validation_failed` error with field-level messages keyed by dotted path.
 * Messages are Zod's own, which describe the expected shape and never echo the submitted value.
 */
export function validationError(error: z.ZodError, message = "The request is not valid."): ApiError {
  const fields: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const path = issue.path.map(String).join(".");
    (fields[path] ??= []).push(issue.message);
  }
  return apiError("validation_failed", message, { fields });
}

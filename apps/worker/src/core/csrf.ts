import { apiError, type ApiError } from "@officebox/shared";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "./context";
import { errorResponse } from "./errors";

/**
 * CSRF defence for API requests (TDD §8.2, Identity §4.5). On top of `SameSite=Lax` cookies, every
 * request whose method isn't GET, HEAD or OPTIONS must carry:
 *
 * - **`X-Officebox-Request: 1`.** A cross-site form can't set custom headers, and a cross-site
 *   `fetch` that sets one needs a CORS preflight, which the Worker never approves (no CORS anywhere).
 * - **An `Origin` equal to the canonical origin** (`c.var.canonicalOrigin`, set by the identity host
 *   guard once setup has been claimed), or, before the claim, to the request's own origin. Browsers
 *   send `Origin` on every non-GET request, same-origin ones included, so a missing one is refused.
 *
 * It runs **before** better-auth's handler, so better-auth's routes need the same header and Origin;
 * better-auth's own origin check runs as well and neither replaces the other. A few GET routes have
 * side effects (better-auth's passkey options routes write a challenge): their routes require the
 * header too, with {@link requireCsrfHeader}.
 *
 * A refusal is a typed `csrf_failed` result (HTTP 403), never a thrown error (AGENTS §4.1).
 */

export const CSRF_HEADER = "X-Officebox-Request";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export type CsrfFailure = "missing_header" | "missing_origin" | "origin_mismatch";

/** Why a request fails the CSRF check, or null when it passes (or is a safe method). */
export function csrfFailure(request: Request, expectedOrigin?: string): CsrfFailure | null {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return null;
  if (request.headers.get(CSRF_HEADER) !== "1") return "missing_header";
  const origin = request.headers.get("Origin");
  if (origin === null || origin === "" || origin === "null") return "missing_origin";
  return origin === (expectedOrigin ?? new URL(request.url).origin) ? null : "origin_mismatch";
}

const MESSAGES: Record<CsrfFailure, string> = {
  missing_header: `State-changing requests need the ${CSRF_HEADER} header.`,
  missing_origin: "State-changing requests need an Origin header.",
  origin_mismatch: "The request's Origin doesn't match this workspace.",
};

export function csrfError(failure: CsrfFailure): ApiError {
  return apiError("csrf_failed", MESSAGES[failure]);
}

export const csrfProtection: MiddlewareHandler<AppEnv> = async (c, next) => {
  const failure = csrfFailure(c.req.raw, c.var.canonicalOrigin);
  if (failure) {
    c.var.log.warn("csrf check failed", { failure, method: c.req.method });
    return errorResponse(c, csrfError(failure));
  }
  await next();
};

/** For GET routes with side effects: the header is required even though the method is safe. */
export function requireCsrfHeader(request: Request): CsrfFailure | null {
  return request.headers.get(CSRF_HEADER) === "1" ? null : "missing_header";
}

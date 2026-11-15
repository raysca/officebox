/**
 * Security response headers (TDD §8.2). The single source of truth: the Worker applies them to every
 * response it produces, `apps/web/public/_headers` repeats them for static assets served by Workers
 * Assets (Assets answers those without running the Worker), and the e2e smoke test checks that the
 * two agree.
 *
 * The Realtime SFU endpoints are added to `connect-src` in M4.
 */

/** CSP for the web app's documents and assets. */
export const APP_CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; " +
  "img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'";

/** CSP for API (JSON) responses: nothing may load, and nothing may frame them. */
export const API_CONTENT_SECURITY_POLICY = "default-src 'none'; frame-ancestors 'none'";

/** Headers on every response, whatever its type. */
export const COMMON_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

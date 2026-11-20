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

/**
 * CSP for user files the Worker serves (avatars from M1d; TDD §8.3): the API policy plus `sandbox`, so
 * even a file opened directly in a tab runs nothing and gets an opaque origin. A route sets exactly this
 * value and the app keeps it.
 */
export const FILE_CONTENT_SECURITY_POLICY = `${API_CONTENT_SECURITY_POLICY}; sandbox`;

/**
 * Pages whose link carries a token in the URL fragment (Identity §2, Platform §10). They're served with
 * {@link FRAGMENT_PAGE_HEADERS} instead of the usual referrer policy, by `_headers` for Workers Assets
 * and by the Worker for anything that reaches it.
 */
export const FRAGMENT_PAGES: readonly string[] = [
  "/sign-in/link",
  "/invitations/accept",
  "/auth/recover",
  "/me/email/confirm",
  "/admin/domain/complete",
];

export const FRAGMENT_PAGE_HEADERS: Readonly<Record<string, string>> = {
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};

/** Headers on every response, whatever its type. */
export const COMMON_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  // No includeSubDomains: an installation on a customer's domain mustn't force HTTPS on that
  // domain's other subdomains (TDD §8.2 asks for HSTS only).
  "Strict-Transport-Security": "max-age=31536000",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

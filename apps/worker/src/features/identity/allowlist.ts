/**
 * The better-auth route allowlist: **default-deny on the exact normalised method and path** (Identity
 * §4.4, §6; TDD §8.1). Only these endpoints of better-auth 1.7.15 are reachable from outside; every
 * other better-auth route (get-session, list and revoke sessions, list, rename and delete passkeys,
 * email and password, update user, change email, delete user, and anything a plugin or an upgrade
 * adds) answers 404. Our routes call the rest on the server through `auth.api`.
 *
 * The magic-link request (`POST /sign-in/magic-link`) joins the list in M1b.
 *
 * Matching: the path is percent-decoded, repeated slashes collapsed, a trailing slash dropped and the
 * result lower-cased; dot segments and backslashes are refused outright. A request is let through only
 * if its normalised form is on the list **and** equals the raw path exactly, so `//`, a trailing slash,
 * case changes and encoded segments all answer 404 rather than reaching better-auth in another form.
 * `HEAD` and `OPTIONS` are not listed, so they answer 404 too.
 */

export const AUTH_ALLOWLIST: ReadonlySet<string> = new Set([
  "POST /api/auth/sign-out",
  // The two options routes are GETs with side effects (a challenge cookie and a verification row):
  // the mount requires the CSRF header on them as well (M1a-0 spike, workaround 9).
  "GET /api/auth/passkey/generate-authenticate-options",
  "POST /api/auth/passkey/verify-authentication",
  "GET /api/auth/passkey/generate-register-options",
  "POST /api/auth/passkey/verify-registration",
]);

/** Normalises a path for matching, or null when it can't be decoded or holds dot segments. */
export function normalisePath(raw: string): string | null {
  let path: string;
  try {
    path = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (path.includes("\\") || path.split("/").some((segment) => segment === "." || segment === "..")) return null;
  path = path.replace(/\/{2,}/g, "/").toLowerCase();
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return path;
}

/** Whether a request to better-auth's mount may reach the handler. */
export function isAllowedAuthRoute(method: string, rawPath: string): boolean {
  const path = normalisePath(rawPath);
  return path !== null && path === rawPath && AUTH_ALLOWLIST.has(`${method} ${path}`);
}

export function isPasskeyOptionsRoute(path: string): boolean {
  return path === "/api/auth/passkey/generate-authenticate-options" || path === "/api/auth/passkey/generate-register-options";
}

export function isRegistrationRoute(path: string): boolean {
  return path === "/api/auth/passkey/generate-register-options" || path === "/api/auth/passkey/verify-registration";
}

export function isPasskeyRoute(path: string): boolean {
  return path.startsWith("/api/auth/passkey/");
}

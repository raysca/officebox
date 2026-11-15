import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppContext } from "../../core/context";
import { ACCESS_TOKEN_TTL_MS } from "./access-token";
import { KNOWN_DEVICE_COOKIE, KNOWN_DEVICE_TTL_MS } from "./known-device";
import { SESSION_TTL_MS, type IssuedSession } from "./sessions";

/**
 * Session cookies (TDD §3.1, Identity §4.5). Both are `HttpOnly`, `Secure` and `SameSite=Lax`, so
 * JavaScript can't read them and cross-site subrequests don't carry them.
 *
 * - `ob_session`: the access token, path `/`, 15 minutes.
 * - `ob_refresh`: the refresh token, 30 days, scoped to `/api/auth` **(default)**: TDD §3.1 scopes it
 *   to the refresh endpoint; the API lives under `/api`, and sign-out (`/api/auth/sign-out`) needs it
 *   too, to revoke the session even after the access token has expired.
 * - `ob_device`: the known-device marker (`known-device.ts`), 400 days, also scoped to `/api/auth`
 *   (only sign-in reads it). Signing out doesn't clear it: it marks the browser, not a session.
 */

export const SESSION_COOKIE = "ob_session";
export const REFRESH_COOKIE = "ob_refresh";
export const REFRESH_COOKIE_PATH = "/api/auth";

const base = { httpOnly: true, secure: true, sameSite: "Lax" } as const;

export function setSessionCookies(c: AppContext, session: IssuedSession): void {
  setCookie(c, SESSION_COOKIE, session.accessToken, {
    ...base,
    path: "/",
    maxAge: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
  });
  setCookie(c, REFRESH_COOKIE, session.refreshToken, {
    ...base,
    path: REFRESH_COOKIE_PATH,
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

export function clearSessionCookies(c: AppContext): void {
  deleteCookie(c, SESSION_COOKIE, { ...base, path: "/" });
  deleteCookie(c, REFRESH_COOKIE, { ...base, path: REFRESH_COOKIE_PATH });
}

export function readAccessCookie(c: AppContext): string | undefined {
  return getCookie(c, SESSION_COOKIE);
}

export function readRefreshCookie(c: AppContext): string | undefined {
  return getCookie(c, REFRESH_COOKIE);
}

export function setKnownDeviceCookie(c: AppContext, value: string): void {
  setCookie(c, KNOWN_DEVICE_COOKIE, value, {
    ...base,
    path: REFRESH_COOKIE_PATH,
    maxAge: Math.floor(KNOWN_DEVICE_TTL_MS / 1000),
  });
}

export function readKnownDeviceCookie(c: AppContext): string | undefined {
  return getCookie(c, KNOWN_DEVICE_COOKIE);
}

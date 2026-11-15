import {
  deviceSessionListSchema,
  meSchema,
  setupResultSchema,
  setupStatusSchema,
  signOutOthersResultSchema,
  type PasswordSignInBody,
  type SetupBody,
} from "@officebox/shared";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { apiRequest, unwrap } from "./client";

/**
 * Identity endpoints (Identity §6): setup, sign-in, the signed-in member and My devices. The session
 * itself lives in `HttpOnly` cookies the browser sends; nothing here stores a token.
 */

export const meQueryKey = ["me"] as const;

/** `GET /api/me`. Fails with `unauthenticated` (sign in) or `setup_required` (go to /setup). */
export const meQuery = queryOptions({
  queryKey: meQueryKey,
  queryFn: async ({ signal }) => unwrap(await apiRequest("/api/me", { schema: meSchema, signal })),
  staleTime: 5 * 60_000,
  retry: false,
});

export function useMe() {
  return useQuery(meQuery);
}

export const setupStatusQueryKey = ["setup-status"] as const;

/** `GET /api/setup`: 404 once the workspace is set up. */
export const setupStatusQuery = queryOptions({
  queryKey: setupStatusQueryKey,
  queryFn: async ({ signal }) => unwrap(await apiRequest("/api/setup", { schema: setupStatusSchema, signal })),
  retry: false,
  staleTime: Infinity,
});

export async function completeSetup(body: SetupBody) {
  return unwrap(await apiRequest("/api/setup", { method: "POST", body, schema: setupResultSchema }));
}

export async function signInWithPassword(body: PasswordSignInBody) {
  return unwrap(await apiRequest("/api/auth/password", { method: "POST", body, schema: meSchema }));
}

export async function signOut() {
  return unwrap(await apiRequest("/api/auth/sign-out", { method: "POST" }));
}

export async function signOutEverywhere() {
  return unwrap(await apiRequest("/api/auth/sign-out-everywhere", { method: "POST" }));
}

export const devicesQueryKey = ["me", "sessions"] as const;

export const devicesQuery = queryOptions({
  queryKey: devicesQueryKey,
  queryFn: async ({ signal }) =>
    unwrap(await apiRequest("/api/me/sessions", { schema: deviceSessionListSchema, signal })).sessions,
});

export async function signOutDevice(sessionId: string) {
  return unwrap(await apiRequest(`/api/me/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" }));
}

export async function signOutOtherDevices() {
  return unwrap(
    await apiRequest("/api/me/sessions/sign-out-others", { method: "POST", schema: signOutOthersResultSchema }),
  );
}

import {
  ackSecurityNoticesResultSchema,
  deviceSessionListSchema,
  err,
  meSchema,
  ok,
  passkeyListSchema,
  passkeySummarySchema,
  reauthResultSchema,
  securityNoticeListSchema,
  setupEnrolmentSchema,
  setupStatusSchema,
  signedOutCountSchema,
  type Result,
  type SetupBody,
} from "@officebox/shared";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { apiRequest, CSRF_HEADER, unwrap, type ApiClientError } from "./client";
import { assertPasskey, createPasskey, type CeremonyError } from "./webauthn";

/**
 * Identity endpoints (Identity §6): setup, passkey sign-in and registration (better-auth's routes behind
 * our allowlist), step-up, the signed-in member, passkeys, My devices and the security-notice banner.
 * The session lives in an `HttpOnly` cookie the browser sends; nothing here stores a token.
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

export async function claimSetup(body: SetupBody) {
  return unwrap(await apiRequest("/api/setup", { method: "POST", body, schema: setupEnrolmentSchema }));
}

export async function resumeSetup(token: string) {
  return unwrap(
    await apiRequest("/api/setup/resume", { method: "POST", body: { token }, schema: setupEnrolmentSchema }),
  );
}

/** better-auth's WebAuthn options are passed straight to the browser; only the envelope is checked. */
const optionsSchema = z.looseObject({ challenge: z.string() });

/** A ceremony fails in the browser (cancelled, unsupported) or at the server (a typed API error). */
export type PasskeyFailure = { kind: "ceremony"; reason: CeremonyError } | { kind: "api"; error: ApiClientError };

async function ceremony(
  optionsPath: string,
  verifyPath: string,
  run: (options: unknown) => Promise<Result<unknown, CeremonyError>>,
  optionsMethod: "GET" | "POST" = "GET",
): Promise<Result<void, PasskeyFailure>> {
  const options = await apiRequest(optionsPath, {
    method: optionsMethod,
    body: optionsMethod === "POST" ? {} : undefined,
    schema: optionsSchema,
    // The options routes are GETs with side effects: the Worker requires the CSRF header on them too.
    headers: { [CSRF_HEADER]: "1" },
  });
  if (!options.ok) return err({ kind: "api", error: options.error });
  const response = await run(options.value);
  if (!response.ok) return err({ kind: "ceremony", reason: response.error });
  const verified = await apiRequest(verifyPath, { method: "POST", body: { response: response.value } });
  return verified.ok ? ok() : err({ kind: "api", error: verified.error });
}

/** Sign in with a discoverable passkey (Identity §4.4). */
export function signInWithPasskey(): Promise<Result<void, PasskeyFailure>> {
  return ceremony(
    "/api/auth/passkey/generate-authenticate-options",
    "/api/auth/passkey/verify-authentication",
    assertPasskey,
  );
}

/**
 * Register a passkey: the first one with the enrolment ticket cookie (setup), or another one while
 * signed in (step-up first, which the client handles on `reauth_required`).
 */
export function registerPasskey(): Promise<Result<void, PasskeyFailure>> {
  return ceremony(
    "/api/auth/passkey/generate-register-options",
    "/api/auth/passkey/verify-registration",
    createPasskey,
  );
}

/** Step-up: confirm with a passkey for the signed-in member (Identity §4.5). Never retried itself. */
export async function reauthenticate(): Promise<Result<void, PasskeyFailure>> {
  const options = await apiRequest("/api/me/reauth/options", {
    method: "POST",
    body: {},
    schema: optionsSchema,
    reauth: false,
  });
  if (!options.ok) return err({ kind: "api", error: options.error });
  const response = await assertPasskey(options.value);
  if (!response.ok) return err({ kind: "ceremony", reason: response.error });
  const verified = await apiRequest("/api/me/reauth", {
    method: "POST",
    body: { response: response.value },
    schema: reauthResultSchema,
    reauth: false,
  });
  return verified.ok ? ok() : err({ kind: "api", error: verified.error });
}

export async function signOut() {
  return unwrap(await apiRequest("/api/auth/sign-out", { method: "POST", body: {} }));
}

export async function signOutEverywhere() {
  return unwrap(await apiRequest("/api/me/sessions/sign-out-everywhere", { method: "POST", body: {} }));
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
    await apiRequest("/api/me/sessions/sign-out-others", { method: "POST", body: {}, schema: signedOutCountSchema }),
  );
}

export const passkeysQueryKey = ["me", "passkeys"] as const;

export const passkeysQuery = queryOptions({
  queryKey: passkeysQueryKey,
  queryFn: async ({ signal }) =>
    unwrap(await apiRequest("/api/me/passkeys", { schema: passkeyListSchema, signal })).passkeys,
});

export async function renamePasskey({ id, name }: { id: string; name: string }) {
  return unwrap(
    await apiRequest(`/api/me/passkeys/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: { name },
      schema: passkeySummarySchema,
    }),
  );
}

export async function removePasskey(id: string) {
  return unwrap(await apiRequest(`/api/me/passkeys/${encodeURIComponent(id)}`, { method: "DELETE" }));
}

export const noticesQueryKey = ["me", "security-notices"] as const;

export const noticesQuery = queryOptions({
  queryKey: noticesQueryKey,
  queryFn: async ({ signal }) =>
    unwrap(await apiRequest("/api/me/security-notices", { schema: securityNoticeListSchema, signal })).notices,
});

export async function acknowledgeNotices(ids?: string[]) {
  return unwrap(
    await apiRequest("/api/me/security-notices/ack", {
      method: "POST",
      body: ids ? { ids } : {},
      schema: ackSecurityNoticesResultSchema,
    }),
  );
}

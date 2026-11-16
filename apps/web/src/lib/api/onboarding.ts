import {
  acceptInvitationResultSchema,
  invitationLookupSchema,
  magicLinkConfirmResultSchema,
  magicLinkLookupSchema,
  publicStatusSchema,
  type AcceptInvitationBody,
} from "@officebox/shared";
import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import { apiRequest, unwrap } from "./client";

/**
 * Signed-out identity endpoints added in M1b (Identity §4.3, §4.4, §6): the public status (whether
 * "Email me a sign-in link" is offered), the magic-link request and confirmation, and the invitee's
 * side of an invitation. Tokens travel only in JSON bodies; pages read them from the URL fragment.
 */

export const publicStatusQueryKey = ["status", "public"] as const;

export const publicStatusQuery = queryOptions({
  queryKey: publicStatusQueryKey,
  queryFn: async ({ signal }) => unwrap(await apiRequest("/api/status/public", { schema: publicStatusSchema, signal })),
  staleTime: 30_000,
  retry: false,
});

/** The answer is the same whatever the email; mail goes only to active members (Identity §4.4). */
export async function requestMagicLink(email: string) {
  return unwrap(
    await apiRequest("/api/auth/sign-in/magic-link", {
      method: "POST",
      body: { email },
      schema: z.looseObject({ status: z.boolean() }),
    }),
  );
}

export async function lookupMagicLink(token: string) {
  return unwrap(
    await apiRequest("/api/sign-in/link/lookup", { method: "POST", body: { token }, schema: magicLinkLookupSchema }),
  );
}

export async function confirmMagicLink(token: string) {
  return unwrap(
    await apiRequest("/api/sign-in/link", { method: "POST", body: { token }, schema: magicLinkConfirmResultSchema }),
  );
}

export async function lookupInvitation(token: string) {
  return unwrap(
    await apiRequest("/api/invitations/lookup", { method: "POST", body: { token }, schema: invitationLookupSchema }),
  );
}

export async function acceptInvitation(body: AcceptInvitationBody) {
  return unwrap(
    await apiRequest("/api/invitations/accept", { method: "POST", body, schema: acceptInvitationResultSchema }),
  );
}

/**
 * Reads the token from the URL fragment (`#t=…`) and removes the fragment from the address bar and
 * history straight away (Identity §2 "Tokens in links"), so it isn't left in the history or shared by
 * accident. Returns null when there's none.
 */
export function takeFragmentToken(): string | null {
  const hash = window.location.hash;
  const path = window.location.pathname;
  if (hash === "") {
    // Read again on the same page (React may run an initializer twice): the token already taken.
    return taken?.path === path ? taken.token : null;
  }
  const token = /^#t=([A-Za-z0-9_-]{16,128})$/.exec(hash)?.[1] ?? null;
  window.history.replaceState(window.history.state, "", path + window.location.search);
  taken = { path, token };
  return token;
}

let taken: { path: string; token: string | null } | null = null;

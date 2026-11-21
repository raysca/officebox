import {
  adminMemberListSchema,
  domainStatusSchema,
  emailChangeResultSchema,
  recoveryLinkResultSchema,
  startDomainMoveResultSchema,
  createInvitationResultSchema,
  invitationLinkSchema,
  invitationListSchema,
  resendInvitationResultSchema,
  sendTestEmailResultSchema,
  settingsListSchema,
  memberChangeResultSchema,
  memberDeletedResultSchema,
  signedOutCountSchema,
  type AdminMembersQuery,
  type AssignableRole,
  type CreateInvitationBody,
} from "@officebox/shared";
import { keepPreviousData, queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import { apiRequest, unwrap } from "./client";

/**
 * The admin area's M1b endpoints (Admin §3, §6; Identity §6; Platform §15): settings (with the email
 * status), Send test email, and invitations. The Worker asks the permission engine on every call.
 */

export const settingsQueryKey = ["admin", "settings"] as const;

export const settingsQuery = queryOptions({
  queryKey: settingsQueryKey,
  queryFn: async ({ signal }) =>
    unwrap(await apiRequest("/api/admin/settings", { schema: settingsListSchema, signal })),
});

export async function patchSetting({ key, value }: { key: string; value: unknown }) {
  return unwrap(
    await apiRequest("/api/admin/settings", {
      method: "PATCH",
      body: { key, value },
      schema: z.looseObject({ key: z.string() }),
    }),
  );
}

export async function sendTestEmail() {
  return unwrap(
    await apiRequest("/api/admin/email/test", { method: "POST", body: {}, schema: sendTestEmailResultSchema }),
  );
}

export const invitationsQueryKey = ["admin", "invitations"] as const;

export const invitationsQuery = queryOptions({
  queryKey: invitationsQueryKey,
  queryFn: async ({ signal }) =>
    unwrap(await apiRequest("/api/admin/invitations", { schema: invitationListSchema, signal })).invitations,
});

export async function createInvitation(body: CreateInvitationBody) {
  return unwrap(
    await apiRequest("/api/admin/invitations", { method: "POST", body, schema: createInvitationResultSchema }),
  );
}

export async function copyInvitationLink(id: string) {
  return unwrap(
    await apiRequest(`/api/admin/invitations/${encodeURIComponent(id)}/link`, { schema: invitationLinkSchema }),
  ).link;
}

export async function resendInvitation(id: string) {
  return unwrap(
    await apiRequest(`/api/admin/invitations/${encodeURIComponent(id)}/resend`, {
      method: "POST",
      body: {},
      schema: resendInvitationResultSchema,
    }),
  );
}

export async function revokeInvitation(id: string) {
  return unwrap(await apiRequest(`/api/admin/invitations/${encodeURIComponent(id)}`, { method: "DELETE" }));
}

// ---- Members (M1c's subset: Identity §4.6, §4.11) ----------------------------------------------

export const membersQueryKey = ["admin", "members"] as const;

export const membersQuery = membersQueryFor({});

/** The member list with Admin §5's search and filters (M1e). */
export function membersQueryFor(filters: AdminMembersQuery) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (typeof value === "string" && value.trim() !== "") params.set(key, value.trim());
  }
  const query = params.toString();
  return queryOptions({
    queryKey: [...membersQueryKey, query] as const,
    queryFn: async ({ signal }) =>
      unwrap(
        await apiRequest(`/api/admin/members${query ? `?${query}` : ""}`, { schema: adminMemberListSchema, signal }),
      ).members,
    placeholderData: keepPreviousData,
  });
}

const memberPath = (id: string, rest = "") => `/api/admin/members/${encodeURIComponent(id)}${rest}`;

/** Step-up first: the client asks for a passkey on `reauth_required` and retries. */
export async function issueRecoveryLink(memberId: string) {
  return unwrap(
    await apiRequest(memberPath(memberId, "/recovery-link"), {
      method: "POST",
      body: {},
      schema: recoveryLinkResultSchema,
    }),
  );
}

export async function changeMemberEmail({ id, email }: { id: string; email: string }) {
  return unwrap(
    await apiRequest(memberPath(id), { method: "PATCH", body: { email }, schema: emailChangeResultSchema }),
  );
}

/** Owners only, with step-up (the client asks for a passkey on `reauth_required` and retries). */
export async function changeMemberRole({ id, role }: { id: string; role: AssignableRole }) {
  return unwrap(
    await apiRequest(memberPath(id), { method: "PATCH", body: { role }, schema: memberChangeResultSchema }),
  );
}

export async function setMemberStatus({ id, status }: { id: string; status: "active" | "disabled" }) {
  return unwrap(
    await apiRequest(memberPath(id), { method: "PATCH", body: { status }, schema: memberChangeResultSchema }),
  );
}

export async function signOutMember(id: string) {
  return unwrap(
    await apiRequest(memberPath(id, "/sign-out"), { method: "POST", body: {}, schema: signedOutCountSchema }),
  );
}

export async function deleteMember(id: string) {
  return unwrap(await apiRequest(memberPath(id), { method: "DELETE", schema: memberDeletedResultSchema }));
}

export async function acknowledgeReset(memberId: string) {
  return unwrap(await apiRequest(memberPath(memberId, "/acknowledge-reset"), { method: "POST", body: {} }));
}

// ---- The domain move (M1c: Identity §4.4) ------------------------------------------------------

export const domainQueryKey = ["admin", "domain"] as const;

export const domainQuery = queryOptions({
  queryKey: domainQueryKey,
  queryFn: async ({ signal }) => unwrap(await apiRequest("/api/admin/domain", { schema: domainStatusSchema, signal })),
});

export async function startDomainMove(origin: string) {
  return unwrap(
    await apiRequest("/api/admin/domain", { method: "POST", body: { origin }, schema: startDomainMoveResultSchema }),
  );
}

export async function cancelDomainMove() {
  return unwrap(await apiRequest("/api/admin/domain/pending", { method: "DELETE" }));
}

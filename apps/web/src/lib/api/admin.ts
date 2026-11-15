import {
  createInvitationResultSchema,
  invitationLinkSchema,
  invitationListSchema,
  resendInvitationResultSchema,
  sendTestEmailResultSchema,
  settingsListSchema,
  type CreateInvitationBody,
} from "@officebox/shared";
import { queryOptions } from "@tanstack/react-query";
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

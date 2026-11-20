import {
  completeDomainMoveResultSchema,
  emailChangeConfirmResultSchema,
  emailChangeLookupSchema,
  recoveryEnrolmentSchema,
  recoveryLookupSchema,
  type OwnerRecoveryBody,
} from "@officebox/shared";
import { apiRequest, unwrap } from "./client";

/**
 * Signed-out M1c endpoints (Identity §4.4, §4.6, §4.11, §6): recovery links, owner recovery with
 * `RECOVERY_TOKEN`, the email-change confirmation and the domain move's commit step. Tokens travel only
 * in JSON bodies; the pages read them from the URL fragment. Each POST that issues an enrolment ticket
 * sets it as an HttpOnly cookie, never in the body.
 */

export async function lookupRecoveryLink(token: string) {
  return unwrap(
    await apiRequest("/api/auth/recover/lookup", { method: "POST", body: { token }, schema: recoveryLookupSchema }),
  );
}

export async function openRecoveryLink(token: string) {
  return unwrap(
    await apiRequest("/api/auth/recover", { method: "POST", body: { token }, schema: recoveryEnrolmentSchema }),
  );
}

export async function recoverOwner(body: OwnerRecoveryBody) {
  return unwrap(await apiRequest("/api/recover", { method: "POST", body, schema: recoveryEnrolmentSchema }));
}

export async function lookupEmailChange(token: string) {
  return unwrap(
    await apiRequest("/api/me/email/confirm/lookup", {
      method: "POST",
      body: { token },
      schema: emailChangeLookupSchema,
    }),
  );
}

export async function confirmEmailChange(token: string) {
  return unwrap(
    await apiRequest("/api/me/email/confirm", {
      method: "POST",
      body: { token },
      schema: emailChangeConfirmResultSchema,
    }),
  );
}

export async function openDomainMoveLink(token: string) {
  return unwrap(
    await apiRequest("/api/admin/domain/complete", {
      method: "POST",
      body: { token },
      schema: completeDomainMoveResultSchema,
    }),
  );
}

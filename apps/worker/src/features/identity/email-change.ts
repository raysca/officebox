import {
  apiError,
  EMAIL_CHANGE_TTL_MS,
  err,
  normaliseEmail,
  ok,
  type ApiError,
  type EmailChangeLookup,
  type EmailChangeResult,
  type Result,
} from "@officebox/shared";
import { z } from "zod";
import { auditStatement } from "../../core/audit";
import type { CoreContext } from "../../core/context";
import { Database, expectOk } from "../../core/db";
import { isEmailConfigured } from "../email/config";
import { enqueueEmail } from "../email/delivery";
import { emailChangeEmail } from "../email/templates";
import { displayNameOf } from "./account-security";
import { randomToken, tokenHash } from "./crypto";
import type { ClaimedInstallation } from "./installation";
import { emailSecurityNotices, type RaisedNotice } from "./notice-email";
import { noticeStatement } from "./notices";
import type { IdentitySecrets } from "./secrets";

/**
 * Email changes (Identity §4.11, §6; Permissions §6; Platform §10; M1c). Admins change members'
 * addresses; owners anyone's (the permission engine's `member.change_email`, with step-up). Email changes
 * go through our route only: better-auth's change-email endpoint isn't exposed.
 *
 * - **With email configured**, the new (normalised) address is held in an `email_change` token's payload
 *   (`auth_tokens`, 24 hours, single-use) and a confirmation link goes to the new address
 *   (`/me/email/confirm#t=…`, canonical origin). Only the confirmation page's POST applies it,
 *   consuming the token by compare-and-set. A newer change revokes an older pending one.
 * - **Without email** there is nobody to confirm with, so the change applies at once **(default)**.
 *
 * **Applying** a change, in one batch: the user row moves only if it still has the address the change
 * was made from (compare-and-set) and nobody else has taken the new one (the unique indexes); the
 * person's pending magic links (by the old normalised email and by user) and their recovery links,
 * email-change links and enrolment tickets are revoked; a `email_changed` notice joins their banner list;
 * the change is audited. The **old** address is then emailed (when email is configured).
 */

const GONE: ApiError = apiError("gone", "This confirmation link isn't valid any more. Ask for the change again.", {
  reason: "email_change_invalid",
});

function emailTaken(): ApiError {
  const message = "Another account already uses this email.";
  return apiError("conflict", message, { reason: "email_taken", fields: { email: [message] } });
}

const payloadSchema = z.object({ newEmail: z.string(), fromNormalised: z.string().nullable().default(null) });

export function emailChangeLink(canonicalOrigin: string, token: string): string {
  return `${new URL("/me/email/confirm", canonicalOrigin).toString()}#t=${token}`;
}

interface PersonRow {
  id: string;
  email: string | null;
  email_normalised: string | null;
  status: string;
}

async function person(db: D1Database, userId: string): Promise<PersonRow | null> {
  return expectOk(
    await new Database(db).first<PersonRow>(
      "SELECT id, email, email_normalised, status FROM users WHERE id = ?",
      userId,
    ),
  );
}

async function addressTaken(db: D1Database, normalised: string, exceptId: string): Promise<boolean> {
  const row = expectOk(
    await new Database(db).first<{ one: number }>(
      "SELECT 1 AS one FROM users WHERE email_normalised = ? AND id != ?",
      normalised,
      exceptId,
    ),
  );
  return row !== null;
}

/** `PATCH /admin/members/:id { email }`. The route has authorized `member.change_email` for the target. */
export async function changeEmail(
  ctx: CoreContext,
  secrets: IdentitySecrets,
  installation: ClaimedInstallation,
  actorId: string,
  targetId: string,
  rawEmail: string,
): Promise<Result<EmailChangeResult, ApiError>> {
  const target = await person(ctx.env.DB, targetId);
  if (!target) return err(apiError("not_found", "No such member."));
  if (target.status !== "active" || !target.email) {
    return err(
      apiError("conflict", "This person's account is disabled. Re-enable it first.", { reason: "member_disabled" }),
    );
  }
  const newEmail = rawEmail.trim();
  const normalised = normaliseEmail(newEmail);
  if (normalised === target.email_normalised) {
    const message = "That's already this person's email.";
    return err(apiError("validation_failed", message, { reason: "email_unchanged", fields: { email: [message] } }));
  }
  if (await addressTaken(ctx.env.DB, normalised, target.id)) return err(emailTaken());

  if (!(await isEmailConfigured(ctx))) {
    // Nobody to confirm with: the change applies at once (default).
    const applied = await applyEmailChange(ctx, {
      userId: target.id,
      actorId,
      newEmail,
      fromNormalised: target.email_normalised,
      oldEmail: target.email,
    });
    return applied.ok ? ok({ status: "changed", email: newEmail }) : applied;
  }

  const now = ctx.now();
  const token = randomToken(32);
  const expiresAt = now + EMAIL_CHANGE_TTL_MS;
  const database = new Database(ctx.env.DB);
  const actorName = await displayNameOf(ctx.env.DB, actorId, "An admin");
  expectOk(
    await database.batchRun([
      // One pending change at a time: a newer change revokes the older link.
      database.statement(
        `UPDATE auth_tokens SET revoked_at = ?
          WHERE user_id = ? AND kind = 'email_change' AND used_at IS NULL AND revoked_at IS NULL`,
        now,
        target.id,
      ),
      database.statement(
        `INSERT INTO auth_tokens (token_hash, user_id, kind, issued_by, payload, expires_at, created_at)
         VALUES (?, ?, 'email_change', ?, ?, ?, ?)`,
        await tokenHash(secrets.tokenHashKey, token),
        target.id,
        actorId,
        JSON.stringify({ newEmail, fromNormalised: target.email_normalised }),
        expiresAt,
        now,
      ),
      await auditStatement(ctx, {
        action: "member.email_change_requested",
        actor: actorId,
        target: { type: "user", id: target.id },
        metadata: { newEmail },
      }),
    ]),
  );
  const rendered = emailChangeEmail({
    workspace: installation.workspaceName,
    newEmail,
    actorName,
    link: emailChangeLink(installation.canonicalOrigin, token),
    expiresAt,
  });
  const queued = await enqueueEmail(ctx, { kind: "email_change", to: newEmail, ...rendered, expiresAt });
  if (!queued.ok) {
    // The link exists but couldn't be sent: say so, so the admin can try again (the next try revokes it).
    ctx.log.warn("email change confirmation not queued", { targetId: target.id });
    return err(
      apiError("unavailable", "The confirmation email couldn't be sent right now. Try again.", {
        reason: "email_unavailable",
      }),
    );
  }
  ctx.log.info("email change requested", { targetId: target.id });
  return ok({ status: "pending_confirmation", email: newEmail });
}

interface ApplyInput {
  userId: string;
  actorId: string | null;
  newEmail: string;
  /** The normalised address the change was made from: the update applies only if it's still current. */
  fromNormalised: string | null;
  oldEmail: string;
}

async function applyEmailChange(ctx: CoreContext, input: ApplyInput): Promise<Result<null, ApiError>> {
  const database = new Database(ctx.env.DB);
  const now = ctx.now();
  const normalised = normaliseEmail(input.newEmail);
  const actorName = await displayNameOf(ctx.env.DB, input.actorId, "An admin");
  const notice: RaisedNotice = {
    userId: input.userId,
    kind: "email_changed",
    details: { newEmail: input.newEmail, actorName },
    at: now,
    // The old address is told (Identity §4.11; Notifications §3).
    to: input.oldEmail,
  };
  // Every revocation in the batch applies only if the user update did (the row now has the new address
  // and this call's timestamp), so a change that lost a race revokes nothing.
  const applied = `EXISTS (SELECT 1 FROM users WHERE id = ?2 AND email_normalised = ?3 AND updated_at = ?1)`;
  const result = await database.batchRun([
    database.statement(
      `UPDATE users SET email = ?1, email_normalised = ?2, updated_at = ?3
        WHERE id = ?4 AND status = 'active' AND email_normalised IS ?5
          AND NOT EXISTS (SELECT 1 FROM users other WHERE other.email_normalised = ?2 AND other.id != ?4)`,
      input.newEmail,
      normalised,
      now,
      input.userId,
      input.fromNormalised,
    ),
    await auditStatement(
      ctx,
      {
        action: "member.email_changed",
        actor: input.actorId,
        target: { type: "user", id: input.userId },
        metadata: { newEmail: input.newEmail },
      },
      { onlyIfPreviousChanged: true },
    ),
    // Pending magic links by the old address and by user; recovery links, email-change links and
    // enrolment tickets (Identity §4.11: "all pending magic links and recovery tokens are revoked").
    database.statement(
      `UPDATE magic_link_issues SET revoked_at = ?1
        WHERE (user_id = ?2 OR email_normalised = ?4) AND consumed_at IS NULL AND revoked_at IS NULL AND ${applied}`,
      now,
      input.userId,
      normalised,
      input.fromNormalised ?? "",
    ),
    database.statement(
      `UPDATE auth_tokens SET revoked_at = ?1
        WHERE user_id = ?2 AND used_at IS NULL AND revoked_at IS NULL
          AND kind IN ('recovery', 'email_change', 'passkey_enrol') AND ${applied}`,
      now,
      input.userId,
      normalised,
    ),
  ]);
  if (!result.ok) {
    if (result.error.kind === "unique") return err(emailTaken());
    return err(result.error.error);
  }
  if ((result.value[0]?.changes ?? 0) !== 1) {
    // The address changed since, or someone else took the new one.
    if (await addressTaken(ctx.env.DB, normalised, input.userId)) return err(emailTaken());
    return err(GONE);
  }
  expectOk(await database.batchRun([noticeStatement(database, notice.userId, notice.kind, notice.details, notice.at)]));
  await emailSecurityNotices(ctx, [notice]);
  ctx.log.info("email changed", { userId: input.userId });
  return ok(null);
}

interface TokenRow {
  user_id: string;
  issued_by: string | null;
  payload: string | null;
}

function parsePayload(raw: string | null): z.infer<typeof payloadSchema> | null {
  if (!raw) return null;
  try {
    const parsed = payloadSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** `POST /me/email/confirm/lookup`: the new address and workspace, without using the link. */
export async function lookupEmailChange(
  ctx: CoreContext,
  secrets: IdentitySecrets,
  installation: ClaimedInstallation,
  token: string,
): Promise<Result<EmailChangeLookup, ApiError>> {
  const row = expectOk(
    await new Database(ctx.env.DB).first<TokenRow>(
      `SELECT t.user_id, t.issued_by, t.payload FROM auth_tokens t JOIN users u ON u.id = t.user_id
        WHERE t.token_hash = ? AND t.kind = 'email_change' AND t.used_at IS NULL AND t.revoked_at IS NULL
          AND t.expires_at > ? AND u.status = 'active'`,
      await tokenHash(secrets.tokenHashKey, token),
      ctx.now(),
    ),
  );
  const payload = parsePayload(row?.payload ?? null);
  if (!row || !payload) return err(GONE);
  return ok({ newEmail: payload.newEmail, workspaceName: installation.workspaceName });
}

/** `POST /me/email/confirm`: consumes the link by compare-and-set, then applies the change, once. */
export async function confirmEmailChange(
  ctx: CoreContext,
  secrets: IdentitySecrets,
  token: string,
): Promise<Result<{ email: string }, ApiError>> {
  const now = ctx.now();
  const consumed = expectOk(
    await new Database(ctx.env.DB).first<TokenRow>(
      `UPDATE auth_tokens SET used_at = ?1
        WHERE token_hash = ?2 AND kind = 'email_change' AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?1
          AND EXISTS (SELECT 1 FROM users WHERE id = auth_tokens.user_id AND status = 'active')
        RETURNING user_id, issued_by, payload`,
      now,
      await tokenHash(secrets.tokenHashKey, token),
    ),
  );
  const payload = parsePayload(consumed?.payload ?? null);
  if (!consumed || !payload) return err(GONE);
  const current = await person(ctx.env.DB, consumed.user_id);
  if (!current?.email) return err(GONE);
  const applied = await applyEmailChange(ctx, {
    userId: consumed.user_id,
    actorId: consumed.issued_by,
    newEmail: payload.newEmail,
    fromNormalised: payload.fromNormalised ?? current.email_normalised,
    oldEmail: current.email,
  });
  return applied.ok ? ok({ email: payload.newEmail }) : applied;
}

import {
  apiError,
  err,
  normaliseEmail,
  ok,
  RECOVERY_LINK_TTL_MS,
  type ApiError,
  type OwnerRecoveryBody,
  type RecoveryLinkResult,
  type RecoveryLookup,
  type Result,
} from "@officebox/shared";
import { audit, auditStatement } from "../../core/audit";
import type { CoreContext } from "../../core/context";
import { Database, expectOk } from "../../core/db";
import { isEmailConfigured } from "../email/config";
import { displayNameOf, revokeLinksStatements, revokeUserSessions } from "./account-security";
import { randomToken, sha256, timingSafeEqual, tokenHash } from "./crypto";
import { issueTicket, type IssuedTicket } from "./enrolment";
import type { ClaimedInstallation } from "./installation";
import { readDeviceCookie } from "./known-devices";
import { emailSecurityNotices, type RaisedNotice } from "./notice-email";
import { noticeStatement } from "./notices";
import type { IdentitySecrets } from "./secrets";

/**
 * Account recovery (Identity §4.6; Permissions §6; Platform §10, §16; M1c). There are no passwords, so
 * recovery always means **registering a new passkey** through an enrolment ticket.
 *
 * **Recovery links** (`POST /admin/members/:id/recovery-link`, {@link issueRecoveryLink}): issued by an
 * admin for members, by an owner for anyone (the permission engine's `member.issue_recovery_link`, with
 * step-up). 32 random bytes, stored as HMAC(TOKEN_HASH_KEY) in `auth_tokens` (`kind = 'recovery'`),
 * valid for 24 hours, built from the canonical origin with the token in the fragment
 * (`/auth/recover#t=…`). Issuing one revokes the person's other pending magic links and recovery
 * links, adds a `recovery_link_issued` notice to their banner list (emailed to their current address
 * when email is configured) and is audited. **Without email** the member is also flagged to every
 * owner (`users.admin_reset_*`) until an owner acknowledges it, and the sign-in page warns them.
 *
 * **Using one** (`POST /auth/recover`, {@link useRecoveryLink}) signs out every session of the person
 * (closing their sockets), revokes their other enrolment tickets and sets a new one, linked to the
 * link. It can be **resumed until a passkey is registered with it**: the registration's after hook
 * marks the link used ({@link markRecoveryLinkUsedStatement}), after which it answers 410.
 *
 * **Owner recovery** (`POST /recover`, {@link recoverOwner}) with the `RECOVERY_TOKEN` secret (at least
 * 32 characters), for one active owner named by email: compared in constant time, limited per IP by the
 * route, and **consumed** by inserting the secret's hash into `recovery_token_uses` (its primary key is
 * the compare-and-set), so one value works once. It signs that owner out everywhere, revokes their other
 * enrolment tickets, sets a new one, is audited and notifies the **other** owners.
 */

const GONE: ApiError = apiError("gone", "This recovery link isn't valid any more. Ask an admin for a new one.", {
  reason: "recovery_link_invalid",
});

export function recoveryLinkUrl(canonicalOrigin: string, token: string): string {
  return `${new URL("/auth/recover", canonicalOrigin).toString()}#t=${token}`;
}

interface TargetRow {
  id: string;
  email: string | null;
  email_normalised: string | null;
  status: string;
}

/** Issues a recovery link. The route has already authorized `member.issue_recovery_link` for the target. */
export async function issueRecoveryLink(
  ctx: CoreContext,
  secrets: IdentitySecrets,
  installation: ClaimedInstallation,
  actorId: string,
  targetId: string,
): Promise<Result<RecoveryLinkResult, ApiError>> {
  const database = new Database(ctx.env.DB);
  const target = expectOk(
    await database.first<TargetRow>("SELECT id, email, email_normalised, status FROM users WHERE id = ?", targetId),
  );
  if (!target) return err(apiError("not_found", "No such member."));
  if (target.status !== "active" || !target.email) {
    // A disabled member can't sign in, so a link would only mislead (default): re-enable them first.
    return err(
      apiError("conflict", "This person's account is disabled. Re-enable it first.", { reason: "member_disabled" }),
    );
  }
  const now = ctx.now();
  const token = randomToken(32);
  const hash = await tokenHash(secrets.tokenHashKey, token);
  const expiresAt = now + RECOVERY_LINK_TTL_MS;
  const emailConfigured = await isEmailConfigured(ctx);
  const actorName = await displayNameOf(ctx.env.DB, actorId, "An admin");
  const notice: RaisedNotice = {
    userId: target.id,
    kind: "recovery_link_issued",
    details: { actorName },
    at: now,
  };
  const statements = [
    // Issuing one revokes the person's other pending magic links and recovery links (Identity §4.6).
    ...revokeLinksStatements(database, {
      userId: target.id,
      emailNormalised: target.email_normalised,
      kinds: ["recovery"],
      now,
    }),
    database.statement(
      `INSERT INTO auth_tokens (token_hash, user_id, kind, issued_by, payload, expires_at, created_at)
       VALUES (?, ?, 'recovery', ?, NULL, ?, ?)`,
      hash,
      target.id,
      actorId,
      expiresAt,
      now,
    ),
    noticeStatement(database, notice.userId, notice.kind, notice.details, notice.at),
    await auditStatement(ctx, {
      action: "member.recovery_link_issued",
      actor: actorId,
      target: { type: "user", id: target.id },
      metadata: { emailed: emailConfigured, flagged: !emailConfigured },
    }),
  ];
  if (!emailConfigured) {
    // Loudly flagged without email (Identity §2, §4.6): every owner sees it until one acknowledges it.
    statements.push(
      database.statement(
        "UPDATE users SET admin_reset_at = ?, admin_reset_by = ?, admin_reset_acknowledged_by = NULL WHERE id = ?",
        now,
        actorId,
        target.id,
      ),
    );
  }
  expectOk(await database.batchRun(statements));
  // To the person's current address, when email is configured (Identity §4.6).
  await emailSecurityNotices(ctx, [notice]);
  ctx.log.info("recovery link issued", { targetId: target.id, flagged: !emailConfigured });
  return ok({
    link: recoveryLinkUrl(installation.canonicalOrigin, token),
    expiresAt,
    notifiedByEmail: emailConfigured,
    flagged: !emailConfigured,
  });
}

interface LinkRow {
  user_id: string;
  email: string | null;
}

/** A recovery link that is unused, unrevoked and unexpired, for an active account; null otherwise. */
async function validLink(ctx: CoreContext, hash: string): Promise<LinkRow | null> {
  return expectOk(
    await new Database(ctx.env.DB).first<LinkRow>(
      `SELECT t.user_id, u.email FROM auth_tokens t JOIN users u ON u.id = t.user_id
        WHERE t.token_hash = ? AND t.kind = 'recovery' AND t.used_at IS NULL AND t.revoked_at IS NULL
          AND t.expires_at > ? AND u.status = 'active' AND u.email IS NOT NULL`,
      hash,
      ctx.now(),
    ),
  );
}

/** `POST /auth/recover/lookup`: the account's email for the confirmation page, without using the link. */
export async function lookupRecoveryLink(
  ctx: CoreContext,
  secrets: IdentitySecrets,
  installation: ClaimedInstallation,
  token: string,
): Promise<Result<RecoveryLookup, ApiError>> {
  const row = await validLink(ctx, await tokenHash(secrets.tokenHashKey, token));
  if (!row?.email) return err(GONE);
  return ok({ email: row.email, workspaceName: installation.workspaceName });
}

export interface RecoveryEnrolmentOutcome {
  email: string;
  ticket: IssuedTicket;
}

/**
 * `POST /auth/recover`: signs the person out everywhere, revokes their other enrolment tickets and sets
 * a new one linked to this link. Resumable: the link stays valid until a passkey is registered with it.
 */
export async function useRecoveryLink(
  ctx: CoreContext,
  secrets: IdentitySecrets,
  token: string,
): Promise<Result<RecoveryEnrolmentOutcome, ApiError>> {
  const hash = await tokenHash(secrets.tokenHashKey, token);
  const row = await validLink(ctx, hash);
  if (!row?.email) return err(GONE);
  const revoked = await revokeUserSessions(ctx, row.user_id);
  // issueTicket revokes the person's other outstanding tickets (Identity §4.4).
  const ticket = await issueTicket(ctx.env.DB, secrets.tokenHashKey, row.user_id, "recovery_link", null, ctx.now(), {
    recovery: hash,
  });
  await audit(ctx, {
    action: "auth.recovery_link_opened",
    actor: row.user_id,
    target: { type: "user", id: row.user_id },
    metadata: { sessionsRevoked: revoked },
  });
  ctx.log.info("recovery link opened", { userId: row.user_id, sessionsRevoked: revoked });
  return ok({ email: row.email, ticket });
}

/** Marks a recovery link used once its passkey is registered (the registration's after hook batch). */
export function markRecoveryLinkUsedStatement(
  database: Database,
  hash: string,
  userId: string,
  now: number,
): D1PreparedStatement {
  return database.statement(
    `UPDATE auth_tokens SET used_at = ? WHERE token_hash = ? AND user_id = ? AND kind = 'recovery' AND used_at IS NULL`,
    now,
    hash,
    userId,
  );
}

/**
 * The sign-in page's notice (Identity §4.6: "An admin reset your account on *date*"), shown before
 * sign-in to the member whose browser this is: the known-device cookie (set on every sign-in, hashed in
 * `user_devices`) names the member, and the notice shows while their `recovery_link_issued` notice is
 * still on the banner list **(default)**. Only the date leaves the Worker, never a name or address.
 */
export async function signInRecoveryNotice(
  db: D1Database,
  key: string,
  headers: Headers,
): Promise<{ at: number } | null> {
  const value = readDeviceCookie(headers);
  if (!value) return null;
  const hash = await tokenHash(key, `device:${value}`);
  const row = expectOk(
    await new Database(db).first<{ at: number | null }>(
      `SELECT max(json_extract(n.value, '$.at')) AS at
         FROM user_devices d JOIN users u ON u.id = d.user_id,
              json_each(coalesce(u.pending_security_notice, '[]')) n
        WHERE d.device_hash = ? AND u.status = 'active'
          AND json_extract(n.value, '$.kind') = 'recovery_link_issued'`,
      hash,
    ),
  );
  return typeof row?.at === "number" ? { at: row.at } : null;
}

// ---- Owner recovery with RECOVERY_TOKEN ------------------------------------------------------------

export const RECOVERY_TOKEN_NOT_SET: ApiError = apiError("not_found", "No such endpoint.");
const RECOVERY_TOKEN_INVALID: ApiError = apiError("forbidden", "That recovery token isn't right.", {
  reason: "recovery_token_invalid",
});
const RECOVERY_TOKEN_USED: ApiError = apiError(
  "gone",
  "This recovery token has already been used. Set a fresh value for RECOVERY_TOKEN and try again.",
  { reason: "recovery_token_used" },
);
const NO_SUCH_OWNER: ApiError = apiError("not_found", "No active owner has that email address.", {
  reason: "owner_not_found",
});

/** Whether `RECOVERY_TOKEN` is set and long enough for owner recovery (Identity §4.6; Platform §16). */
export function recoveryTokenSet(env: CoreContext["env"]): boolean {
  const secret = env.RECOVERY_TOKEN;
  return typeof secret === "string" && [...secret].length >= 32;
}

/** Constant-time comparison of what was presented with the secret: both are hashed to a fixed length first. */
async function matchesSecret(presented: string, secret: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(presented), sha256(secret)]);
  return timingSafeEqual(a, b);
}

/** `POST /recover`. The route has refused an unset secret (404) and applied the per-IP limit. */
export async function recoverOwner(
  ctx: CoreContext,
  secrets: IdentitySecrets,
  body: OwnerRecoveryBody,
): Promise<Result<RecoveryEnrolmentOutcome, ApiError>> {
  const secret = ctx.env.RECOVERY_TOKEN;
  if (!secret || !recoveryTokenSet(ctx.env)) return err(RECOVERY_TOKEN_NOT_SET);
  if (!(await matchesSecret(body.token, secret))) {
    await audit(ctx, {
      action: "auth.owner_recovery_failed",
      actor: null,
      target: { type: "installation", id: "1" },
      metadata: { failure: "wrong_token" },
    });
    return err(RECOVERY_TOKEN_INVALID);
  }
  const database = new Database(ctx.env.DB);
  const hash = await tokenHash(secrets.tokenHashKey, secret);
  const used = expectOk(
    await database.first<{ one: number }>("SELECT 1 AS one FROM recovery_token_uses WHERE token_hash = ?", hash),
  );
  if (used) return err(RECOVERY_TOKEN_USED);
  const owner = expectOk(
    await database.first<{ id: string; email: string; display_name: string }>(
      `SELECT id, email, display_name FROM users
        WHERE email_normalised = ? AND role = 'owner' AND status = 'active' AND email IS NOT NULL`,
      normaliseEmail(body.email),
    ),
  );
  if (!owner) return err(NO_SUCH_OWNER);
  const now = ctx.now();
  // The consume: the primary key makes this the compare-and-set, so concurrent uses succeed at most once.
  const consumed = expectOk(
    await database.first<{ token_hash: string }>(
      `INSERT INTO recovery_token_uses (token_hash, owner_id, used_at) VALUES (?, ?, ?)
       ON CONFLICT (token_hash) DO NOTHING RETURNING token_hash`,
      hash,
      owner.id,
      now,
    ),
  );
  if (!consumed) return err(RECOVERY_TOKEN_USED);

  const revoked = await revokeUserSessions(ctx, owner.id);
  const ticket = await issueTicket(ctx.env.DB, secrets.tokenHashKey, owner.id, "owner_recovery", null, ctx.now());
  const others = expectOk(
    await database.all<{ id: string }>(
      "SELECT id FROM users WHERE role = 'owner' AND status = 'active' AND id != ?",
      owner.id,
    ),
  );
  const raised: RaisedNotice[] = others.map((o) => ({
    userId: o.id,
    kind: "owner_recovery_used",
    details: { subjectName: owner.display_name },
    at: now,
  }));
  expectOk(
    await database.batchRun([
      ...raised.map((n) => noticeStatement(database, n.userId, n.kind, n.details, n.at)),
      await auditStatement(ctx, {
        action: "auth.owner_recovery_used",
        actor: null,
        target: { type: "user", id: owner.id },
        metadata: { sessionsRevoked: revoked },
      }),
    ]),
  );
  await emailSecurityNotices(ctx, raised);
  ctx.log.warn("owner recovery used", { ownerId: owner.id });
  return ok({ email: owner.email, ticket });
}

import {
  apiError,
  DOMAIN_MOVE_TTL_MS,
  err,
  ok,
  type ApiError,
  type CompleteDomainMoveResult,
  type DomainStatus,
  type Result,
  type StartDomainMoveResult,
} from "@officebox/shared";
import { z } from "zod";
import { audit, auditStatement } from "../../core/audit";
import type { CoreContext } from "../../core/context";
import { Database, expectOk } from "../../core/db";
import { displayNameOf, revokeAllSessions } from "./account-security";
import { randomToken, tokenHash } from "./crypto";
import { issueTicket, type IssuedTicket } from "./enrolment";
import { activePendingMove, loadInstallation } from "./installation";
import { emailSecurityNotices, type RaisedNotice } from "./notice-email";
import { noticeStatement } from "./notices";
import type { IdentitySecrets } from "./secrets";

/**
 * The owner's **two-step domain move** (Identity §2, §4.4; TDD §8.1; Permissions §6; M1c).
 *
 * 1. **Start** (`POST /admin/domain`, owner, step-up: the engine's `domain.move_start`): the new origin is
 *    stored as the pending move (`installation.pending_origin*`, 24 hours **(default)**), and a single-use
 *    **move link** for the new origin is returned to that owner (`<new origin>/admin/domain/complete#t=…`;
 *    the token is an `auth_tokens` row of kind `domain_move` **(default)**, bound to the owner, with the
 *    origin in its payload). The old origin keeps working. Starting again replaces the pending move and
 *    revokes the earlier link; `DELETE /admin/domain/pending` cancels it.
 * 2. **Commit**: the owner opens the link on the new origin. While a move is pending, the identity host
 *    guard lets that origin answer only the move-completion routes, with a better-auth instance built for
 *    it. The link's POST ({@link openMoveLink}) sets an enrolment ticket there (via `domain_move`, linked
 *    to the link); the owner registers a passkey with the new origin as relying party, and that
 *    registration's after hook calls {@link commitDomainMove}. Nothing is fetched server-side to verify
 *    the host, so there's no SSRF path.
 *
 * **At commit**, in one batch: the move link is consumed (compare-and-set) and, only if that matched, the
 * canonical origin becomes the new one (checked against the pending row and the old origin), the old host
 * joins `allowed_hosts`, the pending move is cleared; magic links, recovery and email-change links and
 * enrolment tickets are revoked; unfinished invitations lose their link (`origin_moved_at`; admins make
 * a new one, which the list flags). Then every session except the one the registration just created is
 * revoked (closing sockets), the other owners get a `domain_moved` notice, and it's audited. Afterwards
 * the old host redirects (302/307) to the canonical origin (the host guard, `middleware.ts`).
 *
 * The hourly repair job clears an expired pending move and audits it ({@link expirePendingMove}).
 */

const NO_PENDING: ApiError = apiError("not_found", "There's no pending move.", { reason: "no_pending_move" });
const LINK_INVALID: ApiError = apiError(
  "gone",
  "This move link isn't valid any more. Start the move again from the current address.",
  { reason: "domain_move_invalid" },
);

const payloadSchema = z.object({ origin: z.string() });

export function moveLink(origin: string, token: string): string {
  return `${new URL("/admin/domain/complete", origin).toString()}#t=${token}`;
}

/** `GET /admin/domain` (owners). */
export async function domainStatus(ctx: CoreContext): Promise<Result<DomainStatus, ApiError>> {
  const installation = await loadInstallation(ctx.env.DB);
  if (!installation?.canonicalOrigin) return err(apiError("setup_required", "This workspace hasn't been set up yet."));
  const pending = activePendingMove(installation, ctx.now());
  let startedBy: { id: string; displayName: string } | null = null;
  if (pending?.startedBy) {
    startedBy = { id: pending.startedBy, displayName: await displayNameOf(ctx.env.DB, pending.startedBy, "An owner") };
  }
  return ok({
    canonicalOrigin: installation.canonicalOrigin,
    pending: pending ? { origin: pending.origin, expiresAt: pending.expiresAt, startedBy } : null,
  });
}

/** `POST /admin/domain`. The route has authorized `domain.move_start` (owner, step-up). */
export async function startDomainMove(
  ctx: CoreContext,
  secrets: IdentitySecrets,
  actorId: string,
  origin: string,
): Promise<Result<StartDomainMoveResult, ApiError>> {
  const installation = await loadInstallation(ctx.env.DB);
  const canonical = installation?.canonicalOrigin;
  if (!canonical) return err(apiError("setup_required", "This workspace hasn't been set up yet."));
  if (origin === canonical) {
    const message = "That's the workspace's current address.";
    return err(apiError("validation_failed", message, { reason: "same_origin", fields: { origin: [message] } }));
  }
  const now = ctx.now();
  const expiresAt = now + DOMAIN_MOVE_TTL_MS;
  const token = randomToken(32);
  const database = new Database(ctx.env.DB);
  const result = expectOk(
    await database.batchRun([
      // Starting again replaces any pending move: its link stops working.
      database.statement(
        `UPDATE auth_tokens SET revoked_at = ? WHERE kind = 'domain_move' AND used_at IS NULL AND revoked_at IS NULL`,
        now,
      ),
      database.statement(
        `UPDATE installation
            SET pending_origin = ?, pending_origin_started_by = ?, pending_origin_expires_at = ?
          WHERE id = 1 AND canonical_origin = ?`,
        origin,
        actorId,
        expiresAt,
        canonical,
      ),
      database.statement(
        `INSERT INTO auth_tokens (token_hash, user_id, kind, issued_by, payload, expires_at, created_at)
         SELECT ?, ?, 'domain_move', ?, ?, ?, ? WHERE changes() > 0`,
        await tokenHash(secrets.tokenHashKey, token),
        actorId,
        actorId,
        JSON.stringify({ origin }),
        expiresAt,
        now,
      ),
      await auditStatement(
        ctx,
        {
          action: "domain.move_started",
          actor: actorId,
          target: { type: "installation", id: "1" },
          metadata: { from: canonical, to: origin },
        },
        { onlyIfPreviousChanged: true },
      ),
    ]),
  );
  if ((result[2]?.changes ?? 0) !== 1) {
    return err(apiError("conflict", "The workspace's address changed meanwhile. Reload and try again."));
  }
  ctx.log.info("domain move started", { to: origin });
  return ok({ origin, link: moveLink(origin, token), expiresAt });
}

/** `DELETE /admin/domain/pending`. The route has authorized `domain.move_cancel` (owner). */
export async function cancelDomainMove(ctx: CoreContext, actorId: string): Promise<Result<null, ApiError>> {
  const installation = await loadInstallation(ctx.env.DB);
  const pending = activePendingMove(installation, ctx.now());
  if (!pending) return err(NO_PENDING);
  const database = new Database(ctx.env.DB);
  const now = ctx.now();
  const result = expectOk(
    await database.batchRun([
      database.statement(
        `UPDATE installation SET pending_origin = NULL, pending_origin_started_by = NULL, pending_origin_expires_at = NULL
          WHERE id = 1 AND pending_origin = ?`,
        pending.origin,
      ),
      await auditStatement(
        ctx,
        {
          action: "domain.move_cancelled",
          actor: actorId,
          target: { type: "installation", id: "1" },
          metadata: { to: pending.origin },
        },
        { onlyIfPreviousChanged: true },
      ),
      database.statement(
        `UPDATE auth_tokens SET revoked_at = ? WHERE kind = 'domain_move' AND used_at IS NULL AND revoked_at IS NULL`,
        now,
      ),
    ]),
  );
  return (result[0]?.changes ?? 0) === 1 ? ok(null) : err(NO_PENDING);
}

/** Hourly: clears a pending move whose 24 hours are up, revokes its link and audits it once. */
export async function expirePendingMove(ctx: CoreContext): Promise<boolean> {
  const database = new Database(ctx.env.DB);
  const now = ctx.now();
  const result = expectOk(
    await database.batchRun([
      database.statement(
        `UPDATE installation SET pending_origin = NULL, pending_origin_started_by = NULL, pending_origin_expires_at = NULL
          WHERE id = 1 AND pending_origin IS NOT NULL AND pending_origin_expires_at <= ?`,
        now,
      ),
      await auditStatement(
        ctx,
        { action: "domain.move_expired", actor: null, target: { type: "installation", id: "1" } },
        { onlyIfPreviousChanged: true },
      ),
      // With no move pending any more, no move link has anything to commit.
      database.statement(
        `UPDATE auth_tokens SET revoked_at = ?1
          WHERE kind = 'domain_move' AND used_at IS NULL AND revoked_at IS NULL
            AND (SELECT pending_origin FROM installation WHERE id = 1) IS NULL`,
        now,
      ),
    ]),
  );
  return (result[0]?.changes ?? 0) === 1;
}

interface MoveTokenRow {
  user_id: string;
  email: string | null;
  payload: string | null;
}

export interface OpenedMove {
  email: string;
  ticket: IssuedTicket;
}

/**
 * `POST /admin/domain/complete` on the pending origin (`origin` is the request's, which the host guard
 * matched with the pending move): checks the link and sets an enrolment ticket for its owner. The link
 * can be opened again until the move commits or expires (each opening replaces the ticket) **(default)**.
 */
export async function openMoveLink(
  ctx: CoreContext,
  secrets: IdentitySecrets,
  origin: string,
  token: string,
): Promise<Result<OpenedMove & Pick<CompleteDomainMoveResult, "workspaceName">, ApiError>> {
  const installation = await loadInstallation(ctx.env.DB);
  const pending = activePendingMove(installation, ctx.now());
  if (!installation || !pending || pending.origin !== origin) return err(LINK_INVALID);
  const hash = await tokenHash(secrets.tokenHashKey, token);
  const row = expectOk(
    await new Database(ctx.env.DB).first<MoveTokenRow>(
      `SELECT t.user_id, u.email, t.payload FROM auth_tokens t JOIN users u ON u.id = t.user_id
        WHERE t.token_hash = ? AND t.kind = 'domain_move' AND t.used_at IS NULL AND t.revoked_at IS NULL
          AND t.expires_at > ? AND u.status = 'active' AND u.role = 'owner'`,
      hash,
      ctx.now(),
    ),
  );
  const payload = payloadSchema.safeParse(row?.payload ? JSON.parse(row.payload) : null);
  if (!row?.email || !payload.success || payload.data.origin !== origin || row.user_id !== pending.startedBy) {
    return err(LINK_INVALID);
  }
  const ticket = await issueTicket(ctx.env.DB, secrets.tokenHashKey, row.user_id, "domain_move", null, ctx.now(), {
    move: hash,
  });
  await audit(ctx, {
    action: "domain.move_link_opened",
    actor: row.user_id,
    target: { type: "installation", id: "1" },
    metadata: { to: origin },
  });
  return ok({ email: row.email, ticket, workspaceName: installation.workspaceName });
}

export interface CommitInput {
  /** The move link's token hash, from the consumed enrolment ticket. */
  moveHash: string;
  ownerId: string;
  /** The pending origin this registration ran on (the host guard's). */
  origin: string;
  /** The session the registration just created on the new origin: the only one kept. */
  keepSessionId: string | null;
}

/**
 * Commits the move after the owner's passkey registration on the new origin (Identity §4.4). Returns
 * false when the move can't commit any more (cancelled, replaced, expired, or the address changed): the
 * caller then removes the passkey and session it just made.
 */
export async function commitDomainMove(ctx: CoreContext, input: CommitInput): Promise<boolean> {
  const installation = await loadInstallation(ctx.env.DB);
  const oldOrigin = installation?.canonicalOrigin;
  const pending = activePendingMove(installation, ctx.now());
  if (!installation || !oldOrigin || !pending || pending.origin !== input.origin) return false;
  const oldHost = new URL(oldOrigin).host;
  const now = ctx.now();
  const database = new Database(ctx.env.DB);
  // Every statement after the first two applies only if the switch did (the row now names the new
  // origin with no pending move, and the link was consumed at this call's time).
  const committed = `EXISTS (SELECT 1 FROM installation WHERE id = 1 AND canonical_origin = ?2 AND pending_origin IS NULL)
    AND EXISTS (SELECT 1 FROM auth_tokens WHERE token_hash = ?3 AND kind = 'domain_move' AND used_at = ?1)`;
  const result = expectOk(
    await database.batchRun([
      database.statement(
        `UPDATE auth_tokens SET used_at = ?1
          WHERE token_hash = ?2 AND kind = 'domain_move' AND user_id = ?3 AND used_at IS NULL AND revoked_at IS NULL
            AND expires_at > ?1 AND json_extract(payload, '$.origin') = ?4`,
        now,
        input.moveHash,
        input.ownerId,
        input.origin,
      ),
      database.statement(
        `UPDATE installation
            SET canonical_origin = pending_origin,
                allowed_hosts = CASE
                  WHEN EXISTS (SELECT 1 FROM json_each(coalesce(allowed_hosts, '[]')) WHERE value = ?4)
                    THEN coalesce(allowed_hosts, '[]')
                  ELSE json_insert(coalesce(allowed_hosts, '[]'), '$[#]', ?4) END,
                pending_origin = NULL, pending_origin_started_by = NULL, pending_origin_expires_at = NULL
          WHERE id = 1 AND canonical_origin = ?2 AND pending_origin = ?3 AND pending_origin_started_by = ?5
            AND pending_origin_expires_at > ?1 AND changes() > 0`,
        now,
        oldOrigin,
        input.origin,
        oldHost,
        input.ownerId,
      ),
      // Tokens issued for the old origin (Identity §4.4): magic links, every unused link and ticket.
      database.statement(
        `UPDATE magic_link_issues SET revoked_at = ?1 WHERE consumed_at IS NULL AND revoked_at IS NULL AND ${committed}`,
        now,
        input.origin,
        input.moveHash,
      ),
      database.statement(
        `UPDATE auth_tokens SET revoked_at = ?1
          WHERE used_at IS NULL AND revoked_at IS NULL
            AND kind IN ('passkey_enrol', 'recovery', 'email_change', 'domain_move') AND ${committed}`,
        now,
        input.origin,
        input.moveHash,
      ),
      // Unfinished invitations lose their link; "Copy again" or "Resend" makes a new one (flagged).
      database.statement(
        `UPDATE invitations SET token_hash = 'moved:' || id, origin_moved_at = ?1
          WHERE accepted_at IS NULL AND revoked_at IS NULL AND ${committed}`,
        now,
        input.origin,
        input.moveHash,
      ),
    ]),
  );
  if ((result[1]?.changes ?? 0) !== 1) return false;

  const ctxLog = ctx.log;
  const revoked = await revokeAllSessions(ctx, input.keepSessionId ?? undefined);
  const actorName = await displayNameOf(ctx.env.DB, input.ownerId, "An owner");
  const others = expectOk(
    await database.all<{ id: string }>(
      "SELECT id FROM users WHERE role = 'owner' AND status = 'active' AND id != ?",
      input.ownerId,
    ),
  );
  const raised: RaisedNotice[] = others.map((o) => ({
    userId: o.id,
    kind: "domain_moved",
    details: { origin: input.origin, actorName },
    at: now,
  }));
  expectOk(
    await database.batchRun([
      ...raised.map((n) => noticeStatement(database, n.userId, n.kind, n.details, n.at)),
      await auditStatement(ctx, {
        action: "domain.move_committed",
        actor: input.ownerId,
        target: { type: "installation", id: "1" },
        metadata: { from: oldOrigin, to: input.origin, sessionsRevoked: revoked },
      }),
    ]),
  );
  // Emailed links use the new canonical origin from now on (notice-email reads the installation).
  await emailSecurityNotices(ctx, raised);
  ctxLog.warn("domain move committed", { from: oldOrigin, to: input.origin, sessionsRevoked: revoked });
  return true;
}

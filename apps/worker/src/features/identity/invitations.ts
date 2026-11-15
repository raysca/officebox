import {
  apiError,
  err,
  INVITATION_TTL_MS,
  invitableRoleSchema,
  isInviteDomainAllowed,
  normaliseEmail,
  ok,
  type AcceptInvitationBody,
  type ApiError,
  type CreateInvitationBody,
  type CreateInvitationResult,
  type InvitableRole,
  type InvitationEmailOutcome,
  type InvitationLookup,
  type InvitationStatus,
  type InvitationSummary,
  type Result,
} from "@officebox/shared";
import { auditStatement } from "../../core/audit";
import type { CoreContext } from "../../core/context";
import { Database, expectOk } from "../../core/db";
import { ulid, ulidTime } from "../../core/ids";
import { checkLimit, defineLimit } from "../../core/rate-limit";
import { SETTINGS, SettingsStore } from "../../core/settings";
import { isEmailConfigured } from "../email/config";
import { enqueueEmail } from "../email/delivery";
import { invitationEmail } from "../email/templates";
import { authFor } from "./auth";
import { base64url, hmacSha256, randomToken, tokenHash } from "./crypto";
import { issueTicket, type IssuedTicket } from "./enrolment";
import type { ClaimedInstallation } from "./installation";
import { currentStore, runWithStore } from "./request-store";
import type { IdentitySecrets } from "./secrets";

/**
 * Invitations (Identity §4.2, §4.3; TDD §8.1 "Account creation, in order", "Invitation repair").
 *
 * - **Create** (admins invite members; only owners invite admins; owners meet the invite gate on every
 *   invite: the route asks the permission engine first). The invitee's email is always required and
 *   bound to the link. One pending invitation per normalised email (unique index); an expired pending
 *   one is revoked by the new invite. An email that belongs to an active member is refused; a
 *   disabled member is offered "re-enable" instead. The optional `allowed_invite_domains` setting
 *   restricts domains.
 * - **The link** is always returned for copying: `/invitations/accept#t=…` on the canonical origin. The
 *   token is HMAC(TOKEN_HASH_KEY, 'invitation-link:' + nonce) and stored hashed, so "copy again" can
 *   rebuild the same link while D1 alone can't **(default)**. With `sendEmail` and email configured, it
 *   is emailed too.
 * - **Accept**, in order (D1 isn't transactional through better-auth's adapter): consume the invitation
 *   with a compare-and-set that records a fresh `accepted_attempt_id`; create the user through
 *   better-auth inside the server-set accept marker (carrying that attempt ID); claim the handle with
 *   the same attempt ID; record `accepted_by`; set an enrolment ticket for the first passkey.
 *   A handle lost to a race between the check and the claim is compensated (the new account, which has
 *   no passkey or session, is deleted and the invitation released) and the person picks another.
 * - **Reopening**: accepting a consumed invitation again issues a new ticket for the same account, only
 *   while it's valid and the account has **no passkey and has never had a session**; otherwise 410.
 * - **Repair** (hourly): never resurrects a consumed invitation; see {@link repairInvitations}.
 */

export const REPAIR_GRACE_MS = 10 * 60 * 1000;

/** Invitation emails: 200 per workspace per UTC day (Platform §8, Admin §5.1). */
export const INVITATION_SEND_LIMIT = defineLimit({
  mechanism: "d1",
  name: "invitation_send",
  limit: 200,
  window: { kind: "day" },
});

const GONE: ApiError = apiError("gone", "This invitation link isn't valid any more. Ask for a new invitation.", {
  reason: "invitation_invalid",
});
const EXPIRED: ApiError = apiError("gone", "This invitation has expired. Ask for a new invitation.", {
  reason: "invitation_expired",
});
const IN_PROGRESS: ApiError = apiError("conflict", "This invitation is being accepted. Try again in a moment.", {
  reason: "invitation_in_progress",
});
const NOT_FOUND: ApiError = apiError("not_found", "No such invitation.");

/** The link token for a stored nonce. */
export async function invitationToken(key: string, nonce: string): Promise<string> {
  return base64url(await hmacSha256(key, `invitation-link:${nonce}`));
}

export function invitationLink(canonicalOrigin: string, token: string): string {
  return `${new URL("/invitations/accept", canonicalOrigin).toString()}#t=${token}`;
}

interface InvitationRow {
  id: string;
  email: string;
  email_normalised: string;
  role: string;
  token_nonce: string;
  invited_by: string;
  expires_at: number;
  accepted_at: number | null;
  accepted_by: string | null;
  accepted_attempt_id: string | null;
  revoked_at: number | null;
  last_sent_at: number | null;
  created_at: number;
  inviter_name?: string | null;
}

const COLUMNS = `i.id, i.email, i.email_normalised, i.role, i.token_nonce, i.invited_by, i.expires_at, i.accepted_at,
  i.accepted_by, i.accepted_attempt_id, i.revoked_at, i.last_sent_at, i.created_at`;

function roleOf(row: InvitationRow): InvitableRole {
  const parsed = invitableRoleSchema.safeParse(row.role);
  // A role this release doesn't know is shown as the least powerful; the engine refuses acting on it.
  return parsed.success ? parsed.data : "member";
}

function statusOf(row: InvitationRow, now: number): InvitationStatus {
  if (row.accepted_attempt_id !== null) return "accepting";
  return row.expires_at <= now ? "expired" : "pending";
}

function summary(row: InvitationRow, now: number): InvitationSummary {
  return {
    id: row.id,
    email: row.email,
    role: roleOf(row),
    invitedBy: row.inviter_name != null ? { id: row.invited_by, displayName: row.inviter_name } : null,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastSentAt: row.last_sent_at,
    status: statusOf(row, now),
  };
}

async function loadById(db: D1Database, id: string): Promise<InvitationRow | null> {
  return expectOk(
    await new Database(db).first<InvitationRow>(
      `SELECT ${COLUMNS}, u.display_name AS inviter_name FROM invitations i
         LEFT JOIN users u ON u.id = i.invited_by WHERE i.id = ?`,
      id,
    ),
  );
}

/** The role of a pending (not accepted, not revoked) invitation, for the route's permission check. */
export async function invitationRole(ctx: CoreContext, id: string): Promise<InvitableRole | null> {
  const row = await loadById(ctx.env.DB, id);
  if (!row || row.revoked_at !== null || row.accepted_at !== null) return null;
  return roleOf(row);
}

/** Pending, expired-but-unrevoked and in-progress invitations, newest first. */
export async function listInvitations(ctx: CoreContext): Promise<InvitationSummary[]> {
  const rows = expectOk(
    await new Database(ctx.env.DB).all<InvitationRow>(
      `SELECT ${COLUMNS}, u.display_name AS inviter_name FROM invitations i
         LEFT JOIN users u ON u.id = i.invited_by
        WHERE i.accepted_at IS NULL AND i.revoked_at IS NULL
        ORDER BY i.created_at DESC LIMIT 500`,
    ),
  );
  const now = ctx.now();
  return rows.map((row) => summary(row, now));
}

async function sendInvitationEmail(
  ctx: CoreContext,
  installation: ClaimedInstallation,
  row: InvitationRow,
  link: string,
  inviterName: string,
): Promise<InvitationEmailOutcome> {
  if (!(await isEmailConfigured(ctx))) return "not_configured";
  // 200 invitation emails per workspace per UTC day (Platform §8); beyond it, the copy link still works.
  const limited = await checkLimit(ctx, INVITATION_SEND_LIMIT, "workspace");
  if (!limited.ok) return "limited";
  const rendered = invitationEmail({
    workspace: installation.workspaceName,
    inviterName,
    email: row.email,
    link,
    expiresAt: row.expires_at,
  });
  const queued = await enqueueEmail(ctx, { kind: "invitation", to: row.email, ...rendered });
  if (!queued.ok) return "not_configured";
  expectOk(
    await new Database(ctx.env.DB).run("UPDATE invitations SET last_sent_at = ? WHERE id = ?", ctx.now(), row.id),
  );
  return "queued";
}

async function displayName(db: D1Database, userId: string): Promise<string> {
  const row = expectOk(
    await new Database(db).first<{ display_name: string }>("SELECT display_name FROM users WHERE id = ?", userId),
  );
  return row?.display_name ?? "An admin";
}

/** Creates an invitation. The caller has already authorized `invitation.create` for `body.role`. */
export async function createInvitation(
  ctx: CoreContext,
  secrets: IdentitySecrets,
  installation: ClaimedInstallation,
  actorId: string,
  body: CreateInvitationBody,
): Promise<Result<CreateInvitationResult, ApiError>> {
  const now = ctx.now();
  const email = body.email.trim();
  const normalised = normaliseEmail(email);
  const allowed = await new SettingsStore(ctx, SETTINGS).get("allowed_invite_domains");
  if (!isInviteDomainAllowed(email, allowed)) {
    const message = "This email's domain isn't one the workspace allows.";
    return err(
      apiError("validation_failed", message, { reason: "invite_domain_not_allowed", fields: { email: [message] } }),
    );
  }
  const database = new Database(ctx.env.DB);
  const existing = expectOk(
    await database.first<{ status: string }>("SELECT status FROM users WHERE email_normalised = ?", normalised),
  );
  if (existing?.status === "active") {
    return err(apiError("conflict", "This person is already a member.", { reason: "already_member" }));
  }
  if (existing) {
    // Disabled (or reserved): offered "re-enable" instead (Identity §4.2; the action arrives in M1e).
    return err(
      apiError("conflict", "This person's account is disabled. Re-enable it instead.", { reason: "member_disabled" }),
    );
  }

  const id = ulid();
  const nonce = randomToken(32);
  const token = await invitationToken(secrets.tokenHashKey, nonce);
  const expiresAt = now + INVITATION_TTL_MS;
  const inserted = await database.batchRun([
    // An expired pending invitation for this email is revoked by the new one (Identity §5 index note).
    database.statement(
      `UPDATE invitations SET revoked_at = ?1
        WHERE email_normalised = ?2 AND accepted_at IS NULL AND accepted_attempt_id IS NULL
          AND revoked_at IS NULL AND expires_at <= ?1`,
      now,
      normalised,
    ),
    database.statement(
      `INSERT INTO invitations (id, email, email_normalised, role, token_hash, token_nonce, invited_by, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      email,
      normalised,
      body.role,
      await tokenHash(secrets.tokenHashKey, token),
      nonce,
      actorId,
      expiresAt,
      now,
    ),
    await auditStatement(ctx, {
      action: "invitation.created",
      actor: actorId,
      target: { type: "invitation", id },
      metadata: { email, role: body.role, emailed: body.sendEmail },
    }),
  ]);
  if (!inserted.ok) {
    if (inserted.error.kind === "unique") {
      return err(
        apiError("conflict", "There's already a pending invitation for this email.", { reason: "invitation_pending" }),
      );
    }
    return err(inserted.error.error);
  }
  const row = await loadById(ctx.env.DB, id);
  if (!row) throw new Error("invitation vanished after insert");
  const link = invitationLink(installation.canonicalOrigin, token);
  const emailOutcome: InvitationEmailOutcome = body.sendEmail
    ? await sendInvitationEmail(ctx, installation, row, link, row.inviter_name ?? "An admin")
    : "not_requested";
  ctx.log.info("invitation created", { invitationId: id, role: body.role, email: emailOutcome });
  const fresh = (await loadById(ctx.env.DB, id)) ?? row;
  return ok({ invitation: summary(fresh, ctx.now()), link, email: emailOutcome });
}

/** A pending, unexpired invitation by ID, or the error to return. */
async function pendingInvitation(ctx: CoreContext, id: string): Promise<Result<InvitationRow, ApiError>> {
  const row = await loadById(ctx.env.DB, id);
  if (!row || row.revoked_at !== null || row.accepted_at !== null) return err(NOT_FOUND);
  if (row.accepted_attempt_id !== null) {
    return err(apiError("conflict", "This invitation has already been accepted.", { reason: "invitation_accepted" }));
  }
  if (row.expires_at <= ctx.now()) return err(EXPIRED);
  return ok(row);
}

/** "Copy again": the same link, while the invitation is valid. Authorized by the route. */
export async function copyInvitationLink(
  ctx: CoreContext,
  secrets: IdentitySecrets,
  installation: ClaimedInstallation,
  id: string,
): Promise<Result<{ link: string }, ApiError>> {
  const row = await pendingInvitation(ctx, id);
  if (!row.ok) return row;
  const token = await invitationToken(secrets.tokenHashKey, row.value.token_nonce);
  return ok({ link: invitationLink(installation.canonicalOrigin, token) });
}

/** Emails the same link again. Authorized by the route; audited. */
export async function resendInvitation(
  ctx: CoreContext,
  secrets: IdentitySecrets,
  installation: ClaimedInstallation,
  actorId: string,
  id: string,
): Promise<Result<{ email: InvitationEmailOutcome }, ApiError>> {
  const row = await pendingInvitation(ctx, id);
  if (!row.ok) return row;
  const token = await invitationToken(secrets.tokenHashKey, row.value.token_nonce);
  const link = invitationLink(installation.canonicalOrigin, token);
  const outcome = await sendInvitationEmail(ctx, installation, row.value, link, await displayName(ctx.env.DB, actorId));
  const database = new Database(ctx.env.DB);
  expectOk(
    await database.batchRun([
      await auditStatement(ctx, {
        action: "invitation.resent",
        actor: actorId,
        target: { type: "invitation", id },
        metadata: { email: outcome },
      }),
    ]),
  );
  return ok({ email: outcome });
}

/** Revokes a pending invitation. Authorized by the route; audited in the same batch. */
export async function revokeInvitation(ctx: CoreContext, actorId: string, id: string): Promise<Result<null, ApiError>> {
  const database = new Database(ctx.env.DB);
  const result = expectOk(
    await database.batchRun([
      database.statement(
        `UPDATE invitations SET revoked_at = ?
          WHERE id = ? AND revoked_at IS NULL AND accepted_at IS NULL AND accepted_attempt_id IS NULL`,
        ctx.now(),
        id,
      ),
      await auditStatement(
        ctx,
        { action: "invitation.revoked", actor: actorId, target: { type: "invitation", id } },
        { onlyIfPreviousChanged: true },
      ),
    ]),
  );
  if ((result[0]?.changes ?? 0) === 1) return ok(null);
  const row = await loadById(ctx.env.DB, id);
  if (row && row.revoked_at === null) {
    return err(apiError("conflict", "This invitation has already been accepted.", { reason: "invitation_accepted" }));
  }
  return err(NOT_FOUND);
}

// ---- The invitee's side ---------------------------------------------------------------------------

async function byToken(ctx: CoreContext, secrets: IdentitySecrets, token: string): Promise<InvitationRow | null> {
  const hash = await tokenHash(secrets.tokenHashKey, token);
  return expectOk(
    await new Database(ctx.env.DB).first<InvitationRow>(
      `SELECT ${COLUMNS} FROM invitations i WHERE i.token_hash = ?`,
      hash,
    ),
  );
}

interface AttemptUser {
  id: string;
  email: string | null;
  status: string;
  first_signed_in_at: number | null;
  passkeys: number;
}

async function attemptUser(db: D1Database, attemptId: string): Promise<AttemptUser | null> {
  return expectOk(
    await new Database(db).first<AttemptUser>(
      `SELECT id, email, status, first_signed_in_at, (SELECT count(*) FROM passkeys p WHERE p.user_id = users.id) AS passkeys
         FROM users WHERE created_attempt_id = ?`,
      attemptId,
    ),
  );
}

type ConsumedState = { kind: "resume"; user: AttemptUser } | { kind: "error"; error: ApiError };

/** What a consumed invitation allows: reopening only while the account has no passkey or session. */
async function consumedState(ctx: CoreContext, row: InvitationRow): Promise<ConsumedState> {
  const attempt = row.accepted_attempt_id;
  if (attempt === null) return { kind: "error", error: GONE };
  if (row.revoked_at !== null) return { kind: "error", error: GONE };
  const user = await attemptUser(ctx.env.DB, attempt);
  if (!user) {
    // Consumed moments ago and the account isn't written yet: another accept is running.
    const recent = ulidTime(attempt) > ctx.now() - REPAIR_GRACE_MS;
    return { kind: "error", error: recent && row.accepted_at === null ? IN_PROGRESS : GONE };
  }
  if (row.expires_at <= ctx.now()) return { kind: "error", error: GONE };
  if (user.status !== "active" || user.passkeys > 0 || user.first_signed_in_at !== null || !user.email) {
    return { kind: "error", error: GONE };
  }
  return { kind: "resume", user };
}

/** `POST /invitations/lookup`: the invited email, prominently, and whether this is a resume. */
export async function lookupInvitation(
  ctx: CoreContext,
  secrets: IdentitySecrets,
  installation: ClaimedInstallation,
  token: string,
): Promise<Result<InvitationLookup, ApiError>> {
  const row = await byToken(ctx, secrets, token);
  if (!row || row.revoked_at !== null) return err(GONE);
  const base = { role: roleOf(row), workspaceName: installation.workspaceName };
  if (row.accepted_attempt_id === null) {
    if (row.expires_at <= ctx.now()) return err(EXPIRED);
    return ok({ ...base, email: row.email, state: "new" });
  }
  const state = await consumedState(ctx, row);
  if (state.kind === "error") return err(state.error);
  return ok({ ...base, email: state.user.email ?? row.email, state: "resume" });
}

export interface AcceptOutcome {
  email: string;
  ticket: IssuedTicket;
  resumed: boolean;
}

/** `POST /invitations/accept`. */
export async function acceptInvitation(
  ctx: CoreContext,
  secrets: IdentitySecrets,
  installation: ClaimedInstallation,
  body: AcceptInvitationBody,
): Promise<Result<AcceptOutcome, ApiError>> {
  const row = await byToken(ctx, secrets, body.token);
  if (!row || row.revoked_at !== null) return err(GONE);
  if (row.accepted_attempt_id !== null) return reopen(ctx, secrets, row);
  if (row.expires_at <= ctx.now()) return err(EXPIRED);

  const database = new Database(ctx.env.DB);
  const handleTaken = expectOk(
    await database.first<{ one: number }>("SELECT 1 AS one FROM handles WHERE handle = ?", body.handle),
  );
  if (handleTaken) return err(handleConflict());

  // 1. Consume by compare-and-set: exactly one request wins the attempt.
  const attemptId = ulid();
  const now = ctx.now();
  const consumed = expectOk(
    await database.run(
      `UPDATE invitations SET accepted_attempt_id = ?1
        WHERE id = ?2 AND accepted_attempt_id IS NULL AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?3`,
      attemptId,
      row.id,
      now,
    ),
  );
  if (consumed.changes !== 1) {
    const latest = await byToken(ctx, secrets, body.token);
    if (!latest || latest.accepted_attempt_id === null) return err(GONE);
    return reopen(ctx, secrets, latest);
  }

  // The email became a member another way since the invitation was sent: revoke it (Identity §8).
  const existing = expectOk(
    await database.first<{ id: string }>("SELECT id FROM users WHERE email_normalised = ?", row.email_normalised),
  );
  if (existing) {
    expectOk(
      await database.run(
        "UPDATE invitations SET revoked_at = ? WHERE id = ? AND accepted_attempt_id = ?",
        ctx.now(),
        row.id,
        attemptId,
      ),
    );
    return err(apiError("conflict", "This email already belongs to a member.", { reason: "already_member" }));
  }

  // 2. Create the user through better-auth, inside the server-set accept marker.
  const role = roleOf(row);
  const auth = authFor(ctx.env, secrets, installation);
  const internal = (await auth.$context).internalAdapter;
  const store = {
    ...(currentStore() ?? {}),
    create: { kind: "accept" as const, attemptId, role, handle: body.handle },
  };
  let userId: string;
  try {
    const user = await runWithStore(store, () =>
      internal.createUser(
        { email: row.email, name: body.name, emailVerified: true },
        { method: "officebox-invitation" },
      ),
    );
    if (!user) throw new Error("user creation refused inside the accept marker");
    userId = user.id;
  } catch (error) {
    await releaseAttempt(ctx, row.id, attemptId);
    throw error;
  }

  // 3. Claim the handle with the same attempt ID; a race lost since the check is compensated.
  const claimed = await database.run(
    "INSERT INTO handles (handle, owner_type, owner_id, created_attempt_id) VALUES (?, 'user', ?, ?)",
    body.handle,
    userId,
    attemptId,
  );
  if (!claimed.ok) {
    expectOk(
      await database.batchRun([
        database.statement(
          `DELETE FROM users WHERE id = ? AND created_attempt_id = ? AND first_signed_in_at IS NULL
             AND NOT EXISTS (SELECT 1 FROM passkeys WHERE user_id = users.id)`,
          userId,
          attemptId,
        ),
        database.statement(
          `UPDATE invitations SET accepted_attempt_id = NULL
            WHERE id = ? AND accepted_attempt_id = ? AND accepted_at IS NULL
              AND NOT EXISTS (SELECT 1 FROM users WHERE created_attempt_id = ?)`,
          row.id,
          attemptId,
          attemptId,
        ),
      ]),
    );
    return err(handleConflict());
  }

  // 4. Finish: accepted_by and the audit entry, then the enrolment ticket for the first passkey.
  expectOk(
    await database.batchRun([
      database.statement(
        "UPDATE invitations SET accepted_by = ?, accepted_at = ? WHERE id = ? AND accepted_attempt_id = ?",
        userId,
        ctx.now(),
        row.id,
        attemptId,
      ),
      await auditStatement(
        ctx,
        {
          action: "invitation.accepted",
          actor: userId,
          target: { type: "invitation", id: row.id },
          metadata: { role, userId },
        },
        { onlyIfPreviousChanged: true },
      ),
    ]),
  );
  const ticket = await issueTicket(ctx.env.DB, secrets.tokenHashKey, userId, "invitation", null, ctx.now());
  ctx.log.info("invitation accepted", { invitationId: row.id, userId });
  return ok({ email: row.email, ticket, resumed: false });
}

function handleConflict(): ApiError {
  const message = "That handle is taken. Pick another.";
  return apiError("conflict", message, { reason: "handle_taken", fields: { handle: [message] } });
}

/** Puts a consumed invitation back to pending when no account was written for the attempt. */
async function releaseAttempt(ctx: CoreContext, invitationId: string, attemptId: string): Promise<void> {
  await new Database(ctx.env.DB).run(
    `UPDATE invitations SET accepted_attempt_id = NULL
      WHERE id = ? AND accepted_attempt_id = ? AND accepted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM users WHERE created_attempt_id = ?)
        AND NOT EXISTS (SELECT 1 FROM handles WHERE created_attempt_id = ?)`,
    invitationId,
    attemptId,
    attemptId,
    attemptId,
  );
}

async function reopen(
  ctx: CoreContext,
  secrets: IdentitySecrets,
  row: InvitationRow,
): Promise<Result<AcceptOutcome, ApiError>> {
  const state = await consumedState(ctx, row);
  if (state.kind === "error") return err(state.error);
  const ticket = await issueTicket(ctx.env.DB, secrets.tokenHashKey, state.user.id, "invitation", null, ctx.now());
  ctx.log.info("invitation reopened for passkey registration", { invitationId: row.id, userId: state.user.id });
  return ok({ email: state.user.email ?? row.email, ticket, resumed: true });
}

// ---- Repair ---------------------------------------------------------------------------------------

export interface RepairReport {
  rolledForward: number;
  released: number;
  left: number;
}

/**
 * The repair job's invitation half (Identity §4.3; TDD §8.1 "never resurrect"), for invitations
 * consumed but not finished (`accepted_attempt_id` set, `accepted_at` NULL):
 *
 * - **Roll forward** whenever a `users` row (deleted included) carries the attempt ID: claim the
 *   handle if it's free and the user isn't deleted, and record `accepted_by`.
 * - **Release** (back to pending) only when **all** hold: consumed more than 10 minutes ago (the attempt
 *   ID's ULID time); not expired or revoked; no `users` row and no `handles` row carries the attempt
 *   ID; and the release is a compare-and-set on `accepted_attempt_id` that re-checks every condition.
 * - Otherwise leave it (a handle without a user, or an expired invitation with nothing written).
 */
export async function repairInvitations(ctx: CoreContext, limit = 100): Promise<RepairReport> {
  const database = new Database(ctx.env.DB);
  const report: RepairReport = { rolledForward: 0, released: 0, left: 0 };
  const rows = expectOk(
    await database.all<InvitationRow>(
      `SELECT ${COLUMNS} FROM invitations i
        WHERE i.accepted_attempt_id IS NOT NULL AND i.accepted_at IS NULL
        ORDER BY i.accepted_attempt_id LIMIT ?`,
      limit,
    ),
  );
  for (const row of rows) {
    const attempt = row.accepted_attempt_id;
    if (attempt === null) continue;
    const now = ctx.now();
    const user = expectOk(
      await database.first<{ id: string; handle: string | null; status: string }>(
        "SELECT id, handle, status FROM users WHERE created_attempt_id = ?",
        attempt,
      ),
    );
    if (user) {
      const statements: D1PreparedStatement[] = [];
      if (user.handle && user.status !== "deleted") {
        statements.push(
          database.statement(
            `INSERT INTO handles (handle, owner_type, owner_id, created_attempt_id)
             SELECT ?1, 'user', ?2, ?3 WHERE NOT EXISTS (SELECT 1 FROM handles WHERE handle = ?1)`,
            user.handle,
            user.id,
            attempt,
          ),
        );
      }
      statements.push(
        database.statement(
          "UPDATE invitations SET accepted_by = ?, accepted_at = ? WHERE id = ? AND accepted_attempt_id = ? AND accepted_at IS NULL",
          user.id,
          now,
          row.id,
          attempt,
        ),
        await auditStatement(
          ctx,
          {
            action: "invitation.repaired",
            actor: null,
            target: { type: "invitation", id: row.id },
            metadata: { outcome: "rolled_forward", userId: user.id },
          },
          { onlyIfPreviousChanged: true },
        ),
      );
      const result = expectOk(await database.batchRun(statements));
      if ((result[result.length - 2]?.changes ?? 0) === 1) report.rolledForward++;
      continue;
    }
    const handle = expectOk(
      await database.first<{ one: number }>("SELECT 1 AS one FROM handles WHERE created_attempt_id = ?", attempt),
    );
    let consumedAt: number;
    try {
      consumedAt = ulidTime(attempt);
    } catch {
      consumedAt = now;
    }
    const releasable =
      !handle && consumedAt <= now - REPAIR_GRACE_MS && row.expires_at > now && row.revoked_at === null;
    if (!releasable) {
      report.left++;
      continue;
    }
    const released = await database.batchRun([
      database.statement(
        `UPDATE invitations SET accepted_attempt_id = NULL
          WHERE id = ?1 AND accepted_attempt_id = ?2 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?3
            AND NOT EXISTS (SELECT 1 FROM users WHERE created_attempt_id = ?2)
            AND NOT EXISTS (SELECT 1 FROM handles WHERE created_attempt_id = ?2)`,
        row.id,
        attempt,
        now,
      ),
      await auditStatement(
        ctx,
        {
          action: "invitation.repaired",
          actor: null,
          target: { type: "invitation", id: row.id },
          metadata: { outcome: "released" },
        },
        { onlyIfPreviousChanged: true },
      ),
    ]);
    if (!released.ok) {
      // A newer pending invitation for the same email holds the unique index: leave this one.
      ctx.log.warn("invitation not released: another pending invitation for the email exists", {
        invitationId: row.id,
      });
      report.left++;
      continue;
    }
    if ((released.value[0]?.changes ?? 0) === 1) report.released++;
    else report.left++;
  }
  if (report.rolledForward || report.released) ctx.log.info("invitation repair", { ...report });
  return report;
}

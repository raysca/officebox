import { apiError, err, ok, type ApiError, type Result, type SetupBody, type SetupStatus } from "@officebox/shared";
import { audit, auditStatement } from "../../core/audit";
import type { CoreContext } from "../../core/context";
import { Database, expectOk } from "../../core/db";
import { ulid } from "../../core/ids";
import { authFor } from "./auth";
import { issueTicket, type IssuedTicket } from "./enrolment";
import { loadInstallation } from "./installation";
import { runWithStore, currentStore } from "./request-store";
import type { IdentitySecrets } from "./secrets";
import { completeSetupClaim, isSetupComplete } from "./setup-state";
import { checkSetupToken, ensureGeneratedToken, setupTokenSource } from "./setup-token";

/**
 * First-run setup with a passkey (Identity §4.1; TDD §6.8).
 *
 * 1. **Claim** (`POST /setup`): the setup token is checked in constant time, then one compare-and-set
 *    on `installation` (`… WHERE setup_claim IS NULL AND setup_completed_at IS NULL`) lets exactly one
 *    request win. It records the claim nonce, the claim time, the workspace name, the **canonical
 *    origin** (the origin the setup request arrived on) and the allowed hosts (that host alone).
 * 2. The winner creates the owner **through better-auth's adapter** inside the server-set setup marker
 *    that `databaseHooks.user.create.before` requires (with `emailVerified: true`, workaround 13),
 *    claims the handle, and sets an **enrolment ticket** cookie. D1 isn't transactional through the
 *    adapter, so these are ordered steps; a crash between them leaves a claim that the expiry batch
 *    (below) releases.
 * 3. The owner registers a passkey straight away (better-auth's registration routes, with the ticket);
 *    that registration completes setup (`completeSetupClaim`) and signs the owner in.
 *
 * **Resume** (`POST /setup/resume`): the same token issues a new ticket for the claimed owner only,
 * while they have no passkey and have never had a session; otherwise 410.
 *
 * **Expiry:** a claim not completed 24 hours after `setup_claimed_at` is released in **one conditional
 * batch** that never deletes an owner who has a passkey or has signed in, and clears the claim only
 * when no owner row for it remains (so the claim is never half-cleared).
 *
 * Setup creates **identity objects only**: the installation row, the owner and their handle. Settings
 * are the registry defaults until changed.
 */

export const SETUP_CLAIM_TTL_MS = 24 * 60 * 60 * 1000;

const NOT_FOUND: ApiError = apiError("not_found", "No such endpoint.");
const INVALID_TOKEN: ApiError = apiError("forbidden", "The setup token is not valid.");

export interface SetupEnrolmentResult {
  ownerEmail: string;
  ticket: IssuedTicket;
}

/**
 * Releases an expired, incomplete claim (TDD §6.8), in one batch. Each statement re-checks the
 * conditions itself (`NOT EXISTS` rather than `changes()`, which only sees the previous statement), so
 * the owner, their handle and tickets go only if the owner has no passkey and never signed in, and
 * the claim is cleared only if no owner row for it remains. Returns whether a claim was released.
 */
export async function expireStaleClaim(ctx: CoreContext): Promise<boolean> {
  const db = new Database(ctx.env.DB);
  const cutoff = ctx.now() - SETUP_CLAIM_TTL_MS;
  const stale = `(SELECT setup_completed_at FROM installation WHERE id = 1) IS NULL
      AND (SELECT setup_claimed_at FROM installation WHERE id = 1) < ?`;
  const claimOf = "(SELECT setup_claim FROM installation WHERE id = 1)";
  const result = expectOk(
    await db.batchRun([
      db.statement(
        `DELETE FROM users
          WHERE created_attempt_id = ${claimOf} AND role = 'owner'
            AND NOT EXISTS (SELECT 1 FROM passkeys WHERE user_id = users.id)
            AND first_signed_in_at IS NULL
            AND ${stale}`,
        cutoff,
      ),
      db.statement(
        `DELETE FROM handles
          WHERE created_attempt_id = ${claimOf}
            AND NOT EXISTS (SELECT 1 FROM users WHERE created_attempt_id = ${claimOf})
            AND ${stale}`,
        cutoff,
      ),
      db.statement(
        `UPDATE installation
            SET setup_claim = NULL, setup_claimed_at = NULL, canonical_origin = NULL, allowed_hosts = NULL,
                setup_token_hash = NULL, setup_token_expires_at = NULL
          WHERE id = 1 AND setup_completed_at IS NULL AND setup_claim IS NOT NULL AND setup_claimed_at < ?
            AND NOT EXISTS (SELECT 1 FROM users WHERE created_attempt_id = installation.setup_claim)`,
        cutoff,
      ),
      await auditStatement(ctx, { action: "setup.claim_expired", actor: null }, { onlyIfPreviousChanged: true }),
    ]),
  );
  const released = (result[2]?.changes ?? 0) === 1;
  if (released) ctx.log.info("an incomplete setup claim expired and was released");
  return released;
}

/** Runs the expiry batch only when the open claim is actually older than 24 hours (a read first). */
export async function expireIfStale(ctx: CoreContext): Promise<boolean> {
  const installation = await loadInstallation(ctx.env.DB);
  if (!installation?.setupClaim || installation.setupCompletedAt !== null) return false;
  if ((installation.setupClaimedAt ?? 0) >= ctx.now() - SETUP_CLAIM_TTL_MS) return false;
  return expireStaleClaim(ctx);
}

/**
 * Releases a claim that has no owner row (only while it's still the current, incomplete claim). The
 * setup token is kept, so the same token works again. Returns whether it released one.
 */
export async function releaseOrphanedClaim(ctx: CoreContext, claim: string): Promise<boolean> {
  const meta = expectOk(
    await new Database(ctx.env.DB).run(
      `UPDATE installation SET setup_claim = NULL, setup_claimed_at = NULL, canonical_origin = NULL, allowed_hosts = NULL
        WHERE id = 1 AND setup_claim = ? AND setup_completed_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM users WHERE created_attempt_id = ?)`,
      claim,
      claim,
    ),
  );
  if (meta.changes === 1) ctx.log.warn("an incomplete setup claim without an owner was released");
  return meta.changes === 1;
}

export async function setupStatus(ctx: CoreContext): Promise<Result<SetupStatus, ApiError>> {
  if (await isSetupComplete(ctx)) return err(NOT_FOUND);
  await expireIfStale(ctx);
  await ensureGeneratedToken(ctx);
  const installation = await loadInstallation(ctx.env.DB);
  return ok({ setupRequired: true, tokenSource: setupTokenSource(ctx.env), claimed: installation?.setupClaim != null });
}

interface ClaimedOwner {
  id: string;
  email: string;
  passkeys: number;
  firstSignedInAt: number | null;
}

async function claimedOwner(ctx: CoreContext, claim: string): Promise<ClaimedOwner | null> {
  const row = expectOk(
    await new Database(ctx.env.DB).first<{
      id: string;
      email: string;
      passkeys: number;
      first_signed_in_at: number | null;
    }>(
      `SELECT u.id, u.email, u.first_signed_in_at, (SELECT count(*) FROM passkeys p WHERE p.user_id = u.id) AS passkeys
         FROM users u WHERE u.created_attempt_id = ? AND u.role = 'owner'`,
      claim,
    ),
  );
  return row ? { id: row.id, email: row.email, passkeys: row.passkeys, firstSignedInAt: row.first_signed_in_at } : null;
}

/** `POST /setup`: claims the workspace for the canonical origin `origin` and creates the owner. */
export async function claimSetup(
  ctx: CoreContext,
  secrets: IdentitySecrets,
  body: SetupBody,
  origin: string,
  retried = false,
): Promise<Result<SetupEnrolmentResult, ApiError>> {
  if (await isSetupComplete(ctx)) return err(NOT_FOUND);
  await expireIfStale(ctx);
  await ensureGeneratedToken(ctx);
  const token = await checkSetupToken(ctx, body.token);
  if (!token.ok) return token;

  const now = ctx.now();
  const nonce = ulid();
  const host = new URL(origin).host;
  const db = new Database(ctx.env.DB);
  const claimGuard = token.value.storedHash === null ? "" : " AND setup_token_hash = ?";
  const claimParams = token.value.storedHash === null ? [] : [token.value.storedHash];
  const claimed = expectOk(
    await db.batchRun([
      // Secret mode may reach here before any row exists.
      db.statement(
        "INSERT INTO installation (id, installation_id, name) VALUES (1, ?, '') ON CONFLICT (id) DO NOTHING",
        ulid(),
      ),
      db.statement(
        `UPDATE installation
            SET setup_claim = ?, setup_claimed_at = ?, canonical_origin = ?, allowed_hosts = ?, name = ?
          WHERE id = 1 AND setup_claim IS NULL AND setup_completed_at IS NULL${claimGuard}`,
        nonce,
        now,
        origin,
        JSON.stringify([host]),
        body.workspaceName,
        ...claimParams,
      ),
      await auditStatement(
        ctx,
        // "setupVia", not a token-named key: the audit writer redacts those.
        { action: "setup.claim", actor: null, metadata: { setupVia: token.value.source } },
        { onlyIfPreviousChanged: true },
      ),
    ]),
  );
  if ((claimed[1]?.changes ?? 0) !== 1) {
    if (await isSetupComplete(ctx)) return err(NOT_FOUND);
    const installation = await loadInstallation(ctx.env.DB);
    // A claim whose owner row never got written (a crash mid-claim) is released, and this claim retried.
    if (installation?.setupClaim && !retried && (await releaseOrphanedClaim(ctx, installation.setupClaim))) {
      return claimSetup(ctx, secrets, body, origin, true);
    }
    if (installation?.setupClaim) {
      return err(apiError("conflict", "Setup has already been claimed. Resume it with the same setup token."));
    }
    return err(INVALID_TOKEN); // the generated token was replaced since it was checked
  }

  let owner: Result<string, ApiError>;
  try {
    owner = await createOwner(ctx, secrets, body, origin, nonce);
  } catch (error) {
    // A real failure (D1 inside better-auth, say): never leave a claim without an owner behind.
    await releaseOrphanedClaim(ctx, nonce);
    throw error;
  }
  if (!owner.ok) {
    await releaseOrphanedClaim(ctx, nonce);
    return owner;
  }
  const ticket = await issueTicket(ctx.env.DB, secrets.tokenHashKey, owner.value, "setup", nonce, now);
  ctx.log.info("setup claimed", { ownerId: owner.value });
  return ok({ ownerEmail: body.ownerEmail, ticket });
}

/** Creates the owner through better-auth inside the setup marker, then claims the handle. */
async function createOwner(
  ctx: CoreContext,
  secrets: IdentitySecrets,
  body: SetupBody,
  origin: string,
  nonce: string,
): Promise<Result<string, ApiError>> {
  const auth = authFor(ctx.env, secrets, { canonicalOrigin: origin, workspaceName: body.workspaceName });
  const internal = (await auth.$context).internalAdapter;
  const store = {
    ...(currentStore() ?? {}),
    create: { kind: "setup" as const, attemptId: nonce, role: "owner" as const, handle: body.ownerHandle },
  };
  const user = await runWithStore(store, () =>
    internal.createUser(
      { email: body.ownerEmail, name: body.ownerName, emailVerified: true },
      { method: "officebox-setup" },
    ),
  );
  if (!user) {
    ctx.log.error("setup: owner creation refused");
    return err(apiError("conflict", "The owner account couldn't be created."));
  }
  const db = new Database(ctx.env.DB);
  const handle = await db.run(
    "INSERT INTO handles (handle, owner_type, owner_id, created_attempt_id) VALUES (?, 'user', ?, ?)",
    body.ownerHandle,
    user.id,
    nonce,
  );
  if (!handle.ok) ctx.log.warn("setup: handle already taken; the owner keeps the copy only", { ownerId: user.id });
  return ok(user.id);
}

/** `POST /setup/resume`: a new ticket for the claimed owner, while they have no passkey or session. */
export async function resumeSetup(
  ctx: CoreContext,
  secrets: IdentitySecrets,
  presented: string,
): Promise<Result<SetupEnrolmentResult, ApiError>> {
  if (await isSetupComplete(ctx)) return err(NOT_FOUND);
  await expireIfStale(ctx);
  const token = await checkSetupToken(ctx, presented);
  if (!token.ok) return token;
  const installation = await loadInstallation(ctx.env.DB);
  const claim = installation?.setupClaim;
  if (!claim) return err(apiError("gone", "There's no setup in progress to resume. Start setup again."));
  const owner = await claimedOwner(ctx, claim);
  if (!owner) {
    // The claim never got its owner (a crash mid-claim): release it so setup can start again.
    await releaseOrphanedClaim(ctx, claim);
    return err(
      apiError("conflict", "The earlier setup didn't finish and was reset. Start setup again.", {
        reason: "setup_released",
      }),
    );
  }
  if (owner.passkeys > 0 || owner.firstSignedInAt !== null) {
    return err(apiError("gone", "This setup can't be resumed: the owner already has a passkey or has signed in."));
  }
  const ticket = await issueTicket(ctx.env.DB, secrets.tokenHashKey, owner.id, "setup", claim, ctx.now());
  await audit(ctx, { action: "setup.resume", actor: null, target: { type: "user", id: owner.id } });
  return ok({ ownerEmail: owner.email, ticket });
}

/** The repair job's setup half: completes setup when the claimed owner has a passkey (TDD §6.8). */
export async function repairSetup(ctx: CoreContext): Promise<boolean> {
  const installation = await loadInstallation(ctx.env.DB);
  if (!installation?.setupClaim || installation.setupCompletedAt !== null) return false;
  const owner = await claimedOwner(ctx, installation.setupClaim);
  if (!owner || owner.passkeys === 0) return false;
  return completeSetupClaim(ctx, installation.setupClaim, owner.id);
}

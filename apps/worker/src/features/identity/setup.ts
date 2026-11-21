import {
  apiError,
  err,
  ok,
  SETUP_OPEN_WINDOW_MS,
  type ApiError,
  type Result,
  type SetupBody,
  type SetupMode,
  type SetupStatus,
} from "@officebox/shared";
import { audit, auditStatement } from "../../core/audit";
import type { CoreContext } from "../../core/context";
import { Database, expectOk } from "../../core/db";
import { ulid } from "../../core/ids";
import { authFor } from "./auth";
import { randomToken, tokenHash } from "./crypto";
import { issueTicket, type IssuedTicket } from "./enrolment";
import { freeHeldHandleStatement, handleAvailability, handleError } from "./handles";
import { clearPageInstallationCache, loadInstallation } from "./installation";
import { runWithStore, currentStore } from "./request-store";
import type { IdentitySecrets } from "./secrets";
import type { ServicesReport } from "./services";
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
 *
 * **Quick start (M1b-1; Identity §4.1, TDD §6.8):**
 * - **Open claim window.** With no `SETUP_TOKEN` secret, setup needs no token for 60 minutes from
 *   `installation.setup_opened_at`, which the first setup status request or claim whose
 *   required-services check passes records once (`… WHERE setup_opened_at IS NULL`). A claim without a
 *   token adds `AND setup_opened_at > :now - 60 min` to its own atomic `UPDATE`, so the server decides
 *   at the claim; a late one answers `setup_token_required`. The window never restarts. With
 *   `SETUP_TOKEN` set there is no window. An open-window claim returns a **setup resume code** once
 *   (`auth_tokens.kind = 'setup_resume'`, hashed, bound to the owner and the claim, expiring with it),
 *   which `POST /setup/resume` accepts in place of the token.
 * - **Release outside the app.** `scripts/setup-release.sql` releases an unfinished claim and sets
 *   `setup_opened_at = 0`. The next setup request (or the hourly repair job) turns 0 into -1 by
 *   compare-and-set and, only if that matched, writes `setup.released_outside_app` in the same batch,
 *   so one release gives exactly one entry. 0 and -1 both mean the window is over.
 */

export const SETUP_CLAIM_TTL_MS = 24 * 60 * 60 * 1000;

const NOT_FOUND: ApiError = apiError("not_found", "No such endpoint.");
const INVALID_TOKEN: ApiError = apiError("forbidden", "The setup token is not valid.");
export const SETUP_TOKEN_REQUIRED: ApiError = apiError(
  "setup_token_required",
  "The open setup period is over. Enter the setup token to continue.",
);
export const SETUP_SERVICES_FAILING: ApiError = apiError(
  "setup_services_failing",
  "A required service isn't working yet. Fix the items on the setup checklist, then try again.",
);

export interface SetupEnrolmentResult {
  ownerEmail: string;
  ticket: IssuedTicket;
  /** The setup resume code, returned once by an open-window claim. */
  resumeCode?: string;
}

// ---- The open claim window (M1b-1) ------------------------------------------------------------

/** `installation.setup_opened_at`: null before the window starts, 0 or -1 once a release ended it. */
export async function readSetupOpenedAt(ctx: CoreContext): Promise<number | null> {
  const row = expectOk(
    await new Database(ctx.env.DB).first<{ setup_opened_at: number | null }>(
      "SELECT setup_opened_at FROM installation WHERE id = 1",
    ),
  );
  return row?.setup_opened_at ?? null;
}

/**
 * Starts the open claim window, once: only in generated-token mode (no `SETUP_TOKEN`), only while it
 * hasn't started and nothing has been claimed or completed. The row may not exist yet. Concurrent
 * first requests agree on one time; a later request never moves it.
 */
export async function startOpenWindow(ctx: CoreContext): Promise<void> {
  if (setupTokenSource(ctx.env) !== "generated") return;
  expectOk(
    await new Database(ctx.env.DB).run(
      `INSERT INTO installation (id, installation_id, name, setup_opened_at) VALUES (1, ?, '', ?)
       ON CONFLICT (id) DO UPDATE SET setup_opened_at = excluded.setup_opened_at
        WHERE installation.setup_opened_at IS NULL AND installation.setup_claim IS NULL
          AND installation.setup_completed_at IS NULL`,
      ulid(),
      ctx.now(),
    ),
  );
}

/** The mode a setup request is in, from the recorded window start (never from the request). */
export function windowState(ctx: CoreContext, openedAt: number | null): { mode: SetupMode; openUntil?: number } {
  if (setupTokenSource(ctx.env) !== "generated" || openedAt === null || openedAt <= 0) return { mode: "token" };
  const openUntil = openedAt + SETUP_OPEN_WINDOW_MS;
  return ctx.now() < openUntil ? { mode: "open", openUntil } : { mode: "token" };
}

/**
 * Audits a release made outside the app (`scripts/setup-release.sql`): turns the marker 0 into -1 by
 * compare-and-set and writes `setup.released_outside_app` in the same batch only if that matched, so
 * concurrent observers write one entry. Returns whether this call wrote it.
 */
export async function observeRelease(ctx: CoreContext): Promise<boolean> {
  const db = new Database(ctx.env.DB);
  const result = expectOk(
    await db.batchRun([
      db.statement("UPDATE installation SET setup_opened_at = -1 WHERE id = 1 AND setup_opened_at = 0"),
      await auditStatement(
        ctx,
        { action: "setup.released_outside_app", actor: null, metadata: { observedAt: ctx.now() } },
        { onlyIfPreviousChanged: true },
      ),
    ]),
  );
  const observed = (result[0]?.changes ?? 0) === 1;
  if (observed) ctx.log.warn("a setup release made outside the app was observed and audited");
  return observed;
}

/**
 * Observes a release only when the marker says there is one (a read first, so most requests and the
 * hourly job don't write). Returns whether this call wrote the audit entry.
 */
export async function observeReleaseIfMarked(ctx: CoreContext): Promise<boolean> {
  return (await readSetupOpenedAt(ctx)) === 0 ? observeRelease(ctx) : false;
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
 * Undoes a claim whose owner was created but whose later steps failed: deletes that owner (only while
 * it has no passkey and never signed in; its tickets and resume code go with it) and their handle,
 * then releases the claim, which now has no owner row. The window and the setup token are kept.
 */
export async function undoClaim(ctx: CoreContext, claim: string, ownerId: string): Promise<void> {
  try {
    const db = new Database(ctx.env.DB);
    expectOk(
      await db.batchRun([
        db.statement(
          `DELETE FROM users WHERE id = ? AND created_attempt_id = ? AND role = 'owner'
              AND NOT EXISTS (SELECT 1 FROM passkeys WHERE user_id = users.id) AND first_signed_in_at IS NULL`,
          ownerId,
          claim,
        ),
        db.statement(
          "DELETE FROM handles WHERE created_attempt_id = ? AND NOT EXISTS (SELECT 1 FROM users WHERE created_attempt_id = ?)",
          claim,
          claim,
        ),
      ]),
    );
    await releaseOrphanedClaim(ctx, claim);
  } catch (error) {
    // The 24-hour expiry (or the release script) still releases it. A fixed message and the error's
    // name only: raw D1 error text can carry SQL or values.
    ctx.log.error("setup: couldn't undo a failed claim", {
      errorName: error instanceof Error ? error.name : "unknown",
    });
  }
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

/**
 * `GET /setup`: the status, after the required-services check (`report`). When every service passes,
 * the open claim window starts (once). While D1 itself fails, only the checklist is returned.
 */
export async function setupStatus(ctx: CoreContext, report: ServicesReport): Promise<Result<SetupStatus, ApiError>> {
  const tokenSource = setupTokenSource(ctx.env);
  if (!report.d1Ok) {
    return ok({
      setupRequired: true,
      tokenSource,
      claimed: false,
      services: report.services,
      mode: "token",
      now: ctx.now(),
    });
  }
  if (await isSetupComplete(ctx)) return err(NOT_FOUND);
  await observeReleaseIfMarked(ctx);
  await expireIfStale(ctx);
  await ensureGeneratedToken(ctx);
  if (report.allOk) await startOpenWindow(ctx);
  const installation = await loadInstallation(ctx.env.DB);
  const window = windowState(ctx, await readSetupOpenedAt(ctx));
  return ok({
    setupRequired: true,
    tokenSource,
    claimed: installation?.setupClaim != null,
    services: report.services,
    ...window,
    now: ctx.now(),
  });
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
  await observeReleaseIfMarked(ctx);
  await expireIfStale(ctx);
  await ensureGeneratedToken(ctx);

  const now = ctx.now();
  const presented = body.token ?? "";
  // A claim with a token is a token-mode claim, inside the window or not; without one, it's an
  // open-mode claim, which the atomic UPDATE below allows only while the window lasts.
  let mode: SetupMode = "token";
  let claimGuard = "";
  let claimParams: (string | number)[] = [];
  let setupVia: string | null = null;
  if (presented !== "") {
    const token = await checkSetupToken(ctx, presented);
    if (!token.ok) return token;
    setupVia = token.value.source;
    if (token.value.storedHash !== null) {
      claimGuard = " AND setup_token_hash = ?";
      claimParams = [token.value.storedHash];
    }
  } else {
    if (setupTokenSource(ctx.env) !== "generated") return err(SETUP_TOKEN_REQUIRED);
    await startOpenWindow(ctx); // a claim may be the first setup request
    mode = "open";
    claimGuard = " AND setup_opened_at > ?";
    claimParams = [now - SETUP_OPEN_WINDOW_MS];
  }

  // The owner's handle must be claimable (M1d): before any claim, the only rows are reserved ones (the
  // assistant's derived handle), which the shared rules can't see.
  const handleState = await handleAvailability(ctx.env.DB, body.ownerHandle, null, now);
  if (!handleState.available) return err(handleError(handleState.reason ?? "taken"));

  const nonce = ulid();
  const host = new URL(origin).host;
  const db = new Database(ctx.env.DB);
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
        { action: "setup.claim", actor: null, metadata: setupVia ? { mode, setupVia } : { mode } },
        { onlyIfPreviousChanged: true },
      ),
    ]),
  );
  // The canonical origin was just recorded: this isolate's pages see it at once.
  clearPageInstallationCache(ctx.env.DB);
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
    // Open mode: the window ended (or was never open). Token mode: the generated token was replaced.
    return err(mode === "open" ? SETUP_TOKEN_REQUIRED : INVALID_TOKEN);
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
  let ticket: IssuedTicket;
  let resumeCode: string | undefined;
  try {
    ticket = await issueTicket(ctx.env.DB, secrets.tokenHashKey, owner.value, "setup", nonce, now);
    resumeCode = mode === "open" ? await issueResumeCode(ctx, secrets, owner.value, nonce, now) : undefined;
  } catch (error) {
    // Without its ticket or resume code an open-window claimer couldn't resume: undo the claim so
    // setup can be tried again at once, rather than locking it for 24 hours.
    await undoClaim(ctx, nonce, owner.value);
    throw error;
  }
  // One line for the operator (Identity §4.1): mode, time, origin and country; never an email or name.
  const country = currentStore()?.cf?.country;
  ctx.log.info("officebox setup claimed", {
    mode,
    claimedAt: new Date(now).toISOString(),
    origin,
    country: typeof country === "string" && country !== "" ? country : null,
  });
  return ok(resumeCode ? { ownerEmail: body.ownerEmail, ticket, resumeCode } : { ownerEmail: body.ownerEmail, ticket });
}

/**
 * The setup resume code of an open-window claim (Identity §2 "Resuming an open-window claim"): 32
 * random bytes, stored as HMAC(TOKEN_HASH_KEY) in `auth_tokens` with `kind = 'setup_resume'`, bound
 * to the owner and the claim nonce, expiring with the claim. It goes away with the owner if the claim
 * expires or is released (the row cascades with the user).
 */
async function issueResumeCode(
  ctx: CoreContext,
  secrets: IdentitySecrets,
  ownerId: string,
  claim: string,
  now: number,
): Promise<string> {
  const code = randomToken(32);
  expectOk(
    await new Database(ctx.env.DB).run(
      `INSERT INTO auth_tokens (token_hash, user_id, kind, payload, expires_at, created_at)
       VALUES (?, ?, 'setup_resume', ?, ?, ?)`,
      await tokenHash(secrets.tokenHashKey, code),
      ownerId,
      JSON.stringify({ claim }),
      now + SETUP_CLAIM_TTL_MS,
      now,
    ),
  );
  return code;
}

/** Whether `presented` is a live setup resume code for the current claim's owner. */
async function isResumeCode(ctx: CoreContext, secrets: IdentitySecrets, presented: string, claim: string) {
  const row = expectOk(
    await new Database(ctx.env.DB).first<{ ok: number }>(
      `SELECT 1 AS ok FROM auth_tokens t JOIN users u ON u.id = t.user_id
        WHERE t.token_hash = ? AND t.kind = 'setup_resume' AND t.revoked_at IS NULL AND t.expires_at > ?
          AND json_extract(t.payload, '$.claim') = ? AND u.created_attempt_id = ? AND u.role = 'owner'`,
      await tokenHash(secrets.tokenHashKey, presented),
      ctx.now(),
      claim,
      claim,
    ),
  );
  return row?.ok === 1;
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
  const handle = await db.batchRun([
    freeHeldHandleStatement(db, body.ownerHandle, ctx.now()),
    db.statement(
      "INSERT INTO handles (handle, owner_type, owner_id, created_attempt_id) VALUES (?, 'user', ?, ?)",
      body.ownerHandle,
      user.id,
      nonce,
    ),
  ]);
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
  await observeReleaseIfMarked(ctx);
  await expireIfStale(ctx);
  const installation = await loadInstallation(ctx.env.DB);
  const token = await checkSetupToken(ctx, presented);
  if (!token.ok) {
    // After an open-window claim, the setup resume code takes the token's place (M1b-1).
    const isCode =
      token.error.code === "forbidden" &&
      installation?.setupClaim != null &&
      (await isResumeCode(ctx, secrets, presented, installation.setupClaim));
    if (!isCode) return token;
  }
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

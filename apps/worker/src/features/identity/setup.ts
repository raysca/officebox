import {
  apiError,
  err,
  ok,
  type ApiError,
  type Result,
  type SetupBody,
  type SetupResult,
  type SetupStatus,
} from "@officebox/shared";
import { auditStatement } from "../../core/audit";
import type { CoreContext } from "../../core/context";
import { Database, expectOk } from "../../core/db";
import { ulid } from "../../core/ids";
import { checkLimit } from "../../core/rate-limit";
import { clientIp } from "./device";
import { IDENTITY_LIMITS } from "./limits";
import { hashPassword } from "./password";
import type { IdentitySecrets } from "./secrets";
import { isSetupComplete, markSetupComplete } from "./setup-state";
import { checkSetupToken, ensureGeneratedToken, setupTokenSource } from "./setup-token";

/**
 * First-run setup (Identity §4.1, TDD §6.8). Creates **identity objects only**: the installation row
 * (with the workspace name and default settings, which are the registry defaults until changed), the
 * owner's user and their handle. `#general`, calendars and drives arrive with M3a, M5a and M6a.
 *
 * The claim is one atomic D1 batch: the guarded `UPDATE installation … WHERE setup_completed_at IS
 * NULL` lets exactly one request win, and the user, handle and audit inserts only take effect for the
 * request whose nonce was written. After setup, `/api/setup` answers 404 for good.
 */

const NOT_FOUND: ApiError = apiError("not_found", "No such endpoint.");

export async function setupStatus(ctx: CoreContext): Promise<Result<SetupStatus, ApiError>> {
  if (await isSetupComplete(ctx)) return err(NOT_FOUND);
  await ensureGeneratedToken(ctx);
  return ok({ setupRequired: true, tokenSource: setupTokenSource(ctx.env) });
}

export async function completeSetup(
  ctx: CoreContext,
  secrets: IdentitySecrets,
  body: SetupBody,
  request: Request,
): Promise<Result<SetupResult, ApiError>> {
  const limited = await checkLimit(ctx, IDENTITY_LIMITS.setup, clientIp(request));
  if (!limited.ok) return limited;
  if (await isSetupComplete(ctx)) return err(NOT_FOUND);

  await ensureGeneratedToken(ctx);
  const token = await checkSetupToken(ctx, body.token);
  if (!token.ok) return token;

  const now = ctx.now();
  const nonce = ulid();
  const ownerId = ulid();
  const passwordHash = await hashPassword(body.password, secrets.peppers);
  const db = new Database(ctx.env.DB);
  const claimGuard = token.value.storedHash === null ? "" : " AND setup_token_hash = ?";
  const claimParams = token.value.storedHash === null ? [] : [token.value.storedHash];

  const statements = [
    // Secret mode may reach here before any row exists.
    db.statement(
      "INSERT INTO installation (id, installation_id, name) VALUES (1, ?, '') ON CONFLICT (id) DO NOTHING",
      ulid(),
    ),
    db.statement(
      `UPDATE installation
          SET setup_claim = ?, setup_completed_at = ?, setup_token_hash = NULL, setup_token_expires_at = NULL, name = ?
        WHERE id = 1 AND setup_completed_at IS NULL${claimGuard}`,
      nonce,
      now,
      body.workspaceName,
      ...claimParams,
    ),
    db.statement(
      `INSERT INTO users (id, email, display_name, handle, password_hash, role, status, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, 'owner', 'active', ?, ? FROM installation WHERE id = 1 AND setup_claim = ?`,
      ownerId,
      body.ownerEmail,
      body.ownerName,
      body.ownerHandle,
      passwordHash,
      now,
      now,
      nonce,
    ),
    db.statement(
      `INSERT INTO handles (handle, owner_type, owner_id)
       SELECT ?, 'user', ? FROM installation WHERE id = 1 AND setup_claim = ?`,
      body.ownerHandle,
      ownerId,
      nonce,
    ),
    await auditStatement(
      ctx,
      {
        action: "setup.complete",
        actor: ownerId,
        target: { type: "user", id: ownerId },
        // "setupVia", not a token-named key: the audit writer redacts those.
        metadata: { setupVia: token.value.source },
      },
      { onlyIfPreviousChanged: true },
    ),
  ];
  const result = await db.batchRun(statements);
  if (!result.ok) {
    // Only reachable if identity rows exist without a completed setup (a damaged database).
    ctx.log.error("setup batch failed on a constraint", { kind: result.error.kind });
    return err(apiError("conflict", "Setup couldn't complete. Check the database."));
  }
  const claimed = (result.value[1]?.changes ?? 0) === 1;
  if (!claimed) {
    // Another request won the claim, or the generated token was replaced since it was checked.
    return (await isSetupComplete(ctx)) ? err(NOT_FOUND) : err(apiError("forbidden", "The setup token is not valid."));
  }
  markSetupComplete(ctx.env.DB);
  ctx.log.info("first-run setup complete", { ownerId });
  return ok({ ownerEmail: body.ownerEmail });
}

/** Reads the installation row's workspace name (for `GET /me`). */
export async function workspaceName(ctx: CoreContext): Promise<string> {
  const row = expectOk(
    await new Database(ctx.env.DB).first<{ name: string }>("SELECT name FROM installation WHERE id = 1"),
  );
  return row?.name ?? "";
}

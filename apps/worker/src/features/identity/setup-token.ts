import { apiError, err, ok, type ApiError, type Result, type SetupTokenSource } from "@officebox/shared";
import type { CoreContext } from "../../core/context";
import { Database, expectOk } from "../../core/db";
import { ulid } from "../../core/ids";
import type { LogSink } from "../../core/log";
// The one permitted importer of logUnredacted (eslint.config.js): the generated token must reach the
// operator verbatim through Workers Logs, which only members of the Cloudflare account can read.
import { logUnredacted } from "../../core/log-unredacted";
import { base64url, fromBase64url, randomToken, sha256, timingSafeEqual } from "./crypto";

/**
 * The first-run setup token (TDD §6.8).
 *
 * 1. **`SETUP_TOKEN` secret set** (non-empty): it is the token. It must be at least 32 characters;
 *    a shorter one makes setup answer `unavailable` until it's fixed.
 * 2. **Empty or unset:** on the first visit the Worker generates 32 random bytes, stores only their
 *    SHA-256 hash with a 24-hour expiry in the installation row (`INSERT … ON CONFLICT DO NOTHING`,
 *    so concurrent first requests make a single token) and logs the token **once** with
 *    `logUnredacted`. An expired token is replaced, with a compare-and-set on the old hash and
 *    expiry, and the new one is logged.
 *
 * Presented tokens are hashed and compared in constant time.
 */

export const SETUP_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
export const MIN_SETUP_TOKEN_LENGTH = 32;

interface InstallationTokenRow {
  setup_token_hash: string | null;
  setup_token_expires_at: number | null;
  setup_completed_at: number | null;
}

export function setupTokenSource(env: CoreContext["env"]): SetupTokenSource {
  return env.SETUP_TOKEN !== undefined && env.SETUP_TOKEN !== "" ? "secret" : "generated";
}

async function readRow(ctx: CoreContext): Promise<InstallationTokenRow | null> {
  return expectOk(
    await new Database(ctx.env.DB).first<InstallationTokenRow>(
      "SELECT setup_token_hash, setup_token_expires_at, setup_completed_at FROM installation WHERE id = 1",
    ),
  );
}

async function hashToken(token: string): Promise<string> {
  return base64url(await sha256(token));
}

/**
 * In generated-token mode, makes sure an unexpired token exists, creating (or replacing an expired
 * one) and logging it. Does nothing once setup is complete or when the secret is set.
 */
export async function ensureGeneratedToken(ctx: CoreContext, sink?: LogSink): Promise<void> {
  if (setupTokenSource(ctx.env) !== "generated") return;
  const now = ctx.now();
  const row = await readRow(ctx);
  if (row?.setup_completed_at != null) return;
  if (row?.setup_token_hash && (row.setup_token_expires_at ?? 0) > now) return;

  const token = randomToken(32);
  const hash = await hashToken(token);
  const expiresAt = now + SETUP_TOKEN_TTL_MS;
  const db = new Database(ctx.env.DB);
  const meta = row
    ? expectOk(
        await db.run(
          `UPDATE installation SET setup_token_hash = ?, setup_token_expires_at = ?
            WHERE id = 1 AND setup_completed_at IS NULL
              AND setup_token_hash IS ? AND setup_token_expires_at IS ?`,
          hash,
          expiresAt,
          row.setup_token_hash,
          row.setup_token_expires_at,
        ),
      )
    : expectOk(
        // installation_id is fixed here for good; the name is set by setup.
        await db.run(
          `INSERT INTO installation (id, installation_id, name, setup_token_hash, setup_token_expires_at)
           VALUES (1, ?, '', ?, ?) ON CONFLICT (id) DO NOTHING`,
          ulid(),
          hash,
          expiresAt,
        ),
      );
  if (meta.changes === 0) return; // another request created or replaced it, and logged its own
  logUnredacted(
    "officebox setup token",
    {
      setupToken: token,
      expiresAt: new Date(expiresAt).toISOString(),
      instructions: "Open /setup in your browser and paste this token. It works once and expires in 24 hours.",
    },
    sink,
  );
}

export interface CheckedSetupToken {
  source: SetupTokenSource;
  /** In generated mode, the stored hash the claim must still match (so a replaced token can't win). */
  storedHash: string | null;
}

const INVALID_TOKEN: ApiError = apiError("forbidden", "The setup token is not valid.");

/** Checks a presented token against the secret or the stored hash. */
export async function checkSetupToken(
  ctx: CoreContext,
  presented: string,
): Promise<Result<CheckedSetupToken, ApiError>> {
  const presentedHash = await sha256(presented);
  if (setupTokenSource(ctx.env) === "secret") {
    const secret = ctx.env.SETUP_TOKEN ?? "";
    if (secret.length < MIN_SETUP_TOKEN_LENGTH) {
      ctx.log.error("SETUP_TOKEN is shorter than 32 characters; setup is disabled until it is fixed");
      return err(apiError("unavailable", "Setup isn't configured correctly. Check the SETUP_TOKEN secret."));
    }
    const matches = timingSafeEqual(presentedHash, await sha256(secret));
    return matches ? ok({ source: "secret", storedHash: null }) : err(INVALID_TOKEN);
  }
  const row = await readRow(ctx);
  const stored = row?.setup_token_hash ? fromBase64url(row.setup_token_hash) : null;
  if (!row?.setup_token_hash || !stored || (row.setup_token_expires_at ?? 0) <= ctx.now()) return err(INVALID_TOKEN);
  return timingSafeEqual(presentedHash, stored)
    ? ok({ source: "generated", storedHash: row.setup_token_hash })
    : err(INVALID_TOKEN);
}

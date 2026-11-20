import type { PersonRef } from "@officebox/shared";
import type { AppContext, AuthContext } from "../../core/context";
import { coreContext } from "../../core/context";
import { Database, expectOk } from "../../core/db";
import type { PermissionContext, PermissionFacts } from "../../core/permissions";
import { tokenHashKeyOrNull } from "../../core/keys";
import { rootLogger } from "../../core/log";
import type { Env } from "../../env";
import { magicLinksAvailable } from "../email/config";
import { recoveryTokenHashes, timingSafeEqual } from "./crypto";
import { MIN_SECRET_BYTES } from "./secrets";

/**
 * The permission engine's fact loaders, on D1 (M1p `authorize`, Permissions §8). Every loader reads the
 * D1 primary at the time of the check (no caching across requests), so a change just committed counts.
 */
export function d1Facts(env: Env): PermissionFacts {
  const db = new Database(env.DB);
  return {
    async person(userId) {
      const row = expectOk(
        await db.first<{ id: string; role: string; status: string }>(
          "SELECT id, role, status FROM users WHERE id = ?",
          userId,
        ),
      );
      // Unknown role or status values are parsed (and refused) by `authorize`.
      return row ? ({ userId: row.id, role: row.role, status: row.status } as PersonRef) : null;
    },
    async activeOwnerCount() {
      const row = expectOk(
        await db.first<{ n: number }>("SELECT count(*) AS n FROM users WHERE role = 'owner' AND status = 'active'"),
      );
      return row?.n ?? 0;
    },
    async passkeyCount(userId) {
      const row = expectOk(
        await db.first<{ n: number }>("SELECT count(*) AS n FROM passkeys WHERE user_id = ?", userId),
      );
      return row?.n ?? 0;
    },
    async recoveryTokenUnconsumed() {
      return recoveryTokenUnconsumed(env);
    },
    magicLinksAvailable() {
      // Email configured and `magic_link_enabled` on (Identity §2 "Removing the last passkey").
      return magicLinksAvailable({ env, log: rootLogger, now: Date.now });
    },
    groupManagerIds() {
      // Groups arrive in M1e; until then no group exists.
      return Promise.resolve(null);
    },
  };
}

/**
 * The state of `RECOVERY_TOKEN` (Identity §4.6): `unset` (absent or shorter than 32 characters),
 * `unconsumed`, or `consumed` (its hash is in `recovery_token_uses`).
 */
export async function recoveryTokenState(env: Env): Promise<"unset" | "unconsumed" | "consumed"> {
  const secret = env.RECOVERY_TOKEN;
  if (!secret || [...secret].length < MIN_SECRET_BYTES) return "unset";
  // The Worker secret, or the key the Worker generated (M1b-1).
  // Uses are keyed by plain SHA-256 (M1c); older rows by HMAC(TOKEN_HASH_KEY), checked too when a key can
  // be had, so nothing already used becomes usable again.
  const key = await tokenHashKeyOrNull(env, rootLogger);
  const { hash, legacy } = await recoveryTokenHashes(key, secret);
  const rows = expectOk(
    await new Database(env.DB).all<{ token_hash: string }>("SELECT token_hash FROM recovery_token_uses"),
  );
  const encoder = new TextEncoder();
  const targets = [encoder.encode(hash), encoder.encode(legacy)];
  // Constant-time comparison against every recorded use.
  let used = false;
  for (const row of rows) {
    const stored = encoder.encode(row.token_hash);
    for (const target of targets) used = timingSafeEqual(target, stored) || used;
  }
  return used ? "consumed" : "unconsumed";
}

/** `RECOVERY_TOKEN` is set (at least 32 characters) and its hash isn't in `recovery_token_uses` (Identity §4.6). */
export async function recoveryTokenUnconsumed(env: Env): Promise<boolean> {
  return (await recoveryTokenState(env)) === "unconsumed";
}

/** The engine's actor for a signed-in request. */
export function actorOf(auth: AuthContext): PermissionContext["actor"] {
  return {
    userId: auth.userId,
    role: auth.role,
    status: auth.status,
    session: { freshAuthAt: auth.freshAuthAt, freshAuthMethod: auth.freshAuthMethod },
  };
}

/** The permission context for a route behind `requireAuth`. */
export function permissionContext(c: AppContext, auth: AuthContext): PermissionContext {
  const ctx = coreContext(c);
  return { log: ctx.log, now: ctx.now, actor: actorOf(auth), facts: d1Facts(c.env) };
}

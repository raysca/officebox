import type { Logger } from "../../core/log";

/**
 * Socket revocation (Identity §4.5; TDD §3.5).
 *
 * Every revocation (sign out, a device signed out from My devices, sign out everywhere, and later an
 * admin sign-out, disabling a member or using a recovery link) must close that session's live sockets
 * within seconds. Sockets don't exist until M2, so this is the **interface and a stub**: better-auth's
 * `databaseHooks.session.delete.after` calls {@link closeSessionConnections} for every deleted session
 * row (sign-out, revoke one, revoke others, revoke all all fire it per row; M1a-0 spike Q4d), and the
 * stub logs and notifies test listeners.
 *
 * TODO(M2): implement `UserHubRevoker` over the UserHub Durable Object: `closeConnections(userId,
 * reason, scope)` closes the hub sockets carrying that session ID (or all of the user's) with close
 * code 4401 and calls `closeConnections` on every room in its registry, with the Worker-side fallback
 * that recomputes rooms from D1 (TDD §3.5, Platform §12).
 *
 * **The recheck plan (sessions that expire on their own).** better-auth fires no hook when a session
 * simply expires: it deletes the row, and fires the hook, only when the expired cookie is next
 * presented. So from M2 the UserHub's alarm (every 5 minutes, with the presence heartbeat) rechecks
 * each connected session's row and closes sockets whose row is gone **or whose `expires_at` is in the
 * past** (TDD §3.5). Revocations that bypass better-auth (raw SQL deletes) would skip the hook, so our
 * code revokes only through better-auth's internal adapter or `auth.api`.
 */

export type RevocationReason = "session_revoked";

export type RevocationScope = { sessionId: string } | "all";

export interface UserHubRevoker {
  closeConnections(userId: string, reason: RevocationReason, scope: RevocationScope): Promise<void>;
}

export type RevocationListener = (userId: string, reason: RevocationReason, scope: RevocationScope) => void;

const listeners = new Set<RevocationListener>();

/** Observes revocations (tests). Returns an unsubscribe function. */
export function onRevocation(listener: RevocationListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The M1a stub: there are no sockets yet, so it records the call. */
export function stubRevoker(log: Logger): UserHubRevoker {
  return {
    closeConnections(userId, reason, scope) {
      log.info("revocation: close connections (stub until M2)", {
        userId,
        reason,
        scope: scope === "all" ? "all" : "session",
      });
      for (const listener of listeners) listener(userId, reason, scope);
      return Promise.resolve();
    },
  };
}

/** Called for every deleted session row. Failures are logged, never thrown into better-auth. */
export async function closeSessionConnections(log: Logger, userId: string, sessionId: string): Promise<void> {
  try {
    await stubRevoker(log).closeConnections(userId, "session_revoked", { sessionId });
  } catch (error) {
    log.error("revocation failed", { error, userId });
  }
}

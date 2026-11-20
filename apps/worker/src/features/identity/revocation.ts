import type { RevocationReason } from "@officebox/shared";
import type { Logger } from "../../core/log";
import type { Env } from "../../env";
import { executeUserRevocation } from "../realtime/revocation";

/**
 * WebSocket revocation on session deletion or user disable (TDD §3.5; Identity §4.5; Platform §12).
 *
 * Every session deletion in better-auth (`databaseHooks.session.delete.after`) calls
 * {@link closeSessionConnections}: sign-out, "My devices" revoke, "Sign out all other devices" and
 * "Sign out everywhere". Disabling or deleting a user calls {@link closeAllUserConnections} with
 * `scope: "all"`. Both invoke `UserHub.closeConnections` + the Worker-side D1 room-recomputation
 * fallback, and notify any registered test listeners ({@link onRevocation}).
 */

export type RevocationScope = "all" | { sessionId: string };
export type RevocationListener = (userId: string, reason: string, scope: RevocationScope) => void;

const listeners = new Set<RevocationListener>();

/** Registers a listener (used by tests); returns a function that removes it. */
export function onRevocation(listener: RevocationListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Called when a session row is deleted: closes that session's sockets (`4401`) within 5 seconds. */
export async function closeSessionConnections(
  log: Logger,
  userId: string,
  sessionId: string,
  env?: Pick<Env, "DB" | "USER_HUB">,
): Promise<void> {
  const scope: RevocationScope = { sessionId };
  log.info("session revoked; closing connections", { userId, sessionId });
  for (const listener of listeners) listener(userId, "session_revoked", scope);
  if (env) {
    await executeUserRevocation(env, log, userId, "session_revoked", scope);
  }
}

/** Called when a user is disabled, deleted or signed out across all sessions (`scope: "all"`). */
export async function closeAllUserConnections(
  env: Pick<Env, "DB" | "USER_HUB">,
  log: Logger,
  userId: string,
  reason: RevocationReason = "user_disabled",
): Promise<void> {
  const scope: RevocationScope = "all";
  log.info("user revoked; closing all connections", { userId, reason });
  for (const listener of listeners) listener(userId, reason, scope);
  await executeUserRevocation(env, log, userId, reason, scope);
}

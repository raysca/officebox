import type { HubActivityEvent } from "@officebox/shared";
import type { Env } from "../../env";

/**
 * Batched fan-out helper (M2a; TDD §3.4, Platform §11).
 *
 * When a channel or room event needs to reach multiple members' `UserHub`s:
 * 1. Reads the workspace online user list from `WorkspacePresence.listOnline()`, cached per isolate
 *    for 5 seconds (`ONLINE_CACHE_TTL_MS`) so bursts of activity don't query `WorkspacePresence` on
 *    every message.
 * 2. Intersects the target `recipientIds` with the online users (plus any caller-requested force list).
 * 3. Sends a single `deliverActivity(events)` RPC per online recipient for the entire batch.
 *    Offline users receive nothing over WebSocket; they read from D1 when they next open the app.
 */

export const ONLINE_CACHE_TTL_MS = 5_000;

interface CachedOnlineSet {
  ids: Set<string>;
  expiresAt: number;
}

let cache = new WeakMap<object, CachedOnlineSet>();

/** Clears the 5-second isolate online-user cache (used in tests). */
export function clearOnlineUsersCache(): void {
  cache = new WeakMap();
}

export async function getOnlineUserIds(env: Pick<Env, "PRESENCE">, now = Date.now()): Promise<ReadonlySet<string>> {
  const key = env.PRESENCE as unknown as object;
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) {
    return hit.ids;
  }
  const result = await env.PRESENCE.getByName("presence").listOnline();
  const ids = new Set<string>(result.ok ? result.value.map((entry) => entry.userId) : []);
  if (result.ok) {
    cache.set(key, { ids, expiresAt: now + ONLINE_CACHE_TTL_MS });
  }
  return ids;
}

export interface FanOutReport {
  onlineRecipients: string[];
  deliveredSockets: number;
  rpcCalls: number;
}

/**
 * Delivers `events` to every online user in `recipientIds` using at most one `UserHub.deliverActivity`
 * RPC per online recipient.
 */
export async function fanOutToOnlineUsers(
  env: Pick<Env, "PRESENCE" | "USER_HUB">,
  recipientIds: Iterable<string>,
  events: readonly HubActivityEvent[],
  now = Date.now(),
): Promise<FanOutReport> {
  if (events.length === 0) {
    return { onlineRecipients: [], deliveredSockets: 0, rpcCalls: 0 };
  }
  const uniqueRecipients = [...new Set(recipientIds)];
  if (uniqueRecipients.length === 0) {
    return { onlineRecipients: [], deliveredSockets: 0, rpcCalls: 0 };
  }

  const onlineIds = await getOnlineUserIds(env, now);
  const onlineRecipients = uniqueRecipients.filter((id) => onlineIds.has(id));
  if (onlineRecipients.length === 0) {
    return { onlineRecipients: [], deliveredSockets: 0, rpcCalls: 0 };
  }

  const batch = [...events];
  const results = await Promise.allSettled(
    onlineRecipients.map((userId) => env.USER_HUB.getByName(userId).deliverActivity(batch)),
  );

  let deliveredSockets = 0;
  for (const r of results) {
    if (r.status === "fulfilled" && r.value.ok) {
      deliveredSockets += r.value.value.delivered;
    }
  }

  return {
    onlineRecipients,
    deliveredSockets,
    rpcCalls: onlineRecipients.length,
  };
}

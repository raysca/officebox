import {
  WS_CLOSE_ACCESS_REMOVED,
  WS_CLOSE_SESSION_REVOKED,
  type RevocationReason,
  type RoomKind,
} from "@officebox/shared";
import { Database } from "../../core/db";
import type { Logger } from "../../core/log";
import type { Env } from "../../env";
import type { RegisteredRoomEntry, RevocationScopeInput } from "./user-hub-do";

/**
 * WebSocket revocation & access update dispatcher (M2a; TDD §3.5; Identity §4.5; Platform §12).
 *
 * When a session is revoked or a user is disabled/deleted:
 * 1. Calls `UserHub(userId).closeConnections(userId, reason, scope)` to close the user's hub sockets
 *    with `4401` (`WS_CLOSE_SESSION_REVOKED`) and retrieve registered room connections.
 * 2. Runs the Worker-side D1 room-recomputation fallback (TDD §3.5): queries the rooms the user can
 *    access in D1 (`channel_members`, `resource_grants`, `project_members` when those tables exist in
 *    later milestones) and merges them with the `room_registry` entries from `UserHub`, so a room
 *    whose registration RPC failed is still closed.
 * 3. Notifies registered room closers (wired as each room DO arrives in M3a/M4/M5a/M6a/M9/M10).
 */

export interface RoomCloseEvent {
  userId: string;
  kind: RoomKind;
  roomId: string;
  connectionId: string | null;
  sessionId: string | null;
  code: number;
  reason: string;
}

export type RoomCloser = (event: RoomCloseEvent) => Promise<void> | void;

const roomClosers = new Map<RoomKind, Set<RoomCloser>>();

/** Registers a room-socket closer for `kind` (or all kinds via `onRoomClose`). Returns an unsubscribe function. */
export function registerRoomCloser(kind: RoomKind, closer: RoomCloser): () => void {
  let set = roomClosers.get(kind);
  if (!set) {
    set = new Set();
    roomClosers.set(kind, set);
  }
  set.add(closer);
  return () => {
    set?.delete(closer);
  };
}

/**
 * Recomputes rooms the user may have open from D1 tables (TDD §3.5 fallback for failed
 * `registerRoom` RPCs). Queries each table only if it exists in the current schema.
 */
export async function recomputeUserRoomsFromD1(
  db: D1Database,
  userId: string,
): Promise<Array<{ kind: RoomKind; roomId: string }>> {
  const database = new Database(db);
  const rooms: Array<{ kind: RoomKind; roomId: string }> = [];

  // Check which room membership tables exist in D1 (channels arrive in M3a, resources in M6a, projects in M10a).
  const tablesRes = await database.all<{ name: string }>(
    `SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN ('channel_members', 'resource_grants', 'project_members')`,
  );
  if (!tablesRes.ok) return rooms;
  const tableNames = new Set(tablesRes.value.map((t) => t.name));

  if (tableNames.has("channel_members")) {
    const res = await database.all<{ channel_id: string }>(
      "SELECT channel_id FROM channel_members WHERE user_id = ?",
      userId,
    );
    if (res.ok) {
      for (const row of res.value) rooms.push({ kind: "channel", roomId: row.channel_id });
    }
  }

  if (tableNames.has("resource_grants")) {
    const res = await database.all<{ resource_type: string; resource_id: string }>(
      `SELECT resource_type, resource_id FROM resource_grants
        WHERE principal_type = 'user' AND principal_id = ?
          AND resource_type IN ('document', 'whiteboard', 'project')`,
      userId,
    );
    if (res.ok) {
      for (const row of res.value) {
        const kind: RoomKind =
          row.resource_type === "document" ? "doc" : row.resource_type === "whiteboard" ? "board" : "project";
        rooms.push({ kind, roomId: row.resource_id });
      }
    }
  }

  if (tableNames.has("project_members")) {
    const res = await database.all<{ project_id: string }>(
      "SELECT project_id FROM project_members WHERE user_id = ?",
      userId,
    );
    if (res.ok) {
      for (const row of res.value) rooms.push({ kind: "project", roomId: row.project_id });
    }
  }

  return rooms;
}

export async function dispatchRoomCloses(events: readonly RoomCloseEvent[]): Promise<void> {
  const tasks: Array<Promise<unknown>> = [];
  for (const event of events) {
    const closers = roomClosers.get(event.kind);
    if (!closers) continue;
    for (const closer of closers) {
      tasks.push(Promise.resolve().then(() => closer(event)));
    }
  }
  if (tasks.length > 0) {
    await Promise.allSettled(tasks);
  }
}

export interface RevocationResult {
  closedHubSockets: number;
  closedRooms: RegisteredRoomEntry[];
  fallbackRooms: Array<{ kind: RoomKind; roomId: string }>;
}

/**
 * Closes a user's hub and room connections for `scope` (`"all"` or `{ sessionId }`), and runs the
 * Worker-side D1 room-recomputation fallback (TDD §3.5).
 */
export async function executeUserRevocation(
  env: Pick<Env, "DB" | "USER_HUB">,
  log: Logger,
  userId: string,
  reason: RevocationReason,
  scope: RevocationScopeInput,
): Promise<RevocationResult> {
  let closedHubSockets = 0;
  let closedRooms: RegisteredRoomEntry[] = [];

  if (env.USER_HUB) {
    try {
      const res = await env.USER_HUB.getByName(userId).closeConnections(userId, reason, scope);
      if (res.ok) {
        closedHubSockets = res.value.closedHubSockets;
        closedRooms = res.value.closedRooms;
      } else {
        log.warn("UserHub.closeConnections returned an error", { userId, reason, code: res.error.code });
      }
    } catch (error) {
      log.error("UserHub.closeConnections failed", { userId, reason, error });
    }
  }

  // Worker-side D1 room-recomputation fallback (TDD §3.5).
  const d1Rooms = env.DB ? await recomputeUserRoomsFromD1(env.DB, userId) : [];
  const registeredKeySet = new Set(closedRooms.map((r) => `${r.kind}:${r.roomId}`));
  const fallbackRooms = d1Rooms.filter((r) => !registeredKeySet.has(`${r.kind}:${r.roomId}`));

  const roomEvents: RoomCloseEvent[] = [
    ...closedRooms.map((r) => ({
      userId,
      kind: r.kind,
      roomId: r.roomId,
      connectionId: r.connectionId,
      sessionId: r.sessionId || null,
      code: WS_CLOSE_SESSION_REVOKED,
      reason,
    })),
    ...fallbackRooms.map((r) => ({
      userId,
      kind: r.kind,
      roomId: r.roomId,
      connectionId: null,
      sessionId: scope === "all" ? null : scope.sessionId,
      code: WS_CLOSE_SESSION_REVOKED,
      reason,
    })),
  ];

  await dispatchRoomCloses(roomEvents);
  return { closedHubSockets, closedRooms, fallbackRooms };
}

/**
 * Updates a user's access on a room (`role` or `null` when removed; TDD §3.5).
 * When `role === null`, closes any registered sockets for that room with `4403`, and falls back to
 * dispatching a room close for `(roomKind, roomId)` even if `room_registry` had no entry.
 */
export async function updateUserRoomAccess(
  env: Pick<Env, "USER_HUB">,
  log: Logger,
  userId: string,
  roomKind: RoomKind,
  roomId: string,
  role: string | null,
): Promise<{ delivered: number; closedRooms: RegisteredRoomEntry[] }> {
  if (!env.USER_HUB) return { delivered: 0, closedRooms: [] };
  try {
    const res = await env.USER_HUB.getByName(userId).updateRoomAccess(userId, roomKind, roomId, role);
    if (!res.ok) {
      log.warn("UserHub.updateRoomAccess returned an error", { userId, roomKind, roomId, code: res.error.code });
      if (role === null) {
        await dispatchRoomCloses([
          {
            userId,
            kind: roomKind,
            roomId,
            connectionId: null,
            sessionId: null,
            code: WS_CLOSE_ACCESS_REMOVED,
            reason: "access_removed",
          },
        ]);
      }
      return { delivered: 0, closedRooms: [] };
    }
    if (role === null) {
      const events: RoomCloseEvent[] =
        res.value.closedRooms.length > 0
          ? res.value.closedRooms.map((r) => ({
              userId,
              kind: r.kind,
              roomId: r.roomId,
              connectionId: r.connectionId,
              sessionId: r.sessionId || null,
              code: WS_CLOSE_ACCESS_REMOVED,
              reason: "access_removed",
            }))
          : [
              {
                userId,
                kind: roomKind,
                roomId,
                connectionId: null,
                sessionId: null,
                code: WS_CLOSE_ACCESS_REMOVED,
                reason: "access_removed",
              },
            ];
      await dispatchRoomCloses(events);
    }
    return { delivered: res.value.delivered, closedRooms: res.value.closedRooms };
  } catch (error) {
    log.error("UserHub.updateRoomAccess failed", { userId, roomKind, roomId, error });
    if (role === null) {
      await dispatchRoomCloses([
        {
          userId,
          kind: roomKind,
          roomId,
          connectionId: null,
          sessionId: null,
          code: WS_CLOSE_ACCESS_REMOVED,
          reason: "access_removed",
        },
      ]);
    }
    return { delivered: 0, closedRooms: [] };
  }
}

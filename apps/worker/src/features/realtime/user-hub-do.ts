import {
  ACTIVE_WINDOW_MS,
  derivedAvailabilitySchema,
  effectiveStatus,
  HUB_HEARTBEAT_MS,
  hubClientMessages,
  ok,
  statusLine,
  WS_CLOSE_ACCESS_REMOVED,
  WS_CLOSE_SESSION_REVOKED,
  type DerivedAvailability,
  type HubActivityEvent,
  type HubServerMessage,
  type PresenceState,
  type RevocationReason,
  type RoomKind,
} from "@officebox/shared";
import { z } from "zod";
import { Database, expectOk } from "../../core/db";
import { CoreDurableObject, type DoMigration, type RpcResult } from "../../core/do/base";
import { setAttachment } from "../../core/do/websocket";
import { ulid } from "../../core/ids";
import { computeDerivedAvailability, loadAvailabilityInputs, nextAvailabilityBoundary } from "./availability";
import { dispatchRoomCloses } from "./revocation";

/**
 * `UserHub` Durable Object (M2a; TDD §2.2, §3.1, §3.4, §3.5; Notifications §5.5–5.7; Platform §11–12).
 *
 * One instance per user (`env.USER_HUB.getByName(userId)`).
 *
 * - **WebSocket hub:** each browser tab (or its `BroadcastChannel` leader) opens one WebSocket here.
 *   Attachments carry `{ userId, sessionId, connId, visible, lastInputAt }`, persisted across
 *   hibernation via `serializeAttachment`.
 * - **2-minute active rule (Notifications §5.5):** a user is `online` when at least one connected tab
 *   is `visible` and had user input within the last 2 minutes (`ACTIVE_WINDOW_MS`); `idle` when sockets
 *   are connected without recent visible input; `offline` when no sockets remain. An `active_expiry`
 *   timer transitions `online` → `idle` when the 2-minute window elapses without new input.
 * - **Derived availability (Notifications §5.6–5.7):** computed from `user_availability`,
 *   `user_preferences` and raw presence; persisted in `meta('derived_availability')` so it survives
 *   eviction (`evictDurableObject`) and cold starts. An `availability_expiry` timer re-computes when
 *   a time-bounded status (`away`, `dnd`, `focus`, `scheduled_dnd`) expires.
 * - **5-minute heartbeat & session-expiry recheck (TDD §3.5, Platform §11–12):** while sockets are
 *   open, `heartbeat:tick` fires every 5 minutes, rechecks `users.status === 'active'` and each
 *   connected session's `expires_at > now` in D1, closes any expired or revoked session's sockets with
 *   `4401`, sweeps stale `room_registry` rows, and sends a heartbeat to `WorkspacePresence`.
 * - **Status text (M1d; Identity §4.7, Notifications §5.5):** the member's manual status (emoji and text)
 *   is read from D1 by `refreshStatus` (after `PUT /me/status`) and when the member comes online, kept
 *   in `meta('status_text')`, and published to `WorkspacePresence` with their presence. A
 *   `status_expiry` timer clears it from presence when it expires (Platform §11's ReminderScheduler
 *   `status_expire` kind isn't built yet; the hub's own alarm does it until then, default).
 * - **Room registry & revocation (TDD §3.5):** rooms register/unregister open sockets in
 *   `room_registry`. `closeConnections(userId, reason, scope)` closes matching hub sockets and
 *   dispatches room closes for registered rooms.
 */

const MIGRATIONS: readonly DoMigration[] = [
  {
    version: 1,
    description: "room registry for revocation fan-out",
    up(sql) {
      sql.exec(`
        CREATE TABLE IF NOT EXISTS room_registry (
          kind TEXT NOT NULL,
          room_id TEXT NOT NULL,
          connection_id TEXT NOT NULL,
          session_id TEXT NOT NULL DEFAULT '',
          registered_at INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL,
          PRIMARY KEY (kind, room_id, connection_id)
        )
      `);
      sql.exec("CREATE INDEX IF NOT EXISTS room_registry_seen ON room_registry(last_seen_at)");
      sql.exec("CREATE INDEX IF NOT EXISTS room_registry_session ON room_registry(session_id)");
    },
  },
];

export const hubSocketAttachmentSchema = z.object({
  userId: z.string().min(1),
  sessionId: z.string().min(1),
  connId: z.string().min(1),
  visible: z.boolean(),
  lastInputAt: z.number().int().nonnegative(),
});
export type HubSocketAttachment = z.infer<typeof hubSocketAttachmentSchema>;

export interface RegisteredRoomEntry {
  kind: RoomKind;
  roomId: string;
  connectionId: string;
  sessionId: string;
  registeredAt: number;
  lastSeenAt: number;
}

export type RevocationScopeInput = "all" | { sessionId: string };

export interface DeliverPresenceChangeInput {
  userId: string;
  state: PresenceState;
  lastSeenAt: number;
  statusText: string | null;
  availability?: DerivedAvailability;
}

interface RoomRow extends Record<string, SqlStorageValue> {
  kind: string;
  room_id: string;
  connection_id: string;
  session_id: string;
  registered_at: number;
  last_seen_at: number;
}

export class UserHub extends CoreDurableObject {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.onTimer("heartbeat", () => this.onHeartbeatTimer());
    this.onTimer("active_expiry", () => this.onActiveExpiryTimer());
    this.onTimer("availability_expiry", () => this.onAvailabilityExpiryTimer());
    this.onTimer("status_expiry", () => this.onStatusExpiryTimer());
  }

  protected override migrations(): readonly DoMigration[] {
    return MIGRATIONS;
  }

  private now(): number {
    const offset = Number(this.getMeta("test_time_offset_ms") ?? "0");
    return Date.now() + offset;
  }

  private userId(): string | null {
    const stored = this.getMeta("user_id");
    if (stored) return stored;
    const first = this.sockets(hubSocketAttachmentSchema)[0]?.[1];
    if (first) {
      this.setMeta("user_id", first.userId);
      return first.userId;
    }
    return null;
  }

  private storedAvailability(): DerivedAvailability | null {
    const raw = this.getMeta("derived_availability");
    if (!raw) return null;
    try {
      const parsed = derivedAvailabilitySchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  private storeAvailability(availability: DerivedAvailability): boolean {
    const nextJson = JSON.stringify(availability);
    const prevJson = this.getMeta("derived_availability");
    this.setMeta("derived_availability", nextJson);
    return prevJson !== nextJson;
  }

  private openSockets(exclude?: ReadonlySet<WebSocket>): Array<[WebSocket, HubSocketAttachment]> {
    return this.sockets(hubSocketAttachmentSchema).filter(([ws]) => ws.readyState === 1 && !exclude?.has(ws));
  }

  /**
   * Computes current raw presence from open hub sockets and schedules/cancels the `active_expiry`
   * timer so a visible tab with no new input transitions `online` → `idle` after 2 minutes.
   */
  private evaluatePresence(now = this.now(), exclude?: ReadonlySet<WebSocket>): PresenceState {
    const attached = this.openSockets(exclude);
    if (attached.length === 0) {
      this.cancelTimer("active_expiry:window");
      return "offline";
    }
    let latestExpiry: number | null = null;
    for (const [, a] of attached) {
      if (!a.visible) continue;
      const expiresAt = a.lastInputAt + ACTIVE_WINDOW_MS;
      if (expiresAt > now && (latestExpiry === null || expiresAt > latestExpiry)) {
        latestExpiry = expiresAt;
      }
    }
    if (latestExpiry !== null) {
      this.setTimer("active_expiry:window", latestExpiry);
      return "online";
    }
    this.cancelTimer("active_expiry:window");
    return "idle";
  }

  /**
   * Recomputes derived availability from D1 (`user_availability` + `user_preferences`) and current
   * raw presence, persists it in SQLite `meta`, schedules the next expiry boundary if time-bounded,
   * and notifies connected sockets if it changed.
   */
  private async recomputeAvailability(
    userId: string,
    presence: PresenceState,
    now = this.now(),
    broadcastToSockets = true,
  ): Promise<{ availability: DerivedAvailability; changed: boolean }> {
    const inputs = await loadAvailabilityInputs(this.env.DB, userId, presence);
    const availability = computeDerivedAvailability(inputs, now);
    const changed = this.storeAvailability(availability);
    this.setMeta("has_dnd_schedule", inputs.dndSchedule ? "1" : "0");

    const nextBoundary = nextAvailabilityBoundary(inputs, now);
    if (nextBoundary !== null) {
      this.setTimer("availability_expiry:window", nextBoundary);
    } else {
      this.cancelTimer("availability_expiry:window");
    }

    if (changed && broadcastToSockets) {
      this.broadcast({
        type: "status.changed",
        userId,
        availability,
      });
    }
    return { availability, changed };
  }

  /** Syncs raw presence + derived availability with `WorkspacePresence` and local sockets. */
  private async syncPresenceAndAvailability(
    userId: string,
    now = this.now(),
    forceRecompute = false,
    exclude?: ReadonlySet<WebSocket>,
  ): Promise<{
    presence: PresenceState;
    availability: DerivedAvailability;
  }> {
    const prevPresence = this.getMeta("presence_state") as PresenceState | null;
    const presence = this.evaluatePresence(now, exclude);
    this.setMeta("presence_state", presence);

    // Avoid hitting D1 on unchanged `tab.state` frames when cached availability is still valid (H2).
    const cached = this.storedAvailability();
    const canReuseCached =
      !forceRecompute &&
      prevPresence === presence &&
      cached !== null &&
      (cached.until === null || cached.until > now) &&
      (cached.source !== "presence" || cached.state === presence);

    if (canReuseCached) {
      return { presence, availability: cached };
    }

    const { availability, changed: availChanged } = await this.recomputeAvailability(userId, presence, now, true);
    const presenceStub = this.env.PRESENCE.getByName("presence");
    if (presence === "offline") {
      await presenceStub.setOffline(userId, availability);
    } else if (prevPresence !== presence || availChanged) {
      // Coming online: read the status afresh (it may have been set while no tab was open).
      const statusText =
        prevPresence === null || prevPresence === "offline"
          ? await this.loadStatusText(userId, now)
          : this.getMeta("status_text") || null;
      await presenceStub.setOnline(userId, presence, statusText, availability);
    }
    return { presence, availability };
  }

  private broadcast(message: HubServerMessage): number {
    const payload = JSON.stringify(message);
    let delivered = 0;
    for (const [ws] of this.sockets(hubSocketAttachmentSchema)) {
      try {
        ws.send(payload);
        delivered += 1;
      } catch {
        // Closed socket will be cleaned up by webSocketClose.
      }
    }
    return delivered;
  }

  // ------------------------------------------------------------------ WebSocket upgrade & events

  protected override async onFetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/ws" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Not found", { status: 404 });
    }
    const userId = request.headers.get("X-User-Id") ?? url.searchParams.get("userId");
    const sessionId = request.headers.get("X-Session-Id") ?? url.searchParams.get("sessionId");
    if (!userId || !sessionId) {
      return new Response("Missing userId or sessionId", { status: 400 });
    }

    const now = this.now();
    const connId = ulid();
    this.setMeta("user_id", userId);

    const attachment: HubSocketAttachment = {
      userId,
      sessionId,
      connId,
      visible: true,
      lastInputAt: now,
    };

    const response = this.acceptSocket(hubSocketAttachmentSchema, attachment, [
      `user:${userId}`,
      `session:${sessionId}`,
      `conn:${connId}`,
    ]);

    // Ensure the 5-minute heartbeat timer is running while at least one socket is open.
    this.setTimer("heartbeat:tick", now + HUB_HEARTBEAT_MS, { ifEarlier: true });

    const { presence, availability } = await this.syncPresenceAndAvailability(userId, now, true);
    const onlineRes = await this.env.PRESENCE.getByName("presence").listOnline();
    const online = onlineRes.ok ? onlineRes.value : [];

    // Send `hub.welcome` to the newly connected socket.
    const newlyAccepted = this.sockets(hubSocketAttachmentSchema, `conn:${connId}`)[0]?.[0];
    if (newlyAccepted) {
      const welcome: HubServerMessage = {
        type: "hub.welcome",
        userId,
        sessionId,
        connectionId: connId,
        presence,
        availability,
        online,
      };
      try {
        newlyAccepted.send(JSON.stringify(welcome));
      } catch {
        // Socket closed immediately.
      }
    }

    return response;
  }

  protected override async onSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    const parsed = hubClientMessages.parseText(message);
    if (!parsed.ok) return;

    const current = this.sockets(hubSocketAttachmentSchema).find(([socket]) => socket === ws)?.[1];
    if (!current) return;

    const msg = parsed.value;
    if (msg.type === "tab.state") {
      const now = this.now();
      // Clamp client-reported `lastInputAt` so a skewed client clock cannot pin `online` in the future.
      const clampedInputAt = Math.min(msg.lastInputAt, now);
      const updated: HubSocketAttachment = {
        ...current,
        visible: msg.visible,
        lastInputAt: clampedInputAt,
      };
      setAttachment(ws, hubSocketAttachmentSchema, updated);
      await this.syncPresenceAndAvailability(current.userId, now, false);
    }
  }

  protected override async onSocketClose(ws: WebSocket, _code: number, _reason: string): Promise<void> {
    await this.afterSocketDisconnect(ws);
  }

  protected override async onSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    await this.afterSocketDisconnect(ws);
  }

  private async afterSocketDisconnect(closingWs: WebSocket): Promise<void> {
    const exclude = new Set<WebSocket>([closingWs]);
    const remaining = this.openSockets(exclude);
    if (remaining.length === 0) {
      this.cancelTimer("heartbeat:tick");
      this.cancelTimer("active_expiry:window");
    }
    const uid = this.userId();
    if (uid) {
      await this.syncPresenceAndAvailability(uid, this.now(), false, exclude);
    }
  }

  // ------------------------------------------------------------------ Timers

  private async onActiveExpiryTimer(): Promise<void> {
    const uid = this.userId();
    if (!uid) return;
    await this.syncPresenceAndAvailability(uid, this.now(), false);
  }

  private async onStatusExpiryTimer(): Promise<void> {
    const uid = this.userId();
    if (!uid) return;
    await this.syncStatus(uid);
  }

  /**
   * Reads the member's status from D1 (hidden once expired) and schedules the `status_expiry` timer for
   * its expiry. Returns the one-line form, or null. With `remember` (the default, used when the member
   * comes online and the line goes to presence with `setOnline`) it also stores the line in
   * `meta('status_text')`; `syncStatus` stores it only once presence has it.
   */
  private async loadStatusText(userId: string, now = this.now(), remember = true): Promise<string | null> {
    const row = expectOk(
      await new Database(this.env.DB).first<{
        status_emoji: string | null;
        status_text: string | null;
        status_expires_at: number | null;
      }>("SELECT status_emoji, status_text, status_expires_at FROM users WHERE id = ? AND status = 'active'", userId),
    );
    const status = row
      ? effectiveStatus({ emoji: row.status_emoji, text: row.status_text, expiresAt: row.status_expires_at }, now)
      : null;
    if (status?.expiresAt) this.setTimer("status_expiry:window", status.expiresAt);
    else this.cancelTimer("status_expiry:window");
    const line = statusLine(status);
    if (remember) this.setMeta("status_text", line ?? "");
    return line;
  }

  /**
   * Re-reads the status and, only if its line differs from the one last published, tells
   * `WorkspacePresence` (which updates online members). The new line is remembered only after presence
   * has it, so a failed call is retried by the next sync (the heartbeat or `refreshStatus`).
   */
  private async syncStatus(userId: string): Promise<string | null> {
    const published = this.getMeta("status_text") || null;
    const line = await this.loadStatusText(userId, this.now(), false);
    if (line !== published) {
      await this.env.PRESENCE.getByName("presence").setStatusText(userId, line);
      this.setMeta("status_text", line ?? "");
    }
    return line;
  }

  private async onAvailabilityExpiryTimer(): Promise<void> {
    const uid = this.userId();
    if (!uid) return;
    await this.syncPresenceAndAvailability(uid, this.now(), true);
  }

  /**
   * 5-minute heartbeat timer (TDD §3.5, Identity §4.5, Platform §11–12):
   * 1. Rechecks `users.status === 'active'` and each connected session's `expires_at > now` in D1.
   *    Any expired or missing session's sockets (hub + registered rooms) are closed with `4401`.
   * 2. Sends a heartbeat to `WorkspacePresence` if sockets remain open and reschedules `heartbeat:tick`.
   *
   * Note: `room_registry` entries are never pruned by age while sockets live (Platform §12).
   */
  private async onHeartbeatTimer(): Promise<void> {
    const now = this.now();

    const attached = this.openSockets();
    const uid = this.userId();
    if (attached.length === 0 || !uid) {
      if (uid) await this.syncPresenceAndAvailability(uid, now, false);
      return;
    }

    // Recheck user status and connected session expiry in D1.
    const db = new Database(this.env.DB);
    const userRow = expectOk(await db.first<{ status: string }>("SELECT status FROM users WHERE id = ?", uid));
    if (!userRow || userRow.status !== "active") {
      const closed = await this.closeConnectionsInternal(uid, "user_disabled", "all");
      if (closed.closedRooms.length > 0) {
        await dispatchRoomCloses(
          closed.closedRooms.map((r) => ({
            userId: uid,
            kind: r.kind,
            roomId: r.roomId,
            connectionId: r.connectionId,
            sessionId: r.sessionId || null,
            code: WS_CLOSE_SESSION_REVOKED,
            reason: "user_disabled",
          })),
        );
      }
      return;
    }

    const sessionIds = [...new Set(attached.map(([, a]) => a.sessionId))];
    for (const sessionId of sessionIds) {
      const sessionRow = expectOk(
        await db.first<{ expires_at: number }>(
          "SELECT expires_at FROM sessions WHERE id = ? AND user_id = ?",
          sessionId,
          uid,
        ),
      );
      if (!sessionRow || sessionRow.expires_at <= now) {
        const closed = await this.closeConnectionsInternal(uid, "session_revoked", { sessionId });
        if (closed.closedRooms.length > 0) {
          await dispatchRoomCloses(
            closed.closedRooms.map((r) => ({
              userId: uid,
              kind: r.kind,
              roomId: r.roomId,
              connectionId: r.connectionId,
              sessionId: r.sessionId || null,
              code: WS_CLOSE_SESSION_REVOKED,
              reason: "session_revoked",
            })),
          );
        }
      }
    }

    // Re-read remaining sockets after any expired-session closures.
    const remaining = this.openSockets();
    if (remaining.length === 0) {
      await this.syncPresenceAndAvailability(uid, now, false);
      return;
    }

    const { presence, availability } = await this.syncPresenceAndAvailability(uid, now, true);
    if (presence !== "offline") {
      await this.env.PRESENCE.getByName("presence").heartbeat(uid, presence, availability);
    }
    this.setTimer("heartbeat:tick", now + HUB_HEARTBEAT_MS);
    // Reconcile the status with D1 (M1d): catches up on a `refreshStatus` the Worker couldn't deliver
    // and re-arms the expiry timer. `syncStatus` tells presence only when the line differs from the one
    // it last published.
    try {
      await this.syncStatus(uid);
    } catch (error) {
      this.log.warn("user hub: status not reconciled", { error });
    }
  }

  private async closeConnectionsInternal(
    userId: string,
    reason: RevocationReason,
    scope: RevocationScopeInput,
  ): Promise<{ closedHubSockets: number; closedRooms: RegisteredRoomEntry[] }> {
    this.setMeta("user_id", userId);
    const targets =
      scope === "all"
        ? this.sockets(hubSocketAttachmentSchema)
        : this.sockets(hubSocketAttachmentSchema, `session:${scope.sessionId}`);

    const closing = new Set<WebSocket>();
    let closedHubSockets = 0;
    for (const [ws] of targets) {
      closing.add(ws);
      try {
        ws.close(WS_CLOSE_SESSION_REVOKED, reason);
        closedHubSockets += 1;
      } catch {
        // Already closed.
      }
    }

    const roomRows =
      scope === "all"
        ? this.sql
            .exec<RoomRow>(
              "SELECT kind, room_id, connection_id, session_id, registered_at, last_seen_at FROM room_registry",
            )
            .toArray()
        : this.sql
            .exec<RoomRow>(
              `SELECT kind, room_id, connection_id, session_id, registered_at, last_seen_at
                 FROM room_registry WHERE session_id = ?`,
              scope.sessionId,
            )
            .toArray();

    if (scope === "all") {
      this.sql.exec("DELETE FROM room_registry");
    } else {
      this.sql.exec("DELETE FROM room_registry WHERE session_id = ?", scope.sessionId);
    }

    const closedRooms: RegisteredRoomEntry[] = roomRows.map((r) => ({
      kind: r.kind as RoomKind,
      roomId: r.room_id,
      connectionId: r.connection_id,
      sessionId: r.session_id,
      registeredAt: r.registered_at,
      lastSeenAt: r.last_seen_at,
    }));

    const now = this.now();
    await this.syncPresenceAndAvailability(userId, now, false, closing);
    if (this.openSockets(closing).length === 0) {
      this.cancelTimer("heartbeat:tick");
      this.cancelTimer("active_expiry:window");
    }

    return { closedHubSockets, closedRooms };
  }

  // ------------------------------------------------------------------ RPC

  registerRoom(
    kind: RoomKind,
    roomId: string,
    connectionId: string,
    sessionId = "",
  ): Promise<RpcResult<{ registered: true }>> {
    return this.rpc(() => {
      const now = this.now();
      this.sql.exec(
        `INSERT INTO room_registry (kind, room_id, connection_id, session_id, registered_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (kind, room_id, connection_id) DO UPDATE SET
           session_id = excluded.session_id,
           last_seen_at = excluded.last_seen_at`,
        kind,
        roomId,
        connectionId,
        sessionId,
        now,
        now,
      );
      return ok({ registered: true as const });
    });
  }

  unregisterRoom(kind: RoomKind, roomId: string, connectionId: string): Promise<RpcResult<{ unregistered: true }>> {
    return this.rpc(() => {
      this.sql.exec(
        "DELETE FROM room_registry WHERE kind = ? AND room_id = ? AND connection_id = ?",
        kind,
        roomId,
        connectionId,
      );
      return ok({ unregistered: true as const });
    });
  }

  listRegisteredRooms(): Promise<RpcResult<RegisteredRoomEntry[]>> {
    return this.rpc(() => {
      const rows = this.sql
        .exec<RoomRow>(
          `SELECT kind, room_id, connection_id, session_id, registered_at, last_seen_at
             FROM room_registry ORDER BY kind, room_id, connection_id`,
        )
        .toArray();
      return ok(
        rows.map((r) => ({
          kind: r.kind as RoomKind,
          roomId: r.room_id,
          connectionId: r.connection_id,
          sessionId: r.session_id,
          registeredAt: r.registered_at,
          lastSeenAt: r.last_seen_at,
        })),
      );
    });
  }

  closeConnections(
    userId: string,
    reason: RevocationReason,
    scope: RevocationScopeInput = "all",
  ): Promise<RpcResult<{ closedHubSockets: number; closedRooms: RegisteredRoomEntry[] }>> {
    return this.rpc(async () => ok(await this.closeConnectionsInternal(userId, reason, scope)));
  }

  /**
   * Permission downgrade / access removal on a specific room (TDD §3.5 `updateAccess(userId, role)`).
   * Broadcasts `access.changed` to the user's hub sockets, and when `role === null` removes the room
   * from `room_registry` and returns the removed room entries so room sockets can be closed with `4403`.
   */
  updateRoomAccess(
    userId: string,
    roomKind: RoomKind,
    roomId: string,
    role: string | null,
  ): Promise<RpcResult<{ delivered: number; closedRooms: RegisteredRoomEntry[]; closeCode: number | null }>> {
    return this.rpc(() => {
      this.setMeta("user_id", userId);
      const delivered = this.broadcast({
        type: "access.changed",
        roomKind,
        roomId,
        role,
      });
      if (role !== null) {
        const result: { delivered: number; closedRooms: RegisteredRoomEntry[]; closeCode: number | null } = {
          delivered,
          closedRooms: [],
          closeCode: null,
        };
        return ok(result);
      }
      const rows = this.sql
        .exec<RoomRow>(
          `SELECT kind, room_id, connection_id, session_id, registered_at, last_seen_at
             FROM room_registry WHERE kind = ? AND room_id = ?`,
          roomKind,
          roomId,
        )
        .toArray();
      this.sql.exec("DELETE FROM room_registry WHERE kind = ? AND room_id = ?", roomKind, roomId);
      const result: { delivered: number; closedRooms: RegisteredRoomEntry[]; closeCode: number | null } = {
        delivered,
        closedRooms: rows.map((r) => ({
          kind: r.kind as RoomKind,
          roomId: r.room_id,
          connectionId: r.connection_id,
          sessionId: r.session_id,
          registeredAt: r.registered_at,
          lastSeenAt: r.last_seen_at,
        })),
        closeCode: WS_CLOSE_ACCESS_REMOVED,
      };
      return ok(result);
    });
  }

  /**
   * Re-reads `user_availability` and `user_preferences` from D1, updates stored derived availability,
   * syncs with `WorkspacePresence`, and broadcasts `status.changed` if it changed.
   */
  refreshAvailability(userId: string): Promise<RpcResult<DerivedAvailability>> {
    return this.rpc(async () => {
      this.setMeta("user_id", userId);
      const now = this.now();
      const { availability } = await this.syncPresenceAndAvailability(userId, now, true);
      return ok(availability);
    });
  }

  /**
   * Re-reads the member's manual status from D1 (after `PUT /me/status`, M1d), schedules its expiry and
   * publishes the one-line form to `WorkspacePresence`, which tells the other online members.
   */
  refreshStatus(userId: string): Promise<RpcResult<{ statusText: string | null }>> {
    return this.rpc(async () => {
      this.setMeta("user_id", userId);
      return ok({ statusText: await this.syncStatus(userId) });
    });
  }

  /**
   * Returns the user's current derived availability and raw presence. Serves unexpired persisted
   * availability from `meta('derived_availability')` (surviving DO eviction) when presence matches,
   * falling back to D1 recomputation when absent, expired, or presence changed.
   */
  getAvailability(userId: string): Promise<RpcResult<{ presence: PresenceState; availability: DerivedAvailability }>> {
    return this.rpc(async () => {
      this.setMeta("user_id", userId);
      const now = this.now();
      const presence = this.evaluatePresence(now);
      const stored = this.storedAvailability();
      const hasDndSchedule = this.getMeta("has_dnd_schedule") === "1";
      if (
        stored !== null &&
        (stored.until === null || stored.until > now) &&
        (stored.source !== "presence" || (stored.state === presence && !hasDndSchedule))
      ) {
        return ok({ presence, availability: stored });
      }
      const { availability } = await this.recomputeAvailability(userId, presence, now, false);
      return ok({ presence, availability });
    });
  }

  /** Delivers a batch of activity events to all connected hub sockets for this user (TDD §3.4). */
  deliverActivity(events: HubActivityEvent[]): Promise<RpcResult<{ delivered: number }>> {
    return this.rpc(() => {
      if (events.length === 0) return ok({ delivered: 0 });
      const delivered = this.broadcast({
        type: "hub.activity",
        events,
      });
      return ok({ delivered });
    });
  }

  /** Called by `WorkspacePresence` when a workspace member's presence or availability changes. */
  deliverPresenceChange(change: DeliverPresenceChangeInput): Promise<RpcResult<{ delivered: number }>> {
    return this.rpc(() => {
      const delivered = this.broadcast({
        type: "presence.changed",
        userId: change.userId,
        state: change.state,
        lastSeenAt: change.lastSeenAt,
        statusText: change.statusText,
      });
      if (change.availability) {
        this.broadcast({
          type: "status.changed",
          userId: change.userId,
          availability: change.availability,
        });
      }
      return ok({ delivered });
    });
  }

  /** Returns the currently connected hub socket count and session IDs (for diagnostics and tests). */
  connectedInfo(): Promise<
    RpcResult<{
      socketCount: number;
      sessionIds: string[];
      presence: PresenceState;
      storedAvailability: DerivedAvailability | null;
    }>
  > {
    return this.rpc(() => {
      const attached = this.openSockets();
      return ok({
        socketCount: attached.length,
        sessionIds: [...new Set(attached.map(([, a]) => a.sessionId))],
        presence: this.evaluatePresence(this.now()),
        storedAvailability: this.storedAvailability(),
      });
    });
  }
}

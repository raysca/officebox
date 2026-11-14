// UserHub Durable Object: one per user. Holds the user's hub sockets (one per tab) and delivers
// activity, inbox and presence events; tracks which rooms the user is connected to for revocation (TDD §3.5).
import { DurableObject } from "cloudflare:workers";
import type { Env, HubActivity } from "./env";
import { HEARTBEAT_INTERVAL_MS, PRESENCE_STATUSES, type PresenceChange, type PresenceStatus } from "./presence";

export type RoomKind = "channel" | "doc";

interface HubAttachment {
  userId: string;
  connId: string;
}

/** Room registrations older than this are pruned (they are only hints for revocation). */
export const ROOM_REGISTRATION_TTL_MS = 24 * 60 * 60 * 1000;

export class UserHub extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
    this.sql.exec(`CREATE TABLE IF NOT EXISTS rooms (
      kind TEXT NOT NULL,
      id TEXT NOT NULL,
      registered_at INTEGER NOT NULL,
      PRIMARY KEY (kind, id)
    )`);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  private get presence() {
    return this.env.PRESENCE.get(this.env.PRESENCE.idFromName("presence"));
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }
    const userId = request.headers.get("x-ob-user");
    if (!userId) return new Response("Missing connection identity", { status: 400 });
    this.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('user_id', ?)", userId);

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    const attachment: HubAttachment = { userId, connId: crypto.randomUUID() };
    server.serializeAttachment(attachment);

    if (this.ctx.getWebSockets().length === 1) {
      // First tab: announce the user and start heartbeats.
      await this.presence.online(userId, "online");
      await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_INTERVAL_MS);
    }
    server.send(JSON.stringify({ type: "welcome", online: await this.presence.list() }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    if (typeof data !== "string") return;
    let msg: { type?: string; status?: string };
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    const { userId } = ws.deserializeAttachment() as HubAttachment;
    if (msg.type === "status" && PRESENCE_STATUSES.includes(msg.status as PresenceStatus)) {
      await this.presence.setStatus(userId, msg.status as PresenceStatus);
      // Tell the user's other tabs too.
      this.send({ type: "presence", userId, status: msg.status });
    }
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    const { userId } = ws.deserializeAttachment() as HubAttachment;
    const others = this.ctx.getWebSockets().filter((s) => s !== ws);
    if (others.length === 0) {
      await this.presence.offline(userId);
      await this.ctx.storage.deleteAlarm();
    }
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, "closing");
    } catch {
      // Already closed.
    }
  }

  async alarm(): Promise<void> {
    const sockets = this.ctx.getWebSockets();
    if (sockets.length === 0) return;
    const { userId } = sockets[0]!.deserializeAttachment() as HubAttachment;
    await this.presence.heartbeat(userId);
    this.sql.exec("DELETE FROM rooms WHERE registered_at < ?", Date.now() - ROOM_REGISTRATION_TTL_MS);
    await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_INTERVAL_MS);
  }

  // ------------------------------------------------------------------ RPC

  /** Fan-out delivery from the projection consumer: at most one call per consumer batch. */
  async activity(payload: HubActivity): Promise<number> {
    return this.send({ type: "activity", ...payload });
  }

  async presenceChanged(change: PresenceChange): Promise<void> {
    this.send({ type: "presence", ...change });
  }

  /** Channel and document DOs register each connection here so revocation can reach them. */
  async registerRoom(kind: RoomKind, id: string): Promise<void> {
    this.sql.exec(
      "INSERT INTO rooms (kind, id, registered_at) VALUES (?, ?, ?) ON CONFLICT (kind, id) DO UPDATE SET registered_at = excluded.registered_at",
      kind,
      id,
      Date.now(),
    );
  }

  /** Closes the user's hub sockets and every registered room connection, then marks them offline. */
  async revoke(userId: string, code = 4401, reason = "session revoked"): Promise<{ hub: number; rooms: number }> {
    const hubSockets = this.ctx.getWebSockets();
    for (const ws of hubSockets) ws.close(code, reason);
    const rooms = this.sql.exec("SELECT kind, id FROM rooms").toArray();
    const results = await Promise.allSettled(
      rooms.map((r) => {
        const id = String(r.id);
        return r.kind === "channel"
          ? this.env.CHAT.get(this.env.CHAT.idFromName(id)).closeConnections(userId, code, reason)
          : this.env.DOCS.get(this.env.DOCS.idFromName(id)).closeConnections(userId, code, reason);
      }),
    );
    this.sql.exec("DELETE FROM rooms");
    await this.ctx.storage.deleteAlarm();
    await this.presence.offline(userId);
    const closedRooms = results.reduce((n, r) => n + (r.status === "fulfilled" ? r.value : 0), 0);
    return { hub: hubSockets.length, rooms: closedRooms };
  }

  async roomCount(): Promise<number> {
    return Number(this.sql.exec("SELECT COUNT(*) AS n FROM rooms").one().n);
  }

  private send(message: unknown): number {
    const text = JSON.stringify(message);
    let sent = 0;
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(text);
        sent++;
      } catch {
        // Closing.
      }
    }
    return sent;
  }
}

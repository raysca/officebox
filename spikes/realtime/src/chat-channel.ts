// ChatChannel Durable Object: source of truth for one channel's messages (TDD §2.2, §3.3).
// Event log + current message state + transactional outbox, all in the object's SQLite storage.
import { DurableObject } from "cloudflare:workers";
import type { Env, ProjectionMessage } from "./env";

export type ChannelRole = "admin" | "member";

interface Attachment {
  userId: string;
  role: ChannelRole;
  connId: string;
}

export const MAX_BODY_BYTES = 40_000;
export const BATCH_DELAY_MS = 250;
export const OUTBOX_BATCH = 100;
export const SYNC_PAGE = 500;
export const HISTORY_PAGE_MAX = 100;
// Queues limits: 128 KB per message, 256 KB per sendBatch call. Stay well under the batch limit.
const QUEUE_BATCH_BYTES = 200_000;

const enc = new TextEncoder();

type Row = Record<string, SqlStorageValue>;

export interface ChannelEvent {
  seq: number;
  type: string;
  messageId: string;
  actorId: string;
  clientId: string | null;
  payload: unknown;
  createdAt: number;
}

export interface MessageState {
  id: string;
  seq: number;
  senderId: string;
  parentId: string | null;
  body: string | null;
  reactions: Record<string, string[]>;
  createdAt: number;
  editedAt: number | null;
  deletedAt: number | null;
  lastEventSeq: number;
}

export function backoffMs(attempts: number): number {
  return Math.min(1000 * 2 ** attempts, 5 * 60 * 1000);
}

export class ChatChannel extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.migrate();
    // Keepalives are answered by the runtime without waking the object (TDD §3.5).
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  // ---------------------------------------------------------------- schema

  private migrate(): void {
    this.sql.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
    const version = Number(this.getMeta("schema_version") ?? 0);
    if (version >= 1) return;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(`CREATE TABLE events (
        seq INTEGER PRIMARY KEY,
        type TEXT NOT NULL,
        message_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        client_id TEXT,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`);
      this.sql.exec("CREATE UNIQUE INDEX events_client ON events(actor_id, client_id) WHERE client_id IS NOT NULL");
      this.sql.exec("CREATE INDEX events_message ON events(message_id)");
      this.sql.exec(`CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        seq INTEGER NOT NULL UNIQUE,
        sender_id TEXT NOT NULL,
        parent_id TEXT,
        body TEXT,
        reactions TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        edited_at INTEGER,
        deleted_at INTEGER,
        last_event_seq INTEGER NOT NULL
      )`);
      this.sql.exec("CREATE INDEX messages_parent ON messages(parent_id) WHERE parent_id IS NOT NULL");
      this.sql.exec(`CREATE TABLE outbox (
        seq INTEGER PRIMARY KEY,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL
      )`);
      this.setMeta("schema_version", "1");
      this.setMeta("last_seq", "0");
      this.setMeta("log_horizon_seq", "0");
    });
  }

  private getMeta(key: string): string | null {
    const row = this.sql.exec("SELECT value FROM meta WHERE key = ?", key).toArray()[0];
    return row ? String(row.value) : null;
  }

  private setMeta(key: string, value: string): void {
    this.sql.exec("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
  }

  private lastSeq(): number {
    return Number(this.getMeta("last_seq") ?? 0);
  }

  // ------------------------------------------------------------ connections

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }
    // These headers are set by the Worker after authentication; clients can't reach the DO directly.
    const userId = request.headers.get("x-ob-user");
    const role = request.headers.get("x-ob-role") as ChannelRole | null;
    const channelId = request.headers.get("x-ob-channel");
    if (!userId || !channelId || (role !== "admin" && role !== "member")) {
      return new Response("Missing connection identity", { status: 400 });
    }
    if (!this.getMeta("channel_id")) this.setMeta("channel_id", channelId);

    const { 0: client, 1: server } = new WebSocketPair();
    // Tag sockets by user so revocation can find them (TDD §3.5).
    this.ctx.acceptWebSocket(server, [userId]);
    const attachment: Attachment = { userId, role, connId: crypto.randomUUID() };
    server.serializeAttachment(attachment);

    server.send(
      JSON.stringify({
        type: "welcome",
        lastSeq: this.lastSeq(),
        horizonSeq: Number(this.getMeta("log_horizon_seq") ?? 0),
        present: this.presentUsers(),
      }),
    );
    this.broadcast({ type: "presence.joined", userId }, server);
    return new Response(null, { status: 101, webSocket: client });
  }

  private presentUsers(exclude?: WebSocket): string[] {
    const users = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === exclude) continue;
      users.add((ws.deserializeAttachment() as Attachment).userId);
    }
    return [...users];
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    if (typeof data !== "string") return this.sendError(ws, "bad_request", "Expected JSON text frames");
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data);
    } catch {
      return this.sendError(ws, "bad_request", "Invalid JSON");
    }
    const att = ws.deserializeAttachment() as Attachment;
    switch (msg.type) {
      case "message.send":
        return this.handleSend(ws, att, msg);
      case "message.edit":
        return this.handleEdit(ws, att, msg);
      case "message.delete":
        return this.handleDelete(ws, att, msg);
      case "reaction.add":
      case "reaction.remove":
        return this.handleReaction(ws, att, msg);
      case "sync":
        return this.handleSync(ws, msg);
      case "history":
        return this.handleHistory(ws, msg);
      case "typing":
        // Ephemeral: relayed, never stored.
        return this.broadcast({ type: "typing", userId: att.userId }, ws);
      default:
        return this.sendError(ws, "bad_request", `Unknown type ${String(msg.type)}`);
    }
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    const { userId } = ws.deserializeAttachment() as Attachment;
    if (!this.presentUsers(ws).includes(userId)) this.broadcast({ type: "presence.left", userId }, ws);
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, "closing");
    } catch {
      // Already closed.
    }
  }

  /** Revocation (TDD §3.5): close every socket of a user, e.g. after removal from a private channel. */
  async closeConnections(userId: string, code = 4403, reason = "access removed"): Promise<number> {
    const sockets = this.ctx.getWebSockets(userId);
    for (const ws of sockets) ws.close(code, reason);
    return sockets.length;
  }

  // ------------------------------------------------------------ write path

  private handleSend(ws: WebSocket, att: Attachment, msg: Record<string, unknown>): Promise<void> | void {
    const { clientId, body, parentId } = msg;
    if (typeof clientId !== "string" || clientId.length === 0 || clientId.length > 64) {
      return this.sendError(ws, "bad_request", "clientId must be a 1–64 character string");
    }
    const bodyError = this.validateBody(body);
    if (bodyError) return this.sendError(ws, "bad_request", bodyError, clientId);
    if (parentId != null) {
      const parent = typeof parentId === "string" ? this.getMessage(parentId) : null;
      if (!parent || parent.parentId !== null) return this.sendError(ws, "bad_request", "Unknown thread root", clientId);
    }

    const result = this.ctx.storage.transactionSync(() => {
      // Idempotency: a retried send (same actor + clientId) re-acknowledges the original message.
      const existing = this.sql
        .exec("SELECT seq, message_id FROM events WHERE actor_id = ? AND client_id = ?", att.userId, clientId)
        .toArray()[0];
      if (existing) return { duplicate: true, seq: Number(existing.seq), id: String(existing.message_id) };
      const now = Date.now();
      const id = crypto.randomUUID();
      const seq = this.appendEvent("message.created", id, att.userId, clientId, { body, parentId: parentId ?? null }, now);
      this.sql.exec(
        `INSERT INTO messages (id, seq, sender_id, parent_id, body, reactions, created_at, last_event_seq)
         VALUES (?, ?, ?, ?, ?, '{}', ?, ?)`,
        id,
        seq,
        att.userId,
        (parentId as string | undefined) ?? null,
        body as string,
        now,
        seq,
      );
      return { duplicate: false, seq, id };
    });

    // Output gating: nothing below leaves the object until the transaction above is durable.
    ws.send(JSON.stringify({ type: "ack", clientId, seq: result.seq, id: result.id, duplicate: result.duplicate }));
    if (!result.duplicate) return this.afterEvent(result.seq);
  }

  private handleEdit(ws: WebSocket, att: Attachment, msg: Record<string, unknown>): Promise<void> | void {
    const message = typeof msg.messageId === "string" ? this.getMessage(msg.messageId) : null;
    if (!message || message.deletedAt !== null) return this.sendError(ws, "not_found", "Message not found");
    if (message.senderId !== att.userId) return this.sendError(ws, "forbidden", "Only the author can edit");
    const bodyError = this.validateBody(msg.body);
    if (bodyError) return this.sendError(ws, "bad_request", bodyError);
    const seq = this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      const seq = this.appendEvent("message.edited", message.id, att.userId, null, { body: msg.body }, now);
      this.sql.exec("UPDATE messages SET body = ?, edited_at = ?, last_event_seq = ? WHERE id = ?", msg.body as string, now, seq, message.id);
      return seq;
    });
    return this.afterEvent(seq);
  }

  private handleDelete(ws: WebSocket, att: Attachment, msg: Record<string, unknown>): Promise<void> | void {
    const message = typeof msg.messageId === "string" ? this.getMessage(msg.messageId) : null;
    if (!message || message.deletedAt !== null) return this.sendError(ws, "not_found", "Message not found");
    if (message.senderId !== att.userId && att.role !== "admin") {
      return this.sendError(ws, "forbidden", "Only the author or a channel admin can delete");
    }
    const seq = this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      const seq = this.appendEvent("message.deleted", message.id, att.userId, null, {}, now);
      this.sql.exec(
        "UPDATE messages SET body = NULL, reactions = '{}', deleted_at = ?, last_event_seq = ? WHERE id = ?",
        now,
        seq,
        message.id,
      );
      // Redaction (TDD §2.2): deleted content is never served again through replay.
      this.sql.exec(
        `UPDATE events SET payload = '{"redacted":true}' WHERE message_id = ? AND type != 'message.deleted'`,
        message.id,
      );
      return seq;
    });
    return this.afterEvent(seq);
  }

  private handleReaction(ws: WebSocket, att: Attachment, msg: Record<string, unknown>): Promise<void> | void {
    const message = typeof msg.messageId === "string" ? this.getMessage(msg.messageId) : null;
    if (!message || message.deletedAt !== null) return this.sendError(ws, "not_found", "Message not found");
    const emoji = msg.emoji;
    if (typeof emoji !== "string" || emoji.length === 0 || emoji.length > 32) {
      return this.sendError(ws, "bad_request", "emoji must be a 1–32 character string");
    }
    const adding = msg.type === "reaction.add";
    const users = new Set(message.reactions[emoji] ?? []);
    if (adding === users.has(att.userId)) return; // No change, no event.
    adding ? users.add(att.userId) : users.delete(att.userId);
    const reactions = { ...message.reactions, [emoji]: [...users] };
    if (users.size === 0) delete reactions[emoji];
    const seq = this.ctx.storage.transactionSync(() => {
      const type = adding ? "reaction.added" : "reaction.removed";
      const seq = this.appendEvent(type, message.id, att.userId, null, { emoji }, Date.now());
      this.sql.exec("UPDATE messages SET reactions = ?, last_event_seq = ? WHERE id = ?", JSON.stringify(reactions), seq, message.id);
      return seq;
    });
    return this.afterEvent(seq);
  }

  private validateBody(body: unknown): string | null {
    if (typeof body !== "string" || body.trim().length === 0) return "body must be a non-empty string";
    if (enc.encode(body).byteLength > MAX_BODY_BYTES) return `body exceeds ${MAX_BODY_BYTES} bytes`;
    return null;
  }

  /** Must run inside transactionSync. Appends to the event log and the outbox. */
  private appendEvent(type: string, messageId: string, actorId: string, clientId: string | null, payload: unknown, now: number): number {
    const seq = this.lastSeq() + 1;
    this.sql.exec(
      "INSERT INTO events (seq, type, message_id, actor_id, client_id, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      seq,
      type,
      messageId,
      actorId,
      clientId,
      JSON.stringify(payload),
      now,
    );
    this.sql.exec("INSERT INTO outbox (seq, attempts, next_attempt_at) VALUES (?, 0, ?)", seq, now);
    this.setMeta("last_seq", String(seq));
    return seq;
  }

  private async afterEvent(seq: number): Promise<void> {
    const event = this.getEvent(seq);
    if (event) {
      this.broadcast({ type: "event", event, message: this.getMessage(event.messageId) });
    }
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + BATCH_DELAY_MS);
    }
  }

  // ------------------------------------------------------------- read path

  private handleSync(ws: WebSocket, msg: Record<string, unknown>): void {
    const afterSeq = msg.afterSeq;
    if (typeof afterSeq !== "number" || !Number.isInteger(afterSeq) || afterSeq < 0) {
      return this.sendError(ws, "bad_request", "afterSeq must be a non-negative integer");
    }
    const horizon = Number(this.getMeta("log_horizon_seq") ?? 0);
    if (afterSeq < horizon) {
      ws.send(JSON.stringify({ type: "reset", lastSeq: this.lastSeq() }));
      return;
    }
    const rows = this.sql
      .exec("SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?", afterSeq, SYNC_PAGE + 1)
      .toArray();
    const more = rows.length > SYNC_PAGE;
    ws.send(JSON.stringify({ type: "sync", events: rows.slice(0, SYNC_PAGE).map(toEvent), more, lastSeq: this.lastSeq() }));
  }

  private handleHistory(ws: WebSocket, msg: Record<string, unknown>): void {
    const beforeSeq = typeof msg.beforeSeq === "number" ? msg.beforeSeq : Number.MAX_SAFE_INTEGER;
    const limit = Math.min(typeof msg.limit === "number" ? msg.limit : 50, HISTORY_PAGE_MAX);
    const rows = this.sql.exec("SELECT * FROM messages WHERE seq < ? ORDER BY seq DESC LIMIT ?", beforeSeq, limit).toArray();
    ws.send(JSON.stringify({ type: "history", messages: rows.reverse().map(toMessage) }));
  }

  private getMessage(id: string): MessageState | null {
    const row = this.sql.exec("SELECT * FROM messages WHERE id = ?", id).toArray()[0];
    return row ? toMessage(row) : null;
  }

  private getEvent(seq: number): ChannelEvent | null {
    const row = this.sql.exec("SELECT * FROM events WHERE seq = ?", seq).toArray()[0];
    return row ? toEvent(row) : null;
  }

  // -------------------------------------------------- outbox → D1 copy

  async alarm(): Promise<void> {
    const now = Date.now();
    const rows = this.sql
      .exec(
        `SELECT o.seq AS seq, o.attempts AS attempts, e.message_id AS message_id
           FROM outbox o JOIN events e ON e.seq = o.seq
          WHERE o.next_attempt_at <= ? ORDER BY o.seq LIMIT ?`,
        now,
        OUTBOX_BATCH,
      )
      .toArray();

    if (rows.length > 0) {
      const channelId = this.getMeta("channel_id");
      // One projection per message carrying its *current full state*, so delivery order and duplicates don't matter.
      const seqsByMessage = new Map<string, number[]>();
      for (const row of rows) {
        const id = String(row.message_id);
        seqsByMessage.set(id, [...(seqsByMessage.get(id) ?? []), Number(row.seq)]);
      }
      const projections: ProjectionMessage[] = [];
      for (const id of seqsByMessage.keys()) {
        const m = this.getMessage(id);
        if (!m || !channelId) continue;
        projections.push({
          channelId,
          seq: m.seq,
          id: m.id,
          senderId: m.senderId,
          parentId: m.parentId,
          body: m.body,
          reactions: JSON.stringify(m.reactions),
          createdAt: m.createdAt,
          editedAt: m.editedAt,
          deletedAt: m.deletedAt,
          lastEventSeq: m.lastEventSeq,
        });
      }

      const pending = new Set(rows.map((r) => Number(r.seq)));
      try {
        for (const chunk of chunkBySize(projections, QUEUE_BATCH_BYTES)) {
          await this.sendProjection(chunk);
          const done = chunk.flatMap((p) => seqsByMessage.get(p.id) ?? []);
          for (const seq of done) {
            this.sql.exec("DELETE FROM outbox WHERE seq = ?", seq);
            pending.delete(seq);
          }
        }
      } catch (err) {
        console.error("projection send failed; will retry", err);
        for (const row of rows) {
          if (!pending.has(Number(row.seq))) continue;
          const attempts = Number(row.attempts) + 1;
          this.sql.exec(
            "UPDATE outbox SET attempts = ?, next_attempt_at = ? WHERE seq = ?",
            attempts,
            Date.now() + backoffMs(attempts),
            Number(row.seq),
          );
        }
      }
    }

    const next = this.sql.exec("SELECT MIN(next_attempt_at) AS next FROM outbox").toArray()[0]?.next;
    if (next !== null && next !== undefined) {
      await this.ctx.storage.setAlarm(Math.max(Number(next), Date.now() + 1));
    }
  }

  /** Separate method so tests can simulate queue outages. */
  protected async sendProjection(batch: ProjectionMessage[]): Promise<void> {
    await this.env.PROJECTION_QUEUE.sendBatch(batch.map((body) => ({ body })));
  }

  /** Trims the replay log up to `uptoSeq` (never past undelivered outbox rows). Normally run by the daily cron. */
  async trimEventLog(uptoSeq: number): Promise<number> {
    const oldestPending = this.sql.exec("SELECT MIN(seq) AS seq FROM outbox").toArray()[0]?.seq;
    const limit = oldestPending == null ? uptoSeq : Math.min(uptoSeq, Number(oldestPending) - 1);
    if (limit <= Number(this.getMeta("log_horizon_seq") ?? 0)) return 0;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM events WHERE seq <= ?", limit);
      this.setMeta("log_horizon_seq", String(limit));
    });
    return limit;
  }

  // ------------------------------------------------------------- helpers

  private broadcast(message: unknown, except?: WebSocket): void {
    const text = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      try {
        ws.send(text);
      } catch {
        // Socket closing; ignore.
      }
    }
  }

  private sendError(ws: WebSocket, code: string, message: string, clientId?: string): void {
    ws.send(JSON.stringify({ type: "error", code, message, clientId }));
  }
}

function toEvent(row: Row): ChannelEvent {
  return {
    seq: Number(row.seq),
    type: String(row.type),
    messageId: String(row.message_id),
    actorId: String(row.actor_id),
    clientId: row.client_id === null ? null : String(row.client_id),
    payload: JSON.parse(String(row.payload)),
    createdAt: Number(row.created_at),
  };
}

function toMessage(row: Row): MessageState {
  return {
    id: String(row.id),
    seq: Number(row.seq),
    senderId: String(row.sender_id),
    parentId: row.parent_id === null ? null : String(row.parent_id),
    body: row.body === null ? null : String(row.body),
    reactions: JSON.parse(String(row.reactions)),
    createdAt: Number(row.created_at),
    editedAt: row.edited_at === null ? null : Number(row.edited_at),
    deletedAt: row.deleted_at === null ? null : Number(row.deleted_at),
    lastEventSeq: Number(row.last_event_seq),
  };
}

function chunkBySize<T>(items: T[], maxBytes: number): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [];
  let size = 0;
  for (const item of items) {
    const itemSize = enc.encode(JSON.stringify(item)).byteLength;
    if (current.length > 0 && (size + itemSize > maxBytes || current.length >= 100)) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(item);
    size += itemSize;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

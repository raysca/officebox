// DocRoom Durable Object: authoritative Yjs document, standard y-websocket protocol (TDD §4).
// Updates are appended to SQLite and compacted into (chunked) snapshots.
import { DurableObject } from "cloudflare:workers";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as authProtocol from "y-protocols/auth";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import type { Env } from "./env";

export type DocRole = "owner" | "editor" | "commenter" | "viewer";

interface DocAttachment {
  userId: string;
  role: DocRole;
  connId: string;
  /** Yjs awareness client IDs this connection has announced; removed when it disconnects. */
  awarenessIds: number[];
}

// y-websocket message types
const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
const MSG_AUTH = 2;
const MSG_QUERY_AWARENESS = 3;

// Compaction thresholds and limits (TDD §4.3). DO SQLite rows can hold up to 8 MB.
export const COMPACT_AFTER_UPDATES = 500;
export const COMPACT_AFTER_BYTES = 1_000_000;
export const SNAPSHOT_CHUNK_BYTES = 4 * 1024 * 1024;
export const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;

interface AwarenessEntry {
  clock: number;
  state: string; // JSON text as sent by the client
}

const canWrite = (role: DocRole) => role === "owner" || role === "editor";

export class DocRoom extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private doc: Y.Doc | null = null;
  /** Awareness is relayed and remembered in memory only; clients re-announce it periodically. */
  private awareness = new Map<number, AwarenessEntry>();
  /** Present mode (TDD §4.5): at most one presenting awareness client per document. Memory only. */
  private presenter: { clientId: number; connId: string; userId: string } | null = null;
  private pendingUpdates = 0;
  private pendingBytes = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.migrate();
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  private migrate(): void {
    this.sql.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
    const row = this.sql.exec("SELECT value FROM meta WHERE key = 'schema_version'").toArray()[0];
    if (row && Number(row.value) >= 1) return;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(`CREATE TABLE updates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        update_blob BLOB NOT NULL,
        created_at INTEGER NOT NULL
      )`);
      this.sql.exec(`CREATE TABLE snapshots (
        id INTEGER NOT NULL,
        chunk INTEGER NOT NULL DEFAULT 0,
        state_blob BLOB NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (id, chunk)
      )`);
      this.sql.exec("INSERT INTO meta (key, value) VALUES ('schema_version', '1'), ('compactions', '0')");
    });
  }

  // ------------------------------------------------------------- loading

  /** Lazily rebuilds the Y.Doc from the latest snapshot plus later updates (after cold start or hibernation). */
  private loadDoc(): Y.Doc {
    if (this.doc) return this.doc;
    const doc = new Y.Doc();
    const latest = this.sql.exec("SELECT MAX(id) AS id FROM snapshots").toArray()[0]?.id;
    if (latest !== null && latest !== undefined) {
      const chunks = this.sql
        .exec("SELECT state_blob FROM snapshots WHERE id = ? ORDER BY chunk", latest)
        .toArray()
        .map((r) => new Uint8Array(r.state_blob as ArrayBuffer));
      Y.applyUpdate(doc, concat(chunks));
    }
    this.pendingUpdates = 0;
    this.pendingBytes = 0;
    for (const row of this.sql.exec("SELECT update_blob FROM updates ORDER BY id")) {
      const update = new Uint8Array(row.update_blob as ArrayBuffer);
      Y.applyUpdate(doc, update);
      this.pendingUpdates++;
      this.pendingBytes += update.byteLength;
    }
    // Registered after loading so replayed history isn't persisted twice.
    doc.on("update", (update: Uint8Array, origin: unknown) => this.onDocUpdate(update, origin));
    this.doc = doc;
    return doc;
  }

  // --------------------------------------------------------- connections

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }
    const userId = request.headers.get("x-ob-user");
    const role = request.headers.get("x-ob-role") as DocRole | null;
    const docId = request.headers.get("x-ob-doc");
    if (!userId || !docId || !role || !["owner", "editor", "commenter", "viewer"].includes(role)) {
      return new Response("Missing connection identity", { status: 400 });
    }
    const doc = this.loadDoc();
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [userId]);
    const attachment: DocAttachment = { userId, role, connId: crypto.randomUUID(), awarenessIds: [] };
    server.serializeAttachment(attachment);
    await this.env.USER_HUB.get(this.env.USER_HUB.idFromName(userId)).registerRoom("doc", docId);

    // Standard y-websocket handshake: server sends sync step 1, plus current awareness.
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MSG_SYNC);
    syncProtocol.writeSyncStep1(encoder, doc);
    server.send(encoding.toUint8Array(encoder));
    if (this.awareness.size > 0) server.send(this.encodeAwareness([...this.awareness.keys()]));

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message === "string") return; // The Yjs protocol is binary only.
    if (message.byteLength > MAX_MESSAGE_BYTES) {
      ws.close(1009, "message too large");
      return;
    }
    const doc = this.loadDoc();
    const att = ws.deserializeAttachment() as DocAttachment;
    const decoder = decoding.createDecoder(new Uint8Array(message));
    const type = decoding.readVarUint(decoder);

    switch (type) {
      case MSG_SYNC: {
        const reply = encoding.createEncoder();
        encoding.writeVarUint(reply, MSG_SYNC);
        const syncType = decoding.readVarUint(decoder);
        if (syncType === syncProtocol.messageYjsSyncStep1) {
          syncProtocol.readSyncStep1(decoder, reply, doc);
        } else if (syncType === syncProtocol.messageYjsSyncStep2 || syncType === syncProtocol.messageYjsUpdate) {
          if (canWrite(att.role)) {
            syncProtocol.readSyncStep2(decoder, doc, ws);
          } else if (syncType === syncProtocol.messageYjsUpdate) {
            // Read-only roles: refuse edits (step 2 replies from read-only clients are ignored silently).
            this.sendPermissionDenied(ws, `role ${att.role} cannot edit this document`);
          }
        }
        if (encoding.length(reply) > 1) ws.send(encoding.toUint8Array(reply));
        return;
      }
      case MSG_AWARENESS: {
        const update = decoding.readVarUint8Array(decoder);
        const { ids, deniedBecause } = this.applyAwareness(update, att);
        const known = new Set(att.awarenessIds);
        if (ids.some((id) => !known.has(id))) {
          att.awarenessIds = [...new Set([...att.awarenessIds, ...ids])];
          ws.serializeAttachment(att);
        }
        if (deniedBecause) {
          // Second presenter: strip the claim, tell the sender (and echo the corrected state back to them).
          this.sendPermissionDenied(ws, `Currently presenting: ${deniedBecause}`);
          ws.send(this.encodeAwareness(ids));
        }
        // Re-encode from server state so any stripped claim never reaches peers.
        this.broadcast(this.encodeAwareness(ids), ws);
        return;
      }
      case MSG_QUERY_AWARENESS:
        if (this.awareness.size > 0) ws.send(this.encodeAwareness([...this.awareness.keys()]));
        return;
      default:
        return;
    }
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    const att = ws.deserializeAttachment() as DocAttachment;
    if (att.awarenessIds.length > 0) {
      // Tell peers this connection's cursors are gone.
      for (const id of att.awarenessIds) {
        const entry = this.awareness.get(id);
        this.awareness.set(id, { clock: (entry?.clock ?? 0) + 1, state: "null" });
      }
      this.broadcast(this.encodeAwareness(att.awarenessIds), ws);
      for (const id of att.awarenessIds) this.awareness.delete(id);
    }
    if (this.presenter?.connId === att.connId) this.presenter = null;
    // Compact before the object goes idle, so the next cold load is a single snapshot.
    const others = this.ctx.getWebSockets().filter((s) => s !== ws);
    if (others.length === 0 && this.doc && this.pendingUpdates > 0) this.compact();
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, "closing");
    } catch {
      // Already closed.
    }
  }

  async closeConnections(userId: string, code = 4403, reason = "access removed"): Promise<number> {
    const sockets = this.ctx.getWebSockets(userId);
    for (const ws of sockets) ws.close(code, reason);
    return sockets.length;
  }

  // -------------------------------------------------------- persistence

  private onDocUpdate(update: Uint8Array, origin: unknown): void {
    this.sql.exec("INSERT INTO updates (update_blob, created_at) VALUES (?, ?)", toArrayBuffer(update), Date.now());
    this.pendingUpdates++;
    this.pendingBytes += update.byteLength;

    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MSG_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    this.broadcast(encoding.toUint8Array(encoder), origin instanceof WebSocket ? origin : undefined);

    if (this.pendingUpdates >= COMPACT_AFTER_UPDATES || this.pendingBytes >= COMPACT_AFTER_BYTES) this.compact();
  }

  /** Folds all updates into one snapshot, split into chunks under the 8 MB row limit. */
  compact(): void {
    const doc = this.loadDoc();
    const state = Y.encodeStateAsUpdate(doc);
    this.ctx.storage.transactionSync(() => {
      const maxUpdate = this.sql.exec("SELECT MAX(id) AS id FROM updates").toArray()[0]?.id;
      const next = Number(this.sql.exec("SELECT COALESCE(MAX(id), 0) + 1 AS id FROM snapshots").toArray()[0]!.id);
      const now = Date.now();
      for (let i = 0, chunk = 0; i < Math.max(state.byteLength, 1); i += SNAPSHOT_CHUNK_BYTES, chunk++) {
        const part = state.subarray(i, i + SNAPSHOT_CHUNK_BYTES);
        this.sql.exec(
          "INSERT INTO snapshots (id, chunk, state_blob, created_at) VALUES (?, ?, ?, ?)",
          next,
          chunk,
          toArrayBuffer(part),
          now,
        );
      }
      this.sql.exec("DELETE FROM snapshots WHERE id < ?", next);
      if (maxUpdate !== null && maxUpdate !== undefined) this.sql.exec("DELETE FROM updates WHERE id <= ?", maxUpdate);
      this.sql.exec("UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'compactions'");
    });
    this.pendingUpdates = 0;
    this.pendingBytes = 0;
  }

  /** Storage stats, used by tests and (later) the storage monitor. */
  async stats(): Promise<{ updates: number; snapshotChunks: number; compactions: number; bytes: number }> {
    const updates = Number(this.sql.exec("SELECT COUNT(*) AS n FROM updates").toArray()[0]!.n);
    const snapshotChunks = Number(this.sql.exec("SELECT COUNT(*) AS n FROM snapshots").toArray()[0]!.n);
    const compactions = Number(this.sql.exec("SELECT value FROM meta WHERE key = 'compactions'").toArray()[0]!.value);
    return { updates, snapshotChunks, compactions, bytes: this.sql.databaseSize };
  }

  // ---------------------------------------------------------- awareness

  /**
   * Parses an awareness update (y-protocols wire format), remembers newer states and enforces present mode:
   * a `presenting.active` claim is accepted only if nobody else is presenting; otherwise it is stripped.
   */
  private applyAwareness(update: Uint8Array, att: DocAttachment): { ids: number[]; deniedBecause: string | null } {
    const decoder = decoding.createDecoder(update);
    const count = decoding.readVarUint(decoder);
    const ids: number[] = [];
    let deniedBecause: string | null = null;
    for (let i = 0; i < count; i++) {
      const clientId = decoding.readVarUint(decoder);
      const clock = decoding.readVarUint(decoder);
      let state = decoding.readVarString(decoder);
      ids.push(clientId);
      const current = this.awareness.get(clientId);
      if (current && current.clock > clock) continue;

      const parsed = state === "null" ? null : (safeJson(state) as { presenting?: { active?: boolean } } | null);
      if (parsed?.presenting?.active === true) {
        if (!this.presenter || this.presenter.clientId === clientId) {
          this.presenter = { clientId, connId: att.connId, userId: att.userId };
        } else {
          delete parsed.presenting;
          state = JSON.stringify(parsed);
          deniedBecause = this.presenter.userId;
        }
      } else if (this.presenter?.clientId === clientId) {
        this.presenter = null; // stopped presenting (or left)
      }

      if (state === "null") this.awareness.delete(clientId);
      else this.awareness.set(clientId, { clock, state });
    }
    return { ids, deniedBecause };
  }

  async presenting(): Promise<string | null> {
    return this.presenter?.userId ?? null;
  }

  private encodeAwareness(clientIds: number[]): Uint8Array {
    const inner = encoding.createEncoder();
    encoding.writeVarUint(inner, clientIds.length);
    for (const id of clientIds) {
      const entry = this.awareness.get(id) ?? { clock: 0, state: "null" };
      encoding.writeVarUint(inner, id);
      encoding.writeVarUint(inner, entry.clock);
      encoding.writeVarString(inner, entry.state);
    }
    return frame(MSG_AWARENESS, encoding.toUint8Array(inner));
  }

  // ------------------------------------------------------------ helpers

  private sendPermissionDenied(ws: WebSocket, reason: string): void {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MSG_AUTH);
    authProtocol.writePermissionDenied(encoder, reason);
    ws.send(encoding.toUint8Array(encoder));
  }

  private broadcast(data: Uint8Array, except?: WebSocket): void {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      try {
        ws.send(data);
      } catch {
        // Socket closing; ignore.
      }
    }
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function frame(type: number, payload: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, type);
  encoding.writeVarUint8Array(encoder, payload);
  return encoding.toUint8Array(encoder);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

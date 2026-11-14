// HuddleRoom Durable Object: one per active huddle (TDD §3.6).
// Holds the roster and track registry, enforces the single-presenter rule, take-over and host controls,
// and ends the huddle 30 s after the last participant leaves. Media itself goes through the Realtime SFU.
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { sfuFor } from "./sfu";

export type TrackKind = "audio" | "video" | "screen" | "screen-audio";
export const TRACK_KINDS: TrackKind[] = ["audio", "video", "screen", "screen-audio"];
const SCREEN_KINDS: TrackKind[] = ["screen", "screen-audio"];

export type ScreenSharePolicy = "everyone" | "admins" | "off";

export const HANDOVER_TIMEOUT_MS = 5000;
export const END_GRACE_MS = 30_000;
export const MAX_PARTICIPANTS = 25;

interface HuddleAttachment {
  connId: string;
  userId: string;
  moderator: boolean;
}

export interface Participant {
  connId: string;
  userId: string;
  tracks: TrackKind[];
  hand: boolean;
}

/** Errors thrown over RPC; the Worker maps the prefix to an HTTP status. */
export class HuddleError extends Error {
  constructor(code: "forbidden" | "not_found" | "conflict" | "bad_request" | "gone", message: string) {
    super(`${code}: ${message}`);
  }
}

export interface ScreenConstraints {
  width: number;
  height: number;
  detailFrameRate: number;
  motionFrameRate: number;
}

export class HuddleRoom extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
    this.sql.exec(`CREATE TABLE IF NOT EXISTS participants (
      conn_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, session_id TEXT, joined_at INTEGER NOT NULL, hand INTEGER NOT NULL DEFAULT 0)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS tracks (
      conn_id TEXT NOT NULL, kind TEXT NOT NULL, mid TEXT NOT NULL, track_name TEXT NOT NULL, PRIMARY KEY (conn_id, kind))`);
    this.sql.exec("CREATE TABLE IF NOT EXISTS requests (conn_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL)");
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  // ------------------------------------------------------------------ meta

  private meta(key: string): string | null {
    const row = this.sql.exec("SELECT value FROM meta WHERE key = ?", key).toArray()[0];
    return row ? String(row.value) : null;
  }

  private setMeta(key: string, value: string | null): void {
    if (value === null) this.sql.exec("DELETE FROM meta WHERE key = ?", key);
    else this.sql.exec("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
  }

  /** Called by the Worker when the huddle row is created. Settings are fixed for the huddle's lifetime. */
  async init(opts: { huddleId: string; contextType: string; contextId: string; hostId: string; policy: ScreenSharePolicy; maxHeight: number }) {
    if (this.meta("huddle_id")) return;
    this.setMeta("huddle_id", opts.huddleId);
    this.setMeta("context_type", opts.contextType);
    this.setMeta("context_id", opts.contextId);
    this.setMeta("host_id", opts.hostId);
    this.setMeta("policy", opts.policy);
    this.setMeta("max_height", String(opts.maxHeight));
    this.setMeta("started_at", String(Date.now()));
    // If nobody ever joins, end it after the grace period.
    await this.scheduleTimer("end_at", Date.now() + END_GRACE_MS);
  }

  private constraints(): ScreenConstraints {
    const height = Number(this.meta("max_height") ?? 1080) >= 1080 ? 1080 : 720;
    return { width: height === 1080 ? 1920 : 1280, height, detailFrameRate: 15, motionFrameRate: 30 };
  }

  // ----------------------------------------------------------- connections

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("Expected WebSocket upgrade", { status: 426 });
    const userId = request.headers.get("x-ob-user");
    if (!userId) return new Response("Missing connection identity", { status: 400 });
    if (!this.meta("huddle_id") || this.meta("ended")) return new Response("Huddle has ended", { status: 410 });
    if (this.participantCount() >= MAX_PARTICIPANTS) return new Response("Huddle is full", { status: 409 });

    const connId = crypto.randomUUID();
    const moderator = request.headers.get("x-ob-moderator") === "1";
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [userId, connId]);
    server.serializeAttachment({ connId, userId, moderator } satisfies HuddleAttachment);
    this.sql.exec("INSERT INTO participants (conn_id, user_id, joined_at) VALUES (?, ?, ?)", connId, userId, Date.now());
    await this.clearTimer("end_at");

    const huddleId = this.meta("huddle_id")!;
    const count = this.participantCount();
    await this.env.DB.batch([
      this.env.DB.prepare("INSERT INTO huddle_participants (huddle_id, user_id, joined_at) VALUES (?, ?, ?)").bind(huddleId, userId, Date.now()),
      this.env.DB.prepare("UPDATE huddles SET peak_participants = MAX(peak_participants, ?) WHERE id = ?").bind(count, huddleId),
    ]);

    server.send(
      JSON.stringify({
        type: "welcome",
        connId,
        huddleId,
        hostId: this.meta("host_id"),
        moderator,
        policy: { screenShare: this.meta("policy"), constraints: this.constraints() },
        ...this.rosterPayload(),
      }),
    );
    this.broadcastRoster(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    if (typeof data !== "string") return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data);
    } catch {
      return this.sendTo(ws, { type: "error", message: "Invalid JSON" });
    }
    const att = ws.deserializeAttachment() as HuddleAttachment;
    try {
      switch (msg.type) {
        case "screen.start":
          return await this.requestScreen(ws, att);
        case "screen.stopped":
          return await this.presenterStopped(att.connId);
        case "screen.handover":
          return await this.handover(att, String(msg.toConnId ?? ""));
        case "screen.stop":
          return await this.moderatorStopScreen(att, String(msg.targetConnId ?? ""));
        case "mute":
          return await this.moderatorMute(att, String(msg.targetConnId ?? ""));
        case "hand":
          this.sql.exec("UPDATE participants SET hand = ? WHERE conn_id = ?", msg.raised ? 1 : 0, att.connId);
          return this.broadcastRoster();
        default:
          return this.sendTo(ws, { type: "error", message: `Unknown type ${String(msg.type)}` });
      }
    } catch (err) {
      this.sendTo(ws, { type: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    const att = ws.deserializeAttachment() as HuddleAttachment;
    await this.removeParticipant(att.connId, att.userId);
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, "closing");
    } catch {
      // Already closed.
    }
  }

  private async removeParticipant(connId: string, userId: string): Promise<void> {
    const existed = this.sql.exec("DELETE FROM participants WHERE conn_id = ? RETURNING conn_id", connId).toArray().length > 0;
    if (!existed) return;
    this.sql.exec("DELETE FROM tracks WHERE conn_id = ?", connId);
    this.sql.exec("DELETE FROM requests WHERE conn_id = ?", connId);
    const huddleId = this.meta("huddle_id");
    if (huddleId) {
      await this.env.DB.prepare(
        "UPDATE huddle_participants SET left_at = ? WHERE huddle_id = ? AND user_id = ? AND left_at IS NULL",
      )
        .bind(Date.now(), huddleId, userId)
        .run();
    }
    if (this.meta("presenter_conn") === connId) await this.presenterStopped(connId);
    if (this.meta("handover_to") === connId) this.clearHandover();
    this.broadcastRoster();
    if (this.participantCount() === 0) await this.scheduleTimer("end_at", Date.now() + END_GRACE_MS);
  }

  // ---------------------------------------------------- screen sharing

  private async requestScreen(ws: WebSocket, att: HuddleAttachment): Promise<void> {
    const policy = this.meta("policy") as ScreenSharePolicy;
    if (policy === "off") throw new HuddleError("forbidden", "screen sharing is turned off for this workspace");
    if (policy === "admins" && !att.moderator) throw new HuddleError("forbidden", "only admins can share their screen");
    const presenter = this.meta("presenter_conn");
    if (!presenter || presenter === att.connId) return this.grant(att.connId);
    // Someone is presenting: turn this into a take-over request for the presenter and moderators.
    this.sql.exec("INSERT OR REPLACE INTO requests (conn_id, created_at) VALUES (?, ?)", att.connId, Date.now());
    const request = { type: "screen.request", connId: att.connId, userId: att.userId };
    for (const other of this.ctx.getWebSockets()) {
      const a = other.deserializeAttachment() as HuddleAttachment;
      if (a.connId === presenter || a.moderator) this.sendTo(other, request);
    }
    this.sendTo(ws, { type: "screen.pending", presenterConnId: presenter });
  }

  private grant(connId: string): void {
    this.setMeta("presenter_conn", connId);
    this.sql.exec("DELETE FROM requests WHERE conn_id = ?", connId);
    for (const ws of this.ctx.getWebSockets(connId)) this.sendTo(ws, { type: "screen.granted", constraints: this.constraints() });
    this.broadcastRoster();
  }

  /** The presenter's share ended (they stopped, closed the screen track, left, or were stopped). */
  private async presenterStopped(connId: string): Promise<void> {
    if (this.meta("presenter_conn") !== connId) return;
    this.setMeta("presenter_conn", null);
    const next = this.meta("handover_to");
    this.clearHandover();
    await this.clearTimer("handover_deadline");
    if (next && this.isParticipant(next)) this.grant(next);
    else this.broadcastRoster();
  }

  private async handover(att: HuddleAttachment, toConnId: string): Promise<void> {
    const presenter = this.meta("presenter_conn");
    if (att.connId !== presenter && !att.moderator) throw new HuddleError("forbidden", "only the presenter or a moderator can hand over");
    if (!this.isParticipant(toConnId)) throw new HuddleError("not_found", "no such participant");
    if (!presenter) return this.grant(toConnId);
    if (presenter === toConnId) return;
    this.setMeta("handover_to", toConnId);
    for (const ws of this.ctx.getWebSockets(presenter)) this.sendTo(ws, { type: "screen.stop-requested", reason: "handover", toConnId });
    await this.scheduleTimer("handover_deadline", Date.now() + HANDOVER_TIMEOUT_MS);
  }

  private clearHandover(): void {
    this.setMeta("handover_to", null);
  }

  private async moderatorStopScreen(att: HuddleAttachment, targetConnId: string): Promise<void> {
    if (!att.moderator) throw new HuddleError("forbidden", "only the host or a channel admin can stop a share");
    if (this.meta("presenter_conn") !== targetConnId) throw new HuddleError("conflict", "that participant is not presenting");
    await this.forceCloseTracks(targetConnId, SCREEN_KINDS);
    for (const ws of this.ctx.getWebSockets(targetConnId)) this.sendTo(ws, { type: "screen.stopped-by", byUserId: att.userId });
    await this.presenterStopped(targetConnId);
  }

  private async moderatorMute(att: HuddleAttachment, targetConnId: string): Promise<void> {
    if (!att.moderator) throw new HuddleError("forbidden", "only the host or a channel admin can mute others");
    if (!this.isParticipant(targetConnId)) throw new HuddleError("not_found", "no such participant");
    await this.forceCloseTracks(targetConnId, ["audio"]);
    for (const ws of this.ctx.getWebSockets(targetConnId)) this.sendTo(ws, { type: "muted-by", byUserId: att.userId });
    this.broadcastRoster();
  }

  /** Closes a participant's tracks at the SFU without SDP negotiation (force), then forgets them. */
  private async forceCloseTracks(connId: string, kinds: TrackKind[]): Promise<void> {
    const sessionId = this.sql.exec("SELECT session_id FROM participants WHERE conn_id = ?", connId).toArray()[0]?.session_id;
    const placeholders = kinds.map(() => "?").join(",");
    const rows = this.sql.exec(`SELECT mid FROM tracks WHERE conn_id = ? AND kind IN (${placeholders})`, connId, ...kinds).toArray();
    if (sessionId && rows.length > 0) {
      await sfuFor(this.env).closeTracks(String(sessionId), rows.map((r) => String(r.mid)), { force: true });
    }
    this.sql.exec(`DELETE FROM tracks WHERE conn_id = ? AND kind IN (${placeholders})`, connId, ...kinds);
  }

  // ------------------------------------------- RPC used by Worker track routes

  private requireParticipant(userId: string, connId: string): { sessionId: string | null } {
    const row = this.sql.exec("SELECT user_id, session_id FROM participants WHERE conn_id = ?", connId).toArray()[0];
    if (!row) throw new HuddleError("not_found", "not connected to this huddle");
    if (row.user_id !== userId) throw new HuddleError("forbidden", "connection belongs to another user");
    return { sessionId: row.session_id === null ? null : String(row.session_id) };
  }

  /** Checks a publish request and returns the participant's SFU session (null until first publish). */
  async preparePublish(userId: string, connId: string, kinds: string[]): Promise<{ sessionId: string | null }> {
    const participant = this.requireParticipant(userId, connId);
    for (const kind of kinds) {
      if (!TRACK_KINDS.includes(kind as TrackKind)) throw new HuddleError("bad_request", `unknown track kind ${kind}`);
      if (SCREEN_KINDS.includes(kind as TrackKind) && this.meta("presenter_conn") !== connId) {
        throw new HuddleError("forbidden", "ask to share first (screen.start) — only the presenter can publish a screen");
      }
    }
    return participant;
  }

  async setSession(userId: string, connId: string, sessionId: string): Promise<void> {
    this.requireParticipant(userId, connId);
    this.sql.exec("UPDATE participants SET session_id = ? WHERE conn_id = ?", sessionId, connId);
  }

  async tracksPublished(userId: string, connId: string, tracks: Array<{ kind: TrackKind; mid: string; trackName: string }>): Promise<void> {
    this.requireParticipant(userId, connId);
    for (const t of tracks) {
      this.sql.exec("INSERT OR REPLACE INTO tracks (conn_id, kind, mid, track_name) VALUES (?, ?, ?, ?)", connId, t.kind, t.mid, t.trackName);
    }
    if (tracks.some((t) => t.kind === "screen")) {
      await this.env.DB.prepare("UPDATE huddles SET had_screen_share = 1 WHERE id = ?").bind(this.meta("huddle_id")).run();
    }
    this.broadcastRoster();
  }

  /**
   * Isolation (TDD §3.6): a subscriber may only pull tracks that are published by participants of *this* huddle.
   * Returns the subscriber's SFU session and the publishers' (sessionId, trackName) pairs.
   */
  async authorizeSubscribe(
    userId: string,
    connId: string,
    wanted: Array<{ connId: string; kind: string }>,
  ): Promise<{ sessionId: string; remote: Array<{ sessionId: string; trackName: string; connId: string; kind: string }> }> {
    const me = this.requireParticipant(userId, connId);
    if (!me.sessionId) throw new HuddleError("conflict", "publish or create a session before subscribing");
    const remote = wanted.map((w) => {
      const row = this.sql
        .exec(
          `SELECT p.session_id AS session_id, t.track_name AS track_name
             FROM tracks t JOIN participants p ON p.conn_id = t.conn_id
            WHERE t.conn_id = ? AND t.kind = ?`,
          w.connId,
          w.kind,
        )
        .toArray()[0];
      if (!row || row.session_id === null) throw new HuddleError("not_found", `no ${w.kind} track from that participant in this huddle`);
      return { sessionId: String(row.session_id), trackName: String(row.track_name), connId: w.connId, kind: w.kind };
    });
    return { sessionId: me.sessionId, remote };
  }

  async sessionFor(userId: string, connId: string): Promise<string> {
    const me = this.requireParticipant(userId, connId);
    if (!me.sessionId) throw new HuddleError("conflict", "no SFU session yet");
    return me.sessionId;
  }

  async tracksClosed(userId: string, connId: string, mids: string[]): Promise<void> {
    this.requireParticipant(userId, connId);
    const kinds = mids.flatMap((mid) =>
      this.sql.exec("DELETE FROM tracks WHERE conn_id = ? AND mid = ? RETURNING kind", connId, mid).toArray().map((r) => String(r.kind)),
    );
    if (kinds.includes("screen")) await this.presenterStopped(connId);
    else this.broadcastRoster();
  }

  // ------------------------------------------------------------- ending

  private async end(): Promise<void> {
    if (this.meta("ended")) return;
    this.setMeta("ended", String(Date.now()));
    for (const ws of this.ctx.getWebSockets()) ws.close(4000, "huddle ended");
    const huddleId = this.meta("huddle_id")!;
    const startedAt = Number(this.meta("started_at"));
    await this.env.DB.prepare("UPDATE huddles SET ended_at = ? WHERE id = ?").bind(Date.now(), huddleId).run();
    if (this.meta("context_type") === "channel") {
      const people = await this.env.DB.prepare("SELECT DISTINCT user_id FROM huddle_participants WHERE huddle_id = ?").bind(huddleId).all<{ user_id: string }>();
      const channelId = this.meta("context_id")!;
      await this.env.CHAT.get(this.env.CHAT.idFromName(channelId)).postSystemEvent(channelId, "huddle.ended", {
        huddleId,
        durationMs: Date.now() - startedAt,
        participants: people.results.map((r) => r.user_id),
      });
    }
  }

  async state(): Promise<{ ended: boolean; handoverTo: string | null } & ReturnType<HuddleRoom["rosterPayload"]>> {
    return { ended: this.meta("ended") !== null, handoverTo: this.meta("handover_to"), ...this.rosterPayload() };
  }

  // -------------------------------------------------------------- timers

  private async scheduleTimer(name: "end_at" | "handover_deadline", at: number): Promise<void> {
    this.setMeta(name, String(at));
    await this.armAlarm();
  }

  private async clearTimer(name: "end_at" | "handover_deadline"): Promise<void> {
    this.setMeta(name, null);
    await this.armAlarm();
  }

  /** One alarm per object: always set to the earliest pending timer. */
  private async armAlarm(): Promise<void> {
    const times = ["end_at", "handover_deadline"].map((k) => this.meta(k)).filter((v): v is string => v !== null).map(Number);
    if (times.length === 0) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Math.min(...times));
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const handoverAt = this.meta("handover_deadline");
    if (handoverAt !== null && Number(handoverAt) <= now) {
      this.setMeta("handover_deadline", null);
      const presenter = this.meta("presenter_conn");
      // The presenter didn't stop in time: close their screen tracks at the SFU, then grant.
      if (presenter && this.meta("handover_to")) {
        await this.forceCloseTracks(presenter, SCREEN_KINDS);
        for (const ws of this.ctx.getWebSockets(presenter)) this.sendTo(ws, { type: "screen.stopped-by", byUserId: null, reason: "handover" });
        await this.presenterStopped(presenter);
      }
    }
    const endAt = this.meta("end_at");
    if (endAt !== null && Number(endAt) <= now) {
      this.setMeta("end_at", null);
      if (this.participantCount() === 0) await this.end();
    }
    await this.armAlarm();
  }

  // ------------------------------------------------------------- helpers

  private participantCount(): number {
    return Number(this.sql.exec("SELECT COUNT(*) AS n FROM participants").one().n);
  }

  private isParticipant(connId: string): boolean {
    return this.sql.exec("SELECT 1 FROM participants WHERE conn_id = ?", connId).toArray().length > 0;
  }

  private rosterPayload(): { presenter: string | null; participants: Participant[]; requests: string[] } {
    const tracks = new Map<string, TrackKind[]>();
    for (const r of this.sql.exec("SELECT conn_id, kind FROM tracks")) {
      const list = tracks.get(String(r.conn_id)) ?? [];
      list.push(r.kind as TrackKind);
      tracks.set(String(r.conn_id), list);
    }
    const participants = this.sql
      .exec("SELECT conn_id, user_id, hand FROM participants ORDER BY joined_at")
      .toArray()
      .map((r) => ({ connId: String(r.conn_id), userId: String(r.user_id), tracks: (tracks.get(String(r.conn_id)) ?? []).sort(), hand: r.hand === 1 }));
    const requests = this.sql.exec("SELECT conn_id FROM requests ORDER BY created_at").toArray().map((r) => String(r.conn_id));
    return { presenter: this.meta("presenter_conn"), participants, requests };
  }

  private broadcastRoster(except?: WebSocket): void {
    const message = { type: "roster", ...this.rosterPayload() };
    for (const ws of this.ctx.getWebSockets()) if (ws !== except) this.sendTo(ws, message);
  }

  private sendTo(ws: WebSocket, message: unknown): void {
    try {
      ws.send(JSON.stringify(message));
    } catch {
      // Closing.
    }
  }
}

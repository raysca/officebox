// Test double for the Realtime SFU, implemented as a Durable Object (used only when SFU_MODE=fake).
// It models sessions and tracks closely enough to check authorisation, track naming and close/force semantics.
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import type { LocalTrack, RemoteTrack, SessionDescription, SimulcastPreference, TrackResult, TracksResponse } from "./sfu";

export interface FakeCall {
  op: string;
  sessionId: string | null;
  /** JSON text of the request body (kept as text so it crosses RPC without deep type instantiation). */
  bodyJson: string;
}

export class FakeSfu extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY)");
    this.sql.exec(`CREATE TABLE IF NOT EXISTS tracks (
      session_id TEXT NOT NULL, mid TEXT NOT NULL, track_name TEXT, location TEXT NOT NULL,
      remote_session TEXT, preferred_rid TEXT, status TEXT NOT NULL, PRIMARY KEY (session_id, mid))`);
    this.sql.exec("CREATE TABLE IF NOT EXISTS calls (id INTEGER PRIMARY KEY AUTOINCREMENT, op TEXT, session_id TEXT, body TEXT)");
  }

  private log(op: string, sessionId?: string, body?: unknown) {
    this.sql.exec("INSERT INTO calls (op, session_id, body) VALUES (?, ?, ?)", op, sessionId ?? null, JSON.stringify(body ?? null));
  }

  private requireSession(sessionId: string) {
    if (this.sql.exec("SELECT id FROM sessions WHERE id = ?", sessionId).toArray().length === 0) throw new Error(`fake sfu: unknown session ${sessionId}`);
  }

  async newSession(): Promise<string> {
    const id = `sess-${crypto.randomUUID().slice(0, 12)}`;
    this.sql.exec("INSERT INTO sessions (id) VALUES (?)", id);
    this.log("newSession", id);
    return id;
  }

  async addTracks(sessionId: string, body: { sessionDescription?: SessionDescription; tracks: Array<LocalTrack | RemoteTrack> }): Promise<TracksResponse> {
    this.requireSession(sessionId);
    this.log("addTracks", sessionId, body);
    const results: TrackResult[] = [];
    let pulled = false;
    for (const t of body.tracks) {
      if (t.location === "local") {
        if (!body.sessionDescription || body.sessionDescription.type !== "offer") {
          results.push({ location: "local", mid: t.mid, errorCode: "invalid_request", errorDescription: "local tracks need an offer" });
          continue;
        }
        this.sql.exec(
          "INSERT OR REPLACE INTO tracks (session_id, mid, track_name, location, status) VALUES (?, ?, ?, 'local', 'active')",
          sessionId,
          t.mid,
          t.trackName,
        );
        results.push({ location: "local", mid: t.mid, trackName: t.trackName });
      } else {
        const source = this.sql
          .exec("SELECT mid FROM tracks WHERE session_id = ? AND track_name = ? AND location = 'local' AND status = 'active'", t.sessionId, t.trackName)
          .toArray()[0];
        if (!source) {
          results.push({ location: "remote", sessionId: t.sessionId, trackName: t.trackName, errorCode: "not_found", errorDescription: "track not found" });
          continue;
        }
        const mid = String(Number(this.sql.exec("SELECT COUNT(*) AS n FROM tracks WHERE session_id = ?", sessionId).one().n) + 100);
        this.sql.exec(
          "INSERT INTO tracks (session_id, mid, track_name, location, remote_session, preferred_rid, status) VALUES (?, ?, ?, 'remote', ?, ?, 'active')",
          sessionId,
          mid,
          t.trackName,
          t.sessionId,
          t.simulcast?.preferredRid ?? null,
        );
        results.push({ location: "remote", sessionId: t.sessionId, trackName: t.trackName, mid });
        pulled = true;
      }
    }
    return pulled
      ? { requiresImmediateRenegotiation: true, sessionDescription: { type: "offer", sdp: `fake-offer-${sessionId}` }, tracks: results }
      : { requiresImmediateRenegotiation: false, sessionDescription: { type: "answer", sdp: `fake-answer-${sessionId}` }, tracks: results };
  }

  async renegotiate(sessionId: string, sessionDescription: SessionDescription): Promise<void> {
    this.requireSession(sessionId);
    this.log("renegotiate", sessionId, { sessionDescription });
  }

  async closeTracks(sessionId: string, mids: string[], opts: { force: boolean; sessionDescription?: SessionDescription }): Promise<TracksResponse> {
    this.requireSession(sessionId);
    this.log("closeTracks", sessionId, { mids, ...opts });
    const tracks: TrackResult[] = mids.map((mid) => {
      const updated = this.sql
        .exec("UPDATE tracks SET status = 'inactive' WHERE session_id = ? AND mid = ? AND status = 'active' RETURNING mid", sessionId, mid)
        .toArray();
      return updated.length > 0 ? { mid } : { mid, errorCode: "close_track_error", errorDescription: "Track doesn't exist or was already closed" };
    });
    return opts.force ? { tracks } : { tracks, sessionDescription: { type: "answer", sdp: `fake-answer-${sessionId}` } };
  }

  async updateTracks(sessionId: string, tracks: Array<{ location: "remote"; mid: string; simulcast: SimulcastPreference }>): Promise<TracksResponse> {
    this.requireSession(sessionId);
    this.log("updateTracks", sessionId, { tracks });
    for (const t of tracks) this.sql.exec("UPDATE tracks SET preferred_rid = ? WHERE session_id = ? AND mid = ?", t.simulcast.preferredRid, sessionId, t.mid);
    return { tracks: tracks.map((t) => ({ mid: t.mid })) };
  }

  // ---- inspection for tests
  async calls(): Promise<FakeCall[]> {
    return this.sql
      .exec("SELECT op, session_id, body FROM calls ORDER BY id")
      .toArray()
      .map((r) => ({ op: String(r.op), sessionId: r.session_id === null ? null : String(r.session_id), bodyJson: String(r.body) }));
  }

  async trackStatus(sessionId: string, trackName: string): Promise<string | null> {
    const row = this.sql.exec("SELECT status FROM tracks WHERE session_id = ? AND track_name = ? AND location = 'local'", sessionId, trackName).toArray()[0];
    return row ? String(row.status) : null;
  }

  async preferredRid(sessionId: string, mid: string): Promise<string | null> {
    const row = this.sql.exec("SELECT preferred_rid FROM tracks WHERE session_id = ? AND mid = ?", sessionId, mid).toArray()[0];
    return row ? (row.preferred_rid as string | null) : null;
  }
}

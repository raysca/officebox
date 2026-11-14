// WorkspacePresence Durable Object: a single instance holding who is online (TDD §2.2, §3.5).
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";

export type PresenceStatus = "online" | "away" | "dnd" | "presenting";
export const PRESENCE_STATUSES: PresenceStatus[] = ["online", "away", "dnd", "presenting"];

export const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
export const PRESENCE_EXPIRY_MS = 12 * 60 * 1000;

export interface PresenceEntry {
  userId: string;
  status: PresenceStatus;
  since: number;
}

export interface PresenceChange {
  userId: string;
  status: PresenceStatus | "offline";
}

export class WorkspacePresence extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS online (
      user_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      since INTEGER NOT NULL,
      heartbeat_at INTEGER NOT NULL
    )`);
  }

  /** Called by a UserHub when its first socket connects. */
  async online(userId: string, status: PresenceStatus = "online"): Promise<void> {
    const now = Date.now();
    const before = this.statusOf(userId);
    this.sql.exec(
      `INSERT INTO online (user_id, status, since, heartbeat_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET status = excluded.status, heartbeat_at = excluded.heartbeat_at`,
      userId,
      status,
      now,
      now,
    );
    if (before !== status) await this.broadcast({ userId, status }, userId);
  }

  async setStatus(userId: string, status: PresenceStatus): Promise<void> {
    return this.online(userId, status);
  }

  /** Called by a UserHub alarm every few minutes while it has sockets. Re-adds an expired entry. */
  async heartbeat(userId: string): Promise<void> {
    const updated = this.sql.exec("UPDATE online SET heartbeat_at = ? WHERE user_id = ? RETURNING user_id", Date.now(), userId).toArray();
    if (updated.length === 0) await this.online(userId);
  }

  /** Called by a UserHub when its last socket closes (or the user is revoked). */
  async offline(userId: string): Promise<void> {
    const removed = this.sql.exec("DELETE FROM online WHERE user_id = ? RETURNING user_id", userId).toArray();
    if (removed.length > 0) await this.broadcast({ userId, status: "offline" }, userId);
  }

  /** Online users, after expiring entries whose hub stopped sending heartbeats. */
  async list(): Promise<PresenceEntry[]> {
    const stale = this.sql
      .exec("DELETE FROM online WHERE heartbeat_at < ? RETURNING user_id", Date.now() - PRESENCE_EXPIRY_MS)
      .toArray()
      .map((r) => String(r.user_id));
    for (const userId of stale) await this.broadcast({ userId, status: "offline" }, userId);
    return this.sql
      .exec("SELECT user_id, status, since FROM online ORDER BY user_id")
      .toArray()
      .map((r) => ({ userId: String(r.user_id), status: r.status as PresenceStatus, since: Number(r.since) }));
  }

  private statusOf(userId: string): string | null {
    const row = this.sql.exec("SELECT status FROM online WHERE user_id = ?", userId).toArray()[0];
    return row ? String(row.status) : null;
  }

  /** Presence changes are rare (connect, disconnect, status), so a direct call per online hub is fine. */
  private async broadcast(change: PresenceChange, except: string): Promise<void> {
    const targets = this.sql
      .exec("SELECT user_id FROM online WHERE user_id != ?", except)
      .toArray()
      .map((r) => String(r.user_id));
    await Promise.allSettled(targets.map((u) => this.env.USER_HUB.get(this.env.USER_HUB.idFromName(u)).presenceChanged(change)));
  }
}

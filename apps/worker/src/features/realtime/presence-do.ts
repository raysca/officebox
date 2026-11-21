import {
  derivedAvailabilitySchema,
  ok,
  PRESENCE_EXPIRY_MS,
  type DerivedAvailability,
  type PresenceEntry,
} from "@officebox/shared";
import { CoreDurableObject, type DoMigration, type RpcResult } from "../../core/do/base";

/**
 * `WorkspacePresence` Durable Object (M2a; TDD §2.2, §3.1; Notifications §5.5; Platform §11).
 *
 * Singleton per workspace (`env.PRESENCE.getByName("presence")`; TDD §2.2).
 *
 * - Stores online/idle users in SQLite (`online` table) so presence survives eviction and cold starts.
 * - `UserHub` calls `setOnline`, `heartbeat` (every 5 minutes) and `setOffline`.
 * - Entries expire after 12 minutes (`PRESENCE_EXPIRY_MS`, just over two missed 5-minute heartbeats).
 * - Whenever a user's presence or derived availability changes, `WorkspacePresence` fans out
 *   `presence.changed` / `status.changed` to the other active `UserHub`s so connected tabs see live updates.
 */

const MIGRATIONS: readonly DoMigration[] = [
  {
    version: 1,
    description: "workspace online presence table",
    up(sql) {
      sql.exec(`
        CREATE TABLE IF NOT EXISTS online (
          user_id TEXT PRIMARY KEY,
          state TEXT NOT NULL,
          last_seen_at INTEGER NOT NULL,
          status_text TEXT,
          availability_json TEXT
        )
      `);
      sql.exec("CREATE INDEX IF NOT EXISTS online_seen ON online(last_seen_at)");
    },
  },
];

interface OnlineRow extends Record<string, SqlStorageValue> {
  user_id: string;
  state: string;
  last_seen_at: number;
  status_text: string | null;
  availability_json: string | null;
}

function parseAvailability(raw: string | null): DerivedAvailability | undefined {
  if (!raw) return undefined;
  try {
    const parsed = derivedAvailabilitySchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export class WorkspacePresence extends CoreDurableObject {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.onTimer("sweep", () => this.sweepExpired());
  }

  protected override migrations(): readonly DoMigration[] {
    return MIGRATIONS;
  }

  private now(): number {
    const offset = Number(this.getMeta("test_time_offset_ms") ?? "0");
    return Date.now() + offset;
  }

  private scheduleNextSweep(): void {
    const oldest = this.sql
      .exec<{ oldest: number | null }>("SELECT MIN(last_seen_at) AS oldest FROM online")
      .toArray()[0]?.oldest;
    if (oldest == null) {
      this.cancelTimer("sweep:expired");
      return;
    }
    this.setTimer("sweep:expired", oldest + PRESENCE_EXPIRY_MS);
  }

  private async sweepExpired(): Promise<void> {
    const now = this.now();
    const cutoff = now - PRESENCE_EXPIRY_MS;
    const expired = this.sql
      .exec<{ user_id: string }>("SELECT user_id FROM online WHERE last_seen_at <= ?", cutoff)
      .toArray();
    if (expired.length > 0) {
      this.sql.exec("DELETE FROM online WHERE last_seen_at <= ?", cutoff);
      const recipients = this.currentRecipientIds();
      for (const row of expired) {
        const offlineAvailability: DerivedAvailability = {
          state: "offline",
          label: "Offline",
          until: null,
          source: "presence",
        };
        await this.broadcastChange(recipients, row.user_id, "offline", now, null, offlineAvailability);
      }
    }
    this.scheduleNextSweep();
  }

  private currentRecipientIds(): string[] {
    const cutoff = this.now() - PRESENCE_EXPIRY_MS;
    return this.sql
      .exec<{ user_id: string }>("SELECT user_id FROM online WHERE last_seen_at > ?", cutoff)
      .toArray()
      .map((r) => r.user_id);
  }

  private async broadcastChange(
    recipientIds: readonly string[],
    userId: string,
    state: "online" | "idle" | "offline",
    lastSeenAt: number,
    statusText: string | null,
    availability?: DerivedAvailability,
  ): Promise<void> {
    // Skip re-entrant self-RPC back to `userId`'s own `UserHub`, which already updates and
    // broadcasts its own presence and derived availability locally.
    const targets = recipientIds.filter((id) => id !== userId);
    if (targets.length === 0) return;
    await Promise.allSettled(
      targets.map((recipientId) =>
        this.env.USER_HUB.getByName(recipientId).deliverPresenceChange({
          userId,
          state,
          lastSeenAt,
          statusText,
          availability,
        }),
      ),
    );
  }

  // ------------------------------------------------------------------ RPC

  setOnline(
    userId: string,
    state: "online" | "idle",
    statusText: string | null = null,
    availability?: DerivedAvailability,
  ): Promise<RpcResult<{ changed: boolean }>> {
    return this.rpc(async () => {
      const now = this.now();
      const prev = this.sql
        .exec<OnlineRow>("SELECT state, status_text, availability_json FROM online WHERE user_id = ?", userId)
        .toArray()[0];
      const nextStatusText = statusText ?? prev?.status_text ?? null;
      const nextAvailJson = availability ? JSON.stringify(availability) : (prev?.availability_json ?? null);
      const changed =
        !prev ||
        prev.state !== state ||
        prev.status_text !== nextStatusText ||
        prev.availability_json !== nextAvailJson;

      this.sql.exec(
        `INSERT INTO online (user_id, state, last_seen_at, status_text, availability_json)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (user_id) DO UPDATE SET
           state = excluded.state,
           last_seen_at = excluded.last_seen_at,
           status_text = excluded.status_text,
           availability_json = COALESCE(excluded.availability_json, online.availability_json)`,
        userId,
        state,
        now,
        nextStatusText,
        nextAvailJson,
      );
      this.scheduleNextSweep();

      if (changed) {
        const recipients = this.currentRecipientIds();
        await this.broadcastChange(
          recipients,
          userId,
          state,
          now,
          nextStatusText,
          availability ?? parseAvailability(prev?.availability_json ?? null),
        );
      }
      return ok({ changed });
    });
  }

  /**
   * Sets an online member's status text (M1d), `null` included, and tells the other online members.
   * A member who isn't online is left alone: their hub passes the text when they come online.
   */
  setStatusText(userId: string, statusText: string | null): Promise<RpcResult<{ changed: boolean }>> {
    return this.rpc(async (): Promise<RpcResult<{ changed: boolean }>> => {
      const prev = this.sql
        .exec<OnlineRow>(
          "SELECT user_id, state, last_seen_at, status_text, availability_json FROM online WHERE user_id = ?",
          userId,
        )
        .toArray()[0];
      if (!prev || prev.status_text === statusText) return ok({ changed: false });
      this.sql.exec("UPDATE online SET status_text = ? WHERE user_id = ?", statusText, userId);
      const state = prev.state === "online" ? "online" : "idle";
      await this.broadcastChange(
        this.currentRecipientIds(),
        userId,
        state,
        prev.last_seen_at,
        statusText,
        parseAvailability(prev.availability_json),
      );
      return ok({ changed: true });
    });
  }

  heartbeat(
    userId: string,
    state: "online" | "idle",
    availability?: DerivedAvailability,
  ): Promise<RpcResult<{ ok: true }>> {
    return this.rpc(async () => {
      const now = this.now();
      const prev = this.sql
        .exec<OnlineRow>("SELECT state, status_text, availability_json FROM online WHERE user_id = ?", userId)
        .toArray()[0];
      const nextAvailJson = availability ? JSON.stringify(availability) : (prev?.availability_json ?? null);
      const changed = !prev || prev.state !== state || prev.availability_json !== nextAvailJson;

      this.sql.exec(
        `INSERT INTO online (user_id, state, last_seen_at, status_text, availability_json)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (user_id) DO UPDATE SET
           state = excluded.state,
           last_seen_at = excluded.last_seen_at,
           availability_json = COALESCE(excluded.availability_json, online.availability_json)`,
        userId,
        state,
        now,
        prev?.status_text ?? null,
        nextAvailJson,
      );
      this.scheduleNextSweep();

      if (changed) {
        const recipients = this.currentRecipientIds();
        await this.broadcastChange(
          recipients,
          userId,
          state,
          now,
          prev?.status_text ?? null,
          availability ?? parseAvailability(prev?.availability_json ?? null),
        );
      }
      return ok({ ok: true as const });
    });
  }

  setOffline(userId: string, availability?: DerivedAvailability): Promise<RpcResult<{ changed: boolean }>> {
    return this.rpc(async () => {
      const now = this.now();
      const prev = this.sql
        .exec<{ user_id: string }>("SELECT user_id FROM online WHERE user_id = ?", userId)
        .toArray()[0];
      this.sql.exec("DELETE FROM online WHERE user_id = ?", userId);
      this.scheduleNextSweep();

      if (prev) {
        const recipients = this.currentRecipientIds();
        await this.broadcastChange(recipients, userId, "offline", now, null, availability);
      }
      return ok({ changed: Boolean(prev) });
    });
  }

  listOnline(): Promise<RpcResult<PresenceEntry[]>> {
    return this.rpc(() => {
      const cutoff = this.now() - PRESENCE_EXPIRY_MS;
      const rows = this.sql
        .exec<OnlineRow>(
          "SELECT user_id, state, last_seen_at, status_text, availability_json FROM online WHERE last_seen_at > ? ORDER BY user_id",
          cutoff,
        )
        .toArray();
      return ok(
        rows.map((r) => {
          const availability = parseAvailability(r.availability_json);
          return {
            userId: r.user_id,
            state: r.state === "idle" ? ("idle" as const) : ("online" as const),
            lastSeenAt: r.last_seen_at,
            statusText: r.status_text,
            ...(availability ? { availability } : {}),
          };
        }),
      );
    });
  }

  getPresence(userId: string): Promise<RpcResult<{ state: "online" | "idle" | "offline"; lastSeenAt: number | null }>> {
    return this.rpc(() => {
      const cutoff = this.now() - PRESENCE_EXPIRY_MS;
      const row = this.sql
        .exec<{ state: string; last_seen_at: number }>(
          "SELECT state, last_seen_at FROM online WHERE user_id = ? AND last_seen_at > ?",
          userId,
          cutoff,
        )
        .toArray()[0];
      const result: { state: "online" | "idle" | "offline"; lastSeenAt: number | null } = row
        ? {
            state: row.state === "idle" ? "idle" : "online",
            lastSeenAt: row.last_seen_at,
          }
        : { state: "offline", lastSeenAt: null };
      return ok(result);
    });
  }
}

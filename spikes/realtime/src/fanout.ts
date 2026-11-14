// Inbox items and batched fan-out after each projection batch (TDD §3.3 step 5, §3.5).
import type { Env, HubActivity, InboxItem, ProjectionMessage } from "./env";
import type { PresenceEntry } from "./presence";

const ONLINE_CACHE_MS = 5000;
let onlineCache: { at: number; users: Set<string> } | null = null;

export function clearOnlineCache(): void {
  onlineCache = null;
}

async function onlineUsers(env: Env): Promise<Set<string>> {
  if (onlineCache && Date.now() - onlineCache.at < ONLINE_CACHE_MS) return onlineCache.users;
  const entries: PresenceEntry[] = await env.PRESENCE.get(env.PRESENCE.idFromName("presence")).list();
  onlineCache = { at: Date.now(), users: new Set(entries.map((e) => e.userId)) };
  return onlineCache.users;
}

/**
 * Creates inbox items for mentions and DMs (idempotent via dedupe_key), then sends one `activity`
 * call per online member of the affected channels. Returns what was done, for tests and logs.
 */
export async function fanOut(env: Env, messages: ProjectionMessage[]): Promise<{ inbox: number; hubCalls: number }> {
  if (messages.length === 0) return { inbox: 0, hubCalls: 0 };
  const channelIds = [...new Set(messages.map((m) => m.channelId))];
  const placeholders = channelIds.map(() => "?").join(",");
  const [membersResult, channelsResult] = await env.DB.batch([
    env.DB.prepare(`SELECT channel_id, user_id FROM channel_members WHERE channel_id IN (${placeholders})`).bind(...channelIds),
    env.DB.prepare(`SELECT id, type FROM channels WHERE id IN (${placeholders})`).bind(...channelIds),
  ]);
  const members = new Map<string, Set<string>>();
  for (const row of membersResult!.results as Array<{ channel_id: string; user_id: string }>) {
    if (!members.has(row.channel_id)) members.set(row.channel_id, new Set());
    members.get(row.channel_id)!.add(row.user_id);
  }
  const channelType = new Map((channelsResult!.results as Array<{ id: string; type: string }>).map((r) => [r.id, r.type]));

  // 1. Inbox items. Only for live messages; recipients must belong to the channel; never the sender.
  const now = Date.now();
  const candidates: Array<InboxItem & { userId: string }> = [];
  for (const m of messages) {
    if (m.deletedAt !== null) continue;
    const channelMembers = members.get(m.channelId) ?? new Set<string>();
    const recipients = new Map<string, "mention" | "dm">();
    if (channelType.get(m.channelId) === "dm") {
      for (const u of channelMembers) recipients.set(u, "dm");
    }
    for (const u of m.mentions) if (channelMembers.has(u)) recipients.set(u, "mention");
    recipients.delete(m.senderId);
    for (const [userId, eventType] of recipients) {
      candidates.push({ id: crypto.randomUUID(), userId, eventType, channelId: m.channelId, seq: m.seq, messageId: m.id, actorId: m.senderId, createdAt: now });
    }
  }
  const created: Array<InboxItem & { userId: string }> = [];
  if (candidates.length > 0) {
    const results = await env.DB.batch(
      candidates.map((c) =>
        env.DB.prepare(
          `INSERT OR IGNORE INTO inbox_items
             (id, user_id, kind, event_type, source_type, source_id, source_seq, message_id, actor_id, dedupe_key, state, created_at, updated_at)
           VALUES (?, ?, 'notification', ?, 'channel', ?, ?, ?, ?, ?, 'unread', ?, ?)
           RETURNING id`,
        ).bind(c.id, c.userId, c.eventType, c.channelId, c.seq, c.messageId, c.actorId, `${c.channelId}:${c.seq}:${c.eventType}`, now, now),
      ),
    );
    results.forEach((r, i) => {
      if (r.results.length > 0) created.push(candidates[i]!);
    });
  }

  // 2. Fan-out: one call per online member, covering every affected channel in this batch.
  const online = await onlineUsers(env);
  const byChannel = new Map<string, { channelId: string; latestSeq: number; changedSeq: number }>();
  for (const m of messages) {
    const entry = byChannel.get(m.channelId) ?? { channelId: m.channelId, latestSeq: 0, changedSeq: 0 };
    entry.latestSeq = Math.max(entry.latestSeq, m.seq);
    entry.changedSeq = Math.max(entry.changedSeq, m.lastEventSeq);
    byChannel.set(m.channelId, entry);
  }
  const payloads = new Map<string, HubActivity>();
  for (const [channelId, info] of byChannel) {
    for (const userId of members.get(channelId) ?? []) {
      if (!online.has(userId)) continue;
      const payload = payloads.get(userId) ?? { channels: [], inbox: [] };
      payload.channels.push(info);
      payloads.set(userId, payload);
    }
  }
  for (const item of created) {
    const { userId, ...rest } = item;
    payloads.get(userId)?.inbox.push(rest);
  }
  await Promise.allSettled(
    [...payloads].map(([userId, payload]) => env.USER_HUB.get(env.USER_HUB.idFromName(userId)).activity(payload)),
  );
  return { inbox: created.length, hubCalls: payloads.size };
}

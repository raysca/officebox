// Queue consumer side of the D1 copy (TDD §3.3). Idempotent and order-independent:
// every message carries full state, and a row only changes if the incoming last_event_seq is newer.
import type { ProjectionMessage } from "./env";

export async function applyProjection(db: D1Database, messages: ProjectionMessage[]): Promise<void> {
  if (messages.length === 0) return;
  const statements: D1PreparedStatement[] = [];
  const maxSeqByChannel = new Map<string, number>();
  for (const m of messages) {
    statements.push(
      db
        .prepare(
          `INSERT INTO messages (channel_id, seq, id, sender_id, parent_id, body, reactions, created_at, edited_at, deleted_at, last_event_seq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (channel_id, seq) DO UPDATE SET
             body = excluded.body,
             reactions = excluded.reactions,
             edited_at = excluded.edited_at,
             deleted_at = excluded.deleted_at,
             last_event_seq = excluded.last_event_seq
           WHERE excluded.last_event_seq > messages.last_event_seq`,
        )
        .bind(m.channelId, m.seq, m.id, m.senderId, m.parentId, m.body, m.reactions, m.createdAt, m.editedAt, m.deletedAt, m.lastEventSeq),
    );
    maxSeqByChannel.set(m.channelId, Math.max(maxSeqByChannel.get(m.channelId) ?? 0, m.lastEventSeq));
  }
  for (const [channelId, seq] of maxSeqByChannel) {
    statements.push(db.prepare("UPDATE channels SET projected_seq = MAX(projected_seq, ?) WHERE id = ?").bind(seq, channelId));
  }
  await db.batch(statements);
}

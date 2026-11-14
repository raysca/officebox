// Worker entry: authentication, permission resolution, routing to Durable Objects, and the D1 copy consumer.
import {
  HttpError,
  SESSION_TTL_MS,
  authenticateUpgrade,
  issueTicket,
  requireSession,
  sessionCookie,
  signSession,
} from "./auth";
import type { ChannelRole } from "./chat-channel";
import { seed } from "./dev";
import type { DocRole } from "./doc-room";
import type { Env, ProjectionMessage } from "./env";
import { fanOut } from "./fanout";
import { applyProjection } from "./projection";

export { ChatChannel } from "./chat-channel";
export { DocRoom } from "./doc-room";
export { WorkspacePresence } from "./presence";
export { UserHub } from "./user-hub";

const ID = "[A-Za-z0-9_-]{1,64}";
const CHANNEL_WS = new RegExp(`^/ws/channels/(${ID})$`);
const DOC_WS = new RegExp(`^/ws/docs/(${ID})$`);
const CHANNEL_READ = new RegExp(`^/api/channels/(${ID})/read$`);
const INBOX_ITEM = new RegExp(`^/api/inbox/(${ID})$`);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      let match: RegExpMatchArray | null;
      if ((match = url.pathname.match(CHANNEL_WS))) return await connectChannel(request, env, match[1]!);
      if ((match = url.pathname.match(DOC_WS))) return await connectDoc(request, env, match[1]!);
      if (url.pathname === "/ws/hub") return await connectHub(request, env);
      if (url.pathname === "/api/unread" && request.method === "GET") return await unread(request, env);
      if (url.pathname === "/api/inbox" && request.method === "GET") return await inbox(request, env);
      if ((match = url.pathname.match(CHANNEL_READ)) && request.method === "POST") return await markRead(request, env, match[1]!);
      if ((match = url.pathname.match(INBOX_ITEM)) && request.method === "POST") return await updateInboxItem(request, env, match[1]!);
      if (url.pathname === "/auth/ws-ticket" && request.method === "POST") return await wsTicket(request, env);
      if (url.pathname.startsWith("/dev/") && env.DEV_LOGIN === "1") return await devRoute(request, env, url);
      return new Response("Not found", { status: 404 });
    } catch (err) {
      if (err instanceof HttpError) return new Response(err.message, { status: err.status });
      console.error(err);
      return new Response("Internal error", { status: 500 });
    }
  },

  async queue(batch: MessageBatch<ProjectionMessage>, env: Env): Promise<void> {
    // Throwing makes the whole batch retry; projection and inbox inserts are idempotent, so that's safe.
    const messages = batch.messages.map((m) => m.body);
    await applyProjection(env.DB, messages);
    await fanOut(env, messages);
    batch.ackAll();
  },
} satisfies ExportedHandler<Env, ProjectionMessage>;

async function connectChannel(request: Request, env: Env, channelId: string): Promise<Response> {
  const userId = await authenticateUpgrade(request, env, `channels:${channelId}`);
  const channel = await env.DB.prepare("SELECT type FROM channels WHERE id = ? AND deleted_at IS NULL")
    .bind(channelId)
    .first<{ type: string }>();
  if (!channel) throw new HttpError(404, "Channel not found");
  const member = await env.DB.prepare("SELECT role FROM channel_members WHERE channel_id = ? AND user_id = ?")
    .bind(channelId, userId)
    .first<{ role: ChannelRole }>();
  if (!member && channel.type !== "public") throw new HttpError(403, "Not a member of this channel");
  const role: ChannelRole = member?.role ?? "member";
  // Build a fresh request so no client-supplied identity headers reach the DO.
  return env.CHAT.get(env.CHAT.idFromName(channelId)).fetch(
    new Request("https://do/connect", {
      headers: { Upgrade: "websocket", "x-ob-user": userId, "x-ob-role": role, "x-ob-channel": channelId },
    }),
  );
}

const ROLE_RANK: Record<DocRole, number> = { viewer: 1, commenter: 2, editor: 3, owner: 4 };
const GENERAL_ACCESS_ROLE: Record<string, DocRole | null> = {
  restricted: null,
  workspace_view: "viewer",
  workspace_comment: "commenter",
  workspace_edit: "editor",
};

/** Document role resolution (TDD §2.1, simplified to user grants for the spike). */
async function resolveDocRole(env: Env, docId: string, userId: string): Promise<DocRole | null> {
  const doc = await env.DB.prepare("SELECT owner_id, general_access FROM documents WHERE id = ? AND deleted_at IS NULL")
    .bind(docId)
    .first<{ owner_id: string; general_access: string }>();
  if (!doc) throw new HttpError(404, "Document not found");
  if (doc.owner_id === userId) return "owner";
  const grant = await env.DB.prepare(
    `SELECT role FROM resource_grants
      WHERE resource_type = 'document' AND resource_id = ? AND principal_type = 'user' AND principal_id = ?`,
  )
    .bind(docId, userId)
    .first<{ role: DocRole }>();
  const candidates = [grant?.role ?? null, GENERAL_ACCESS_ROLE[doc.general_access] ?? null].filter(
    (r): r is DocRole => r !== null,
  );
  if (candidates.length === 0) return null;
  return candidates.sort((a, b) => ROLE_RANK[b] - ROLE_RANK[a])[0]!;
}

async function connectDoc(request: Request, env: Env, docId: string): Promise<Response> {
  const userId = await authenticateUpgrade(request, env, `docs:${docId}`);
  const role = await resolveDocRole(env, docId, userId);
  if (!role) throw new HttpError(403, "No access to this document");
  return env.DOCS.get(env.DOCS.idFromName(docId)).fetch(
    new Request("https://do/connect", {
      headers: { Upgrade: "websocket", "x-ob-user": userId, "x-ob-role": role, "x-ob-doc": docId },
    }),
  );
}

async function connectHub(request: Request, env: Env): Promise<Response> {
  const userId = await authenticateUpgrade(request, env, "hub");
  return env.USER_HUB.get(env.USER_HUB.idFromName(userId)).fetch(
    new Request("https://do/connect", { headers: { Upgrade: "websocket", "x-ob-user": userId } }),
  );
}

/** Unread and mention counts per channel, computed from the D1 copy (TDD §3.5). */
async function unread(request: Request, env: Env): Promise<Response> {
  const session = await requireSession(request, env);
  const rows = await env.DB.prepare(
    `SELECT cm.channel_id AS channelId, cm.last_read_seq AS lastReadSeq,
            (SELECT COUNT(*) FROM messages m
              WHERE m.channel_id = cm.channel_id AND m.seq > cm.last_read_seq
                AND m.deleted_at IS NULL AND m.sender_id != cm.user_id) AS unread,
            (SELECT COUNT(*) FROM inbox_items i
              WHERE i.user_id = cm.user_id AND i.source_type = 'channel'
                AND i.source_id = cm.channel_id AND i.state = 'unread') AS mentions
       FROM channel_members cm WHERE cm.user_id = ? ORDER BY cm.channel_id`,
  )
    .bind(session.uid)
    .all();
  return Response.json({ channels: rows.results });
}

/** Marks a channel read up to `seq`; inbox items for messages up to that point resolve to read. */
async function markRead(request: Request, env: Env, channelId: string): Promise<Response> {
  const session = await requireSession(request, env, { stateChanging: true });
  const { seq } = (await request.json()) as { seq?: unknown };
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0) throw new HttpError(400, "seq must be a non-negative integer");
  const [membership] = await env.DB.batch([
    env.DB.prepare(
      "UPDATE channel_members SET last_read_seq = MAX(last_read_seq, ?) WHERE channel_id = ? AND user_id = ? RETURNING last_read_seq",
    ).bind(seq, channelId, session.uid),
    env.DB.prepare(
      `UPDATE inbox_items SET state = 'read', updated_at = ?
        WHERE user_id = ? AND source_type = 'channel' AND source_id = ? AND source_seq <= ? AND state = 'unread'`,
    ).bind(Date.now(), session.uid, channelId, seq),
  ]);
  if (membership!.results.length === 0) throw new HttpError(404, "Not a member of this channel");
  return Response.json({ lastReadSeq: (membership!.results[0] as { last_read_seq: number }).last_read_seq });
}

async function inbox(request: Request, env: Env): Promise<Response> {
  const session = await requireSession(request, env);
  const rows = await env.DB.prepare(
    `SELECT id, event_type AS eventType, source_id AS channelId, source_seq AS seq, message_id AS messageId,
            actor_id AS actorId, state, created_at AS createdAt
       FROM inbox_items WHERE user_id = ? AND state IN ('unread', 'read') ORDER BY created_at DESC LIMIT 100`,
  )
    .bind(session.uid)
    .all();
  return Response.json({ items: rows.results });
}

async function updateInboxItem(request: Request, env: Env, itemId: string): Promise<Response> {
  const session = await requireSession(request, env, { stateChanging: true });
  const { state } = (await request.json()) as { state?: unknown };
  if (state !== "read" && state !== "done" && state !== "dismissed") throw new HttpError(400, "state must be read, done or dismissed");
  const row = await env.DB.prepare("UPDATE inbox_items SET state = ?, updated_at = ? WHERE id = ? AND user_id = ? RETURNING id")
    .bind(state, Date.now(), itemId, session.uid)
    .first();
  if (!row) throw new HttpError(404, "Inbox item not found");
  return Response.json({ id: itemId, state });
}

async function wsTicket(request: Request, env: Env): Promise<Response> {
  const session = await requireSession(request, env, { stateChanging: true });
  const { target } = (await request.json()) as { target?: unknown };
  if (typeof target !== "string" || !new RegExp(`^(channels|docs):${ID}$`).test(target)) {
    throw new HttpError(400, "target must look like docs:<id> or channels:<id>");
  }
  return Response.json({ ticket: await issueTicket(env, session.uid, target) });
}

async function devRoute(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== "POST") throw new HttpError(405, "POST only");
  switch (url.pathname) {
    case "/dev/seed":
      await seed(env);
      return new Response("seeded");
    case "/dev/login": {
      const { userId } = (await request.json()) as { userId?: string };
      const user = await env.DB.prepare("SELECT id, session_epoch FROM users WHERE id = ?")
        .bind(userId ?? "")
        .first<{ id: string; session_epoch: number }>();
      if (!user) throw new HttpError(404, "Unknown user");
      const token = await signSession(
        { uid: user.id, sid: crypto.randomUUID(), exp: Date.now() + SESSION_TTL_MS, ep: user.session_epoch },
        env.SESSION_SECRET,
      );
      return new Response("ok", { headers: { "Set-Cookie": sessionCookie(token) } });
    }
    case "/dev/remove-member": {
      // Demonstrates revocation (TDD §3.5): remove from a private channel, then close open sockets.
      const { channelId, userId } = (await request.json()) as { channelId: string; userId: string };
      await env.DB.prepare("DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?").bind(channelId, userId).run();
      const closed = await env.CHAT.get(env.CHAT.idFromName(channelId)).closeConnections(userId);
      return Response.json({ closed });
    }
    case "/dev/disable-user": {
      // Revocation (TDD §3.5, §8.1): disable, bump session_epoch, close every open socket via the user's hub.
      const { userId } = (await request.json()) as { userId: string };
      await env.DB.prepare("UPDATE users SET status = 'disabled', session_epoch = session_epoch + 1 WHERE id = ?").bind(userId).run();
      const closed = await env.USER_HUB.get(env.USER_HUB.idFromName(userId)).revoke(userId, 4401, "session revoked");
      return Response.json(closed);
    }
    default:
      throw new HttpError(404, "Unknown dev route");
  }
}

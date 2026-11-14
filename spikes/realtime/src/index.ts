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
import { type ScreenSharePolicy, TRACK_KINDS, type TrackKind } from "./huddle-room";
import { SfuError, iceServers, sfuFor, type SessionDescription } from "./sfu";
import { applyProjection } from "./projection";

export { ChatChannel } from "./chat-channel";
export { DocRoom } from "./doc-room";
export { WorkspacePresence } from "./presence";
export { UserHub } from "./user-hub";
export { HuddleRoom } from "./huddle-room";
export { FakeSfu } from "./fake-sfu";

const ID = "[A-Za-z0-9_-]{1,64}";
const CHANNEL_WS = new RegExp(`^/ws/channels/(${ID})$`);
const DOC_WS = new RegExp(`^/ws/docs/(${ID})$`);
const CHANNEL_READ = new RegExp(`^/api/channels/(${ID})/read$`);
const INBOX_ITEM = new RegExp(`^/api/inbox/(${ID})$`);
const HUDDLE_WS = new RegExp(`^/ws/huddles/(${ID})$`);
const HUDDLE_ROUTE = new RegExp(`^/huddles/(${ID})/(tracks/publish|tracks/subscribe|tracks/close|tracks/layer|renegotiate|ice-servers)$`);
const RPC_ERROR = /^(forbidden|not_found|conflict|bad_request|gone): /;
const RPC_STATUS: Record<string, number> = { forbidden: 403, not_found: 404, conflict: 409, bad_request: 400, gone: 410 };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      let match: RegExpMatchArray | null;
      if ((match = url.pathname.match(CHANNEL_WS))) return await connectChannel(request, env, match[1]!);
      if ((match = url.pathname.match(DOC_WS))) return await connectDoc(request, env, match[1]!);
      if (url.pathname === "/ws/hub") return await connectHub(request, env);
      if ((match = url.pathname.match(HUDDLE_WS))) return await connectHuddle(request, env, match[1]!);
      if (url.pathname === "/huddles" && request.method === "POST") return await startHuddle(request, env);
      if ((match = url.pathname.match(HUDDLE_ROUTE))) return await huddleRoute(request, env, match[1]!, match[2]!);
      if (url.pathname === "/api/unread" && request.method === "GET") return await unread(request, env);
      if (url.pathname === "/api/inbox" && request.method === "GET") return await inbox(request, env);
      if ((match = url.pathname.match(CHANNEL_READ)) && request.method === "POST") return await markRead(request, env, match[1]!);
      if ((match = url.pathname.match(INBOX_ITEM)) && request.method === "POST") return await updateInboxItem(request, env, match[1]!);
      if (url.pathname === "/auth/ws-ticket" && request.method === "POST") return await wsTicket(request, env);
      if (url.pathname.startsWith("/dev/") && env.DEV_LOGIN === "1") return await devRoute(request, env, url);
      return new Response("Not found", { status: 404 });
    } catch (err) {
      if (err instanceof HttpError) return new Response(err.message, { status: err.status });
      if (err instanceof SfuError) return new Response(err.message, { status: err.status >= 500 || err.status < 400 ? 502 : err.status });
      // Errors thrown by Durable Objects over RPC keep their message.
      const rpc = err instanceof Error ? err.message.match(RPC_ERROR) : null;
      if (rpc) return new Response(err instanceof Error ? err.message : "", { status: RPC_STATUS[rpc[1]!] });
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
  if (request.method === "GET" && url.pathname === "/dev/media-harness") {
    // Blank same-origin page that the media run injects participant code into (cookies + Origin check work).
    return new Response("<!doctype html><meta charset=utf-8><title>media harness</title>", { headers: { "Content-Type": "text/html" } });
  }
  if (request.method === "GET" && url.pathname === "/dev/sfu-status") {
    return Response.json({
      sfuMode: env.SFU_MODE ?? "real",
      realtimeConfigured: Boolean(env.REALTIME_APP_ID && env.REALTIME_APP_SECRET),
      turnConfigured: Boolean(env.TURN_KEY_ID && env.TURN_KEY_API_TOKEN),
    });
  }
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

// ------------------------------------------------------------------ huddles (TDD §3.6)

interface HuddleRow {
  id: string;
  context_type: "channel" | "document";
  context_id: string;
  started_by: string;
  ended_at: number | null;
}

/** Huddle access follows the context: channel membership (or public), or any document role. */
async function huddleAccess(env: Env, userId: string, contextType: string, contextId: string): Promise<{ moderator: boolean }> {
  if (contextType === "channel") {
    const channel = await env.DB.prepare("SELECT type FROM channels WHERE id = ? AND deleted_at IS NULL").bind(contextId).first<{ type: string }>();
    if (!channel) throw new HttpError(404, "Channel not found");
    const member = await env.DB.prepare("SELECT role FROM channel_members WHERE channel_id = ? AND user_id = ?")
      .bind(contextId, userId)
      .first<{ role: ChannelRole }>();
    if (!member && channel.type !== "public") throw new HttpError(403, "No access to this channel");
    return { moderator: member?.role === "admin" };
  }
  if (contextType === "document") {
    const role = await resolveDocRole(env, contextId, userId);
    if (!role) throw new HttpError(403, "No access to this document");
    return { moderator: role === "owner" };
  }
  throw new HttpError(400, "contextType must be channel or document");
}

async function loadHuddle(env: Env, huddleId: string): Promise<HuddleRow> {
  const huddle = await env.DB.prepare("SELECT id, context_type, context_id, started_by, ended_at FROM huddles WHERE id = ?")
    .bind(huddleId)
    .first<HuddleRow>();
  if (!huddle) throw new HttpError(404, "Huddle not found");
  if (huddle.ended_at !== null) throw new HttpError(410, "Huddle has ended");
  return huddle;
}

async function initHuddleRoom(env: Env, huddle: HuddleRow): Promise<void> {
  const settings = await env.DB.prepare("SELECT key, value FROM settings WHERE key IN ('screen_share', 'screen_share_max_height')").all<{ key: string; value: string }>();
  const get = (k: string) => settings.results.find((r) => r.key === k)?.value;
  await env.HUDDLES.get(env.HUDDLES.idFromName(huddle.id)).init({
    huddleId: huddle.id,
    contextType: huddle.context_type,
    contextId: huddle.context_id,
    hostId: huddle.started_by,
    policy: (get("screen_share") ?? "everyone") as ScreenSharePolicy,
    maxHeight: Number(get("screen_share_max_height") ?? 1080),
  });
}

/** Starts a huddle in a context, or returns the active one (one per context, enforced by a partial unique index). */
async function startHuddle(request: Request, env: Env): Promise<Response> {
  const session = await requireSession(request, env, { stateChanging: true });
  const { contextType, contextId } = (await request.json()) as { contextType?: string; contextId?: string };
  if (typeof contextType !== "string" || typeof contextId !== "string") throw new HttpError(400, "contextType and contextId are required");
  await huddleAccess(env, session.uid, contextType, contextId);
  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO huddles (id, context_type, context_id, started_by, started_at) VALUES (?, ?, ?, ?, ?) RETURNING id`,
  )
    .bind(crypto.randomUUID(), contextType, contextId, session.uid, Date.now())
    .first<{ id: string }>();
  if (!inserted) {
    const active = await env.DB.prepare("SELECT id FROM huddles WHERE context_type = ? AND context_id = ? AND ended_at IS NULL")
      .bind(contextType, contextId)
      .first<{ id: string }>();
    return Response.json({ huddleId: active!.id, created: false });
  }
  const huddle = await loadHuddle(env, inserted.id);
  await initHuddleRoom(env, huddle);
  if (contextType === "channel") {
    await env.CHAT.get(env.CHAT.idFromName(contextId)).postSystemEvent(contextId, "huddle.started", { huddleId: huddle.id, startedBy: session.uid });
  }
  return Response.json({ huddleId: huddle.id, created: true });
}

async function connectHuddle(request: Request, env: Env, huddleId: string): Promise<Response> {
  const userId = await authenticateUpgrade(request, env, `huddles:${huddleId}`);
  const huddle = await loadHuddle(env, huddleId);
  const { moderator } = await huddleAccess(env, userId, huddle.context_type, huddle.context_id);
  await initHuddleRoom(env, huddle); // idempotent; covers a join racing the start
  return env.HUDDLES.get(env.HUDDLES.idFromName(huddleId)).fetch(
    new Request("https://do/connect", {
      headers: { Upgrade: "websocket", "x-ob-user": userId, "x-ob-moderator": moderator || huddle.started_by === userId ? "1" : "0" },
    }),
  );
}

function isSessionDescription(value: unknown, type?: "offer" | "answer"): value is SessionDescription {
  const sd = value as SessionDescription | undefined;
  return !!sd && typeof sd.sdp === "string" && (sd.type === "offer" || sd.type === "answer") && (!type || sd.type === type);
}

/** SFU signalling goes through the Worker so the app secret never reaches clients and every call is authorised. */
async function huddleRoute(request: Request, env: Env, huddleId: string, action: string): Promise<Response> {
  const isGet = action === "ice-servers";
  if (isGet ? request.method !== "GET" : request.method !== "POST") throw new HttpError(405, "Method not allowed");
  const session = await requireSession(request, env, { stateChanging: !isGet });
  const huddle = await loadHuddle(env, huddleId);
  await huddleAccess(env, session.uid, huddle.context_type, huddle.context_id);
  if (isGet) return Response.json({ iceServers: await iceServers(env) });

  const room = env.HUDDLES.get(env.HUDDLES.idFromName(huddleId));
  const sfu = sfuFor(env);
  const body = (await request.json()) as Record<string, any>;
  const connId = body.connId;
  if (typeof connId !== "string") throw new HttpError(400, "connId is required");

  switch (action) {
    case "tracks/publish": {
      const tracks = body.tracks as Array<{ mid: string; kind: TrackKind }>;
      if (!isSessionDescription(body.sessionDescription, "offer")) throw new HttpError(400, "sessionDescription must be an SDP offer");
      if (!Array.isArray(tracks) || tracks.length === 0 || tracks.length > 4) throw new HttpError(400, "tracks must list 1–4 tracks");
      if (tracks.some((t) => typeof t.mid !== "string" || !TRACK_KINDS.includes(t.kind))) throw new HttpError(400, "each track needs a mid and a kind");
      const prepared = await room.preparePublish(session.uid, connId, tracks.map((t) => t.kind));
      let sessionId = prepared.sessionId;
      if (!sessionId) {
        sessionId = await sfu.newSession();
        await room.setSession(session.uid, connId, sessionId);
      }
      // Track names are the kind; they are unique within a participant's SFU session.
      const result = await sfu.addTracks(sessionId, {
        sessionDescription: body.sessionDescription,
        tracks: tracks.map((t) => ({ location: "local", mid: t.mid, trackName: t.kind })),
      });
      const ok = tracks.filter((t) => !(result.tracks ?? []).some((r) => r.mid === t.mid && r.errorCode));
      if (ok.length > 0) await room.tracksPublished(session.uid, connId, ok.map((t) => ({ kind: t.kind, mid: t.mid, trackName: t.kind })));
      return Response.json(result);
    }
    case "tracks/subscribe": {
      const wanted = body.tracks as Array<{ connId: string; kind: string; preferredRid?: string }>;
      if (!Array.isArray(wanted) || wanted.length === 0 || wanted.length > 64) throw new HttpError(400, "tracks must list 1–64 tracks");
      const { sessionId, remote } = await room.authorizeSubscribe(session.uid, connId, wanted.map((w) => ({ connId: w.connId, kind: w.kind })));
      const result = await sfu.addTracks(sessionId, {
        tracks: remote.map((r, i) => ({
          location: "remote",
          sessionId: r.sessionId,
          trackName: r.trackName,
          // Simulcast layer choice for video and screen; fall back alphabetically (f > h > q) if the layer is missing.
          ...(wanted[i]!.preferredRid && (r.kind === "screen" || r.kind === "video")
            ? { simulcast: { preferredRid: wanted[i]!.preferredRid!, priorityOrdering: "asciibetical", ridNotAvailable: "asciibetical" } }
            : {}),
        })),
      });
      return Response.json({ ...result, publishers: remote.map((r) => ({ connId: r.connId, kind: r.kind })) });
    }
    case "renegotiate": {
      if (!isSessionDescription(body.sessionDescription, "answer")) throw new HttpError(400, "sessionDescription must be an SDP answer");
      await sfu.renegotiate(await room.sessionFor(session.uid, connId), body.sessionDescription);
      return Response.json({});
    }
    case "tracks/close": {
      const mids = body.mids as string[];
      if (!Array.isArray(mids) || mids.length === 0 || mids.some((m) => typeof m !== "string")) throw new HttpError(400, "mids must be a non-empty list");
      const sessionDescription = isSessionDescription(body.sessionDescription, "offer") ? body.sessionDescription : undefined;
      const result = await sfu.closeTracks(await room.sessionFor(session.uid, connId), mids, { force: !sessionDescription, sessionDescription });
      await room.tracksClosed(session.uid, connId, mids);
      return Response.json(result);
    }
    case "tracks/layer": {
      if (typeof body.mid !== "string" || typeof body.preferredRid !== "string") throw new HttpError(400, "mid and preferredRid are required");
      const result = await sfu.updateTracks(await room.sessionFor(session.uid, connId), [
        { location: "remote", mid: body.mid, simulcast: { preferredRid: body.preferredRid, priorityOrdering: "asciibetical", ridNotAvailable: "asciibetical" } },
      ]);
      return Response.json(result);
    }
    default:
      throw new HttpError(404, "Unknown huddle route");
  }
}

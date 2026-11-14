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
import { applyProjection } from "./projection";

export { ChatChannel } from "./chat-channel";
export { DocRoom } from "./doc-room";

const ID = "[A-Za-z0-9_-]{1,64}";
const CHANNEL_WS = new RegExp(`^/ws/channels/(${ID})$`);
const DOC_WS = new RegExp(`^/ws/docs/(${ID})$`);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      let match: RegExpMatchArray | null;
      if ((match = url.pathname.match(CHANNEL_WS))) return await connectChannel(request, env, match[1]!);
      if ((match = url.pathname.match(DOC_WS))) return await connectDoc(request, env, match[1]!);
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
    // Throwing makes the whole batch retry; applyProjection is idempotent, so that's safe.
    await applyProjection(env.DB, batch.messages.map((m) => m.body));
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
    new Request("https://do/connect", { headers: { Upgrade: "websocket", "x-ob-user": userId, "x-ob-role": role } }),
  );
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
      const user = await env.DB.prepare("SELECT id FROM users WHERE id = ?").bind(userId ?? "").first();
      if (!user) throw new HttpError(404, "Unknown user");
      const token = await signSession({ uid: userId!, sid: crypto.randomUUID(), exp: Date.now() + SESSION_TTL_MS }, env.SESSION_SECRET);
      return new Response("ok", { headers: { "Set-Cookie": sessionCookie(token) } });
    }
    case "/dev/remove-member": {
      // Demonstrates revocation (TDD §3.5): remove from a private channel, then close open sockets.
      const { channelId, userId } = (await request.json()) as { channelId: string; userId: string };
      await env.DB.prepare("DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?").bind(channelId, userId).run();
      const closed = await env.CHAT.get(env.CHAT.idFromName(channelId)).closeConnections(userId);
      return Response.json({ closed });
    }
    default:
      throw new HttpError(404, "Unknown dev route");
  }
}

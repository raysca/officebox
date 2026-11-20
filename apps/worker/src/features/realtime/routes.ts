import {
  apiError,
  err,
  issueWsTicketBodySchema,
  ok,
  setDndBodySchema,
  ulidSchema,
  updateRealtimePreferencesBodySchema,
} from "@officebox/shared";
import { Hono } from "hono";
import { defineFeature } from "../../core/app";
import { authOf, type AppContext, type AppEnv } from "../../core/context";
import { Database, expectOk } from "../../core/db";
import { errorResponse, readJson, respond } from "../../core/errors";
import { authorize } from "../../core/permissions";
import { permissionContext } from "../identity/facts";
import { identityServices, loadSession, requireAuth } from "../identity/middleware";
import { consumeWsTicket, issueWsTicket } from "./tickets";

/**
 * Realtime HTTP & WebSocket routes (M2a; TDD §3.1, §4.2; Notifications §5.5–5.7, §10; Platform §12).
 *
 * - `GET /api/ws/hub` and `GET /ws/hub`: WebSocket upgrade to the signed-in user's `UserHub`.
 *   Authenticates either via better-auth session cookie + `Origin === canonicalOrigin`, or via a
 *   single-use `?ticket=<raw>` query parameter bound to `target = "hub"`.
 * - `POST /api/auth/ws-ticket` and `POST /api/realtime/ws-ticket`: issues a 30-second, single-use
 *   WebSocket ticket bound to `target` (`"hub"` or `"<kind>:<roomId>"`).
 * - `GET /api/members/:id/availability`: returns the member's derived availability (`state`, `label`,
 *   `until`, `source`) and raw `presence`, checked through `authorize(…, { action: "availability.view" })`.
 * - `GET /api/realtime/presence`: returns the workspace online/idle list (`presence.view`).
 * - `PUT /api/me/dnd` and `PUT /api/realtime/dnd`: sets or clears the caller's manual DND (`dnd.edit`)
 *   and refreshes their `UserHub` availability.
 * - `PATCH /api/me/preferences` and `PATCH /api/realtime/preferences`: updates the caller's timezone
 *   or recurring `dndSchedule` (`preferences.edit`) and refreshes their `UserHub` availability.
 */

const SMALL_BODY = 16 * 1024;
const UNAUTHENTICATED = apiError("unauthenticated", "Sign in to continue.");
const FORBIDDEN_ORIGIN = apiError("forbidden", "Origin not allowed for WebSocket upgrade.");

/**
 * Authenticates a WebSocket upgrade request for `target` (`"hub"` or `"<kind>:<roomId>"`).
 *
 * 1. Requires `Upgrade: websocket`.
 * 2. When `Origin` is present, requires `Origin === canonicalOrigin`. When no `?ticket=` is used,
 *    `Origin` MUST be present and match `canonicalOrigin` (TDD §3.1).
 * 3. Authenticates via `?ticket=<raw>` (consumed atomically by compare-and-set) OR via the
 *    `__Host-officebox.session_token` cookie through `loadSession(c)`.
 */
export async function upgradeHubWebSocket(c: AppContext): Promise<Response> {
  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") {
    return errorResponse(c, apiError("validation_failed", "WebSocket Upgrade header is required."));
  }

  const services = await identityServices(c);
  if (!services.ok) return errorResponse(c, services.error);
  const canonicalOrigin = services.value.installation.canonicalOrigin;
  const origin = c.req.header("Origin");

  if (origin && origin !== canonicalOrigin) {
    return errorResponse(c, FORBIDDEN_ORIGIN);
  }

  const rawTicket = c.req.query("ticket");
  let userId: string;
  let sessionId: string;

  if (rawTicket) {
    const consumed = await consumeWsTicket(c.env, c.var.log, rawTicket, "hub", c.var.now());
    if (!consumed) {
      return errorResponse(c, UNAUTHENTICATED);
    }
    userId = consumed.userId;
    sessionId = consumed.sessionId;
  } else {
    // Cookie-authenticated WebSocket upgrades must present a matching Origin header (TDD §3.1).
    if (!origin || origin !== canonicalOrigin) {
      return errorResponse(c, FORBIDDEN_ORIGIN);
    }
    const loaded = await loadSession(c, { forward: false });
    if (!loaded.ok) {
      return errorResponse(c, UNAUTHENTICATED);
    }
    const auth = authOf(c);
    userId = auth.userId;
    sessionId = auth.sessionId;
  }

  const stub = c.env.USER_HUB.getByName(userId);
  const doUrl = new URL("http://do/ws");
  doUrl.searchParams.set("userId", userId);
  doUrl.searchParams.set("sessionId", sessionId);
  const headers = new Headers(c.req.raw.headers);
  headers.delete("cookie");
  headers.set("X-User-Id", userId);
  headers.set("X-Session-Id", sessionId);

  return stub.fetch(new Request(doUrl.toString(), { headers }));
}

/** Handler for `POST /api/auth/ws-ticket` and `POST /api/realtime/ws-ticket`. */
export async function handleIssueWsTicket(c: AppContext): Promise<Response> {
  const me = authOf(c);
  const allowed = await authorize(permissionContext(c, me), {
    action: "ws_ticket.create",
    ownerId: me.userId,
  });
  if (!allowed.ok) return respond(c, allowed);

  const body = await readJson(c, issueWsTicketBodySchema, SMALL_BODY);
  if (!body.ok) return respond(c, body);

  const issued = await issueWsTicket(c.env, c.var.log, me.userId, me.sessionId, body.value.target, c.var.now());
  if (!issued) {
    return respond(c, err(apiError("unavailable", "Sign-in keys can't be read right now. Try again in a moment.")));
  }
  return respond(c, ok(issued), 201);
}

/** Handler for `PUT /api/me/dnd` and `PUT /api/realtime/dnd`. */
export async function handleSetMyDnd(c: AppContext): Promise<Response> {
  const me = authOf(c);
  const allowed = await authorize(permissionContext(c, me), {
    action: "dnd.edit",
    ownerId: me.userId,
  });
  if (!allowed.ok) return respond(c, allowed);

  const body = await readJson(c, setDndBodySchema, SMALL_BODY);
  if (!body.ok) return respond(c, body);

  const now = c.var.now();
  const db = new Database(c.env.DB);
  expectOk(
    await db.run(
      `INSERT INTO user_preferences (user_id, dnd_until, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET
         dnd_until = excluded.dnd_until,
         updated_at = excluded.updated_at`,
      me.userId,
      body.value.until,
      now,
    ),
  );

  const refreshed = await c.env.USER_HUB.getByName(me.userId).refreshAvailability(me.userId);
  if (!refreshed.ok) return respond(c, refreshed);
  return respond(c, ok({ availability: refreshed.value }));
}

/** Handler for `PATCH /api/me/preferences` and `PATCH /api/realtime/preferences`. */
export async function handleUpdateMyPreferences(c: AppContext): Promise<Response> {
  const me = authOf(c);
  const allowed = await authorize(permissionContext(c, me), {
    action: "preferences.edit",
    ownerId: me.userId,
  });
  if (!allowed.ok) return respond(c, allowed);

  const body = await readJson(c, updateRealtimePreferencesBodySchema, SMALL_BODY);
  if (!body.ok) return respond(c, body);

  if (body.value.timezone !== undefined) {
    try {
      Intl.DateTimeFormat("en-GB", { timeZone: body.value.timezone });
    } catch {
      return respond(
        c,
        err(
          apiError("validation_failed", "Invalid IANA time zone.", {
            fields: { timezone: ["Invalid IANA time zone."] },
          }),
        ),
      );
    }
  }

  const now = c.var.now();
  const db = new Database(c.env.DB);
  const [userRow, prefRow] = await Promise.all([
    db.first<{ timezone: string | null }>("SELECT timezone FROM users WHERE id = ?", me.userId),
    db.first<{ dnd_schedule: string | null }>("SELECT dnd_schedule FROM user_preferences WHERE user_id = ?", me.userId),
  ]);
  const existingUser = expectOk(userRow);
  const existingPref = expectOk(prefRow);
  const nextTimezone = body.value.timezone ?? existingUser?.timezone ?? "UTC";
  const nextSchedule =
    body.value.dndSchedule === undefined
      ? (existingPref?.dnd_schedule ?? null)
      : body.value.dndSchedule === null
        ? null
        : JSON.stringify(body.value.dndSchedule);

  if (body.value.timezone !== undefined) {
    expectOk(await db.run("UPDATE users SET timezone = ? WHERE id = ?", nextTimezone, me.userId));
  }
  if (body.value.dndSchedule !== undefined) {
    expectOk(
      await db.run(
        `INSERT INTO user_preferences (user_id, dnd_schedule, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT (user_id) DO UPDATE SET
           dnd_schedule = excluded.dnd_schedule,
           updated_at = excluded.updated_at`,
        me.userId,
        nextSchedule,
        now,
      ),
    );
  }

  const refreshed = await c.env.USER_HUB.getByName(me.userId).refreshAvailability(me.userId);
  if (!refreshed.ok) return respond(c, refreshed);
  return respond(c, ok({ timezone: nextTimezone, availability: refreshed.value }));
}

const wsRoutes = new Hono<AppEnv>().get("/hub", (c) => upgradeHubWebSocket(c));

const membersRoutes = new Hono<AppEnv>().use(requireAuth).get("/:id/availability", async (c) => {
  const me = authOf(c);
  const allowed = await authorize(permissionContext(c, me), { action: "availability.view" });
  if (!allowed.ok) return respond(c, allowed);

  const targetId = c.req.param("id");
  if (!ulidSchema.safeParse(targetId).success) {
    return respond(c, err(apiError("not_found", "No such member.")));
  }

  const db = new Database(c.env.DB);
  const target = expectOk(
    await db.first<{ id: string; status: string; role: string }>(
      "SELECT id, status, role FROM users WHERE id = ?",
      targetId,
    ),
  );
  if (!target || target.status === "deleted" || target.status === "system" || target.role === "system") {
    return respond(c, err(apiError("not_found", "No such member.")));
  }

  const res = await c.env.USER_HUB.getByName(targetId).getAvailability(targetId);
  if (!res.ok) return respond(c, res);
  return respond(
    c,
    ok({
      userId: targetId,
      presence: res.value.presence,
      availability: res.value.availability,
    }),
  );
});

const realtimeRoutes = new Hono<AppEnv>()
  .use(requireAuth)
  .post("/ws-ticket", (c) => handleIssueWsTicket(c))
  .put("/dnd", (c) => handleSetMyDnd(c))
  .patch("/preferences", (c) => handleUpdateMyPreferences(c))
  .get("/presence", async (c) => {
    const me = authOf(c);
    const allowed = await authorize(permissionContext(c, me), { action: "presence.view" });
    if (!allowed.ok) return respond(c, allowed);

    const res = await c.env.PRESENCE.getByName("presence").listOnline();
    if (!res.ok) return respond(c, res);
    return respond(c, ok({ online: res.value }));
  });

export const wsFeature = defineFeature("ws", wsRoutes);
export const membersFeature = defineFeature("members", membersRoutes);
export const realtimeFeature = defineFeature("realtime", realtimeRoutes);

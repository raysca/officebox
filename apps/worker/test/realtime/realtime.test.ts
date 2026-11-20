import {
  ACTIVE_WINDOW_MS,
  PRESENCE_EXPIRY_MS,
  WS_CLOSE_ACCESS_REMOVED,
  WS_CLOSE_SESSION_REVOKED,
  type HubServerMessage,
} from "@officebox/shared";
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "../../src/core/log";
import { closeAllUserConnections } from "../../src/features/identity/revocation";
import { clearOnlineUsersCache, fanOutToOnlineUsers } from "../../src/features/realtime/fanout";
import { REALTIME_JOBS } from "../../src/features/realtime/jobs";
import { registerRoomCloser, updateUserRoomAccess, type RoomCloseEvent } from "../../src/features/realtime/revocation";
import type { UserHub, WorkspacePresence } from "../../src/index";
import type { SoftAuthenticator } from "../identity/authenticator";
import {
  addMember,
  Browser,
  callWorker,
  ORIGIN,
  setupWorkspace,
  signInWithPasskey,
  type Workspace,
} from "../identity/helpers";

async function advanceDoClock(stub: DurableObjectStub<UserHub | WorkspacePresence>, ms: number): Promise<void> {
  await runInDurableObject(stub, (_instance, state) => {
    const current = Number(
      state.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'test_time_offset_ms'").toArray()[0]
        ?.value ?? "0",
    );
    state.storage.sql.exec(
      "INSERT OR REPLACE INTO meta (key, value) VALUES ('test_time_offset_ms', ?)",
      String(current + ms),
    );
    state.storage.sql.exec("UPDATE core_timers SET due_at = due_at - ?", ms);
  });
}

const quietLog = createLogger({}, () => {});

let ws: Workspace;
beforeAll(async () => {
  ws = await setupWorkspace();
});

async function signedInBrowser(member: { authenticator: SoftAuthenticator }) {
  const browser = new Browser();
  const { verify } = await signInWithPasskey(browser, member.authenticator);
  expect(verify.status).toBe(200);
  return browser;
}

class HubTestSocket {
  readonly ws: WebSocket;
  readonly messages: HubServerMessage[] = [];
  readonly rawMessages: string[] = [];
  closed: { code: number; reason: string } | null = null;
  private waiters: Array<() => void> = [];

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.accept();
    ws.addEventListener("message", (event) => {
      const text = String(event.data);
      this.rawMessages.push(text);
      if (text !== "pong") {
        try {
          this.messages.push(JSON.parse(text) as HubServerMessage);
        } catch {
          // Ignore malformed JSON.
        }
      }
      this.flushWaiters();
    });
    ws.addEventListener("close", (event) => {
      this.closed = { code: event.code, reason: event.reason };
      this.flushWaiters();
    });
  }

  private flushWaiters(): void {
    const current = this.waiters;
    this.waiters = [];
    for (const resolve of current) resolve();
  }

  async waitFor<T extends HubServerMessage["type"]>(
    type: T,
    predicate?: (msg: Extract<HubServerMessage, { type: T }>) => boolean,
    timeoutMs = 3000,
  ): Promise<Extract<HubServerMessage, { type: T }>> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.messages.find(
        (m): m is Extract<HubServerMessage, { type: T }> =>
          m.type === type && (!predicate || predicate(m as Extract<HubServerMessage, { type: T }>)),
      );
      if (found) return found;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 25);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    throw new Error(`Timed out waiting for message type ${type}; received: ${JSON.stringify(this.messages)}`);
  }

  async waitForClose(timeoutMs = 5000): Promise<{ code: number; reason: string }> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.closed) return this.closed;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 25);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    throw new Error("Timed out waiting for WebSocket close");
  }

  sendTabState(visible: boolean, lastInputAt: number): void {
    this.ws.send(JSON.stringify({ type: "tab.state", visible, lastInputAt }));
  }

  close(): void {
    try {
      this.ws.close(1000, "test_done");
    } catch {
      // Ignore.
    }
  }
}

async function openHubSocket(
  browser: Browser,
  options: { path?: string; origin?: string | null; ticket?: string } = {},
): Promise<{ response: Response; socket: HubTestSocket | null }> {
  const path = options.path ?? "/api/ws/hub";
  const url = `${ORIGIN}${path}${options.ticket ? `?ticket=${encodeURIComponent(options.ticket)}` : ""}`;
  const headers: Record<string, string> = {
    Upgrade: "websocket",
    "cf-connecting-ip": browser.ip,
    "user-agent": browser.userAgent,
  };
  if (options.origin !== null) {
    headers.Origin = options.origin ?? ORIGIN;
  }
  const cookie = browser.cookieHeader();
  if (cookie && !options.ticket) {
    headers.Cookie = cookie;
  }
  const res = await callWorker(new Request(url, { headers }));
  if (res.status !== 101 || !res.webSocket) {
    return { response: res, socket: null };
  }
  return { response: res, socket: new HubTestSocket(res.webSocket) };
}

describe("WebSocket authentication & upgrade (/api/ws/hub and /ws/hub)", () => {
  it("upgrades with a valid session cookie and matching Origin on both /api/ws/hub and /ws/hub", async () => {
    const member = await addMember();
    const { response, socket } = await openHubSocket(member.browser, { path: "/ws/hub" });
    expect(response.status).toBe(101);
    expect(socket).not.toBeNull();
    const welcome = await socket!.waitFor("hub.welcome");
    expect(welcome.userId).toBe(member.id);
    expect(welcome.presence).toBe("online");
    expect(welcome.availability.state).toBe("online");

    // Ping/pong auto-response works without waking the DO (poll with deadline instead of fixed sleep).
    socket!.ws.send("ping");
    const deadline = Date.now() + 2000;
    while (!socket!.rawMessages.includes("pong") && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(socket!.rawMessages).toContain("pong");
    socket!.close();
  });

  it("refuses upgrades without a session cookie, with a mismatched Origin, or for a disabled user", async () => {
    const anon = new Browser();
    const noSession = await openHubSocket(anon);
    expect(noSession.response.status).toBe(401);

    const member = await addMember();
    const wrongOrigin = await openHubSocket(member.browser, { origin: "https://evil.test" });
    expect(wrongOrigin.response.status).toBe(403);

    const missingOrigin = await openHubSocket(member.browser, { origin: null });
    expect(missingOrigin.response.status).toBe(403);

    await env.DB.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").bind(member.id).run();
    const disabled = await openHubSocket(member.browser);
    expect(disabled.response.status).toBe(401);
  });

  it("issues a 30s single-use ws-ticket bound to target and refuses replay, wrong target, expiry, or denied callers", async () => {
    const member = await addMember();
    const issued = await member.browser.json<{ ticket: string; expiresAt: number; target: string }>(
      "/api/auth/ws-ticket",
      { body: { target: "hub" } },
    );
    expect(issued.status).toBe(201);
    expect(issued.body.target).toBe("hub");

    // First use succeeds even without a Cookie header.
    const first = await openHubSocket(new Browser(), { ticket: issued.body.ticket });
    expect(first.response.status).toBe(101);
    const welcome = await first.socket!.waitFor("hub.welcome");
    expect(welcome.userId).toBe(member.id);
    first.socket!.close();

    // Replay of the same single-use ticket fails with 401.
    const replay = await openHubSocket(new Browser(), { ticket: issued.body.ticket });
    expect(replay.response.status).toBe(401);

    // A ticket bound to a room target cannot upgrade /api/ws/hub.
    const roomTicket = await member.browser.json<{ ticket: string }>("/api/auth/ws-ticket", {
      body: { target: `channel:${member.id}` },
    });
    expect(roomTicket.status).toBe(201);
    const wrongTarget = await openHubSocket(new Browser(), { ticket: roomTicket.body.ticket });
    expect(wrongTarget.response.status).toBe(401);

    // Expired ticket (>30s) is refused.
    const expiring = await member.browser.json<{ ticket: string }>("/api/auth/ws-ticket", {
      body: { target: "hub" },
    });
    expect(expiring.status).toBe(201);
    await env.DB.prepare("UPDATE ws_tickets SET expires_at = ? WHERE user_id = ?")
      .bind(Date.now() - 1000, member.id)
      .run();
    expect((await openHubSocket(new Browser(), { ticket: expiring.body.ticket })).response.status).toBe(401);

    // Ticket issued before user disable is refused.
    const beforeDisable = await member.browser.json<{ ticket: string }>("/api/auth/ws-ticket", {
      body: { target: "hub" },
    });
    expect(beforeDisable.status).toBe(201);
    await env.DB.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").bind(member.id).run();
    expect((await openHubSocket(new Browser(), { ticket: beforeDisable.body.ticket })).response.status).toBe(401);
    await env.DB.prepare("UPDATE users SET status = 'active' WHERE id = ?").bind(member.id).run();

    // Denied callers & validation: unauthenticated (401), guest (403), invalid target (400).
    expect((await new Browser().json("/api/auth/ws-ticket", { body: { target: "hub" } })).status).toBe(401);
    expect((await member.browser.json("/api/auth/ws-ticket", { body: { target: "not-a-target" } })).status).toBe(400);
    const guest = await addMember();
    await env.DB.prepare("UPDATE users SET role = 'guest' WHERE id = ?").bind(guest.id).run();
    expect((await guest.browser.json("/api/auth/ws-ticket", { body: { target: "hub" } })).status).toBe(403);
  });
});

describe("Presence, 2-minute active rule & derived availability (Notifications §5.5–5.7)", () => {
  it("tracks online → idle (after 2 min without visible input) → offline, and fans out presence.changed", async () => {
    const alice = await addMember();
    const bob = await addMember();

    const aliceConn = await openHubSocket(alice.browser);
    const bobConn = await openHubSocket(bob.browser);
    expect(aliceConn.socket).not.toBeNull();
    expect(bobConn.socket).not.toBeNull();

    await aliceConn.socket!.waitFor("hub.welcome");
    await bobConn.socket!.waitFor("hub.welcome");

    // Bob sees Alice online in `/api/realtime/presence`.
    const onlineRes = await bob.browser.json<{ online: Array<{ userId: string; state: string }> }>(
      "/api/realtime/presence",
    );
    expect(onlineRes.status).toBe(200);
    expect(onlineRes.body.online.some((e) => e.userId === alice.id && e.state === "online")).toBe(true);

    // When Alice's tab becomes hidden, she immediately transitions to `idle` because no visible tab
    // has recent input.
    aliceConn.socket!.messages.length = 0;
    bobConn.socket!.messages.length = 0;
    aliceConn.socket!.sendTabState(false, Date.now());

    const idleChange = await bobConn.socket!.waitFor(
      "presence.changed",
      (m) => m.userId === alice.id && m.state === "idle",
    );
    expect(idleChange.state).toBe("idle");

    // When Alice makes her tab visible again with fresh input, she returns to `online`.
    bobConn.socket!.messages.length = 0;
    aliceConn.socket!.sendTabState(true, Date.now());
    const onlineAgain = await bobConn.socket!.waitFor(
      "presence.changed",
      (m) => m.userId === alice.id && m.state === "online",
    );
    expect(onlineAgain.state).toBe("online");

    // If Alice's tab remains visible but has no input for > 2 minutes, the `active_expiry` alarm
    // transitions her to `idle`.
    bobConn.socket!.messages.length = 0;
    const aliceHub = env.USER_HUB.getByName(alice.id);
    await advanceDoClock(aliceHub, ACTIVE_WINDOW_MS + 1000);
    await runDurableObjectAlarm(aliceHub);

    const expiredToIdle = await bobConn.socket!.waitFor(
      "presence.changed",
      (m) => m.userId === alice.id && m.state === "idle",
    );
    expect(expiredToIdle.state).toBe("idle");

    aliceConn.socket!.close();
    bobConn.socket!.close();
  });

  it("expires stale WorkspacePresence entries after 12 minutes via alarm", async () => {
    const member = await addMember();
    const presenceStub = env.PRESENCE.getByName("presence");
    await presenceStub.setOnline(member.id, "online", null);
    const before = await presenceStub.getPresence(member.id);
    expect(before.ok && before.value.state).toBe("online");

    // Advance WorkspacePresence clock past PRESENCE_EXPIRY_MS and run its sweep alarm.
    await advanceDoClock(presenceStub, PRESENCE_EXPIRY_MS + 5000);
    await runDurableObjectAlarm(presenceStub);

    const after = await presenceStub.getPresence(member.id);
    expect(after.ok && after.value.state).toBe("offline");
  });

  it("evaluates derived availability precedence (away > dnd > focus > scheduled_dnd > presence) and persists across eviction", async () => {
    const member = await addMember();
    const viewer = await addMember();
    const conn = await openHubSocket(member.browser);
    await conn.socket!.waitFor("hub.welcome");

    const now = Date.now();
    // 1. Set recurring DND schedule covering all 7 days 00:00–23:59 UTC -> scheduled_dnd.
    const prefRes = await member.browser.json("/api/me/preferences", {
      method: "PATCH",
      body: {
        timezone: "UTC",
        dndSchedule: {
          mon: [["00:00", "23:59"]],
          tue: [["00:00", "23:59"]],
          wed: [["00:00", "23:59"]],
          thu: [["00:00", "23:59"]],
          fri: [["00:00", "23:59"]],
          sat: [["00:00", "23:59"]],
          sun: [["00:00", "23:59"]],
        },
      },
    });
    expect(prefRes.status).toBe(200);

    let avail = await viewer.browser.json<{
      presence: string;
      availability: { state: string; label: string; source: string };
    }>(`/api/members/${member.id}/availability`);
    expect(avail.status).toBe(200);
    expect(avail.body.availability).toMatchObject({
      state: "scheduled_dnd",
      label: "Do Not Disturb",
      source: "dnd_schedule",
    });

    // 2. Insert an active focus event -> focus beats scheduled_dnd.
    await env.DB.prepare(
      `INSERT INTO user_availability (user_id, focus_event_id, focus_until, updated_at)
       VALUES (?, 'evt-focus', ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET
         focus_event_id = excluded.focus_event_id,
         focus_until = excluded.focus_until,
         updated_at = excluded.updated_at`,
    )
      .bind(member.id, now + 30 * 60_000, now)
      .run();
    await env.USER_HUB.getByName(member.id).refreshAvailability(member.id);

    avail = await viewer.browser.json(`/api/members/${member.id}/availability`);
    expect(avail.body.availability).toMatchObject({
      state: "focus",
      label: "Focus time",
      source: "focus",
    });

    // 3. Set manual DND via PUT /api/me/dnd -> dnd beats focus.
    const dndRes = await member.browser.json<{ availability: { state: string; source: string } }>("/api/me/dnd", {
      method: "PUT",
      body: { until: now + 60 * 60_000 },
    });
    expect(dndRes.status).toBe(200);
    expect(dndRes.body.availability).toMatchObject({ state: "dnd", source: "manual_dnd" });

    // 4. Evict the UserHub Durable Object and verify persisted `storedAvailability` survives eviction
    // before any D1 recompute (PLAN M2 exit criterion).
    const hubStub = env.USER_HUB.getByName(member.id);
    await evictDurableObject(hubStub);

    const infoAfterEvict = await hubStub.connectedInfo();
    expect(infoAfterEvict.ok && infoAfterEvict.value.storedAvailability).toMatchObject({
      state: "dnd",
      label: "Do Not Disturb",
      source: "manual_dnd",
    });

    avail = await viewer.browser.json(`/api/members/${member.id}/availability`);
    expect(avail.status).toBe(200);
    expect(avail.body.availability).toMatchObject({
      state: "dnd",
      label: "Do Not Disturb",
      source: "manual_dnd",
    });

    // 5. Set active time-off (`away_until` tomorrow in UTC) -> away beats manual dnd.
    const tomorrow = new Date(now + 2 * 24 * 60 * 60_000).toISOString().slice(0, 10);
    await env.DB.prepare("UPDATE user_availability SET away_time_off_id = 'evt-pto', away_until = ? WHERE user_id = ?")
      .bind(tomorrow, member.id)
      .run();
    await hubStub.refreshAvailability(member.id);

    avail = await viewer.browser.json(`/api/members/${member.id}/availability`);
    expect(avail.body.availability).toMatchObject({
      state: "away",
      label: "Away",
      source: "time_off",
    });

    // Denied & validation cases: unauthenticated (401), guest (403), invalid timezone (400),
    // invalid ULID / unknown / deleted member availability (404).
    expect((await new Browser().json(`/api/members/${member.id}/availability`)).status).toBe(401);
    expect((await new Browser().json("/api/me/dnd", { method: "PUT", body: { until: null } })).status).toBe(401);
    expect(
      (await new Browser().json("/api/me/preferences", { method: "PATCH", body: { timezone: "UTC" } })).status,
    ).toBe(401);
    expect(
      (await member.browser.json("/api/me/preferences", { method: "PATCH", body: { timezone: "Mars/Olympus" } }))
        .status,
    ).toBe(400);
    expect((await viewer.browser.json("/api/members/not-a-ulid/availability")).status).toBe(404);
    expect((await viewer.browser.json("/api/members/01J00000000000000000000000/availability")).status).toBe(404);

    const deleted = await addMember();
    await env.DB.prepare("UPDATE users SET status = 'deleted' WHERE id = ?").bind(deleted.id).run();
    expect((await viewer.browser.json(`/api/members/${deleted.id}/availability`)).status).toBe(404);

    const guest = await addMember();
    await env.DB.prepare("UPDATE users SET role = 'guest' WHERE id = ?").bind(guest.id).run();
    expect((await guest.browser.json(`/api/members/${member.id}/availability`)).status).toBe(403);
    expect((await guest.browser.json("/api/realtime/presence")).status).toBe(403);
    expect((await guest.browser.json("/api/me/dnd", { method: "PUT", body: { until: null } })).status).toBe(403);
    expect(
      (await guest.browser.json("/api/me/preferences", { method: "PATCH", body: { timezone: "UTC" } })).status,
    ).toBe(403);

    conn.socket!.close();
  });

  it("availability_expiry alarm automatically clears expired manual DND and broadcasts status.changed", async () => {
    const member = await addMember();
    const conn = await openHubSocket(member.browser);
    await conn.socket!.waitFor("hub.welcome");

    const dndRes = await member.browser.json("/api/me/dnd", {
      method: "PUT",
      body: { until: Date.now() + 60_000 },
    });
    expect(dndRes.status).toBe(200);

    conn.socket!.messages.length = 0;
    const hub = env.USER_HUB.getByName(member.id);
    await advanceDoClock(hub, 65_000);
    await runDurableObjectAlarm(hub);

    const cleared = await conn.socket!.waitFor(
      "status.changed",
      (m) => m.userId === member.id && m.availability.source === "presence",
    );
    expect(cleared.availability.source).toBe("presence");
    conn.socket!.close();
  });
});

describe("Revocation, session-expiry recheck & room registry (TDD §3.5, Identity §4.5, Platform §12)", () => {
  it("revoking one session closes only that session's hub and room sockets with 4401, keeping other sessions open", async () => {
    const member = await addMember();
    const browserB = await signedInBrowser(member);

    const connA = await openHubSocket(member.browser);
    const connB = await openHubSocket(browserB);
    const welcomeA = await connA.socket!.waitFor("hub.welcome");
    const welcomeB = await connB.socket!.waitFor("hub.welcome");
    expect(welcomeA.sessionId).not.toBe(welcomeB.sessionId);

    // Register a room for session B and a room for session A.
    const hub = env.USER_HUB.getByName(member.id);
    const roomId = member.id; // valid ULID
    await hub.registerRoom("channel", roomId, "room-conn-a", welcomeA.sessionId);
    await hub.registerRoom("channel", roomId, "room-conn-b", welcomeB.sessionId);

    const closedRoomEvents: RoomCloseEvent[] = [];
    const unregisterCloser = registerRoomCloser("channel", (evt) => {
      closedRoomEvents.push(evt);
    });

    try {
      // Sign out session B from session A's "My devices" endpoint.
      const del = await member.browser.json(`/api/me/sessions/${welcomeB.sessionId}`, {
        method: "DELETE",
      });
      expect(del.status).toBe(200);

      // Session B's hub socket closes with 4401 within 5 seconds.
      const closedB = await connB.socket!.waitForClose(5000);
      expect(closedB.code).toBe(WS_CLOSE_SESSION_REVOKED);

      // Session A's hub socket remains open and responsive.
      expect(connA.socket!.closed).toBeNull();
      const remainingRooms = await hub.listRegisteredRooms();
      expect(remainingRooms.ok && remainingRooms.value.map((r) => r.connectionId)).toEqual(["room-conn-a"]);
      expect(
        closedRoomEvents.some((e) => e.connectionId === "room-conn-b" && e.code === WS_CLOSE_SESSION_REVOKED),
      ).toBe(true);
    } finally {
      unregisterCloser();
      connA.socket!.close();
    }
  });

  it("disabling a user (scope: 'all') closes all hub sockets and registered rooms with 4401", async () => {
    const member = await addMember();
    const browserB = await signedInBrowser(member);

    const connA = await openHubSocket(member.browser);
    const connB = await openHubSocket(browserB);
    await connA.socket!.waitFor("hub.welcome");
    await connB.socket!.waitFor("hub.welcome");

    const hub = env.USER_HUB.getByName(member.id);
    await hub.registerRoom("doc", member.id, "doc-conn-1", "s1");

    const closedDocs: RoomCloseEvent[] = [];
    const stopCloser = registerRoomCloser("doc", (evt) => {
      closedDocs.push(evt);
    });

    try {
      await env.DB.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").bind(member.id).run();
      await closeAllUserConnections(env, quietLog, member.id, "user_disabled");

      const [closeA, closeB] = await Promise.all([connA.socket!.waitForClose(5000), connB.socket!.waitForClose(5000)]);
      expect(closeA.code).toBe(WS_CLOSE_SESSION_REVOKED);
      expect(closeB.code).toBe(WS_CLOSE_SESSION_REVOKED);
      expect(closedDocs).toHaveLength(1);
      expect(closedDocs[0]?.code).toBe(WS_CLOSE_SESSION_REVOKED);

      // Platform §3: disabled member is removed from WorkspacePresence immediately.
      const presenceAfterDisable = await env.PRESENCE.getByName("presence").getPresence(member.id);
      expect(presenceAfterDisable.ok && presenceAfterDisable.value.state).toBe("offline");
    } finally {
      stopCloser();
    }
  });

  it("5-minute UserHub heartbeat alarm rechecks session expiry and user status in D1 and dispatches room closes", async () => {
    const member = await addMember();
    const conn = await openHubSocket(member.browser);
    const welcome = await conn.socket!.waitFor("hub.welcome");

    const hub = env.USER_HUB.getByName(member.id);
    await hub.registerRoom("channel", ws.ownerId, "hb-room-conn", welcome.sessionId);

    const closedRooms: RoomCloseEvent[] = [];
    const stopCloser = registerRoomCloser("channel", (e) => {
      closedRooms.push(e);
    });

    try {
      // Expire the session row in D1 without calling better-auth's delete hook.
      await env.DB.prepare("UPDATE sessions SET expires_at = ? WHERE id = ?")
        .bind(Date.now() - 10_000, welcome.sessionId)
        .run();

      await advanceDoClock(hub, 5 * 60_000 + 1000);
      await runDurableObjectAlarm(hub);

      const closed = await conn.socket!.waitForClose(5000);
      expect(closed.code).toBe(WS_CLOSE_SESSION_REVOKED);
      expect(closedRooms.some((e) => e.connectionId === "hb-room-conn" && e.code === WS_CLOSE_SESSION_REVOKED)).toBe(
        true,
      );
    } finally {
      stopCloser();
    }

    // Also verify heartbeat closes sockets when users.status becomes 'disabled' in D1.
    const member2 = await addMember();
    const conn2 = await openHubSocket(member2.browser);
    await conn2.socket!.waitFor("hub.welcome");
    await env.DB.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").bind(member2.id).run();

    const hub2 = env.USER_HUB.getByName(member2.id);
    await advanceDoClock(hub2, 5 * 60_000 + 1000);
    await runDurableObjectAlarm(hub2);

    const closed2 = await conn2.socket!.waitForClose(5000);
    expect(closed2.code).toBe(WS_CLOSE_SESSION_REVOKED);
  });

  it("updateUserRoomAccess broadcasts access.changed and closes rooms with 4403 even when room_registry has no entry", async () => {
    const member = await addMember();
    const conn = await openHubSocket(member.browser);
    const welcome = await conn.socket!.waitFor("hub.welcome");

    const hub = env.USER_HUB.getByName(member.id);
    await hub.registerRoom("doc", ws.ownerId, "doc-conn-4403", welcome.sessionId);

    // Downgrade to viewer: sends `access.changed` with role "viewer", keeps room registered.
    await updateUserRoomAccess(env, quietLog, member.id, "doc", ws.ownerId, "viewer");
    const changed = await conn.socket!.waitFor("access.changed", (m) => m.roomId === ws.ownerId && m.role === "viewer");
    expect(changed.role).toBe("viewer");

    // Remove access (`role = null`): sends `access.changed` with role null and closes room with 4403.
    const closedRooms: RoomCloseEvent[] = [];
    const stop = registerRoomCloser("doc", (e) => {
      closedRooms.push(e);
    });
    try {
      conn.socket!.messages.length = 0;
      await updateUserRoomAccess(env, quietLog, member.id, "doc", ws.ownerId, null);
      const removed = await conn.socket!.waitFor("access.changed", (m) => m.roomId === ws.ownerId && m.role === null);
      expect(removed.role).toBeNull();
      expect(closedRooms).toHaveLength(1);
      expect(closedRooms[0]?.code).toBe(WS_CLOSE_ACCESS_REMOVED);

      // Even when room_registry has no entry for another room, role = null still dispatches 4403.
      closedRooms.length = 0;
      await updateUserRoomAccess(env, quietLog, member.id, "doc", member.id, null);
      expect(closedRooms).toHaveLength(1);
      expect(closedRooms[0]).toMatchObject({
        kind: "doc",
        roomId: member.id,
        connectionId: null,
        code: WS_CLOSE_ACCESS_REMOVED,
      });
    } finally {
      stop();
      conn.socket!.close();
    }
  });
});

describe("Batched fan-out helper & daily prune cron (TDD §3.4)", () => {
  it("delivers activity batches only to online recipients using a single RPC per recipient", async () => {
    const onlineMember = await addMember();
    const offlineMember = await addMember();

    const conn = await openHubSocket(onlineMember.browser);
    await conn.socket!.waitFor("hub.welcome");
    clearOnlineUsersCache();

    const report = await fanOutToOnlineUsers(
      env,
      [onlineMember.id, offlineMember.id, onlineMember.id],
      [
        {
          id: onlineMember.id,
          kind: "message.created",
          roomKind: "channel",
          roomId: ws.ownerId,
          actorId: ws.ownerId,
          createdAt: Date.now(),
          payload: { preview: "Hello" },
        },
        {
          id: offlineMember.id,
          kind: "reaction.added",
          roomKind: "channel",
          roomId: ws.ownerId,
          actorId: ws.ownerId,
          createdAt: Date.now(),
          payload: { emoji: "👍" },
        },
      ],
    );

    expect(report.onlineRecipients).toEqual([onlineMember.id]);
    expect(report.rpcCalls).toBe(1);
    expect(report.deliveredSockets).toBe(1);

    const activity = await conn.socket!.waitFor("hub.activity");
    expect(activity.events).toHaveLength(2);
    conn.socket!.close();
  });

  it("realtime.prune cron job deletes expired ws_tickets older than retention window", async () => {
    const member = await addMember();
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO ws_tickets (token_hash, user_id, session_id, target, expires_at, created_at)
       VALUES ('expired-hash-prune', ?, 'sess-1', 'hub', ?, ?)`,
    )
      .bind(member.id, now - 2 * 60 * 60_000, now - 3 * 60 * 60_000)
      .run();

    const pruneJob = REALTIME_JOBS.find((j) => j.name === "realtime.prune");
    expect(pruneJob).toBeDefined();
    await pruneJob!.run({
      env,
      log: quietLog,
      now: () => now,
      scheduledTime: now,
    });

    const row = await env.DB.prepare(
      "SELECT token_hash FROM ws_tickets WHERE token_hash = 'expired-hash-prune'",
    ).first();
    expect(row).toBeNull();
  });
});

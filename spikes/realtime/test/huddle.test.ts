import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudflareSfu, SFU_BASE, SfuError, iceServers } from "../src/sfu";
import type { Env } from "../src/env";
import { JsonClient, ORIGIN, call, login, newChannel, newDoc, newUser, seed, sleep, upgrade } from "./helpers";
import { YClient } from "./yclient";

const open: Array<{ close(): void }> = [];
afterEach(() => {
  for (const c of open.splice(0)) c.close();
});
beforeEach(seed);

const room = (huddleId: string) => env.HUDDLES.get(env.HUDDLES.idFromName(huddleId));
const fakeSfu = () => env.FAKE_SFU.get(env.FAKE_SFU.idFromName("sfu"));
async function sfuCalls(): Promise<Array<{ op: string; sessionId: string | null; body: any }>> {
  return (await fakeSfu().calls()).map((c) => ({ op: c.op, sessionId: c.sessionId, body: JSON.parse(c.bodyJson) }));
}

async function post(path: string, userId: string, body: unknown): Promise<Response> {
  return call(path, {
    method: "POST",
    headers: { Cookie: await login(userId), "X-Officebox-Request": "1", Origin: ORIGIN, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
async function postOk(path: string, userId: string, body: unknown): Promise<any> {
  const res = await post(path, userId, body);
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function start(userId: string, contextId: string, contextType = "channel"): Promise<string> {
  return (await postOk("/huddles", userId, { contextType, contextId })).huddleId;
}
async function join(huddleId: string, userId: string): Promise<JsonClient> {
  const client = await JsonClient.connect(`/ws/huddles/${huddleId}`, await login(userId));
  open.push(client);
  return client;
}
const offer = { type: "offer", sdp: "v=0 fake offer" };
async function publish(huddleId: string, userId: string, client: JsonClient, tracks: Array<{ mid: string; kind: string }>) {
  return post(`/huddles/${huddleId}/tracks/publish`, userId, { connId: client.welcome.connId, sessionDescription: offer, tracks });
}

/** A channel with a host (channel admin), a member and a third member; plus a fresh huddle. */
async function setup() {
  const host = await newUser("host");
  const ann = await newUser("ann");
  const ben = await newUser("ben");
  const channel = await newChannel("private", { [host]: "admin", [ann]: "member", [ben]: "member" });
  const huddleId = await start(host, channel);
  return { host, ann, ben, channel, huddleId };
}

describe("starting and joining (TDD §3.6)", () => {
  it("starts one huddle per context, posts a system message, and checks access", async () => {
    const { host, ann, channel, huddleId } = await setup();
    // A second start (even concurrent ones) joins the active huddle.
    const again = await Promise.all([postOk("/huddles", ann, { contextType: "channel", contextId: channel }), postOk("/huddles", host, { contextType: "channel", contextId: channel })]);
    expect(again.map((r) => r.huddleId)).toEqual([huddleId, huddleId]);
    expect(again.every((r) => r.created === false)).toBe(true);

    const outsider = await newUser("out");
    expect((await post("/huddles", outsider, { contextType: "channel", contextId: channel })).status).toBe(403);
    expect((await upgrade(`/ws/huddles/${huddleId}`, { cookie: await login(outsider) })).status).toBe(403);

    // System message in the channel log.
    const watcher = await JsonClient.connect(`/ws/channels/${channel}`, await login(host));
    open.push(watcher);
    watcher.send({ type: "history" });
    const history = await watcher.next((m) => m.type === "history");
    expect(history.messages[0]).toMatchObject({ senderId: "system", body: "Huddle started" });
  });

  it("sends a roster and marks the host as moderator", async () => {
    const { host, ann, huddleId } = await setup();
    const h = await join(huddleId, host);
    expect(h.welcome).toMatchObject({ moderator: true, hostId: host, policy: { screenShare: "everyone", constraints: { width: 1920, height: 1080 } } });
    const a = await join(huddleId, ann);
    expect(a.welcome.moderator).toBe(false);
    const roster = await h.next((m) => m.type === "roster");
    expect(roster.participants.map((p: any) => p.userId)).toEqual([host, ann]);
  });

  it("supports document huddles; the document owner moderates", async () => {
    const owner = "alice";
    const doc = await newDoc("workspace_view", {});
    const ben = await newUser("ben");
    const huddleId = await start(ben, doc, "document");
    const o = await join(huddleId, owner);
    expect(o.welcome.moderator).toBe(true);
  });
});

describe("publishing and subscribing through the SFU", () => {
  it("creates an SFU session on first publish and lets others subscribe", async () => {
    const { host, ann, huddleId } = await setup();
    const h = await join(huddleId, host);
    const a = await join(huddleId, ann);

    const published = await (await publish(huddleId, host, h, [{ mid: "0", kind: "audio" }])).json<any>();
    expect(published.sessionDescription.type).toBe("answer");
    const roster = await a.next((m) => m.type === "roster" && m.participants.some((p: any) => p.tracks.includes("audio")));
    expect(roster.participants.find((p: any) => p.userId === host).tracks).toEqual(["audio"]);

    // Ann needs her own session first (publishing her mic creates it).
    await publish(huddleId, ann, a, [{ mid: "0", kind: "audio" }]);
    const sub = await postOk(`/huddles/${huddleId}/tracks/subscribe`, ann, { connId: a.welcome.connId, tracks: [{ connId: h.welcome.connId, kind: "audio" }] });
    expect(sub.requiresImmediateRenegotiation).toBe(true);
    expect(sub.sessionDescription.type).toBe("offer");
    expect(sub.publishers).toEqual([{ connId: h.welcome.connId, kind: "audio" }]);
    await postOk(`/huddles/${huddleId}/renegotiate`, ann, { connId: a.welcome.connId, sessionDescription: { type: "answer", sdp: "v=0 answer" } });

    const ops = (await sfuCalls()).map((c) => c.op);
    expect(ops).toEqual(expect.arrayContaining(["newSession", "addTracks", "renegotiate"]));
  });

  it("never lets a client pull tracks from another huddle or use someone else's connection", async () => {
    const a1 = await setup();
    const a2 = await setup();
    const h1 = await join(a1.huddleId, a1.host);
    await publish(a1.huddleId, a1.host, h1, [{ mid: "0", kind: "audio" }]);
    const h2 = await join(a2.huddleId, a2.host);
    await publish(a2.huddleId, a2.host, h2, [{ mid: "0", kind: "audio" }]);

    // Huddle 2's participant asks huddle 2 for huddle 1's publisher → not in this huddle.
    const cross = await post(`/huddles/${a2.huddleId}/tracks/subscribe`, a2.host, { connId: h2.welcome.connId, tracks: [{ connId: h1.welcome.connId, kind: "audio" }] });
    expect(cross.status).toBe(404);
    // Using huddle 1's route with a huddle 2 connection → not a participant there.
    const wrongRoom = await post(`/huddles/${a1.huddleId}/tracks/subscribe`, a1.ann, { connId: h2.welcome.connId, tracks: [{ connId: h1.welcome.connId, kind: "audio" }] });
    expect(wrongRoom.status).toBe(404);
    // Someone else's connection ID in the same huddle → forbidden.
    const a = await join(a1.huddleId, a1.ann);
    const impersonate = await publish(a1.huddleId, a1.ann, h1, [{ mid: "1", kind: "video" }]);
    expect(impersonate.status).toBe(403);
    a.close();
  });

  it("asks the SFU for the requested simulcast layer and can switch layers", async () => {
    const { host, ann, huddleId } = await setup();
    const h = await join(huddleId, host);
    const a = await join(huddleId, ann);
    h.send({ type: "screen.start" });
    await h.next((m) => m.type === "screen.granted");
    await publish(huddleId, host, h, [{ mid: "1", kind: "screen" }]);
    await publish(huddleId, ann, a, [{ mid: "0", kind: "audio" }]);

    const sub = await postOk(`/huddles/${huddleId}/tracks/subscribe`, ann, {
      connId: a.welcome.connId,
      tracks: [{ connId: h.welcome.connId, kind: "screen", preferredRid: "h" }],
    });
    const pullCall = (await sfuCalls()).filter((c) => c.op === "addTracks").at(-1)!;
    expect((pullCall.body as any).tracks[0].simulcast).toEqual({ preferredRid: "h", priorityOrdering: "asciibetical", ridNotAvailable: "asciibetical" });

    const mid = sub.tracks[0].mid;
    await postOk(`/huddles/${huddleId}/tracks/layer`, ann, { connId: a.welcome.connId, mid, preferredRid: "q" });
    expect(await fakeSfu().preferredRid(pullCall.sessionId!, mid)).toBe("q");
  });
});

describe("screen sharing (PRD §5.8, TDD §3.6)", () => {
  it("requires a grant before publishing a screen", async () => {
    const { host, huddleId } = await setup();
    const h = await join(huddleId, host);
    expect((await publish(huddleId, host, h, [{ mid: "1", kind: "screen" }])).status).toBe(403);
    h.send({ type: "screen.start" });
    const granted = await h.next((m) => m.type === "screen.granted");
    expect(granted.constraints).toEqual({ width: 1920, height: 1080, detailFrameRate: 15, motionFrameRate: 30 });
    expect((await publish(huddleId, host, h, [{ mid: "1", kind: "screen" }, { mid: "2", kind: "screen-audio" }])).status).toBe(200);
    const huddle = await env.DB.prepare("SELECT had_screen_share FROM huddles WHERE id = ?").bind(huddleId).first();
    expect(huddle).toEqual({ had_screen_share: 1 });
  });

  it("allows one presenter; a second request becomes a take-over that the presenter accepts", async () => {
    const { host, ann, huddleId } = await setup();
    const h = await join(huddleId, host);
    const a = await join(huddleId, ann);
    a.send({ type: "screen.start" });
    await a.next((m) => m.type === "screen.granted");
    await publish(huddleId, ann, a, [{ mid: "1", kind: "screen" }]);

    h.send({ type: "screen.start" }); // host is also a moderator, but still has to ask
    expect((await h.next((m) => m.type === "screen.pending")).presenterConnId).toBe(a.welcome.connId);
    const request = await a.next((m) => m.type === "screen.request");
    expect(request).toMatchObject({ connId: h.welcome.connId, userId: host });

    a.send({ type: "screen.handover", toConnId: h.welcome.connId });
    await a.next((m) => m.type === "screen.stop-requested");
    // Ann's client stops capture and closes the screen track; the grant moves to the host.
    await postOk(`/huddles/${huddleId}/tracks/close`, ann, { connId: a.welcome.connId, mids: ["1"] });
    await h.next((m) => m.type === "screen.granted");
    expect((await room(huddleId).state()).presenter).toBe(h.welcome.connId);
  });

  it("force-closes the old presenter's screen if they don't stop within 5 seconds", async () => {
    const { host, ann, huddleId } = await setup();
    const h = await join(huddleId, host);
    const a = await join(huddleId, ann);
    a.send({ type: "screen.start" });
    await a.next((m) => m.type === "screen.granted");
    await publish(huddleId, ann, a, [{ mid: "1", kind: "screen" }]);
    h.send({ type: "screen.handover", toConnId: h.welcome.connId }); // moderator hands to themselves
    await a.next((m) => m.type === "screen.stop-requested");

    // Ann ignores the request; the deadline passes.
    await runInDurableObject(room(huddleId), (_i, state) => state.storage.sql.exec("UPDATE meta SET value = '0' WHERE key = 'handover_deadline'"));
    await runDurableObjectAlarm(room(huddleId));

    expect((await a.next((m) => m.type === "screen.stopped-by")).reason).toBe("handover");
    await h.next((m) => m.type === "screen.granted");
    const close = (await sfuCalls()).filter((c) => c.op === "closeTracks").at(-1)!;
    expect(close.body).toMatchObject({ mids: ["1"], force: true });
  });

  it("lets moderators stop a share and mute others, but not regular participants", async () => {
    const { host, ann, ben, huddleId } = await setup();
    const h = await join(huddleId, host);
    const a = await join(huddleId, ann);
    const b = await join(huddleId, ben);
    a.send({ type: "screen.start" });
    await a.next((m) => m.type === "screen.granted");
    await publish(huddleId, ann, a, [{ mid: "0", kind: "audio" }, { mid: "1", kind: "screen" }]);

    b.send({ type: "screen.stop", targetConnId: a.welcome.connId });
    expect((await b.next((m) => m.type === "error")).message).toMatch(/^forbidden/);
    b.send({ type: "mute", targetConnId: a.welcome.connId });
    expect((await b.next((m) => m.type === "error")).message).toMatch(/^forbidden/);

    h.send({ type: "screen.stop", targetConnId: a.welcome.connId });
    expect((await a.next((m) => m.type === "screen.stopped-by")).byUserId).toBe(host);
    h.send({ type: "mute", targetConnId: a.welcome.connId });
    await a.next((m) => m.type === "muted-by");
    await vi.waitFor(async () => {
      const state = await room(huddleId).state();
      expect(state.presenter).toBeNull();
      expect(state.participants.find((p) => p.userId === ann)!.tracks).toEqual([]);
    });
    const closes = (await sfuCalls()).filter((c) => c.op === "closeTracks").slice(-2);
    expect(closes.map((c) => (c.body as any).mids)).toEqual([["1"], ["0"]]);
  });

  it("grants a pending take-over when the presenter leaves", async () => {
    const { host, ann, huddleId } = await setup();
    const h = await join(huddleId, host);
    const a = await join(huddleId, ann);
    a.send({ type: "screen.start" });
    await a.next((m) => m.type === "screen.granted");
    h.send({ type: "screen.handover", toConnId: h.welcome.connId });
    await a.next((m) => m.type === "screen.stop-requested");
    a.close();
    await h.next((m) => m.type === "screen.granted");
  });

  it("enforces the workspace sharing policy and resolution cap", async () => {
    try {
      await env.DB.batch([
        env.DB.prepare("UPDATE settings SET value = 'admins' WHERE key = 'screen_share'"),
        env.DB.prepare("UPDATE settings SET value = '720' WHERE key = 'screen_share_max_height'"),
      ]);
      const { host, ann, huddleId } = await setup();
      const h = await join(huddleId, host);
      const a = await join(huddleId, ann);
      a.send({ type: "screen.start" });
      expect((await a.next((m) => m.type === "error")).message).toMatch(/only admins/);
      h.send({ type: "screen.start" });
      expect((await h.next((m) => m.type === "screen.granted")).constraints).toMatchObject({ width: 1280, height: 720 });

      await env.DB.prepare("UPDATE settings SET value = 'off' WHERE key = 'screen_share'").run();
      const off = await setup();
      const oh = await join(off.huddleId, off.host);
      oh.send({ type: "screen.start" });
      expect((await oh.next((m) => m.type === "error")).message).toMatch(/turned off/);
    } finally {
      await env.DB.batch([
        env.DB.prepare("UPDATE settings SET value = 'everyone' WHERE key = 'screen_share'"),
        env.DB.prepare("UPDATE settings SET value = '1080' WHERE key = 'screen_share_max_height'"),
      ]);
    }
  });
});

describe("ending a huddle", () => {
  it("ends 30 s after the last person leaves and posts a summary", async () => {
    const { host, ann, channel, huddleId } = await setup();
    const h = await join(huddleId, host);
    const a = await join(huddleId, ann);
    h.close();
    a.close();
    await vi.waitFor(async () => expect((await room(huddleId).state()).participants).toHaveLength(0));
    await runInDurableObject(room(huddleId), (_i, state) => state.storage.sql.exec("UPDATE meta SET value = '0' WHERE key = 'end_at'"));
    await runDurableObjectAlarm(room(huddleId));

    const row = await env.DB.prepare("SELECT ended_at, peak_participants FROM huddles WHERE id = ?").bind(huddleId).first<any>();
    expect(row.ended_at).toEqual(expect.any(Number));
    expect(row.peak_participants).toBe(2);
    expect((await upgrade(`/ws/huddles/${huddleId}`, { cookie: await login(host) })).status).toBe(410);

    const watcher = await JsonClient.connect(`/ws/channels/${channel}`, await login(host));
    open.push(watcher);
    watcher.send({ type: "sync", afterSeq: 0 });
    const ended = (await watcher.next((m) => m.type === "sync")).events.find((e: any) => e.payload.system?.kind === "huddle.ended");
    expect(ended.payload.system.participants.sort()).toEqual([host, ann].sort());

    // A new start creates a new huddle.
    expect(await start(host, channel)).not.toBe(huddleId);
  });

  it("does not end while someone rejoins within the grace period", async () => {
    const { host, huddleId } = await setup();
    (await join(huddleId, host)).close();
    await sleep(100);
    const again = await join(huddleId, host);
    await runDurableObjectAlarm(room(huddleId));
    expect((await room(huddleId).state()).ended).toBe(false);
    again.close();
  });
});

describe("present mode (TDD §4.5)", () => {
  it("allows one presenter per document and strips a second claim", async () => {
    const doc = await newDoc("workspace_view", { bob: "editor" });
    const alice = await YClient.connect(doc, "alice");
    const bob = await YClient.connect(doc, "bob");
    open.push(alice, bob);

    alice.setLocal("presenting", { active: true, scrollAnchor: null, zoom: 1 });
    await bob.until(() => bob.awareness.getStates().get(alice.doc.clientID)?.presenting?.active === true);
    expect(await env.DOCS.get(env.DOCS.idFromName(doc)).presenting()).toBe("alice");

    bob.setLocal("presenting", { active: true });
    await bob.until(() => bob.denied.length > 0);
    expect(bob.denied[0]).toBe("Currently presenting: alice");
    await sleep(100);
    expect(alice.awareness.getStates().get(bob.doc.clientID)?.presenting).toBeUndefined();

    // When alice leaves, bob can present.
    alice.close();
    await sleep(100);
    bob.denied.length = 0;
    bob.setLocal("presenting", { active: true, at: 2 });
    await sleep(100);
    expect(bob.denied).toHaveLength(0);
    expect(await env.DOCS.get(env.DOCS.idFromName(doc)).presenting()).toBe("bob");
  });
});

describe("Realtime SFU HTTP client and TURN (contract with the documented API)", () => {
  function recorder(responses: Array<{ status?: number; body: unknown }>) {
    const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: any }> = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      const next = responses.shift()!;
      return new Response(JSON.stringify(next.body), { status: next.status ?? 200 });
    }) as typeof fetch;
    return { calls, fetcher };
  }

  it("sends documented paths, methods, auth and bodies", async () => {
    const { calls, fetcher } = recorder([
      { status: 201, body: { sessionId: "s1" } },
      { body: { sessionDescription: { type: "answer", sdp: "a" }, tracks: [{ mid: "0", trackName: "audio" }] } },
      { body: {} },
      { body: { tracks: [{ mid: "0" }] } },
      { body: { tracks: [{ mid: "5" }] } },
    ]);
    const sfu = new CloudflareSfu("app123", "secret456", fetcher);
    expect(await sfu.newSession()).toBe("s1");
    await sfu.addTracks("s1", { sessionDescription: { type: "offer", sdp: "o" }, tracks: [{ location: "local", mid: "0", trackName: "audio" }] });
    await sfu.renegotiate("s1", { type: "answer", sdp: "x" });
    await sfu.closeTracks("s1", ["0"], { force: true });
    await sfu.updateTracks("s1", [{ location: "remote", mid: "5", simulcast: { preferredRid: "q" } }]);

    expect(calls.map((c) => [c.method, c.url.replace(SFU_BASE, "")])).toEqual([
      ["POST", "/apps/app123/sessions/new"],
      ["POST", "/apps/app123/sessions/s1/tracks/new"],
      ["PUT", "/apps/app123/sessions/s1/renegotiate"],
      ["PUT", "/apps/app123/sessions/s1/tracks/close"],
      ["PUT", "/apps/app123/sessions/s1/tracks/update"],
    ]);
    expect(calls.every((c) => c.headers.authorization === "Bearer secret456")).toBe(true);
    expect(calls[3]!.body).toEqual({ tracks: [{ mid: "0" }], force: true });
    expect(calls[2]!.body).toEqual({ sessionDescription: { type: "answer", sdp: "x" } });
  });

  it("treats a top-level errorCode in a 2xx response as a failure", async () => {
    const { fetcher } = recorder([{ body: { errorCode: "invalid_request", errorDescription: "bad sdp" } }]);
    await expect(new CloudflareSfu("a", "s", fetcher).addTracks("s1", { tracks: [] })).rejects.toBeInstanceOf(SfuError);
  });

  it("returns STUN only without TURN keys, and filters port 53 from TURN credentials", async () => {
    const base = { ...(env as unknown as Env), TURN_KEY_ID: undefined, TURN_KEY_API_TOKEN: undefined };
    expect(await iceServers(base)).toEqual([{ urls: ["stun:stun.cloudflare.com:3478"] }]);

    const { calls, fetcher } = recorder([
      {
        status: 201,
        body: {
          iceServers: [
            { urls: ["stun:stun.cloudflare.com:3478", "stun:stun.cloudflare.com:53"] },
            { urls: ["turn:turn.cloudflare.com:3478?transport=udp", "turn:turn.cloudflare.com:53?transport=udp", "turns:turn.cloudflare.com:443?transport=tcp"], username: "u", credential: "c" },
          ],
        },
      },
    ]);
    const servers = await iceServers({ ...base, TURN_KEY_ID: "key1", TURN_KEY_API_TOKEN: "tok" }, 3600, fetcher);
    expect(calls[0]).toMatchObject({ method: "POST", url: `${SFU_BASE}/turn/keys/key1/credentials/generate-ice-servers`, body: { ttl: 3600 } });
    expect(calls[0]!.headers.authorization).toBe("Bearer tok");
    expect(servers.flatMap((s) => s.urls).some((u) => u.includes(":53"))).toBe(false);
    expect(servers[1]).toMatchObject({ username: "u", credential: "c" });
  });

  it("serves STUN servers to participants from the ice-servers route", async () => {
    const { host, huddleId } = await setup();
    const res = await call(`/huddles/${huddleId}/ice-servers`, { headers: { Cookie: await login(host) } });
    expect(await res.json()).toEqual({ iceServers: [{ urls: ["stun:stun.cloudflare.com:3478"] }] });
  });
});

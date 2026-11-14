import { listDurableObjectIds, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PRESENCE_EXPIRY_MS } from "../src/presence";
import { clearOnlineCache } from "../src/fanout";
import { JsonClient, ORIGIN, call, login, newChannel, newDm, newDoc, newUser, seed, sleep, upgrade } from "./helpers";
import { YClient } from "./yclient";

const open: Array<{ close(): void }> = [];
afterEach(() => {
  for (const c of open.splice(0)) c.close();
});
beforeEach(async () => {
  await seed();
  clearOnlineCache();
});

/** Hub connections don't get a channel-style "welcome" with lastSeq, so connect manually. */
async function hub(userId: string): Promise<JsonClient> {
  const res = await upgrade("/ws/hub", { cookie: await login(userId) });
  if (res.status !== 101) throw new Error(`hub upgrade failed: ${res.status}`);
  const client = new JsonClient(res.webSocket!);
  open.push(client);
  await client.next((m) => m.type === "welcome");
  return client;
}
async function channel(channelId: string, userId: string): Promise<JsonClient> {
  const client = await JsonClient.connect(`/ws/channels/${channelId}`, await login(userId));
  open.push(client);
  return client;
}
const hubStub = (userId: string) => env.USER_HUB.get(env.USER_HUB.idFromName(userId));
const presenceStub = () => env.PRESENCE.get(env.PRESENCE.idFromName("presence"));
const chatStub = (id: string) => env.CHAT.get(env.CHAT.idFromName(id));

async function api(path: string, userId: string, body?: unknown): Promise<any> {
  const res = await call(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { Cookie: await login(userId), "X-Officebox-Request": "1", Origin: ORIGIN },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

describe("workspace presence (TDD §3.5)", () => {
  it("announces users coming online and going offline", async () => {
    const ann = await newUser("ann");
    const ben = await newUser("ben");
    const annHub = await hub(ann);

    const benHub = await hub(ben);
    expect((await annHub.next((m) => m.type === "presence" && m.userId === ben)).status).toBe("online");
    const online = (await presenceStub().list()).map((e) => e.userId);
    expect(online).toEqual(expect.arrayContaining([ann, ben]));

    benHub.close();
    expect((await annHub.next((m) => m.type === "presence" && m.userId === ben)).status).toBe("offline");
  });

  it("treats several tabs as one presence and only goes offline when the last closes", async () => {
    const ann = await newUser("ann");
    const ben = await newUser("ben");
    const annHub = await hub(ann);
    const tab1 = await hub(ben);
    const tab2 = await hub(ben);
    await annHub.next((m) => m.type === "presence" && m.userId === ben && m.status === "online");

    tab1.close();
    await sleep(200);
    expect(annHub.received.filter((m) => m.type === "presence" && m.status === "offline")).toHaveLength(0);
    tab2.close();
    await annHub.next((m) => m.type === "presence" && m.userId === ben && m.status === "offline");
  });

  it("broadcasts status changes such as do-not-disturb", async () => {
    const ann = await newUser("ann");
    const ben = await newUser("ben");
    const annHub = await hub(ann);
    const benHub = await hub(ben);
    benHub.send({ type: "status", status: "dnd" });
    expect((await annHub.next((m) => m.type === "presence" && m.userId === ben && m.status !== "online")).status).toBe("dnd");
  });

  it("heartbeats keep users online and expired entries are removed", async () => {
    const ann = await newUser("ann");
    const ben = await newUser("ben");
    const annHub = await hub(ann);
    await hub(ben);
    await annHub.next((m) => m.type === "presence" && m.userId === ben);

    // A heartbeat refreshes ben's entry...
    await runInDurableObject(presenceStub(), (_i, state) =>
      state.storage.sql.exec("UPDATE online SET heartbeat_at = 0 WHERE user_id = ?", ben),
    );
    expect(await runDurableObjectAlarm(hubStub(ben))).toBe(true);
    expect((await presenceStub().list()).map((e) => e.userId)).toContain(ben);

    // ...but if ben's hub stops heartbeating (crash), the entry expires and others are told.
    await runInDurableObject(presenceStub(), (_i, state) =>
      state.storage.sql.exec("UPDATE online SET heartbeat_at = ? WHERE user_id = ?", Date.now() - PRESENCE_EXPIRY_MS - 1, ben),
    );
    expect((await presenceStub().list()).map((e) => e.userId)).not.toContain(ben);
    await annHub.next((m) => m.type === "presence" && m.userId === ben && m.status === "offline");
  });
});

describe("fan-out, inbox and unread counts (TDD §3.3, §3.5)", () => {
  it("delivers activity and mention inbox items to online members only", async () => {
    const ann = await newUser("ann");
    const ben = await newUser("ben");
    const cat = await newUser("cat"); // offline throughout
    const ch = await newChannel("public", { [ann]: "admin", [ben]: "member", [cat]: "member" });
    const benHub = await hub(ben);
    const annChannel = await channel(ch, ann);

    annChannel.send({ type: "message.send", clientId: "m1", body: `hi @ben and @cat`, mentions: [ben, cat] });
    const { seq } = await annChannel.next((m) => m.type === "ack");
    await runDurableObjectAlarm(chatStub(ch));

    const activity = await benHub.next((m) => m.type === "activity", 8000);
    expect(activity.channels).toEqual([{ channelId: ch, latestSeq: seq, changedSeq: seq }]);
    expect(activity.inbox).toHaveLength(1);
    expect(activity.inbox[0]).toMatchObject({ eventType: "mention", channelId: ch, seq, actorId: ann });

    // Cat was offline: no hub call (her hub object was never created), but the inbox item exists.
    const hubIds = (await listDurableObjectIds(env.USER_HUB)).map((id) => id.toString());
    expect(hubIds).not.toContain(env.USER_HUB.idFromName(cat).toString());
    const catInbox = await api("/api/inbox", cat);
    expect(catInbox.items).toHaveLength(1);
    expect(catInbox.items[0]).toMatchObject({ eventType: "mention", state: "unread" });
  });

  it("sends one hub call per consumer batch, not one per message", async () => {
    const ann = await newUser("ann");
    const ben = await newUser("ben");
    const ch = await newChannel("public", { [ann]: "admin", [ben]: "member" });
    const benHub = await hub(ben);
    const annChannel = await channel(ch, ann);
    for (let i = 1; i <= 20; i++) annChannel.send({ type: "message.send", clientId: `b${i}`, body: `burst ${i}` });
    await annChannel.next((m) => m.type === "ack" && m.clientId === "b20");
    await runDurableObjectAlarm(chatStub(ch)); // one outbox drain → one queue batch

    const activity = await benHub.next((m) => m.type === "activity", 8000);
    expect(activity.channels[0].latestSeq).toBe(20);
    await sleep(1500);
    expect(benHub.received.filter((m) => m.type === "activity")).toHaveLength(0);
  });

  it("creates DM inbox items and resolves them when the channel is read", async () => {
    const ann = await newUser("ann");
    const ben = await newUser("ben");
    const dm = await newDm(ann, ben);
    const annChannel = await channel(dm, ann);
    annChannel.send({ type: "message.send", clientId: "d1", body: "ping" });
    annChannel.send({ type: "message.send", clientId: "d2", body: "ping again" });
    const last = await annChannel.next((m) => m.type === "ack" && m.clientId === "d2");
    await runDurableObjectAlarm(chatStub(dm));

    await vi.waitFor(
      async () => {
        const unread = await api("/api/unread", ben);
        expect(unread.channels).toEqual([{ channelId: dm, lastReadSeq: 0, unread: 2, mentions: 2 }]);
      },
      { timeout: 8000, interval: 200 },
    );
    // The sender gets no inbox items for their own messages.
    expect((await api("/api/inbox", ann)).items).toHaveLength(0);

    expect(await api(`/api/channels/${dm}/read`, ben, { seq: last.seq })).toEqual({ lastReadSeq: last.seq });
    const after = await api("/api/unread", ben);
    expect(after.channels[0]).toMatchObject({ unread: 0, mentions: 0 });
    expect((await api("/api/inbox", ben)).items.every((i: any) => i.state === "read")).toBe(true);
  });

  it("is idempotent when the queue redelivers a batch", async () => {
    const ann = await newUser("ann");
    const ben = await newUser("ben");
    const ch = await newChannel("public", { [ann]: "admin", [ben]: "member" });
    const annChannel = await channel(ch, ann);
    annChannel.send({ type: "message.send", clientId: "r1", body: "once", mentions: [ben] });
    await annChannel.next((m) => m.type === "ack");
    await runDurableObjectAlarm(chatStub(ch));
    await vi.waitFor(async () => expect((await api("/api/inbox", ben)).items).toHaveLength(1), { timeout: 8000, interval: 200 });

    // Force a second delivery of the same state.
    await runInDurableObject(chatStub(ch), (_i, state) =>
      state.storage.sql.exec("INSERT INTO outbox (seq, attempts, next_attempt_at) VALUES (1, 0, 0)"),
    );
    await runDurableObjectAlarm(chatStub(ch));
    await sleep(2000);
    expect((await api("/api/inbox", ben)).items).toHaveLength(1);
  });

  it("does not notify mentions of non-members or deleted messages", async () => {
    const ann = await newUser("ann");
    const ben = await newUser("ben");
    const outsider = await newUser("out");
    const ch = await newChannel("private", { [ann]: "admin", [ben]: "member" });
    const annChannel = await channel(ch, ann);
    annChannel.send({ type: "message.send", clientId: "n1", body: "secret", mentions: [outsider] });
    annChannel.send({ type: "message.send", clientId: "n2", body: "oops", mentions: [ben] });
    const oops = await annChannel.next((m) => m.type === "ack" && m.clientId === "n2");
    annChannel.send({ type: "message.delete", messageId: oops.id });
    await annChannel.next((m) => m.type === "event" && m.event.type === "message.deleted");
    await runDurableObjectAlarm(chatStub(ch));
    await sleep(2000);
    expect((await api("/api/inbox", outsider)).items).toHaveLength(0);
    expect((await api("/api/inbox", ben)).items).toHaveLength(0);
  });
});

describe("revocation across hub, channels and documents (TDD §3.5)", () => {
  it("closes every socket of a disabled user and refuses reconnects", async () => {
    const ann = await newUser("ann");
    const ben = await newUser("ben");
    const ch = await newChannel("public", { [ann]: "admin", [ben]: "member" });
    const doc = await newDoc("workspace_edit", {});
    const benCookie = await login(ben);

    const annHub = await hub(ann);
    const benHub = await hub(ben);
    const benChannel = await channel(ch, ben);
    const benDoc = await YClient.connect(doc, ben);
    open.push(benDoc);
    expect(await hubStub(ben).roomCount()).toBe(2);

    const res = await call("/dev/disable-user", { method: "POST", body: JSON.stringify({ userId: ben }) });
    expect(await res.json()).toEqual({ hub: 1, rooms: 2 });

    expect((await benHub.waitClosed()).code).toBe(4401);
    expect((await benChannel.waitClosed()).code).toBe(4401);
    await benDoc.until(() => benDoc.closed !== null);
    expect(benDoc.closed!.code).toBe(4401);
    await annHub.next((m) => m.type === "presence" && m.userId === ben && m.status === "offline");

    // The old cookie is dead (status and session_epoch), even after re-enabling the account.
    expect((await upgrade("/ws/hub", { cookie: benCookie })).status).toBe(401);
    await env.DB.prepare("UPDATE users SET status = 'active' WHERE id = ?").bind(ben).run();
    expect((await upgrade("/ws/hub", { cookie: benCookie })).status).toBe(401);
    const fresh = await upgrade("/ws/hub", { cookie: await login(ben) });
    expect(fresh.status).toBe(101);
    fresh.webSocket!.accept();
    fresh.webSocket!.close();
  });
});

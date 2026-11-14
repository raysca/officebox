import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatChannel } from "../src/chat-channel";
import type { ProjectionMessage } from "../src/env";
import { applyProjection } from "../src/projection";
import { JsonClient, call, login, newChannel, seed, upgrade } from "./helpers";

const clients: JsonClient[] = [];
async function connect(channel: string, user: string): Promise<JsonClient> {
  const client = await JsonClient.connect(`/ws/channels/${channel}`, await login(user));
  clients.push(client);
  return client;
}
const channelStub = (id: string) => env.CHAT.get(env.CHAT.idFromName(id));

let general: string;
let secret: string;

beforeEach(async () => {
  await seed();
  general = await newChannel("public");
  secret = await newChannel("private", { alice: "admin", bob: "member" });
});
afterEach(() => {
  for (const c of clients.splice(0)) c.close();
});

describe("authentication and access (TDD §3.1)", () => {
  it("rejects an upgrade without a session", async () => {
    const res = await upgrade(`/ws/channels/${general}`);
    expect(res.status).toBe(401);
  });

  it("rejects a cross-origin upgrade even with a valid cookie", async () => {
    const res = await upgrade(`/ws/channels/${general}`, { cookie: await login("alice"), origin: "https://evil.example" });
    expect(res.status).toBe(403);
  });

  it("rejects a tampered session cookie", async () => {
    const cookie = (await login("alice")).replace(/.$/, (c) => (c === "A" ? "B" : "A"));
    const res = await upgrade(`/ws/channels/${general}`, { cookie });
    expect(res.status).toBe(401);
  });

  it("rejects disabled accounts", async () => {
    const res = await upgrade(`/ws/channels/${general}`, { cookie: await login("dave") });
    expect(res.status).toBe(401);
  });

  it("keeps non-members out of private channels", async () => {
    const res = await upgrade(`/ws/channels/${secret}`, { cookie: await login("carol") });
    expect(res.status).toBe(403);
    const ok = await upgrade(`/ws/channels/${secret}`, { cookie: await login("bob") });
    expect(ok.status).toBe(101);
    ok.webSocket!.accept();
    ok.webSocket!.close();
  });
});

describe("write path (TDD §3.3)", () => {
  it("acknowledges messages and delivers them to every connected client in order", async () => {
    const alice = await connect(general, "alice");
    const bob = await connect(general, "bob");
    for (const n of [1, 2, 3]) alice.send({ type: "message.send", clientId: `c${n}`, body: `hello ${n}` });

    const acks = [];
    for (const n of [1, 2, 3]) acks.push(await alice.next((m) => m.type === "ack" && m.clientId === `c${n}`));
    expect(acks.map((a) => a.seq)).toEqual([1, 2, 3]);

    const seen = [];
    for (let i = 0; i < 3; i++) seen.push(await bob.next((m) => m.type === "event"));
    expect(seen.map((e) => [e.event.seq, e.message.body])).toEqual([
      [1, "hello 1"],
      [2, "hello 2"],
      [3, "hello 3"],
    ]);
  });

  it("treats a retried send with the same clientId as one message", async () => {
    const alice = await connect(general, "alice");
    alice.send({ type: "message.send", clientId: "retry-me", body: "once" });
    alice.send({ type: "message.send", clientId: "retry-me", body: "once" });
    const first = await alice.next((m) => m.type === "ack");
    const second = await alice.next((m) => m.type === "ack");
    expect(second.seq).toBe(first.seq);
    expect(second.id).toBe(first.id);
    expect(second.duplicate).toBe(true);

    alice.send({ type: "history", limit: 10 });
    const history = await alice.next((m) => m.type === "history");
    expect(history.messages).toHaveLength(1);
  });

  it("rejects oversized bodies and unknown thread roots", async () => {
    const alice = await connect(general, "alice");
    alice.send({ type: "message.send", clientId: "big", body: "x".repeat(40_001) });
    expect((await alice.next((m) => m.type === "error")).message).toMatch(/exceeds/);
    alice.send({ type: "message.send", clientId: "orphan", body: "reply", parentId: "nope" });
    expect((await alice.next((m) => m.type === "error")).message).toMatch(/thread root/);
  });

  it("supports threads and reactions", async () => {
    const alice = await connect(general, "alice");
    const bob = await connect(general, "bob");
    alice.send({ type: "message.send", clientId: "root", body: "root" });
    const root = await alice.next((m) => m.type === "ack");
    bob.send({ type: "message.send", clientId: "r1", body: "reply", parentId: root.id });
    const reply = await bob.next((m) => m.type === "ack");
    bob.send({ type: "reaction.add", messageId: root.id, emoji: "👍" });
    const reacted = await alice.next((m) => m.type === "event" && m.event.type === "reaction.added");
    expect(reacted.message.reactions).toEqual({ "👍": ["bob"] });
    const replyEvent = await alice.next((m) => m.type === "event" && m.event.messageId === reply.id);
    expect(replyEvent.message.parentId).toBe(root.id);
  });
});

describe("reconnect replay and redaction", () => {
  it("replays missed events after a reconnect", async () => {
    const alice = await connect(general, "alice");
    alice.send({ type: "message.send", clientId: "a1", body: "before" });
    const firstAck = await alice.next((m) => m.type === "ack");

    // Bob was offline for the next two messages.
    alice.send({ type: "message.send", clientId: "a2", body: "while away 1" });
    alice.send({ type: "message.send", clientId: "a3", body: "while away 2" });
    await alice.next((m) => m.type === "ack" && m.clientId === "a3");

    const bob = await connect(general, "bob");
    bob.send({ type: "sync", afterSeq: firstAck.seq });
    const sync = await bob.next((m) => m.type === "sync");
    expect(sync.events.map((e: any) => e.payload.body)).toEqual(["while away 1", "while away 2"]);
    expect(sync.more).toBe(false);
  });

  it("delivers edits and deletes, and never replays deleted content", async () => {
    const alice = await connect(general, "alice");
    const bob = await connect(general, "bob");
    alice.send({ type: "message.send", clientId: "e1", body: "secret plan" });
    const { id } = await alice.next((m) => m.type === "ack");

    alice.send({ type: "message.edit", messageId: id, body: "secret plan v2" });
    const edited = await bob.next((m) => m.type === "event" && m.event.type === "message.edited");
    expect(edited.message.body).toBe("secret plan v2");

    alice.send({ type: "message.delete", messageId: id });
    const deleted = await bob.next((m) => m.type === "event" && m.event.type === "message.deleted");
    expect(deleted.message.body).toBeNull();

    bob.send({ type: "sync", afterSeq: 0 });
    const sync = await bob.next((m) => m.type === "sync");
    expect(JSON.stringify(sync.events)).not.toContain("secret plan");
    expect(sync.events.filter((e: any) => e.type !== "message.deleted").every((e: any) => e.payload.redacted)).toBe(true);
  });

  it("enforces edit and delete permissions", async () => {
    const bob = await connect(general, "bob");
    const carol = await connect(general, "carol");
    const alice = await connect(general, "alice"); // channel admin
    bob.send({ type: "message.send", clientId: "b1", body: "bob's" });
    const { id } = await bob.next((m) => m.type === "ack");

    carol.send({ type: "message.edit", messageId: id, body: "hijack" });
    expect((await carol.next((m) => m.type === "error")).code).toBe("forbidden");
    carol.send({ type: "message.delete", messageId: id });
    expect((await carol.next((m) => m.type === "error")).code).toBe("forbidden");

    alice.send({ type: "message.delete", messageId: id });
    await bob.next((m) => m.type === "event" && m.event.type === "message.deleted");
  });

  it("tells clients behind the log horizon to reset", async () => {
    const alice = await connect(general, "alice");
    for (const n of [1, 2, 3]) alice.send({ type: "message.send", clientId: `h${n}`, body: `m${n}` });
    await alice.next((m) => m.type === "ack" && m.clientId === "h3");
    const stub = channelStub(general);
    await runDurableObjectAlarm(stub); // drain the outbox so trimming is allowed
    expect(await stub.trimEventLog(2)).toBe(2);

    alice.send({ type: "sync", afterSeq: 1 });
    expect((await alice.next((m) => m.type === "reset")).lastSeq).toBe(3);
    alice.send({ type: "sync", afterSeq: 2 });
    expect((await alice.next((m) => m.type === "sync")).events.map((e: any) => e.seq)).toEqual([3]);
  });
});

describe("hibernation and eviction (TDD §3.2)", () => {
  it("keeps sockets connected across eviction and continues the sequence", async () => {
    const alice = await connect(general, "alice");
    const bob = await connect(general, "bob");
    alice.send({ type: "message.send", clientId: "x1", body: "before eviction" });
    await bob.next((m) => m.type === "event");

    // Tear down the in-memory instance; hibernatable sockets stay open.
    await evictDurableObject(channelStub(general));

    alice.send({ type: "message.send", clientId: "x2", body: "after eviction" });
    const event = await bob.next((m) => m.type === "event");
    expect(event.event.seq).toBe(2);
    expect(event.message.body).toBe("after eviction");
  });
});

describe("D1 copy via outbox and queue (TDD §3.3)", () => {
  it("copies the final state of each message to D1", async () => {
    const alice = await connect(general, "alice");
    alice.send({ type: "message.send", clientId: "p1", body: "first" });
    const a = await alice.next((m) => m.type === "ack");
    alice.send({ type: "message.send", clientId: "p2", body: "second" });
    const b = await alice.next((m) => m.type === "ack");
    alice.send({ type: "message.edit", messageId: a.id, body: "first (edited)" });
    alice.send({ type: "message.delete", messageId: b.id });
    await alice.next((m) => m.type === "event" && m.event.type === "message.deleted");

    expect(await runDurableObjectAlarm(channelStub(general))).toBe(true);

    // The queue consumer runs asynchronously (max_batch_timeout = 1 s).
    await vi.waitFor(
      async () => {
        const rows = await env.DB.prepare("SELECT id, body, deleted_at FROM messages WHERE channel_id = ? ORDER BY seq").bind(general).all();
        expect(rows.results).toEqual([
          { id: a.id, body: "first (edited)", deleted_at: null },
          { id: b.id, body: null, deleted_at: expect.any(Number) },
        ]);
      },
      { timeout: 8000, interval: 200 },
    );
    const channel = await env.DB.prepare("SELECT projected_seq FROM channels WHERE id = ?").bind(general).first();
    expect(channel).toEqual({ projected_seq: 4 });

    const outbox = await runInDurableObject(channelStub(general), (_i, state) =>
      state.storage.sql.exec("SELECT COUNT(*) AS n FROM outbox").one(),
    );
    expect(outbox.n).toBe(0);
  });

  it("is idempotent and order-independent", async () => {
    const base: ProjectionMessage = {
      channelId: general,
      seq: 7,
      id: "m7",
      senderId: "alice",
      parentId: null,
      body: "v1",
      mentions: [],
      reactions: "{}",
      createdAt: 1,
      editedAt: null,
      deletedAt: null,
      lastEventSeq: 7,
    };
    const v2 = { ...base, body: "v2", editedAt: 2, lastEventSeq: 8 };
    const v3 = { ...base, body: null, deletedAt: 3, lastEventSeq: 9 };
    // Newest first, then stale duplicates.
    await applyProjection(env.DB, [v3]);
    await applyProjection(env.DB, [v2, base, v2]);
    const row = await env.DB.prepare("SELECT body, deleted_at, last_event_seq FROM messages WHERE id = 'm7'").first();
    expect(row).toEqual({ body: null, deleted_at: 3, last_event_seq: 9 });
  });

  it("keeps undelivered events in the outbox and retries after a queue outage", async () => {
    const alice = await connect(general, "alice");
    alice.send({ type: "message.send", clientId: "q1", body: "survives outage" });
    await alice.next((m) => m.type === "ack");
    const stub = channelStub(general);

    // Simulate the queue being unavailable for this instance.
    await runInDurableObject(stub, (instance: ChatChannel) => {
      (instance as any).sendProjection = async () => {
        throw new Error("queue unavailable");
      };
    });
    await runDurableObjectAlarm(stub);
    const failed = await runInDurableObject(stub, (_i, state) =>
      state.storage.sql.exec("SELECT attempts, next_attempt_at FROM outbox").toArray(),
    );
    expect(failed).toHaveLength(1);
    expect(failed[0]!.attempts).toBe(1);
    expect(Number(failed[0]!.next_attempt_at)).toBeGreaterThan(Date.now());

    // The client was acknowledged and can still read the message from the DO.
    alice.send({ type: "history" });
    expect((await alice.next((m) => m.type === "history")).messages[0].body).toBe("survives outage");

    // Queue recovers (fresh instance), retry becomes due.
    await evictDurableObject(stub);
    await runInDurableObject(stub, (_i, state) => state.storage.sql.exec("UPDATE outbox SET next_attempt_at = 0"));
    await runDurableObjectAlarm(stub);
    await vi.waitFor(
      async () => {
        const row = await env.DB.prepare("SELECT body FROM messages WHERE channel_id = ?").bind(general).first();
        expect(row).toEqual({ body: "survives outage" });
      },
      { timeout: 8000, interval: 200 },
    );
  });
});

describe("revocation (TDD §3.5)", () => {
  it("closes a removed member's sockets with 4403", async () => {
    const bob = await connect(secret, "bob");
    const alice = await connect(secret, "alice");
    const res = await call("/dev/remove-member", {
      method: "POST",
      body: JSON.stringify({ channelId: secret, userId: "bob" }),
    });
    expect(await res.json()).toEqual({ closed: 1 });
    expect((await bob.waitClosed()).code).toBe(4403);
    await alice.next((m) => m.type === "presence.left" && m.userId === "bob");
    // And bob can't come back.
    expect((await upgrade(`/ws/channels/${secret}`, { cookie: await login("bob") })).status).toBe(403);
  });
});

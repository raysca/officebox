import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COMPACT_AFTER_UPDATES } from "../src/doc-room";
import { ORIGIN, call, login, newDoc, seed, sleep, upgrade } from "./helpers";
import { YClient } from "./yclient";

const clients: YClient[] = [];
async function connect(docId: string, user: string): Promise<YClient> {
  const client = await YClient.connect(docId, user);
  clients.push(client);
  return client;
}
const docStub = (id: string) => env.DOCS.get(env.DOCS.idFromName(id));
function closeAll() {
  for (const c of clients.splice(0)) c.close();
}

let spec: string;
beforeEach(async () => {
  await seed();
  spec = await newDoc("workspace_view", { bob: "editor" }); // alice owns, bob edits, carol views
});
afterEach(closeAll);

describe("collaborative editing (TDD §4)", () => {
  it("syncs edits between clients and converges on concurrent edits", async () => {
    const alice = await connect(spec, "alice");
    const bob = await connect(spec, "bob");

    alice.doc.getText("body").insert(0, "Hello");
    await bob.until(() => bob.text === "Hello");

    // Concurrent edits at both ends.
    alice.doc.getText("body").insert(5, " world");
    bob.doc.getText("body").insert(0, ">> ");
    await alice.until(() => alice.text.length === ">> Hello world".length);
    await bob.until(() => bob.text === alice.text);
    expect(alice.text).toBe(">> Hello world");
  });

  it("sends existing content to a client that joins later", async () => {
    const alice = await connect(spec, "alice");
    alice.doc.getText("body").insert(0, "already here");
    await sleep(50);
    const bob = await connect(spec, "bob");
    await bob.until(() => bob.text === "already here");
  });

  it("relays awareness (cursors) and removes it when a client leaves", async () => {
    const alice = await connect(spec, "alice");
    const bob = await connect(spec, "bob");
    alice.setCursor("Alice");
    await bob.until(() => bob.awareness.getStates().get(alice.doc.clientID)?.user?.name === "Alice");
    alice.close();
    await bob.until(() => !bob.awareness.getStates().has(alice.doc.clientID));
  });
});

describe("permissions (TDD §4.4)", () => {
  it("lets viewers read but refuses their edits", async () => {
    const alice = await connect(spec, "alice");
    alice.doc.getText("body").insert(0, "owner text");
    const carol = await connect(spec, "carol"); // viewer via general access
    await carol.until(() => carol.text === "owner text");

    carol.doc.getText("body").insert(0, "vandalism ");
    await carol.until(() => carol.denied.length > 0);
    expect(carol.denied[0]).toMatch(/viewer cannot edit/);
    await sleep(100);
    expect(alice.text).toBe("owner text");
  });

  it("rejects users without access to a restricted document", async () => {
    const plan = await newDoc("restricted", {});
    expect((await upgrade(`/ws/docs/${plan}`, { cookie: await login("carol") })).status).toBe(403);
    expect((await upgrade(`/ws/docs/${plan}`, { cookie: await login("alice") })).status).toBe(101);
  });
});

describe("persistence and compaction (TDD §4.3)", () => {
  it("restores the document after the object is evicted", async () => {
    const alice = await connect(spec, "alice");
    alice.doc.getText("body").insert(0, "durable content");
    await sleep(50);
    closeAll();
    await sleep(50);
    await evictDurableObject(docStub(spec), { webSockets: "close" }).catch(() => {
      // Already idle after the last socket closed — also fine.
    });

    const bob = await connect(spec, "bob");
    await bob.until(() => bob.text === "durable content");
  });

  it("compacts on the last disconnect", async () => {
    const alice = await connect(spec, "alice");
    for (let i = 0; i < 10; i++) alice.doc.getText("body").insert(i, "x");
    await sleep(100);
    expect((await docStub(spec).stats()).updates).toBeGreaterThan(0);
    closeAll();
    await sleep(100);
    const stats = await docStub(spec).stats();
    expect(stats.updates).toBe(0);
    expect(stats.snapshotChunks).toBe(1);
    expect(stats.compactions).toBe(1);
  });

  it(`compacts after ${COMPACT_AFTER_UPDATES} updates while editing and reloads correctly`, async () => {
    const alice = await connect(spec, "alice");
    const text = alice.doc.getText("body");
    for (let i = 0; i < COMPACT_AFTER_UPDATES + 20; i++) text.insert(text.length, String(i % 10));
    await sleep(500);
    const stats = await docStub(spec).stats();
    expect(stats.compactions).toBeGreaterThanOrEqual(1);
    expect(stats.updates).toBeLessThan(COMPACT_AFTER_UPDATES);

    // Hibernation-style eviction keeps sockets; the doc reloads from snapshot + updates on the next message.
    await evictDurableObject(docStub(spec));
    const bob = await connect(spec, "bob");
    await bob.until(() => bob.text === alice.text);
    expect(bob.text).toHaveLength(COMPACT_AFTER_UPDATES + 20);
  });

  it("splits large snapshots into chunks under the row limit", async () => {
    const stub = docStub(spec);
    const alice = await connect(spec, "alice");
    // ~9 MB of content in a few large updates (each under the 4 MB message cap).
    for (let i = 0; i < 3; i++) alice.doc.getText("body").insert(0, "y".repeat(3 * 1024 * 1024));
    await sleep(1500);
    closeAll();
    await sleep(500);
    const stats = await stub.stats();
    expect(stats.snapshotChunks).toBeGreaterThanOrEqual(3);
    await evictDurableObject(stub).catch(() => {});
    const bob = await connect(spec, "bob");
    await bob.until(() => bob.text.length === 9 * 1024 * 1024, 10_000);
  });
});

describe("one-time tickets for non-browser clients (TDD §3.1)", () => {
  it("accepts a ticket once, without cookie or Origin, and rejects reuse", async () => {
    const cookie = await login("bob");
    const res = await call("/auth/ws-ticket", {
      method: "POST",
      headers: { Cookie: cookie, "X-Officebox-Request": "1", Origin: ORIGIN },
      body: JSON.stringify({ target: `docs:${spec}` }),
    });
    expect(res.status).toBe(200);
    const { ticket } = (await res.json()) as { ticket: string };

    const first = await upgrade(`/ws/docs/${spec}?ticket=${ticket}`, { origin: null });
    expect(first.status).toBe(101);
    first.webSocket!.accept();
    first.webSocket!.close();
    expect((await upgrade(`/ws/docs/${spec}?ticket=${ticket}`, { origin: null })).status).toBe(401);
  });

  it("binds tickets to their target and requires the CSRF header to issue one", async () => {
    const cookie = await login("bob");
    const noHeader = await call("/auth/ws-ticket", {
      method: "POST",
      headers: { Cookie: cookie },
      body: JSON.stringify({ target: `docs:${spec}` }),
    });
    expect(noHeader.status).toBe(403);
    const res = await call("/auth/ws-ticket", {
      method: "POST",
      headers: { Cookie: cookie, "X-Officebox-Request": "1" },
      body: JSON.stringify({ target: `docs:${spec}` }),
    });
    const { ticket } = (await res.json()) as { ticket: string };
    const other = await newDoc("workspace_edit", {});
    expect((await upgrade(`/ws/docs/${other}?ticket=${ticket}`, { origin: null })).status).toBe(401);
  });
});

describe("storage introspection", () => {
  it("reports database size for the storage monitor", async () => {
    const alice = await connect(spec, "alice");
    alice.doc.getText("body").insert(0, "size me");
    await sleep(50);
    const stats = await runInDurableObject(docStub(spec), (_i, state) => state.storage.sql.databaseSize);
    expect(stats).toBeGreaterThan(0);
  });
});

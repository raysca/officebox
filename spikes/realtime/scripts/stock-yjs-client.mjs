// Connects two stock y-websocket providers (Node) to a running spike and checks they converge.
// Usage: npm run dev  (in another terminal), then: npm run stock-client
import WebSocket from "ws";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";

const BASE = process.env.BASE ?? "http://127.0.0.1:8787";
const DOC = process.env.DOC ?? "spec";

async function post(path, { cookie, body } = {}) {
  const headers = { "Content-Type": "application/json", "X-Officebox-Request": "1" };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(`${BASE}${path}`, { method: "POST", headers, body: body && JSON.stringify(body) });
  if (!res.ok) throw new Error(`${path} failed: ${res.status} ${await res.text()}`);
  return res;
}

async function ticketFor(userId) {
  const login = await post("/dev/login", { body: { userId } });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const res = await post("/auth/ws-ticket", { cookie, body: { target: `docs:${DOC}` } });
  return (await res.json()).ticket;
}

function connect(name, ticket) {
  const doc = new Y.Doc();
  // A stock client can't send cookies from Node in a standard way, so it uses a one-time ticket (TDD §3.1).
  const provider = new WebsocketProvider(`${BASE.replace(/^http/, "ws")}/ws/docs`, DOC, doc, {
    WebSocketPolyfill: WebSocket,
    params: { ticket },
    disableBc: true,
    maxBackoffTime: 60_000,
  });
  const synced = new Promise((resolve) => provider.once("sync", resolve));
  return { name, doc, provider, synced };
}

const until = async (check, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};

await post("/dev/seed");
const alice = connect("alice", await ticketFor("alice"));
const bob = connect("bob", await ticketFor("bob"));
await Promise.all([alice.synced, bob.synced]);
console.log("both stock providers synced");

const marker = `stock-client ${new Date().toISOString()}`;
alice.doc.getText("body").insert(0, `${marker}\n`);
await until(() => bob.doc.getText("body").toString().includes(marker));
bob.doc.getText("body").insert(0, "bob was here\n");
await until(() => alice.doc.getText("body").toString() === bob.doc.getText("body").toString() && alice.doc.getText("body").toString().includes("bob was here"));

console.log("converged; document now starts with:");
console.log(alice.doc.getText("body").toString().split("\n").slice(0, 2).join("\n"));
alice.provider.destroy();
bob.provider.destroy();
process.exit(0);

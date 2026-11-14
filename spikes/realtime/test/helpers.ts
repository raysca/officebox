import { exports } from "cloudflare:workers";

export const ORIGIN = "http://officebox.test";

export function call(path: string, init?: RequestInit): Promise<Response> {
  return exports.default.fetch(new Request(`${ORIGIN}${path}`, init));
}

export async function seed(): Promise<void> {
  const res = await call("/dev/seed", { method: "POST" });
  if (!res.ok) throw new Error(`seed failed: ${res.status}`);
}

/** Signs in through the dev route and returns a Cookie header value. */
export async function login(userId: string): Promise<string> {
  const res = await call("/dev/login", { method: "POST", body: JSON.stringify({ userId }) });
  if (!res.ok) throw new Error(`login failed: ${res.status}`);
  return res.headers.get("Set-Cookie")!.split(";")[0]!;
}

export async function upgrade(path: string, opts: { cookie?: string; origin?: string | null } = {}): Promise<Response> {
  const headers: Record<string, string> = { Upgrade: "websocket" };
  if (opts.cookie) headers.Cookie = opts.cookie;
  if (opts.origin !== null) headers.Origin = opts.origin ?? ORIGIN;
  return call(path, { headers });
}

/** A connected JSON WebSocket client with a message inbox. */
export class JsonClient {
  readonly received: any[] = [];
  closed: { code: number; reason: string } | null = null;
  private waiters: Array<() => void> = [];

  constructor(readonly ws: WebSocket) {
    ws.accept();
    ws.addEventListener("message", (ev) => {
      this.received.push(JSON.parse(ev.data as string));
      this.notify();
    });
    ws.addEventListener("close", (ev) => {
      this.closed = { code: ev.code, reason: ev.reason };
      this.notify();
    });
  }

  static async connect(path: string, cookie: string): Promise<JsonClient> {
    const res = await upgrade(path, { cookie });
    if (res.status !== 101 || !res.webSocket) throw new Error(`upgrade failed: ${res.status} ${await res.text()}`);
    const client = new JsonClient(res.webSocket);
    await client.next((m) => m.type === "welcome");
    return client;
  }

  send(message: unknown): void {
    this.ws.send(JSON.stringify(message));
  }

  private notify(): void {
    for (const w of this.waiters.splice(0)) w();
  }

  /** Resolves with the first message (received so far or later) matching `predicate` and removes it. */
  async next(predicate: (m: any) => boolean, timeoutMs = 3000): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = this.received.findIndex(predicate);
      if (index >= 0) return this.received.splice(index, 1)[0];
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`timed out; received: ${JSON.stringify(this.received)}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  async waitClosed(timeoutMs = 3000): Promise<{ code: number; reason: string }> {
    const deadline = Date.now() + timeoutMs;
    while (!this.closed) {
      if (Date.now() > deadline) throw new Error("socket did not close");
      await new Promise((r) => setTimeout(r, 20));
    }
    return this.closed;
  }

  close(): void {
    try {
      this.ws.close(1000, "done");
    } catch {
      // Already closed.
    }
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Creates a channel with a unique ID (storage is shared across tests in a file). */
export async function newChannel(
  type: "public" | "private" = "public",
  members: Record<string, "admin" | "member"> = { alice: "admin", bob: "member", carol: "member" },
): Promise<string> {
  const { env } = await import("cloudflare:workers");
  const id = `${type}-${crypto.randomUUID().slice(0, 8)}`;
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO channels (id, type, name, created_by, created_at) VALUES (?, ?, ?, 'alice', ?)").bind(id, type, id, now),
    ...Object.entries(members).map(([user, role]) =>
      env.DB.prepare("INSERT INTO channel_members (channel_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)").bind(id, user, role, now),
    ),
  ]);
  return id;
}

/** Creates a document with a unique ID owned by alice. */
export async function newDoc(
  generalAccess: "restricted" | "workspace_view" | "workspace_edit" = "workspace_view",
  grants: Record<string, "editor" | "commenter" | "viewer"> = { bob: "editor" },
): Promise<string> {
  const { env } = await import("cloudflare:workers");
  const id = `doc-${crypto.randomUUID().slice(0, 8)}`;
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO documents (id, title, owner_id, general_access, created_at) VALUES (?, ?, 'alice', ?, ?)").bind(id, id, generalAccess, now),
    ...Object.entries(grants).map(([user, role]) =>
      env.DB.prepare(
        "INSERT INTO resource_grants (resource_type, resource_id, principal_type, principal_id, role, created_at) VALUES ('document', ?, 'user', ?, ?, ?)",
      ).bind(id, user, role, now),
    ),
  ]);
  return id;
}

/** Creates an active user with a unique ID (presence and hubs are shared across tests). */
export async function newUser(name: string): Promise<string> {
  const { env } = await import("cloudflare:workers");
  const id = `${name}-${crypto.randomUUID().slice(0, 8)}`;
  await env.DB.prepare("INSERT INTO users (id, email, display_name, created_at) VALUES (?, ?, ?, ?)")
    .bind(id, `${id}@example.com`, name, Date.now())
    .run();
  return id;
}

/** Creates a DM channel between the given users. */
export async function newDm(...users: string[]): Promise<string> {
  const { env } = await import("cloudflare:workers");
  const id = `dm-${crypto.randomUUID().slice(0, 8)}`;
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO channels (id, type, created_by, created_at) VALUES (?, 'dm', ?, ?)").bind(id, users[0], now),
    ...users.map((u) =>
      env.DB.prepare("INSERT INTO channel_members (channel_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)").bind(id, u, now),
    ),
  ]);
  return id;
}

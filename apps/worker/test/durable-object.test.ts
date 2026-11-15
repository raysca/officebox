import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { TestObject } from "./fixtures/test-object";

// Storage is shared between tests in a file: every test uses its own object name (AGENTS §5).
const stub = () => env.TEST_OBJECT.getByName(`do-${crypto.randomUUID()}`);

type Stub = ReturnType<typeof stub>;

const sqlRows = <T extends Record<string, SqlStorageValue>>(s: Stub, query: string, ...params: SqlStorageValue[]) =>
  runInDurableObject(s, (_i: TestObject, state) => state.storage.sql.exec<T>(query, ...params).toArray());

const HOUR = 3_600_000;

const metaValue = async (s: Stub, key: string) =>
  (await sqlRows<{ value: string }>(s, "SELECT value FROM meta WHERE key = ?", key))[0]?.value ?? null;

describe("schema versioning", () => {
  it("migrates a new object to the latest version on first wake", async () => {
    const s = stub();
    expect(await s.version()).toEqual({ ok: true, value: { schemaVersion: 2 } });
    expect(await metaValue(s, "core_schema_version")).toBe("1");
  });

  it("migrates an older object lazily after eviction, keeping its data (PLAN M0 exit criterion)", async () => {
    const s = stub();
    expect((await s.addItem("a", "Alpha")).ok).toBe(true);

    // Rewind the stored schema to version 1, as if the object was last opened by an older release.
    await runInDurableObject(s, (_i: TestObject, state) => {
      state.storage.sql.exec("ALTER TABLE items DROP COLUMN note");
      state.storage.sql.exec("UPDATE meta SET value = '1' WHERE key = 'schema_version'");
    });
    await evictDurableObject(s);

    // The next call wakes a fresh instance, which applies migration 2 before handling it.
    expect(await s.version()).toEqual({ ok: true, value: { schemaVersion: 2 } });
    expect(await s.items()).toEqual({ ok: true, value: [{ id: "a", name: "Alpha", note: "" }] });

    // And it survives a further eviction without migrating again.
    await evictDurableObject(s);
    expect(await s.version()).toEqual({ ok: true, value: { schemaVersion: 2 } });
  });

  it("refuses work and leaves data untouched when a migration fails", async () => {
    const s = stub();
    await s.addItem("a", "Alpha");
    await runInDurableObject(s, (_i: TestObject, state) => {
      state.storage.sql.exec("ALTER TABLE items DROP COLUMN note");
      state.storage.sql.exec("UPDATE meta SET value = '1' WHERE key = 'schema_version'");
      state.storage.sql.exec("INSERT INTO meta (key, value) VALUES ('fail_v2', '1')");
    });
    await evictDurableObject(s);

    const result = await s.version();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("unavailable");
    const res = await s.fetch("http://do/anything");
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: "unavailable" } });

    // The failed migration rolled back: still version 1, no `note` column, the row intact.
    // (Read over RPC: runInDurableObject goes through fetch, which the object now refuses.)
    expect(await s.rawState()).toEqual({ schemaVersion: "1", columns: ["id", "name"], rows: 1 });

    // A fixed release (here: the failure cleared) migrates on the next wake.
    await s.meta("fail_v2", "0");
    await evictDurableObject(s);
    expect(await s.version()).toEqual({ ok: true, value: { schemaVersion: 2 } });
  });

  it("tolerates a schema newer than the code", async () => {
    const s = stub();
    await s.version();
    await runInDurableObject(s, (_i: TestObject, state) =>
      state.storage.sql.exec("UPDATE meta SET value = '9' WHERE key = 'schema_version'"),
    );
    await evictDurableObject(s);
    expect(await s.version()).toEqual({ ok: true, value: { schemaVersion: 9 } });
  });
});

describe("typed RPC results", () => {
  it("returns expected denials as plain results instead of throwing", async () => {
    const s = stub();
    const result = await s.denied();
    expect(result).toEqual({ ok: false, error: { code: "forbidden", message: "Not allowed." } });
  });
});

describe("alarm multiplexer", () => {
  it("runs due timers in due order, keeps future ones and points the alarm at the earliest", async () => {
    const s = stub();
    const now = Date.now();
    await s.timer("record:b", now + HOUR + 1000);
    await s.timer("record:a", now + HOUR);
    await s.timer("record:later", now + 10 * HOUR);
    expect(await runInDurableObject(s, (_i: TestObject, state) => state.storage.getAlarm())).toBe(now + HOUR);

    await s.rewind(2 * HOUR); // time passes: a and b are due
    expect(await runDurableObjectAlarm(s)).toBe(true);
    expect(await s.timerLog()).toEqual(["record:a", "record:b"]);
    expect(await runInDurableObject(s, (_i: TestObject, state) => state.storage.getAlarm())).toBe(now + 8 * HOUR);

    await s.cancel("record:later");
    expect(await runInDurableObject(s, (_i: TestObject, state) => state.storage.getAlarm())).toBeNull();
  });

  it("is idempotent: a timer runs once, and a spurious alarm does nothing", async () => {
    const s = stub();
    await s.timer("record:once", Date.now() + HOUR, '{"n":1}');
    await s.rewind(HOUR);
    await runDurableObjectAlarm(s);
    // Force an alarm with nothing due.
    await runInDurableObject(s, (_i: TestObject, state) => state.storage.setAlarm(Date.now() + HOUR));
    expect(await runDurableObjectAlarm(s)).toBe(true);
    expect(await s.timerLog()).toEqual(["record:once"]);
    expect(await sqlRows(s, "SELECT * FROM core_timers")).toEqual([]);
  });

  it("moving a timer replaces it rather than adding a second one", async () => {
    const s = stub();
    await s.timer("record:x", Date.now() + 2 * HOUR);
    await s.timer("record:x", Date.now() + HOUR);
    await s.rewind(HOUR);
    await runDurableObjectAlarm(s);
    expect(await s.timerLog()).toEqual(["record:x"]);
  });

  it("keeps timers across eviction and runs them on the next alarm", async () => {
    const s = stub();
    await s.timer("record:durable", Date.now() + HOUR, "payload");
    await s.rewind(HOUR);
    await evictDurableObject(s);
    expect(await runDurableObjectAlarm(s)).toBe(true);
    expect(await s.timerLog()).toEqual(["record:durable"]);
  });

  it("restores a missing alarm when the object wakes", async () => {
    const s = stub();
    const due = Date.now() + 120_000;
    await s.timer("record:restore", due);
    await runInDurableObject(s, (_i: TestObject, state) => state.storage.deleteAlarm());
    await evictDurableObject(s);
    await s.version(); // wake
    expect(await runInDurableObject(s, (_i: TestObject, state) => state.storage.getAlarm())).toBe(due);
  });

  it("retries a failing handler with backoff without blocking other timers", async () => {
    const s = stub();
    await s.meta("flaky_fail", "1");
    await s.timer("flaky:1", Date.now() + HOUR);
    await s.timer("record:ok", Date.now() + HOUR + 10);
    await s.rewind(2 * HOUR);
    const before = Date.now();
    await runDurableObjectAlarm(s);
    expect(await s.timerLog()).toEqual(["record:ok"]);

    const [row] = await sqlRows<{ attempts: number; due_at: number }>(
      s,
      "SELECT attempts, due_at FROM core_timers WHERE name = 'flaky:1'",
    );
    expect(row?.attempts).toBe(1);
    expect(row?.due_at).toBeGreaterThanOrEqual(before + 2000);

    await s.meta("flaky_fail", "0");
    await s.rewind(HOUR);
    await runDurableObjectAlarm(s);
    expect(await s.timerLog()).toEqual(["record:ok", "flaky:1"]);
  });

  it("keeps a timer that its handler rescheduled", async () => {
    const s = stub();
    await s.timer("again:1", Date.now() + HOUR);
    await s.rewind(HOUR);
    await runDurableObjectAlarm(s);
    const rows = await sqlRows<{ name: string; due_at: number }>(s, "SELECT name, due_at FROM core_timers");
    expect(rows.map((r) => r.name)).toEqual(["again:1"]);
    expect(rows[0]?.due_at).toBeGreaterThan(Date.now());
  });

  it("drops timers with no handler", async () => {
    const s = stub();
    await s.timer("nobody:1", Date.now() + HOUR);
    await s.rewind(HOUR);
    await runDurableObjectAlarm(s);
    expect(await sqlRows(s, "SELECT * FROM core_timers")).toEqual([]);
  });
});

describe("WebSocket helpers", () => {
  it("answers ping with pong and keeps typed attachments across hibernation", async () => {
    const s = stub();
    const res = await s.fetch("http://do/ws?user=u1", { headers: { Upgrade: "websocket" } });
    expect(res.status).toBe(101);
    const ws = res.webSocket;
    if (!ws) throw new Error("no socket");
    ws.accept();
    const received: string[] = [];
    let wake: (() => void) | undefined;
    ws.addEventListener("message", (e) => {
      received.push(String(e.data));
      wake?.();
    });
    const next = () =>
      new Promise<string>((resolve) => {
        const count = received.length;
        wake = () => {
          if (received.length > count) resolve(received[received.length - 1] ?? "");
        };
      });

    let reply = next();
    ws.send("ping");
    expect(await reply).toBe("pong");

    await evictDurableObject(s);
    reply = next();
    ws.send("hello");
    expect(JSON.parse(await reply)).toEqual({ type: "test.echo", message: "hello", users: ["u1"] });
    expect(await s.connected()).toEqual(["u1"]);
    ws.close();
  });
});

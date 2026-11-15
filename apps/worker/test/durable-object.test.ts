import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { RpcMethodsReturnResults } from "../src/core/do/base";
import type { SystemObject } from "../src/system-object";
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
    expect(await metaValue(s, "core_schema_version")).toBe("2");
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

  it("keeps timers of an unknown kind for a later release, and drops retired kinds", async () => {
    const s = stub();
    await s.timer("nobody:1", Date.now() + HOUR);
    await s.timer("old:1", Date.now() + HOUR);
    await s.rewind(HOUR);
    await runDurableObjectAlarm(s);
    const rows = await s.timerRows();
    expect(rows.map((r) => [r.name, r.attempts])).toEqual([["nobody:1", 1]]);
    expect(rows[0]?.due_at).toBeGreaterThan(Date.now());
  });

  it("treats a handler that exceeds its timeout as failed and backs off", async () => {
    const s = stub();
    await s.timer("hang:1", Date.now() + HOUR);
    await s.rewind(HOUR);
    await runDurableObjectAlarm(s);
    const [row] = await s.timerRows();
    expect(row).toMatchObject({ name: "hang:1", attempts: 1 });
    expect(row?.due_at).toBeGreaterThan(Date.now());
  });

  it("leaves the alarm alone when the transaction that set a timer rolls back", async () => {
    const s = stub();
    expect(await s.rolledBackTimer("record:rb", Date.now() + HOUR)).toBe("roll back");
    expect(await s.timerRows()).toEqual([]);
    expect(await runInDurableObject(s, (_i: TestObject, state) => state.storage.getAlarm())).toBeNull();

    // With an existing timer, the alarm stays on it.
    const due = Date.now() + 2 * HOUR;
    await s.timer("record:keep", due);
    await s.rolledBackTimer("record:rb", Date.now() + HOUR);
    expect(await runInDurableObject(s, (_i: TestObject, state) => state.storage.getAlarm())).toBe(due);
  });

  it("applies concurrent setTimer calls one at a time, without duplicates", async () => {
    const s = stub();
    const base = Date.now() + HOUR;
    await Promise.all(Array.from({ length: 10 }, (_, i) => s.timer("record:c", base + (10 - i) * 1000, null, true)));
    const rows = await s.timerRows();
    expect(rows.length).toBe(1);
    expect(rows[0]?.due_at).toBe(base + 1000); // ifEarlier: the earliest wins
    expect(await runInDurableObject(s, (_i: TestObject, state) => state.storage.getAlarm())).toBe(base + 1000);
  });

  it("ifEarlier keeps an earlier timer untouched and moves a later one", async () => {
    const s = stub();
    const t = Date.now() + HOUR;
    await s.timer("record:e", t, "first");
    const [before] = await s.timerRows();
    await s.timer("record:e", t + 5000, "second", true);
    expect((await s.timerRows())[0]).toEqual(before); // due, payload, attempts and generation unchanged
    await s.timer("record:e", t - 5000, "third", true);
    expect((await s.timerRows())[0]).toMatchObject({ due_at: t - 5000, payload: "third" });
  });

  // These run on the runtime's own alarm (due in 50 ms) rather than runDurableObjectAlarm, which
  // holds back other requests to the object while it runs. Each step waits for a known state.
  const until = async (check: () => Promise<boolean>) => {
    for (let i = 0; i < 400 && !(await check()); i++) await new Promise((r) => setTimeout(r, 5));
    expect(await check()).toBe(true);
  };
  const startGated = async (s: Stub, name: string) => {
    await s.timer(name, Date.now() + 50);
    await until(async () => (await s.gateReached()) === 1);
  };

  it("keeps a timer rescheduled while its handler is mid-I/O", async () => {
    const s = stub();
    await startGated(s, "gated:1");
    const later = Date.now() + 3 * HOUR;
    await s.timer("gated:1", later);
    await s.openGate();
    await until(async () => (await s.timerLog()).length === 1);
    expect(await s.timerLog()).toEqual(["gated:1"]);
    await until(async () => (await s.timerRows())[0]?.due_at === later);
    expect((await s.timerRows()).map((r) => [r.name, r.due_at])).toEqual([["gated:1", later]]);
  });

  it("an ifEarlier request while the timer runs keeps it due, and it runs again", async () => {
    const s = stub();
    await startGated(s, "gated:2");
    await s.timer("gated:2", Date.now() + HOUR, null, true);
    const [row] = await s.timerRows();
    expect(row?.due_at).toBeLessThanOrEqual(Date.now()); // the earlier (running) due time was kept
    await s.openGate();
    // Kept as changed, so the alarm runs it a second time, then it's gone.
    await until(async () => (await s.timerLog()).length === 2);
    await until(async () => (await s.timerRows()).length === 0);
    expect(await s.timerLog()).toEqual(["gated:2", "gated:2"]);
  });

  it("cancelling a timer while its handler runs leaves no timer behind", async () => {
    const s = stub();
    await startGated(s, "gated:3");
    await s.cancel("gated:3");
    await s.openGate();
    await until(async () => (await s.timerLog()).length === 1);
    expect(await s.timerRows()).toEqual([]);
    expect(await s.timerLog()).toEqual(["gated:3"]);
  });

  it("runs more than 100 due timers over successive alarms, each once", async () => {
    const s = stub();
    const due = Date.now() + HOUR;
    for (let i = 0; i < 150; i++) await s.timer(`record:${String(i).padStart(3, "0")}`, due);
    await s.rewind(HOUR);
    await runDurableObjectAlarm(s);
    expect((await s.timerLog()).length).toBeGreaterThanOrEqual(100);
    // The remaining 50 are past due, so the alarm is set to fire straight away; run it until done.
    for (let i = 0; i < 5 && (await s.timerLog()).length < 150; i++) await runDurableObjectAlarm(s);
    const log = await s.timerLog();
    expect(log.length).toBe(150);
    expect(new Set(log).size).toBe(150);
  });
});

describe("migration failures and newer schemas", () => {
  it("refuses work when a core migration fails", async () => {
    const s = stub();
    await s.version();
    // Rewind the core schema to 1 and plant a conflicting table so core migration 2 fails.
    await runInDurableObject(s, (_i: TestObject, state) => {
      state.storage.sql.exec("DROP TABLE core_outbox_dead");
      state.storage.sql.exec("CREATE TABLE core_outbox_dead (unrelated TEXT)");
      state.storage.sql.exec("UPDATE meta SET value = '1' WHERE key = 'core_schema_version'");
    });
    await evictDurableObject(s);
    const result = await s.version();
    expect(!result.ok && result.error.code).toBe("unavailable");
  });

  it("keeps serving reads and writes on a schema newer than the code", async () => {
    const s = stub();
    await s.version();
    await runInDurableObject(s, (_i: TestObject, state) => {
      state.storage.sql.exec("ALTER TABLE items ADD COLUMN added_by_newer TEXT");
      state.storage.sql.exec("UPDATE meta SET value = '3' WHERE key = 'schema_version'");
    });
    await evictDurableObject(s);
    expect((await s.addItem("n1", "Newer")).ok).toBe(true);
    const items = await s.items();
    expect(items.ok && items.value.map((i) => i.id)).toEqual(["n1"]);
  });

  it("closes sockets instead of handling messages while unavailable", async () => {
    const s = stub();
    const res = await s.fetch("http://do/ws?user=u2", { headers: { Upgrade: "websocket" } });
    const ws = res.webSocket;
    if (!ws) throw new Error("no socket");
    ws.accept();
    const closed = new Promise<number>((resolve) => ws.addEventListener("close", (e) => resolve(e.code)));
    await s.meta("fail_v2", "1");
    await runInDurableObject(s, (_i: TestObject, state) => {
      state.storage.sql.exec("ALTER TABLE items DROP COLUMN note");
      state.storage.sql.exec("UPDATE meta SET value = '1' WHERE key = 'schema_version'");
    });
    await evictDurableObject(s);
    ws.send("hello");
    expect(await closed).toBe(1011);
  });
});

describe("RPC method types", () => {
  it("every SystemObject RPC method returns an RpcResult (checked at compile time)", () => {
    const check: RpcMethodsReturnResults<SystemObject> = true;
    expect(check).toBe(true);
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

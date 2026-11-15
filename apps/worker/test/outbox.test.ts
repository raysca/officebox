import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  chunkRows,
  MAX_OUTBOX_BATCH_BYTES,
  MAX_OUTBOX_ATTEMPTS,
  MAX_OUTBOX_BATCH_MESSAGES,
  MAX_OUTBOX_MESSAGE_BYTES,
} from "../src/core/do/outbox";
import type { TestObject } from "./fixtures/test-object";

// The TestObject's outbox sends through a fake queue sender that records batches in its SQLite, and
// fails while `meta.outbox_fail` is "1".
const stub = () => env.TEST_OBJECT.getByName(`outbox-${crypto.randomUUID()}`);
type Stub = ReturnType<typeof stub>;

const pending = (s: Stub) =>
  runInDurableObject(s, (_i: TestObject, state) =>
    state.storage.sql
      .exec<{ id: number; attempts: number; next_attempt_at: number }>(
        "SELECT id, attempts, next_attempt_at FROM core_outbox ORDER BY id",
      )
      .toArray(),
  );

describe("outbox", () => {
  it("writes the outbox row in the same transaction as the state change and schedules a drain", async () => {
    const s = stub();
    const before = Date.now();
    expect(await s.addItem("i1", "One")).toEqual({ ok: true, value: { id: "i1" } });
    expect((await pending(s)).length).toBe(1);
    const alarm = await runInDurableObject(s, (_i: TestObject, state) => state.storage.getAlarm());
    expect(alarm).toBeGreaterThanOrEqual(before + 250);
  });

  it("rolls back the state change when the message can't be queued", async () => {
    const s = stub();
    // A programming error (features cap sizes first), so it throws; caught inside the object here so
    // the runtime doesn't report an uncaught exception.
    const message = await runInDurableObject(s, async (instance: TestObject) => {
      try {
        await instance.addItem("big", "Too big", MAX_OUTBOX_MESSAGE_BYTES);
        return "no error";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });
    expect(message).toMatch(/exceeds/);
    expect(await s.items()).toEqual({ ok: true, value: [] });
    expect(await pending(s)).toEqual([]);
  });

  it("drains in order and deletes rows only after they are sent", async () => {
    const s = stub();
    for (const id of ["a", "b", "c"]) await s.addItem(id, id);
    await s.rewind(1000); // past the 250 ms batching delay
    expect(await runDurableObjectAlarm(s)).toBe(true);
    expect(await s.sentBodies()).toEqual([
      { batch: 1, id: "a", bytes: expect.any(Number) as number },
      { batch: 1, id: "b", bytes: expect.any(Number) as number },
      { batch: 1, id: "c", bytes: expect.any(Number) as number },
    ]);
    expect(await pending(s)).toEqual([]);
    expect(await runInDurableObject(s, (_i: TestObject, state) => state.storage.getAlarm())).toBeNull();
  });

  it("chunks sends by the queue batch size limit", async () => {
    const s = stub();
    // 5 messages of ~100 KB: at most two fit in a 240 KB batch.
    for (let i = 0; i < 5; i++) await s.addItem(`big${i}`, "big", 100_000);
    await s.rewind(1000);
    await runDurableObjectAlarm(s);
    const sent = await s.sentBodies();
    expect(sent.map((r) => r.id)).toEqual(["big0", "big1", "big2", "big3", "big4"]);
    expect(sent.map((r) => r.batch)).toEqual([1, 1, 2, 2, 3]);
    expect(await pending(s)).toEqual([]);
  });

  it("keeps rows and backs off exponentially while the queue fails, then delivers", async () => {
    const s = stub();
    await s.meta("outbox_fail", "1");
    await s.addItem("x", "x");
    await s.rewind(1000);

    const t0 = Date.now();
    await runDurableObjectAlarm(s);
    let rows = await pending(s);
    expect(rows.map((r) => r.attempts)).toEqual([1]);
    expect(rows[0]?.next_attempt_at).toBeGreaterThanOrEqual(t0 + 2000);
    expect(rows[0]?.next_attempt_at).toBeLessThan(t0 + 2000 + 5000);
    // The drain timer follows the retry.
    expect(await runInDurableObject(s, (_i: TestObject, state) => state.storage.getAlarm())).toBe(
      rows[0]?.next_attempt_at,
    );

    await s.rewind(10_000);
    const t1 = Date.now();
    await runDurableObjectAlarm(s);
    rows = await pending(s);
    expect(rows.map((r) => r.attempts)).toEqual([2]);
    expect(rows[0]?.next_attempt_at).toBeGreaterThanOrEqual(t1 + 4000);
    expect(await s.sentBodies()).toEqual([]);

    // Survives eviction; delivered once the queue recovers.
    await evictDurableObject(s);
    await s.meta("outbox_fail", "0");
    await s.rewind(10_000);
    await runDurableObjectAlarm(s);
    expect((await s.sentBodies()).map((r) => r.id)).toEqual(["x"]);
    expect(await pending(s)).toEqual([]);
  });
});

describe("outbox failures", () => {
  const drain = async (s: Stub) => {
    await s.rewind(10 * 60_000); // past any backoff
    await runDurableObjectAlarm(s);
  };

  it("isolates a poison row by bisecting, sending the rest of the chunk", async () => {
    const s = stub();
    for (const id of ["a", "b", "c", "d", "e", "f"]) await s.addItem(id, id, 0, id === "c");
    await drain(s);
    expect((await s.sentBodies()).map((r) => r.id).sort()).toEqual(["a", "b", "d", "e", "f"]);
    const rows = await pending(s);
    expect(rows.map((r) => r.attempts)).toEqual([1]); // only the poison row counts an attempt
    const stats = await s.outboxStats();
    expect(stats).toMatchObject({ pending: 1, dead: 0 });
    expect(stats.sendCalls).toBeLessThanOrEqual(7); // a bisection, not one call per row
  });

  it("moves a row that keeps failing while others succeed to core_outbox_dead", async () => {
    const s = stub();
    await s.addItem("bad", "bad", 0, true);
    for (let i = 0; i < MAX_OUTBOX_ATTEMPTS; i++) {
      await s.addItem(`good${i}`, "good");
      await drain(s);
    }
    expect(await s.outboxStats()).toMatchObject({ pending: 0, dead: 1 });
    const dead = await runInDurableObject(s, (_i: TestObject, state) =>
      state.storage.sql.exec<{ attempts: number }>("SELECT attempts FROM core_outbox_dead").toArray(),
    );
    expect(dead).toEqual([{ attempts: MAX_OUTBOX_ATTEMPTS }]);
    expect((await s.sentBodies()).length).toBe(MAX_OUTBOX_ATTEMPTS);
  });

  it("never kills rows during an outage, and probes cheaply", async () => {
    const s = stub();
    await s.meta("outbox_fail", "1");
    for (let i = 0; i < 20; i++) await s.addItem(`o${i}`, "o");
    for (let i = 0; i < MAX_OUTBOX_ATTEMPTS + 2; i++) await drain(s);
    const stats = await s.outboxStats();
    expect(stats).toMatchObject({ pending: 20, dead: 0 });
    expect(stats.sendCalls).toBeLessThanOrEqual((MAX_OUTBOX_ATTEMPTS + 2) * 8);
    // Untried rows wait too, so a down queue isn't hammered.
    const rows = await pending(s);
    expect(rows.every((r) => r.next_attempt_at > Date.now())).toBe(true);

    await s.meta("outbox_fail", "0");
    await drain(s);
    expect(await s.outboxStats()).toMatchObject({ pending: 0, dead: 0 });
  });

  it("delivers in order after the queue recovers", async () => {
    const s = stub();
    await s.meta("outbox_fail", "1");
    for (const id of ["x1", "x2", "x3"]) await s.addItem(id, id);
    await drain(s);
    await s.addItem("x4", "x4");
    await s.meta("outbox_fail", "0");
    await drain(s);
    expect((await s.sentBodies()).map((r) => r.id)).toEqual(["x1", "x2", "x3", "x4"]);
  });

  it("stops early when the queue goes down part-way through a drain", async () => {
    const s = stub();
    await s.addItems("m", 300);
    const before = (await s.outboxStats()).sendCalls;
    await s.meta("outbox_fail_after", String(before + 1)); // the first chunk goes through, then the queue fails
    await drain(s);
    const stats = await s.outboxStats();
    expect(stats.pending).toBe(200);
    expect(stats.dead).toBe(0);
    expect(stats.sendCalls - before).toBeLessThanOrEqual(12); // not ~400 single-row sends
    const rows = await pending(s);
    expect(rows.filter((r) => r.attempts > 0).length).toBeLessThanOrEqual(2);
    expect(rows.every((r) => r.next_attempt_at > Date.now())).toBe(true);
  });

  it("doesn't pull the drain earlier for new messages during an outage", async () => {
    const s = stub();
    await s.meta("outbox_fail", "1");
    await s.addItem("p1", "p");
    await s.addItem("p2", "p");
    await drain(s);
    const retryAt = Math.min(...(await pending(s)).map((r) => r.next_attempt_at));
    expect(retryAt).toBeGreaterThan(Date.now());
    await s.addItem("p3", "p");
    const alarm = await runInDurableObject(s, (_i: TestObject, state) => state.storage.getAlarm());
    expect(alarm).toBeGreaterThanOrEqual(retryAt);
    const newest = (await pending(s)).at(-1);
    expect(newest?.next_attempt_at).toBeGreaterThanOrEqual(retryAt);
  });

  it("runs one drain at a time and times out a send that hangs", async () => {
    const s = stub();
    await s.meta("outbox_hang", "1");
    await s.addItem("h1", "h");
    await s.rewind(10 * 60_000);
    const first = s.drainNow();
    // Wait until the first drain is inside its (hanging) send.
    for (let i = 0; i < 50 && (await s.outboxStats()).sendCalls === 0; i++) await new Promise((r) => setTimeout(r, 5));
    const second = await s.drainNow();
    expect(second).toBeGreaterThan(Date.now()); // asked to be retried; did nothing
    await first;
    const stats = await s.outboxStats();
    expect(stats.sendCalls).toBe(1);
    expect((await pending(s)).map((r) => r.attempts)).toEqual([1]); // the timeout counted as a failure
  });
});

describe("chunkRows", () => {
  it("respects the message count and byte limits and keeps order", () => {
    const small = Array.from({ length: 250 }, (_, i) => ({ id: i, bytes: 10 }));
    const chunks = chunkRows(small);
    expect(chunks.map((c) => c.length)).toEqual([MAX_OUTBOX_BATCH_MESSAGES, MAX_OUTBOX_BATCH_MESSAGES, 50]);
    expect(chunks.flat().map((r) => r.id)).toEqual(small.map((r) => r.id));

    const big = [{ bytes: MAX_OUTBOX_BATCH_BYTES - 10 }, { bytes: 20 }, { bytes: 5 }];
    expect(chunkRows(big).map((c) => c.length)).toEqual([1, 2]);
  });
});

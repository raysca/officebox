import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  chunkRows,
  MAX_OUTBOX_BATCH_BYTES,
  DEFAULT_MAX_SENDS_PER_DRAIN,
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

  it("backs a failing row off exponentially, keeps it through eviction, then delivers", async () => {
    const s = stub();
    await s.meta("outbox_fail", "1");
    await s.addItem("x", "x");
    await s.rewind(1000);

    const t0 = Date.now();
    await runDurableObjectAlarm(s);
    let [row] = await s.outboxRows();
    expect(row?.attempts).toBe(1);
    expect(row?.first_failed_at).not.toBeNull();
    expect(row?.next_attempt_at).toBeGreaterThanOrEqual(t0 + 2000);
    expect(row?.next_attempt_at).toBeLessThanOrEqual(t0 + 2000 + 1000); // 2 s (no jitter in tests)
    // The drain timer follows the retry.
    expect(await s.alarmTime()).toBe(row?.next_attempt_at);

    await s.advanceToNextRetry();
    const t1 = Date.now();
    await runDurableObjectAlarm(s);
    [row] = await s.outboxRows();
    expect(row?.attempts).toBe(2);
    expect(row?.next_attempt_at).toBeGreaterThanOrEqual(t1 + 4000);
    expect(await s.sentBodies()).toEqual([]);
    expect((await s.outboxStats()).streamBackoff).toBe(2); // two drains that sent nothing

    // Survives eviction; delivered once the queue recovers.
    await evictDurableObject(s);
    await s.meta("outbox_fail", "0");
    await s.advanceToNextRetry();
    await runDurableObjectAlarm(s);
    expect((await s.sentBodies()).map((r) => r.id)).toEqual(["x"]);
    const stats = await s.outboxStats();
    expect(stats).toMatchObject({ pending: 0, dead: 0, streamBackoff: 0, oldestPendingAgeMs: null });
    expect(stats.lastSuccessAt).not.toBeNull();
  });
});

describe("outbox failures", () => {
  /** Lets time pass until the earliest retry, then runs the drain the runtime would run. */
  const drain = async (s: Stub) => {
    await s.advanceToNextRetry();
    await runDurableObjectAlarm(s);
    return s.lastDrain();
  };
  const drainUntil = async (s: Stub, done: () => Promise<boolean>, maxDrains: number) => {
    const sends: number[] = [];
    for (let i = 0; i < maxDrains && !(await done()); i++) sends.push((await drain(s))?.sends ?? 0);
    return sends;
  };

  it("isolates a poison row by bisecting, sending the rest of the chunk", async () => {
    const s = stub();
    await s.addRows(["g1", "g2", "p1", "g3", "g4", "g5"]);
    const report = await drain(s);
    expect((await s.sentBodies()).map((r) => r.id).sort()).toEqual(["g1", "g2", "g3", "g4", "g5"]);
    expect((await s.outboxRows()).map((r) => [r.id, r.attempts])).toEqual([["p1", 1]]);
    expect(report).toMatchObject({ sends: 5, sentRows: 5, failedRows: 1 });
  });

  it("sends the good rows behind poison rows at both ends, and dead-letters the poison", async () => {
    const s = stub();
    await s.meta("manual_alarms", "1");
    await s.addRows(["p1", "p2", "p3", "g1", "g2", "pz"]);
    const sends = await drainUntil(
      s,
      async () => (await s.sentBodies()).length === 2 && (await s.outboxStats()).dead === 4,
      80,
    );
    expect((await s.sentBodies()).map((r) => r.id).sort()).toEqual(["g1", "g2"]);
    expect(await s.outboxStats()).toMatchObject({ pending: 0, dead: 4 });
    // The good rows went out in the first drain; the rest is the poison rows' own retries.
    expect((await s.sentBodies()).every((r) => r.batch <= 1)).toBe(true);
    expect(Math.max(...sends)).toBeLessThanOrEqual(DEFAULT_MAX_SENDS_PER_DRAIN);
  });

  it("sends every good row from a long alternating run of poison and good rows, within budget", async () => {
    const s = stub();
    await s.meta("manual_alarms", "1");
    const ids = Array.from({ length: 600 }, (_, i) => `${i % 2 === 0 ? "p" : "g"}${String(i).padStart(3, "0")}`);
    await s.addRows(ids);
    const sends = await drainUntil(s, async () => (await s.sentBodies()).length === 300, 400);
    expect((await s.sentBodies()).length).toBe(300);
    expect(Math.max(...sends)).toBeLessThanOrEqual(DEFAULT_MAX_SENDS_PER_DRAIN);
    // Good rows are never blamed for the bad rows they shared batches with.
    expect((await s.outboxRows()).every((r) => r.id.startsWith("p"))).toBe(true);
  });

  it("never dead-letters rows during a long outage, stays within budget and doesn't spin", async () => {
    const s = stub();
    await s.meta("manual_alarms", "1"); // only the test runs drains, so each check sees one drain
    await s.meta("outbox_fail", "1");
    await s.addItems("o", 150);
    const sends: number[] = [];
    // Keep draining until some rows have failed more often than the dead-letter limit.
    for (let i = 0; i < 150 && (await s.outboxStats()).maxAttempts < MAX_OUTBOX_ATTEMPTS + 2; i++) {
      await s.advanceToNextRetry();
      const start = Date.now();
      const dueAtStart = (await s.outboxRows()).filter((r) => r.next_attempt_at <= start).map((r) => r.id);
      await runDurableObjectAlarm(s);
      sends.push((await s.lastDrain())?.sends ?? 0);
      // No tight loop: every row that was due when the drain started is now due at least a backoff
      // later (rows tried get their own backoff, rows not reached get the stream backoff).
      const after = new Map((await s.outboxRows()).map((r) => [r.id, r.next_attempt_at]));
      for (const id of dueAtStart) expect(after.get(id) ?? 0).toBeGreaterThanOrEqual(start + 1000);
    }
    expect(await s.outboxStats()).toMatchObject({ pending: 150, dead: 0 });
    expect(Math.max(...sends)).toBeLessThanOrEqual(DEFAULT_MAX_SENDS_PER_DRAIN);
    expect((await s.outboxStats()).maxAttempts).toBeGreaterThanOrEqual(MAX_OUTBOX_ATTEMPTS);

    await s.meta("outbox_fail", "0");
    await drainUntil(s, async () => (await s.outboxStats()).pending === 0, 20);
    expect(await s.outboxStats()).toMatchObject({ pending: 0, dead: 0, streamBackoff: 0 });
    expect((await s.sentBodies()).length).toBe(150);
  });

  it("dead-letters a lone poison row only after another row has been sent", async () => {
    const s = stub();
    await s.addRows(["p1"]);
    for (let i = 0; i < MAX_OUTBOX_ATTEMPTS + 2; i++) await drain(s);
    expect(await s.outboxStats()).toMatchObject({ pending: 1, dead: 0 });
    expect((await s.outboxRows())[0]?.attempts).toBe(MAX_OUTBOX_ATTEMPTS + 2);

    await s.addRows(["g1"]);
    await drain(s);
    expect((await s.sentBodies()).map((r) => r.id)).toEqual(["g1"]);
    // p1 is dead-lettered at its next failure, now that something else has been sent.
    await drainUntil(s, async () => (await s.outboxStats()).dead === 1, 3);
    expect(await s.outboxStats()).toMatchObject({ pending: 0, dead: 1 });
  });

  it("doesn't hold back new rows behind a failing row", async () => {
    const s = stub();
    await s.addRows(["p1"]);
    for (let i = 0; i < 6; i++) await drain(s); // p1 is now backing off for a while
    const before = Date.now();
    await s.addRows(["g1"]);
    const g1 = (await s.outboxRows()).find((r) => r.id === "g1");
    expect(g1?.next_attempt_at).toBeLessThanOrEqual(before + 1000);
    expect(await s.alarmTime()).toBeLessThanOrEqual(before + 1000);
  });

  it("a flapping queue dead-letters a good row only after a later success and 10 failures", async () => {
    const s = stub();
    // g1 fails each time (as if the queue flapped whenever it was sent), but nothing else succeeds.
    await s.meta("fail_ids", "g1");
    await s.addRows(["g1"]);
    for (let i = 0; i < MAX_OUTBOX_ATTEMPTS + 2; i++) await drain(s);
    expect(await s.outboxStats()).toMatchObject({ pending: 1, dead: 0 });
    // Once another row has been sent, g1's next failure dead-letters it (accepted, documented).
    await s.addRows(["h1"]);
    await drainUntil(s, async () => (await s.outboxStats()).dead === 1, 3);
    expect(await s.outboxStats()).toMatchObject({ pending: 0, dead: 1 });
    // Had the queue recovered for g1 instead, it would have been sent.
    await s.meta("fail_ids", "");
    await s.addRows(["g2"]);
    await drain(s);
    expect((await s.sentBodies()).map((r) => r.id)).toEqual(["h1", "g2"]);
  });

  it("stops a drain at its send budget", async () => {
    const s = stub();
    await s.meta("max_sends", "3");
    await s.meta("outbox_fail", "1");
    await s.addItems("b", 50);
    const report = await drain(s);
    expect(report).toMatchObject({ sends: 3, sentRows: 0, stoppedEarly: true });
    // Untried rows were pushed back by the stream backoff, not left due.
    expect((await s.outboxRows()).every((r) => r.next_attempt_at > Date.now())).toBe(true);
  });

  it("stops a drain at its wall-clock limit", async () => {
    const s = stub();
    await s.meta("send_delay_ms", "30");
    await s.meta("max_drain_ms", "10");
    await s.addItems("w", 300); // three chunks
    const report = await drain(s);
    expect(report).toMatchObject({ sends: 1, sentRows: 100, stoppedEarly: true });
    expect((await s.outboxStats()).pending).toBe(200);
  });

  // Order after failures isn't kept (rows retry on their own jittered backoff); see outbox.ts.
  it("delivers every row after the queue recovers", async () => {
    const s = stub();
    await s.meta("outbox_fail", "1");
    for (const id of ["x1", "x2", "x3"]) await s.addItem(id, id);
    await drain(s);
    await s.meta("outbox_fail", "0");
    await drainUntil(s, async () => (await s.outboxStats()).pending === 0, 5);
    expect((await s.sentBodies()).map((r) => r.id).sort()).toEqual(["x1", "x2", "x3"]);
  });

  it("never moves a row earlier than its own longer backoff", async () => {
    const s = stub();
    await s.meta("outbox_fail", "1");
    await s.addRows(["late", "now"]);
    const farFuture = Date.now() + 60 * 60_000;
    await runInDurableObject(s, (_i: TestObject, state) =>
      state.storage.sql.exec("UPDATE core_outbox SET next_attempt_at = ? WHERE body LIKE '%\"late\"%'", farFuture),
    );
    await s.rewind(1000);
    await runDurableObjectAlarm(s);
    expect((await s.outboxRows()).find((r) => r.id === "late")?.next_attempt_at).toBe(farFuture - 1000);
  });

  it("runs one drain at a time", async () => {
    const s = stub();
    await s.meta("send_timeout_ms", "10000"); // longer than this test needs, so the timeout can't race it
    await s.meta("outbox_hang", "1");
    await s.addItem("h1", "h");
    await s.rewind(10 * 60_000);
    const first = s.drainNow();
    // Wait until the first drain is inside its (held) send.
    for (let i = 0; i < 400 && (await s.outboxStats()).sendCalls === 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect((await s.outboxStats()).sendCalls).toBe(1);
    const second = await s.drainNow();
    expect(second).toBeGreaterThan(Date.now()); // asked to be retried; did nothing
    expect((await s.outboxStats()).sendCalls).toBe(1);
    await s.meta("outbox_hang", "0"); // release the first drain's send
    await first;
    expect((await s.sentBodies()).map((r) => r.id)).toEqual(["h1"]);
    expect((await s.outboxStats()).sendCalls).toBe(1);
  });

  it("treats a send that times out as a failure", async () => {
    const s = stub();
    await s.meta("send_timeout_ms", "50");
    await s.meta("outbox_hang", "1");
    await s.addItem("t1", "t");
    await s.rewind(10 * 60_000);
    await s.drainNow();
    expect(await s.sentBodies()).toEqual([]);
    expect((await s.outboxRows())[0]?.attempts).toBe(1);
    await s.meta("outbox_hang", "0");
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

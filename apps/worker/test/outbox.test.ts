import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  chunkRows,
  MAX_OUTBOX_BATCH_BYTES,
  DEFAULT_MAX_SENDS_PER_DRAIN,
  MAX_OUTBOX_STRIKES,
  MAX_OUTBOX_BATCH_MESSAGES,
  MAX_OUTBOX_MESSAGE_BYTES,
} from "../src/core/do/outbox";
import type { TestObject } from "./fixtures/test-object";

/**
 * Measured drains before the first dead-letter when every other send fails, the gap is off and
 * fresh traffic arrives every drain: none within 120 drains (20 simulated hours), because good rows
 * are sent by the successful half of the sends long before they collect 10 strikes.
 */
const FLIP_DRAINS_TO_FIRST_DEAD: number | null = null;

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
    expect(row?.strikes).toBe(0); // nothing succeeded after the failure
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
  /** Lets time pass until the drain timer, then runs the drain the runtime would run. */
  const drain = async (s: Stub) => {
    await s.advanceToNextRetry();
    await runDurableObjectAlarm(s);
    return s.lastDrain();
  };
  /** Lets enough time pass that every row is due (beyond the longest backoff), then drains. */
  const drainAll = async (s: Stub) => {
    await s.rewind(10 * 60_000);
    await runDurableObjectAlarm(s);
    return s.lastDrain();
  };
  const drainUntil = async (s: Stub, done: () => Promise<boolean>, maxDrains: number) => {
    const sends: number[] = [];
    for (let i = 0; i < maxDrains && !(await done()); i++) sends.push((await drain(s))?.sends ?? 0);
    return sends;
  };
  // Only the test runs drains (the real alarm is parked), so every check sees one drain.
  const manual = async () => {
    const s = stub();
    await s.meta("manual_alarms", "1");
    return s;
  };

  it("isolates a poison row by bisecting, sending the rest of the chunk", async () => {
    const s = await manual();
    await s.addRows(["g1", "g2", "p1", "g3", "g4", "g5"]);
    const report = await drain(s);
    expect((await s.sentBodies()).map((r) => r.id).sort()).toEqual(["g1", "g2", "g3", "g4", "g5"]);
    expect((await s.outboxRows()).map((r) => [r.id, r.attempts, r.strikes])).toEqual([["p1", 1, 1]]);
    expect(report).toMatchObject({ sends: 5, sentRows: 5, failedRows: 1 });
  });

  it("sends the good rows behind poison rows at both ends, and dead-letters the poison with traffic", async () => {
    const s = await manual();
    await s.addRows(["p1", "p2", "p3", "g1", "g2", "pz"]);
    const first = await drainAll(s);
    expect((await s.sentBodies()).map((r) => r.id).sort()).toEqual(["g1", "g2"]);
    const sends = [first?.sends ?? 0];
    // Periodic good traffic, 10 minutes apart: the poison rows are tested first and the fresh row's
    // success after them earns each a strike.
    for (let i = 0; i < 20 && (await s.outboxStats()).dead < 4; i++) {
      await s.addRows([`t${i}`]);
      sends.push((await drainAll(s))?.sends ?? 0);
    }
    expect(await s.outboxStats()).toMatchObject({ pending: 0, dead: 4 });
    // pz earned a strike in the first drain; p1-p3 failed after the only success there.
    expect(sends.length).toBe(MAX_OUTBOX_STRIKES + 1);
    expect(Math.max(...sends)).toBeLessThanOrEqual(DEFAULT_MAX_SENDS_PER_DRAIN);
  });

  it("sends every good row from a long alternating run of poison and good rows, within budget", async () => {
    const s = await manual();
    const ids = Array.from({ length: 600 }, (_, i) => `${i % 2 === 0 ? "p" : "g"}${String(i).padStart(3, "0")}`);
    await s.addRows(ids);
    const sends: number[] = [];
    for (let i = 0; i < 400 && (await s.sentBodies()).length < 300; i++) sends.push((await drainAll(s))?.sends ?? 0);
    expect((await s.sentBodies()).length).toBe(300);
    expect(Math.max(...sends)).toBeLessThanOrEqual(DEFAULT_MAX_SENDS_PER_DRAIN);
    // Good rows are never blamed for the bad rows they shared batches with.
    expect((await s.outboxRows()).every((r) => r.id.startsWith("p"))).toBe(true);
  });

  for (const poisonCount of [150, 700]) {
    it(`gets a new good row past ${poisonCount} poison rows without waiting for them`, async () => {
      const s = await manual();
      await s.addRows(Array.from({ length: poisonCount }, (_, i) => `p${i}`));
      // The poison rows fail (or are pushed back) for a while...
      for (let i = 0; i < 3; i++) await drainAll(s);
      // ...then a good row arrives; rows that never failed go first.
      await s.addRows(["g-new"]);
      let drains = 0;
      while (drains < 50 && !(await s.sentBodies()).some((r) => r.id === "g-new")) {
        drains += 1;
        await drainAll(s);
      }
      // Rows that have already failed go behind it. Rows never tried yet are ordinary pending rows
      // and keep their place (FIFO), at about one chunk of them per drain. Measured: 1 drain behind
      // 150 rows, 5 behind 700 (400 of them never tried in the three earlier drains).
      expect(drains).toBeLessThanOrEqual(Math.ceil(poisonCount / 100));
    });
  }

  it("never dead-letters rows during a long outage, stays within budget and doesn't spin", async () => {
    const s = await manual();
    await s.meta("outbox_fail", "1");
    await s.addItems("o", 150);
    const sends: number[] = [];
    // Keep draining until some rows have failed more often than the strike limit.
    for (let i = 0; i < 150 && (await s.outboxStats()).maxAttempts < MAX_OUTBOX_STRIKES + 2; i++) {
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
    const stats = await s.outboxStats();
    expect(stats).toMatchObject({ pending: 150, dead: 0, maxStrikes: 0 });
    expect(stats.maxAttempts).toBeGreaterThanOrEqual(MAX_OUTBOX_STRIKES);
    expect(Math.max(...sends)).toBeLessThanOrEqual(DEFAULT_MAX_SENDS_PER_DRAIN);

    await s.meta("outbox_fail", "0");
    await drainUntil(s, async () => (await s.outboxStats()).pending === 0, 20);
    expect(await s.outboxStats()).toMatchObject({ pending: 0, dead: 0, streamBackoff: 0 });
    expect((await s.sentBodies()).length).toBe(150);
  });

  it("adds no strikes when the queue goes down right after a success", async () => {
    const s = await manual();
    await s.addItems("m", 300); // three chunks
    // The first send goes through, every later one fails.
    await s.meta("outbox_fail_after", String((await s.outboxStats()).sendCalls + 1));
    for (let i = 0; i < 25; i++) await drainAll(s);
    const stats = await s.outboxStats();
    expect(stats).toMatchObject({ pending: 200, dead: 0, successSeq: 1, maxStrikes: 0 });
    expect(stats.maxAttempts).toBeGreaterThanOrEqual(MAX_OUTBOX_STRIKES);

    await s.meta("outbox_fail_after", "-1");
    await drainUntil(s, async () => (await s.outboxStats()).pending === 0, 20);
    expect(await s.outboxStats()).toMatchObject({ pending: 0, dead: 0 });
    expect((await s.sentBodies()).length).toBe(300);
  });

  it("counts a strike for failures followed by a success in the same drain, then none in an outage", async () => {
    const s = await manual();
    // x1 and x2 fail on their own; the fresh rows are sent after them in the same drain.
    await s.meta("fail_ids", "x1,x2");
    await s.addRows(["x1", "x2"]);
    await drainAll(s); // nothing else to send: no strike
    expect((await s.outboxRows()).map((r) => r.strikes)).toEqual([0, 0]);
    await s.addRows(["f1", "f2", "f3"]);
    await drainAll(s); // x1, x2 fail first, then f1-f3 succeed: one strike each
    expect((await s.outboxRows()).map((r) => [r.id, r.strikes])).toEqual([
      ["x1", 1],
      ["x2", 1],
    ]);
    // Then a long outage, with fresh rows still arriving: no more strikes.
    await s.meta("outbox_fail", "1");
    for (let i = 0; i < 20; i++) {
      await s.addRows([`o${i}`]);
      await drainAll(s);
    }
    const rows = await s.outboxRows();
    expect(rows.filter((r) => r.id.startsWith("x")).map((r) => r.strikes)).toEqual([1, 1]);
    expect((await s.outboxStats()).dead).toBe(0);
  });

  it("doesn't dead-letter good rows when each drain has one success and then fails (big rows)", async () => {
    const s = await manual();
    await s.meta("strike_gap_ms", "0"); // even without the gap
    await s.addBigRows("b", 60, 100_000); // two rows per chunk
    for (let i = 0; i < 25; i++) {
      await s.meta("outbox_fail_after", String((await s.outboxStats()).sendCalls + 1));
      await drainAll(s); // 10 minutes later each time
    }
    const stats = await s.outboxStats();
    expect(stats.dead).toBe(0);
    expect(stats.maxStrikes).toBe(0);
    expect(stats.pending + (await s.sentBodies()).length).toBe(60);
  });

  it("a queue alternating success and failure per send: no dead-letter in 120 drains without the gap, none within 90 minutes with it", async () => {
    // Big rows (two per chunk), and fresh traffic every drain, so sends keep alternating.
    const noGap = await manual();
    await noGap.meta("strike_gap_ms", "0");
    await noGap.meta("flip", "1");
    let drains = 0;
    let firstDead: number | null = null;
    while (drains < 120 && firstDead === null) {
      drains += 1;
      await noGap.addBigRows(`a${drains}-`, 4, 100_000);
      await drainAll(noGap);
      if ((await noGap.outboxStats()).dead > 0) firstDead = drains;
    }
    expect(firstDead).toBe(FLIP_DRAINS_TO_FIRST_DEAD);
    if (firstDead !== null) expect(firstDead).toBeGreaterThanOrEqual(MAX_OUTBOX_STRIKES);

    const withGap = await manual();
    await withGap.meta("flip", "1");
    for (let minute = 0; minute < 89; minute++) {
      await withGap.addBigRows(`b${minute}-`, 4, 100_000);
      await withGap.rewind(60_000); // one simulated minute per step
      await runDurableObjectAlarm(withGap);
    }
    expect((await withGap.outboxStats()).dead).toBe(0);
    expect((await withGap.outboxStats()).maxStrikes).toBeLessThanOrEqual(9);
  });

  it("doesn't dead-letter after an outage beyond 10 attempts, one success, then more failures", async () => {
    const s = await manual();
    await s.meta("outbox_fail", "1");
    await s.addItems("q", 20);
    for (let i = 0; i < 15; i++) await drainAll(s);
    expect((await s.outboxStats()).maxAttempts).toBeGreaterThanOrEqual(MAX_OUTBOX_STRIKES);
    // The queue comes back for exactly one send, then fails again for a long time.
    await s.meta("outbox_fail", "0");
    await s.meta("outbox_fail_after", String((await s.outboxStats()).sendCalls + 1));
    for (let i = 0; i < 15; i++) await drainAll(s);
    const stats = await s.outboxStats();
    expect(stats.dead).toBe(0);
    expect(stats.maxStrikes).toBe(0);
    expect(stats.pending + (await s.sentBodies()).length).toBe(20);
  });

  it("doesn't dead-letter a row written before strikes existed on its first counted failure", async () => {
    const s = await manual();
    await s.addRows(["g0"]);
    await drainAll(s); // the stream has a success
    await s.addRows(["p-legacy"]);
    // As left by an older release: many attempts, no strike data.
    await runInDurableObject(s, (_i: TestObject, state) =>
      state.storage.sql.exec("UPDATE core_outbox SET attempts = 15, strikes = 0, last_strike_at = NULL"),
    );
    await s.addRows(["g1"]);
    await drainAll(s);
    expect(await s.outboxStats()).toMatchObject({ pending: 1, dead: 0 });
    expect((await s.outboxRows())[0]).toMatchObject({ id: "p-legacy", attempts: 16, strikes: 1 });
  });

  it("the strike gap is what protects a lone good row from a queue that flips on every send", async () => {
    // g1 fails whenever it is sent; every fresh row sent after it in the same drain succeeds, as if
    // the queue flipped between them. Simulated time steps one minute per drain.
    const run = async (gapMs: string) => {
      const s = await manual();
      await s.meta("strike_gap_ms", gapMs);
      await s.meta("fail_ids", "g1");
      await s.addRows(["g1"]);
      await drainAll(s); // g1 has failed before now, so it rides along
      for (let minute = 1; minute <= 30; minute++) {
        await s.addRows([`f${minute}`]);
        await s.rewind(60_000);
        await runDurableObjectAlarm(s);
        if ((await s.outboxStats()).dead > 0) return { deadAtMinute: minute, strikes: MAX_OUTBOX_STRIKES };
      }
      return { deadAtMinute: null, strikes: (await s.outboxRows()).find((r) => r.id === "g1")?.strikes ?? -1 };
    };
    // A 1-minute gap: one strike per minute, dead-lettered at the 10th.
    expect(await run("60000")).toEqual({ deadAtMinute: MAX_OUTBOX_STRIKES, strikes: MAX_OUTBOX_STRIKES });
    // The 10-minute default over the same 30 minutes: strikes at minutes 1, 11 and 21 only.
    expect(await run("600000")).toEqual({ deadAtMinute: null, strikes: 3 });
  });

  it("lets nothing ride along while the stream is in backoff, so rows that aren't due keep it", async () => {
    const s = await manual();
    await s.meta("outbox_fail", "1");
    await s.addRows(["r1", "r2", "r3", "r4", "r5", "r6"]);
    for (let i = 0; i < 3; i++) await drainAll(s); // all six have failed; the stream is in backoff
    const sends: number[] = [];
    for (let i = 0; i < 10; i++) {
      await s.addRows([`n${i}`]);
      await s.advanceToNextRetry(); // up to the fresh row's drain timer only
      const start = Date.now();
      const before = new Map((await s.outboxRows()).map((r) => [r.id, r]));
      await runDurableObjectAlarm(s);
      sends.push((await s.lastDrain())?.sends ?? 0);
      // Rows that weren't due gained no attempts.
      for (const row of await s.outboxRows()) {
        const was = before.get(row.id);
        if (was && was.next_attempt_at > start) expect(row.attempts, row.id).toBe(was.attempts);
      }
    }
    expect(Math.max(...sends)).toBeLessThanOrEqual(2);
    expect((await s.outboxStats()).dead).toBe(0);
  });

  it("never dead-letters a lone poison row with no other traffic", async () => {
    const s = await manual();
    await s.meta("strike_gap_ms", "0");
    await s.addRows(["p1"]);
    for (let i = 0; i < 30; i++) await drainAll(s);
    expect(await s.outboxStats()).toMatchObject({ pending: 1, dead: 0, maxStrikes: 0 });
  });

  it("tests a lone poison row alongside sparse traffic even when it isn't due, and dead-letters it at 10 strikes", async () => {
    const s = await manual();
    await s.meta("strike_gap_ms", "0");
    await s.addRows(["p1"]);
    for (let i = 0; i < 8; i++) await drainAll(s); // long backoff now
    expect((await s.outboxRows())[0]).toMatchObject({ id: "p1", strikes: 0 });
    // One fresh row per drain, while p1 is NOT due. The first fresh row goes out alone: the stream
    // was in backoff (nothing sent for 8 drains), so nothing rides along. From then on p1 rides along
    // and earns a strike each drain.
    await s.addRows(["g0"]);
    await drain(s);
    expect((await s.outboxRows())[0]).toMatchObject({ id: "p1", strikes: 0 });
    for (let i = 1; i <= MAX_OUTBOX_STRIKES; i++) {
      await s.addRows([`g${i}`]);
      const before = Date.now();
      await drain(s); // only up to the fresh row's drain timer
      const p1 = (await s.outboxRows()).find((r) => r.id === "p1");
      if (i < MAX_OUTBOX_STRIKES) {
        expect(p1?.strikes).toBe(i);
        expect(p1?.next_attempt_at).toBeGreaterThan(before); // it wasn't due; it rode along
      }
    }
    expect(await s.outboxStats()).toMatchObject({ pending: 0, dead: 1 });
  });

  it("respects the gap between strikes for a riding-along poison row", async () => {
    const s = await manual(); // production gap: 10 minutes
    await s.addRows(["p1"]);
    await drainAll(s);
    for (let i = 1; i <= 12; i++) {
      await s.addRows([`g${i}`]);
      await drain(s); // seconds apart, not minutes
    }
    expect((await s.outboxRows())[0]).toMatchObject({ id: "p1", strikes: 1 });
    await s.rewind(10 * 60_000);
    await s.addRows(["g-later"]);
    await drain(s);
    expect((await s.outboxRows())[0]).toMatchObject({ id: "p1", strikes: 2 });
  });

  it("doesn't hold back new rows behind a failing row", async () => {
    const s = await manual();
    await s.addRows(["p1"]);
    for (let i = 0; i < 6; i++) await drainAll(s); // p1 is now backing off for a while
    const before = Date.now();
    await s.addRows(["g1"]);
    const g1 = (await s.outboxRows()).find((r) => r.id === "g1");
    expect(g1?.next_attempt_at).toBeLessThanOrEqual(before + 1000);
  });

  it("a flapping queue dead-letters a good row only after 10 strikes, each with a later success", async () => {
    const s = await manual();
    // g1 fails whenever it is sent, as if the queue flapped each time.
    await s.meta("fail_ids", "g1");
    await s.addRows(["g1"]);
    for (let i = 0; i < 5; i++) await drainAll(s); // no success after the failures: no strike
    expect((await s.outboxRows())[0]).toMatchObject({ id: "g1", strikes: 0 });

    for (let i = 1; i <= MAX_OUTBOX_STRIKES; i++) {
      await s.addRows([`h${i}`]);
      await drainAll(s); // g1 fails, then h succeeds after it: one strike (10 minutes apart)
      if (i < MAX_OUTBOX_STRIKES) {
        expect((await s.outboxRows())[0]).toMatchObject({ id: "g1", strikes: i });
        await drainAll(s); // a failure with no success after it: no strike
        expect((await s.outboxRows())[0]).toMatchObject({ id: "g1", strikes: i });
      }
    }
    expect(await s.outboxStats()).toMatchObject({ pending: 0, dead: 1 });
  });

  it("stops a drain at its send budget", async () => {
    const s = await manual();
    await s.meta("max_sends", "3");
    await s.meta("outbox_fail", "1");
    await s.addItems("b", 50);
    const report = await drain(s);
    expect(report).toMatchObject({ sends: 3, sentRows: 0, stoppedEarly: true });
    // Untried rows were pushed back by the stream backoff, not left due.
    expect((await s.outboxRows()).every((r) => r.next_attempt_at > Date.now())).toBe(true);
  });

  it("stops a drain at its wall-clock limit", async () => {
    const s = await manual();
    await s.meta("send_delay_ms", "30");
    await s.meta("max_drain_ms", "10");
    await s.addItems("w", 300); // three chunks
    const report = await drain(s);
    expect(report).toMatchObject({ sends: 1, sentRows: 100, stoppedEarly: true });
    expect((await s.outboxStats()).pending).toBe(200);
  });

  // Order after failures isn't kept (rows retry on their own jittered backoff); see outbox.ts.
  it("delivers every row after the queue recovers", async () => {
    const s = await manual();
    await s.meta("outbox_fail", "1");
    await s.addRows(["x1", "x2", "x3"]);
    await drainAll(s);
    await s.meta("outbox_fail", "0");
    await drainUntil(s, async () => (await s.outboxStats()).pending === 0, 5);
    expect((await s.sentBodies()).map((r) => r.id).sort()).toEqual(["x1", "x2", "x3"]);
  });

  it("never moves a row earlier than its own longer backoff", async () => {
    const s = await manual();
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

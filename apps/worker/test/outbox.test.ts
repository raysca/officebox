import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  chunkRows,
  MAX_OUTBOX_BATCH_BYTES,
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

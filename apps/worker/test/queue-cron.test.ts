import { defineMessage } from "@officebox/shared";
import { createExecutionContext, createMessageBatch, createScheduledController, getQueueResult } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import worker from "../src/index";
import { createCronDispatcher, defineJob } from "../src/core/cron";
import { createLogger } from "../src/core/log";
import { ACK, createQueueConsumer, defineQueueHandler, retryDelaySeconds } from "../src/core/queue";

const quiet = createLogger({}, () => {});

/** A fake dead-letter queue recording what it receives. */
function fakeQueue(fail = false) {
  const sent: unknown[] = [];
  const queue = {
    send: (body: unknown) => {
      if (fail) return Promise.reject(new Error("dlq down"));
      sent.push(body);
      return Promise.resolve();
    },
  } as unknown as Queue;
  return { queue, sent };
}

const greet = defineMessage("test.greet", { name: z.string().min(1) });
const flaky = defineMessage("test.flaky", { mode: z.enum(["throw", "retry", "dead"]) });

function setup(dlqFails = false) {
  const handled: string[] = [];
  const dlq = fakeQueue(dlqFails);
  const consume = createQueueConsumer(
    {
      queues: [
        {
          queue: "test-queue",
          deadLetter: () => dlq.queue,
          handlers: [
            defineQueueHandler({
              schema: greet,
              handle: (message, ctx) => {
                handled.push(`${message.name}@${ctx.attempts}`);
                return Promise.resolve(ACK);
              },
            }),
            defineQueueHandler({
              schema: flaky,
              handle: (message) => {
                if (message.mode === "throw") return Promise.reject(new Error("boom"));
                if (message.mode === "retry") return Promise.resolve({ kind: "retry", delaySeconds: 30 } as const);
                return Promise.resolve({ kind: "dead_letter", reason: "permanent" } as const);
              },
            }),
          ],
        },
      ],
    },
    quiet,
  );
  return { consume, handled, dlq };
}

const T0 = 1_790_000_000_000;
const msg = (id: string, body: unknown, attempts = 1) => ({ id, timestamp: T0, attempts, body });
const wrapped = (original: unknown, reason: string, attempts = 1) => ({
  original,
  reason,
  queue: "test-queue",
  attempts,
  firstSeenAt: T0,
});

describe("queue consumer", () => {
  it("validates and dispatches by type, acking each message", async () => {
    const { consume, handled } = setup();
    const batch = createMessageBatch("test-queue", [
      msg("m1", { type: "test.greet", name: "a" }),
      msg("m2", { type: "test.greet", name: "b" }, 3),
    ]);
    const ctx = createExecutionContext();
    await consume(batch, env, ctx);
    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks.sort()).toEqual(["m1", "m2"]);
    expect(result.retryMessages).toEqual([]);
    expect(handled).toEqual(["a@1", "b@3"]);
  });

  it("sends unknown and invalid messages to the dead-letter queue instead of retrying", async () => {
    const { consume, handled, dlq } = setup();
    const unknown = { type: "test.nobody", x: 1 };
    const invalid = { type: "test.greet", name: "" };
    const garbage = "not an envelope";
    const batch = createMessageBatch("test-queue", [msg("u", unknown), msg("i", invalid), msg("g", garbage)]);
    const ctx = createExecutionContext();
    await consume(batch, env, ctx);
    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks.sort()).toEqual(["g", "i", "u"]);
    expect(result.retryMessages).toEqual([]);
    expect(dlq.sent).toEqual([
      wrapped(unknown, "unknown_type"),
      wrapped(invalid, "invalid_payload"),
      wrapped(garbage, "invalid_envelope"),
    ]);
    expect(handled).toEqual([]);
  });

  it("retries thrown failures with exponential backoff and honours handler outcomes", async () => {
    const { consume, dlq } = setup();
    const batch = createMessageBatch("test-queue", [
      msg("t", { type: "test.flaky", mode: "throw" }, 3),
      msg("r", { type: "test.flaky", mode: "retry" }),
      msg("d", { type: "test.flaky", mode: "dead" }),
    ]);
    const ctx = createExecutionContext();
    await consume(batch, env, ctx);
    const result = await getQueueResult(batch, ctx);
    expect(result.retryMessages.map((m) => m.msgId)).toEqual(["t", "r"]);
    expect(result.explicitAcks).toEqual(["d"]);
    expect(dlq.sent).toEqual([wrapped({ type: "test.flaky", mode: "dead" }, "permanent")]);
  });

  it("passes the retry delay: exponential for failures, the handler's own otherwise", async () => {
    // getQueueResult doesn't report delays, so record them from hand-made messages.
    const { consume } = setup();
    const delays: Record<string, number | undefined> = {};
    const fake = (id: string, body: unknown, attempts: number) => ({
      id,
      timestamp: new Date(),
      attempts,
      body,
      ack: () => {},
      retry: (options?: QueueRetryOptions) => {
        delays[id] = options?.delaySeconds;
      },
    });
    const batch = {
      queue: "test-queue",
      messages: [
        fake("t", { type: "test.flaky", mode: "throw" }, 3),
        fake("r", { type: "test.flaky", mode: "retry" }, 1),
      ],
      ackAll: () => {},
      retryAll: () => {},
    } as unknown as MessageBatch;
    await consume(batch, env);
    expect(delays).toEqual({ t: retryDelaySeconds(3), r: 30 });
    expect([1, 2, 3, 10].map(retryDelaySeconds)).toEqual([10, 20, 40, 900]);
  });

  it("retries when the dead-letter queue itself is unavailable", async () => {
    const { consume } = setup(true);
    const batch = createMessageBatch("test-queue", [msg("x", { type: "test.nobody" })]);
    const ctx = createExecutionContext();
    await consume(batch, env, ctx);
    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks).toEqual([]);
    expect(result.retryMessages.map((m) => m.msgId)).toEqual(["x"]);
  });

  it("retries a whole batch from a queue with no registered consumer", async () => {
    const { consume } = setup();
    const batch = createMessageBatch("other-queue", [msg("o", { type: "test.greet", name: "a" })]);
    const ctx = createExecutionContext();
    await consume(batch, env, ctx);
    expect((await getQueueResult(batch, ctx)).retryBatch.retry).toBe(true);
  });

  it("the Worker's email queue sends messages it has no handler for to its DLQ", async () => {
    const batch = createMessageBatch("officebox-email", [msg("e1", { type: "email.send", to: "x" })]);
    const ctx = createExecutionContext();
    await worker.queue(batch, env, ctx);
    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks).toEqual(["e1"]);
  });
});

describe("cron dispatcher", () => {
  it("maps each trigger to its schedule and runs that schedule's jobs, isolating failures", async () => {
    const ran: string[] = [];
    const dispatch = createCronDispatcher(
      [
        defineJob({ name: "test.five", schedule: "five_minutes", run: () => (ran.push("five"), Promise.resolve()) }),
        defineJob({ name: "test.failing", schedule: "hourly", run: () => Promise.reject(new Error("boom")) }),
        defineJob({ name: "test.hourly", schedule: "hourly", run: () => (ran.push("hourly"), Promise.resolve()) }),
        defineJob({
          name: "test.daily",
          schedule: "daily",
          run: (ctx) => (ran.push(`daily@${ctx.scheduledTime}`), Promise.resolve()),
        }),
      ],
      quiet,
    );

    const hourly = await dispatch(createScheduledController({ cron: "0 * * * *" }), env);
    expect(hourly.schedule).toBe("hourly");
    expect(hourly.jobs.map((j) => [j.name, j.ok])).toEqual([
      ["test.failing", false],
      ["test.hourly", true],
    ]);
    expect(hourly.jobs.every((j) => j.durationMs >= 0)).toBe(true);

    await dispatch(createScheduledController({ cron: "*/5 * * * *" }), env);
    await dispatch(createScheduledController({ cron: "17 3 * * *", scheduledTime: 1234 }), env);
    expect(ran).toEqual(["hourly", "five", "daily@1234"]);

    const unknown = await dispatch(createScheduledController({ cron: "1 1 1 1 1" }), env);
    expect(unknown).toEqual({ cron: "1 1 1 1 1", schedule: null, jobs: [] });
  });

  it("times out a job that runs too long and still runs the next", async () => {
    const ran: string[] = [];
    const dispatch = createCronDispatcher(
      [
        defineJob({ name: "test.hangs", schedule: "hourly", timeoutMs: 30, run: () => new Promise<void>(() => {}) }),
        defineJob({ name: "test.after", schedule: "hourly", run: () => (ran.push("after"), Promise.resolve()) }),
      ],
      quiet,
    );
    const report = await dispatch(createScheduledController({ cron: "0 * * * *" }), env);
    expect(report.jobs.map((j) => [j.name, j.ok, j.timedOut ?? false])).toEqual([
      ["test.hangs", false, true],
      ["test.after", true, false],
    ]);
    expect(ran).toEqual(["after"]);
  });

  it("skips a trigger while the previous run of the same schedule holds the lease", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const runs: string[] = [];
    const dispatch = createCronDispatcher(
      [defineJob({ name: "test.slow", schedule: "five_minutes", run: () => (runs.push("slow"), gate) })],
      quiet,
    );
    const first = dispatch(createScheduledController({ cron: "*/5 * * * *" }), env);
    await new Promise((r) => setTimeout(r, 50));
    const second = await dispatch(createScheduledController({ cron: "*/5 * * * *" }), env);
    expect(second).toMatchObject({ skipped: true, jobs: [] });
    release();
    expect((await first).jobs.map((j) => j.ok)).toEqual([true]);
    // Released: the next trigger runs.
    expect((await dispatch(createScheduledController({ cron: "*/5 * * * *" }), env)).skipped).toBeUndefined();
    expect(runs).toEqual(["slow", "slow"]);
  });

  it("takes over an expired lease", async () => {
    await env.DB.prepare(
      "INSERT OR REPLACE INTO cron_leases (schedule, holder, expires_at) VALUES ('daily', 'crashed', ?)",
    )
      .bind(Date.now() - 1)
      .run();
    const dispatch = createCronDispatcher([], quiet);
    expect((await dispatch(createScheduledController({ cron: "17 3 * * *" }), env)).skipped).toBeUndefined();
  });

  it("runs unguarded, and logs, when the lease can't be checked", async () => {
    const ran: string[] = [];
    const lines: string[] = [];
    const brokenDb = {
      prepare: () => {
        throw new Error("no such table: cron_leases");
      },
    } as unknown as D1Database;
    const dispatch = createCronDispatcher(
      [defineJob({ name: "test.unguarded", schedule: "hourly", run: () => (ran.push("ran"), Promise.resolve()) })],
      createLogger({}, (_l, line) => lines.push(line)),
    );
    const report = await dispatch(createScheduledController({ cron: "0 * * * *" }), { ...env, DB: brokenDb });
    expect(report.jobs.map((j) => j.ok)).toEqual([true]);
    expect(ran).toEqual(["ran"]);
    expect(lines.join("\n")).toContain("running unguarded");
  });

  it("keeps the report when releasing the lease fails", async () => {
    const lines: string[] = [];
    const releaseFails = {
      prepare: (sql: string) => {
        if (sql.startsWith("DELETE FROM cron_leases")) throw new Error("D1 went away");
        return env.DB.prepare(sql);
      },
    } as unknown as D1Database;
    const dispatch = createCronDispatcher(
      [defineJob({ name: "test.release", schedule: "hourly", run: () => Promise.resolve() })],
      createLogger({}, (_l, line) => lines.push(line)),
    );
    const report = await dispatch(createScheduledController({ cron: "0 * * * *" }), { ...env, DB: releaseFails });
    expect(report.jobs.map((j) => [j.name, j.ok])).toEqual([["test.release", true]]);
    expect(lines.join("\n")).toContain("could not release the cron lease");
    // Clean up the lease the failed release left behind, for later tests in this file.
    await env.DB.prepare("DELETE FROM cron_leases WHERE schedule = 'hourly'").run();
  });

  it("refuses job timeouts that add up to more than the lease", () => {
    const long = (name: string) =>
      defineJob({ name, schedule: "daily", timeoutMs: 8 * 60_000, run: () => Promise.resolve() });
    expect(() => createCronDispatcher([long("test.a"), long("test.b")])).toThrow(/beyond/);
  });

  it("refuses duplicate or malformed job names", () => {
    const job = defineJob({ name: "test.same", schedule: "daily", run: () => Promise.resolve() });
    expect(() => createCronDispatcher([job, job])).toThrow(/twice/);
    expect(() => defineJob({ name: "nodot", schedule: "daily", run: () => Promise.resolve() })).toThrow();
  });

  it("the Worker's triggers all run their core jobs", async () => {
    for (const cron of ["*/5 * * * *", "0 * * * *", "17 3 * * *"]) {
      await expect(worker.scheduled(createScheduledController({ cron }), env)).resolves.toBeUndefined();
    }
  });
});

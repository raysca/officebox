import type { Env } from "../env";
import type { CoreContext } from "./context";
import { ulid } from "./ids";
import { rootLogger, type Logger } from "./log";

/**
 * Cron dispatcher (TDD §7.8). Three Cron Triggers in wrangler.jsonc map to three schedules; each
 * schedule runs the named jobs registered for it.
 *
 * - **Error isolation:** a job that throws or exceeds its timeout (60 s by default) is logged with its
 *   duration and the next job still runs. A timed-out job's promise is abandoned, not cancelled, so
 *   jobs should do their work in bounded steps.
 * - Jobs run **one after another**, in registration order, so they never compete for D1.
 * - **Overlap guard:** each run takes a lease on its schedule in D1 (`cron_leases`). If the previous
 *   run of the same schedule still holds it (for example a slow 5-minute run), the new trigger skips.
 *   The lease expires after `LEASE_MS` so a crashed run can't block the schedule for good. The job
 *   timeouts of one schedule must add up to less than `LEASE_MS` (checked at registration), so a
 *   live run never outlasts its lease.
 * - **If the lease can't be checked** (D1 unavailable, or the table not there yet mid-deploy), the
 *   jobs run unguarded and the error is logged **(default)**. Jobs are idempotent, so an occasional
 *   overlap is harmless, while skipping could stall purges and retention for as long as D1 errors.
 *   A failure to release the lease is logged; the lease then simply expires.
 * - A job must be **idempotent**: a trigger can fire twice, or be skipped.
 */

export const SCHEDULES = ["five_minutes", "hourly", "daily"] as const;
export type Schedule = (typeof SCHEDULES)[number];

/** Cron expressions from wrangler.jsonc `triggers.crons`. Keep the two in step. */
export const CRON_SCHEDULES: Readonly<Record<string, Schedule>> = {
  "*/5 * * * *": "five_minutes",
  "0 * * * *": "hourly",
  "17 3 * * *": "daily",
};

export const DEFAULT_JOB_TIMEOUT_MS = 60_000;
/** A scheduled invocation runs for at most 15 minutes, so a lease older than that is abandoned. */
export const LEASE_MS = 15 * 60 * 1000;

export interface JobContext extends CoreContext {
  /** When the trigger was scheduled to fire (epoch ms). */
  scheduledTime: number;
}

export interface CronJob {
  /** Dotted name, `<feature>.<job>`, used in logs. */
  name: string;
  schedule: Schedule;
  run(ctx: JobContext): Promise<void>;
  /** Defaults to `DEFAULT_JOB_TIMEOUT_MS`. */
  timeoutMs?: number;
}

export function defineJob(job: CronJob): CronJob {
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(job.name)) throw new Error(`Invalid job name: ${job.name}`);
  return job;
}

export interface JobReport {
  name: string;
  ok: boolean;
  durationMs: number;
  timedOut?: boolean;
}

export interface DispatchReport {
  cron: string;
  schedule: Schedule | null;
  /** True when the previous run of this schedule still held the lease. */
  skipped?: boolean;
  jobs: JobReport[];
}

class JobTimeout extends Error {}

async function withTimeout(work: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new JobTimeout()), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function acquireLease(db: D1Database, schedule: Schedule, holder: string, now: number): Promise<boolean> {
  const row = await db
    .prepare(
      `INSERT INTO cron_leases (schedule, holder, expires_at) VALUES (?, ?, ?)
       ON CONFLICT (schedule) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at
       WHERE cron_leases.expires_at <= ?
       RETURNING holder`,
    )
    .bind(schedule, holder, now + LEASE_MS, now)
    .first<{ holder: string }>();
  return row?.holder === holder;
}

async function releaseLease(db: D1Database, schedule: Schedule, holder: string): Promise<void> {
  await db.prepare("DELETE FROM cron_leases WHERE schedule = ? AND holder = ?").bind(schedule, holder).run();
}

/** Builds the `scheduled()` export from a list of jobs. */
export function createCronDispatcher(jobs: readonly CronJob[], log: Logger = rootLogger) {
  const names = new Set<string>();
  for (const job of jobs) {
    if (names.has(job.name)) throw new Error(`Job ${job.name} registered twice`);
    names.add(job.name);
  }
  for (const schedule of SCHEDULES) {
    const total = jobs
      .filter((j) => j.schedule === schedule)
      .reduce((sum, j) => sum + (j.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS), 0);
    if (total >= LEASE_MS) {
      throw new Error(`Jobs on the ${schedule} schedule may run for ${total} ms, beyond the ${LEASE_MS} ms lease`);
    }
  }

  return async function scheduled(controller: ScheduledController, env: Env): Promise<DispatchReport> {
    const schedule = CRON_SCHEDULES[controller.cron] ?? null;
    const cronLog = log.child({ cron: controller.cron, schedule });
    if (schedule === null) {
      cronLog.error("cron trigger has no schedule; check wrangler.jsonc triggers");
      return { cron: controller.cron, schedule, jobs: [] };
    }

    const holder = ulid();
    let leased = false;
    try {
      leased = await acquireLease(env.DB, schedule, holder, Date.now());
      if (!leased) {
        cronLog.warn("previous run of this schedule is still going; skipping");
        return { cron: controller.cron, schedule, skipped: true, jobs: [] };
      }
    } catch (error) {
      cronLog.error("could not check the cron lease; running unguarded", { error });
    }

    const reports: JobReport[] = [];
    try {
      for (const job of jobs.filter((j) => j.schedule === schedule)) {
        const jobLog = cronLog.child({ job: job.name });
        const started = Date.now();
        try {
          await withTimeout(
            job.run({ env, log: jobLog, now: Date.now, scheduledTime: controller.scheduledTime }),
            job.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS,
          );
          const durationMs = Date.now() - started;
          jobLog.info("cron job finished", { durationMs });
          reports.push({ name: job.name, ok: true, durationMs });
        } catch (error) {
          const durationMs = Date.now() - started;
          const timedOut = error instanceof JobTimeout;
          jobLog.error(timedOut ? "cron job timed out" : "cron job failed", {
            durationMs,
            error: timedOut ? undefined : error,
          });
          reports.push({ name: job.name, ok: false, durationMs, ...(timedOut ? { timedOut } : {}) });
        }
      }
    } finally {
      if (leased) {
        try {
          await releaseLease(env.DB, schedule, holder);
        } catch (error) {
          cronLog.error("could not release the cron lease; it will expire", { error });
        }
      }
    }
    cronLog.info("cron trigger finished", {
      jobs: reports.length,
      failed: reports.filter((r) => !r.ok).length,
    });
    return { cron: controller.cron, schedule, jobs: reports };
  };
}

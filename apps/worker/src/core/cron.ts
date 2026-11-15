import type { Env } from "../env";
import type { CoreContext } from "./context";
import { rootLogger, type Logger } from "./log";

/**
 * Cron dispatcher (TDD §7.8). Three Cron Triggers in wrangler.jsonc map to three schedules; each
 * schedule runs the named jobs registered for it.
 *
 * Every job runs with its own error isolation: a job that throws is logged with its duration and the
 * next job still runs. Jobs run one after another, in registration order, so they never compete for
 * D1. A job must be idempotent: a trigger can fire twice, or be skipped.
 */

export const SCHEDULES = ["five_minutes", "hourly", "daily"] as const;
export type Schedule = (typeof SCHEDULES)[number];

/** Cron expressions from wrangler.jsonc `triggers.crons`. Keep the two in step. */
export const CRON_SCHEDULES: Readonly<Record<string, Schedule>> = {
  "*/5 * * * *": "five_minutes",
  "0 * * * *": "hourly",
  "17 3 * * *": "daily",
};

export interface JobContext extends CoreContext {
  /** When the trigger was scheduled to fire (epoch ms). */
  scheduledTime: number;
}

export interface CronJob {
  /** Dotted name, `<feature>.<job>`, used in logs. */
  name: string;
  schedule: Schedule;
  run(ctx: JobContext): Promise<void>;
}

export function defineJob(job: CronJob): CronJob {
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(job.name)) throw new Error(`Invalid job name: ${job.name}`);
  return job;
}

export interface JobReport {
  name: string;
  ok: boolean;
  durationMs: number;
}

export interface DispatchReport {
  cron: string;
  schedule: Schedule | null;
  jobs: JobReport[];
}

/** Builds the `scheduled()` export from a list of jobs. */
export function createCronDispatcher(jobs: readonly CronJob[], log: Logger = rootLogger) {
  const names = new Set<string>();
  for (const job of jobs) {
    if (names.has(job.name)) throw new Error(`Job ${job.name} registered twice`);
    names.add(job.name);
  }

  return async function scheduled(controller: ScheduledController, env: Env): Promise<DispatchReport> {
    const schedule = CRON_SCHEDULES[controller.cron] ?? null;
    const cronLog = log.child({ cron: controller.cron, schedule });
    if (schedule === null) {
      cronLog.error("cron trigger has no schedule; check wrangler.jsonc triggers");
      return { cron: controller.cron, schedule, jobs: [] };
    }

    const reports: JobReport[] = [];
    for (const job of jobs.filter((j) => j.schedule === schedule)) {
      const jobLog = cronLog.child({ job: job.name });
      const started = Date.now();
      try {
        await job.run({ env, log: jobLog, now: Date.now, scheduledTime: controller.scheduledTime });
        const durationMs = Date.now() - started;
        jobLog.info("cron job finished", { durationMs });
        reports.push({ name: job.name, ok: true, durationMs });
      } catch (error) {
        const durationMs = Date.now() - started;
        jobLog.error("cron job failed", { durationMs, error });
        reports.push({ name: job.name, ok: false, durationMs });
      }
    }
    cronLog.info("cron trigger finished", {
      jobs: reports.length,
      failed: reports.filter((r) => !r.ok).length,
    });
    return { cron: controller.cron, schedule, jobs: reports };
  };
}

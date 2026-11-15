import { createApp } from "./core/app";
import { createCronDispatcher, type CronJob } from "./core/cron";
import { CORE_JOBS } from "./core/jobs";
import { createQueueConsumer, type QueueRegistry } from "./core/queue";
import type { Env } from "./env";
import { features } from "./features";
import { IDENTITY_JOBS } from "./features/identity/jobs";
import { identityApiMiddleware } from "./features/identity/middleware";

export { SystemObject } from "./system-object";

/** Cron jobs by schedule (TDD §7.8). Features append theirs. */
const JOBS: readonly CronJob[] = [...CORE_JOBS, ...IDENTITY_JOBS];

/**
 * Queues and their typed handlers. The email queue has no handlers until M1, so anything that arrives
 * on it goes to its dead-letter queue.
 */
const QUEUES: QueueRegistry = {
  queues: [{ queue: "officebox-email", deadLetter: (env) => env.EMAIL_DLQ, handlers: [] }],
};

const app = createApp({ features, apiMiddleware: [identityApiMiddleware] });
const dispatchCron = createCronDispatcher(JOBS);
const consumeQueue = createQueueConsumer(QUEUES);

export default {
  fetch: app.fetch,
  async scheduled(controller, env) {
    await dispatchCron(controller, env);
  },
  async queue(batch, env, ctx) {
    await consumeQueue(batch, env, ctx);
  },
} satisfies ExportedHandler<Env>;

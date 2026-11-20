import { createApp } from "./core/app";
import { createCronDispatcher, type CronJob } from "./core/cron";
import { CORE_JOBS } from "./core/jobs";
import { createQueueConsumer, type QueueRegistry } from "./core/queue";
import type { Env } from "./env";
import { features } from "./features";
import { emailQueueHandler } from "./features/email/delivery";
import { IDENTITY_JOBS } from "./features/identity/jobs";
import { identityApiMiddleware } from "./features/identity/middleware";
import { REALTIME_JOBS } from "./features/realtime/jobs";

export { WorkspacePresence } from "./features/realtime/presence-do";
export { UserHub } from "./features/realtime/user-hub-do";
export { SystemObject } from "./system-object";

/** Cron jobs by schedule (TDD §7.8). Features append theirs. */
const JOBS: readonly CronJob[] = [...CORE_JOBS, ...IDENTITY_JOBS, ...REALTIME_JOBS];

/** Queues and their typed handlers. The email queue sends through the configured driver (TDD §7.6). */
const QUEUES: QueueRegistry = {
  queues: [{ queue: "officebox-email", deadLetter: (env) => env.EMAIL_DLQ, handlers: [emailQueueHandler()] }],
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

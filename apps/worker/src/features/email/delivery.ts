import {
  apiError,
  emailSendMessage,
  err,
  ok,
  type ApiError,
  type EmailKind,
  type EmailSendMessage,
  type Result,
} from "@officebox/shared";
import { hashPersonal } from "../../core/audit";
import type { CoreContext } from "../../core/context";
import { Database, expectOk } from "../../core/db";
import { ulid } from "../../core/ids";
import { ACK, defineQueueHandler, type HandlerOutcome, type QueueMessageContext } from "../../core/queue";
import { loadInstallation } from "../identity/installation";
import { defaultDriverDeps, driverFor, loadEmailProvider, type DriverDeps } from "./config";
import type { RenderedEmail } from "./templates";

/**
 * Email delivery (TDD §7.6).
 *
 * **Enqueue** (`enqueueEmail`): a row in `email_deliveries` (job ID, kind, an HMAC of the recipient,
 * state `queued`), then one message on the `email` queue carrying the rendered email. The job ID is the
 * idempotency key. The message body holds the links (it is the email), so it is never logged.
 *
 * **Consume** (`emailQueueHandler`): idempotent by job ID: a job already `sent`, `failed` or `dead` is
 * acked without sending again. Otherwise the configured driver sends it and the outcome is recorded:
 * - `sent`: state `sent`, with the provider's message ID
 * - `permanent` (or email no longer configured): state `failed` with the error code, acked
 * - `transient`: retried with exponential delay (1 minute, doubling, capped at 2 hours), up to **8 tries**;
 *   the 8th failure marks the job `dead` and sends the message to the dead-letter queue.
 */

export const MAX_EMAIL_TRIES = 8;
const FIRST_RETRY_SECONDS = 60;
const MAX_RETRY_SECONDS = 2 * 60 * 60;

/** Delay before try `attempts + 1`, after try `attempts` (1-based) failed: 60 s, 120 s, … capped at 2 h. */
export function emailRetryDelaySeconds(attempts: number): number {
  return Math.min(FIRST_RETRY_SECONDS * 2 ** Math.max(0, attempts - 1), MAX_RETRY_SECONDS);
}

export interface EnqueueInput extends RenderedEmail {
  kind: EmailKind;
  to: string;
  /** When the email's link stops working; the job is never sent or retried after it. */
  expiresAt?: number;
}

/** Queues one email. Returns the job ID, or `unavailable` when the queue refused it. */
export async function enqueueEmail(ctx: CoreContext, input: EnqueueInput): Promise<Result<string, ApiError>> {
  const id = ulid();
  const now = ctx.now();
  const message: EmailSendMessage = {
    type: "email.send",
    jobId: id,
    kind: input.kind,
    to: input.to,
    subject: input.subject,
    text: input.text,
    html: input.html,
    ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
  };
  const parsed = emailSendMessage.safeParse(message);
  if (!parsed.success) {
    ctx.log.error("email message failed its schema; not queued", { kind: input.kind });
    return err(apiError("internal", "The email couldn't be prepared."));
  }
  const database = new Database(ctx.env.DB);
  expectOk(
    await database.run(
      `INSERT INTO email_deliveries (id, kind, recipient_hash, state, attempts, created_at, updated_at)
       VALUES (?, ?, ?, 'queued', 0, ?, ?)`,
      id,
      input.kind,
      await hashPersonal(ctx.env, "email", input.to),
      now,
      now,
    ),
  );
  try {
    await ctx.env.EMAIL_QUEUE.send(parsed.data, { contentType: "json" });
  } catch (error) {
    ctx.log.error("could not queue an email", { kind: input.kind, jobId: id, error });
    await database.run(
      "UPDATE email_deliveries SET state = 'failed', last_error = 'enqueue_failed', updated_at = ? WHERE id = ?",
      ctx.now(),
      id,
    );
    return err(apiError("unavailable", "Email couldn't be queued right now."));
  }
  ctx.log.info("email queued", { kind: input.kind, jobId: id });
  return ok(id);
}

/**
 * Queues an email from work that mustn't hold up (or fail) a response: in the request's `waitUntil`
 * when there is one, otherwise awaited. Failures are logged, never thrown.
 */
export function enqueueInBackground(
  ctx: CoreContext,
  input: EnqueueInput,
  waitUntil: ((promise: Promise<unknown>) => void) | undefined,
): Promise<void> {
  const work = enqueueEmail(ctx, input).then(
    () => undefined,
    (error: unknown) => ctx.log.error("email enqueue failed", { kind: input.kind, error }),
  );
  if (waitUntil) {
    waitUntil(work);
    return Promise.resolve();
  }
  return work;
}

type DeliveryState = "queued" | "sent" | "failed" | "dead";

async function record(
  ctx: CoreContext,
  id: string,
  kind: EmailKind,
  state: DeliveryState,
  fields: { attempts: number; driver?: string | null; messageId?: string | null; error?: string | null },
): Promise<void> {
  try {
    await writeRecord(ctx, id, kind, state, fields);
  } catch (error) {
    // The record is bookkeeping: failing to write it must never change what happens to the message (a
    // thrown error would retry it, resending a sent email or dead-lettering an expired link).
    ctx.log.error("email delivery record wasn't updated", { jobId: id, state, error });
  }
}

async function writeRecord(
  ctx: CoreContext,
  id: string,
  kind: EmailKind,
  state: DeliveryState,
  fields: { attempts: number; driver?: string | null; messageId?: string | null; error?: string | null },
): Promise<void> {
  const now = ctx.now();
  // Upsert: a message whose row is missing (it can't normally be) still gets one.
  expectOk(
    await new Database(ctx.env.DB).run(
      `INSERT INTO email_deliveries (id, kind, recipient_hash, state, attempts, driver, provider_message_id, last_error, created_at, updated_at)
       VALUES (?1, ?2, '', ?3, ?4, ?5, ?6, ?7, ?8, ?8)
       ON CONFLICT (id) DO UPDATE SET state = ?3, attempts = ?4, driver = coalesce(?5, driver),
         provider_message_id = coalesce(?6, provider_message_id), last_error = ?7, updated_at = ?8`,
      id,
      kind,
      state,
      fields.attempts,
      fields.driver ?? null,
      fields.messageId ?? null,
      fields.error ?? null,
      now,
    ),
  );
}

export interface EmailHandlerOptions {
  /** Drivers' I/O; tests pass fakes (a fake driver is a `driverFor` override). */
  deps?: (canonicalOrigin: string | null) => DriverDeps;
  driverFor?: typeof driverFor;
}

/** The `email.send` handler for the `officebox-email` queue. */
export function emailQueueHandler(options: EmailHandlerOptions = {}) {
  const resolveDriver = options.driverFor ?? driverFor;
  const deps = options.deps ?? defaultDriverDeps;
  return defineQueueHandler({
    schema: emailSendMessage,
    async handle(message, ctx: QueueMessageContext): Promise<HandlerOutcome> {
      const log = ctx.log.child({ jobId: message.jobId, kind: message.kind });
      // A link that no longer works isn't worth sending (a magic link after 15 minutes). Checked before
      // any D1 read, so even with D1 down an expired link is acked, never retried into the DLQ.
      if (message.expiresAt !== undefined && ctx.now() >= message.expiresAt) {
        const settled = await new Database(ctx.env.DB)
          .first<{ state: string }>("SELECT state FROM email_deliveries WHERE id = ?", message.jobId)
          .then((r) => (r.ok ? r.value?.state !== undefined && r.value.state !== "queued" : false))
          .catch(() => false);
        if (!settled) {
          log.warn("email's link expired before it could be sent; the job failed");
          await record(ctx, message.jobId, message.kind, "failed", { attempts: ctx.attempts, error: "expired" });
        }
        return ACK;
      }
      const existing = expectOk(
        await new Database(ctx.env.DB).first<{ state: string }>(
          "SELECT state FROM email_deliveries WHERE id = ?",
          message.jobId,
        ),
      );
      if (existing && existing.state !== "queued") {
        log.info("email job already settled; not sending again", { state: existing.state });
        return ACK;
      }
      const provider = await loadEmailProvider(ctx);
      const installation = await loadInstallation(ctx.env.DB);
      const driver = resolveDriver(ctx.env, provider, deps(installation?.canonicalOrigin ?? null));
      if (!driver || provider.driver === "none") {
        log.warn("email isn't configured; the job failed without sending");
        await record(ctx, message.jobId, message.kind, "failed", { attempts: ctx.attempts, error: "not_configured" });
        return ACK;
      }
      const outcome = await driver.send({
        id: message.jobId,
        to: message.to,
        from: { email: provider.from, ...(provider.fromName ? { name: provider.fromName } : {}) },
        subject: message.subject,
        text: message.text,
        html: message.html,
      });
      if (outcome.kind === "sent") {
        // Sent is sent: a failure to record it is logged by record() and never redelivers the email.
        await record(ctx, message.jobId, message.kind, "sent", {
          attempts: ctx.attempts,
          driver: driver.kind,
          messageId: outcome.messageId,
        });
        log.info("email sent", { driver: driver.kind });
        return ACK;
      }
      if (outcome.kind === "permanent") {
        await record(ctx, message.jobId, message.kind, "failed", {
          attempts: ctx.attempts,
          driver: driver.kind,
          error: outcome.code,
        });
        log.warn("email refused permanently", { driver: driver.kind, code: outcome.code });
        return ACK;
      }
      const delaySeconds = emailRetryDelaySeconds(ctx.attempts);
      // Retrying past the link's lifetime would deliver a dead link (or dead-letter a live one): stop.
      if (message.expiresAt !== undefined && ctx.now() + delaySeconds * 1000 >= message.expiresAt) {
        await record(ctx, message.jobId, message.kind, "failed", {
          attempts: ctx.attempts,
          driver: driver.kind,
          error: `expired:${outcome.code}`.slice(0, 120),
        });
        log.warn("email failed for now and its link expires before a retry; the job failed", {
          driver: driver.kind,
          code: outcome.code,
        });
        return ACK;
      }
      if (ctx.attempts >= MAX_EMAIL_TRIES) {
        await record(ctx, message.jobId, message.kind, "dead", {
          attempts: ctx.attempts,
          driver: driver.kind,
          error: outcome.code,
        });
        log.error("email failed after every try; sending it to the dead-letter queue", {
          driver: driver.kind,
          code: outcome.code,
        });
        return { kind: "dead_letter", reason: "email_retries_exhausted" };
      }
      await record(ctx, message.jobId, message.kind, "queued", {
        attempts: ctx.attempts,
        driver: driver.kind,
        error: outcome.code,
      });
      log.info("email failed for now; will retry", { driver: driver.kind, code: outcome.code, delaySeconds });
      return { kind: "retry", delaySeconds };
    },
  });
}

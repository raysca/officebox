import type { EmailSendMessage } from "@officebox/shared";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "../../src/core/log";
import { ulid } from "../../src/core/ids";
import { createQueueConsumer } from "../../src/core/queue";
import {
  emailRetryDelaySeconds,
  emailQueueHandler,
  enqueueEmail,
  MAX_EMAIL_TRIES,
} from "../../src/features/email/delivery";
import type { EmailDriver, OutgoingEmail, SendOutcome } from "../../src/features/email/drivers/types";
import {
  addMember,
  Browser,
  configureEmail,
  outbox,
  setupWorkspace,
  staleFreshAuth,
  type Workspace,
} from "../identity/helpers";

/**
 * Email delivery (TDD §7.6): the queue consumer's retries, permanent failures, dead-lettering and
 * idempotency; Send test email; the email settings. A fake driver records what would be sent.
 */

const quiet = createLogger({}, () => {});

let ws: Workspace;
beforeAll(async () => {
  ws = await setupWorkspace();
});

function fakeDriver(outcomes: SendOutcome[]) {
  const sent: OutgoingEmail[] = [];
  const driver: EmailDriver = {
    kind: "sink",
    send(email) {
      sent.push(email);
      return Promise.resolve(outcomes.shift() ?? { kind: "sent", messageId: "fake-1" });
    },
  };
  return { driver, sent };
}

/** A queued job, as enqueueEmail would make it. */
async function queuedJob(kind: EmailSendMessage["kind"] = "test"): Promise<EmailSendMessage> {
  const before = outbox.messages.length;
  const result = await enqueueEmail(
    { env: { ...env, EMAIL_QUEUE: outbox as unknown as Queue }, log: quiet, now: Date.now },
    { kind, to: "ana@example.com", subject: "Hello", text: "Body", html: "<p>Body</p>" },
  );
  if (!result.ok) throw new Error("enqueue failed");
  expect(outbox.messages.length).toBe(before + 1);
  return outbox.messages[outbox.messages.length - 1]!;
}

const state = (jobId: string) =>
  env.DB.prepare("SELECT state, attempts, driver, provider_message_id, last_error FROM email_deliveries WHERE id = ?")
    .bind(jobId)
    .first<{
      state: string;
      attempts: number;
      driver: string | null;
      provider_message_id: string | null;
      last_error: string | null;
    }>();

function run(message: EmailSendMessage, driver: EmailDriver | null, attempts = 1) {
  const handler = emailQueueHandler({ driverFor: () => driver });
  return handler.handle(message, { env, log: quiet, now: Date.now, attempts, messageId: ulid() });
}

describe("the email queue consumer (TDD §7.6)", () => {
  it("enqueue records the job without the address or content, and queues the rendered email", async () => {
    await configureEmail();
    const message = await queuedJob();
    expect(message).toMatchObject({ type: "email.send", kind: "test", to: "ana@example.com" });
    const row = await env.DB.prepare("SELECT * FROM email_deliveries WHERE id = ?")
      .bind(message.jobId)
      .first<Record<string, unknown>>();
    expect(row).toMatchObject({ kind: "test", state: "queued", attempts: 0 });
    expect(JSON.stringify(row)).not.toContain("ana@example.com");
    expect(JSON.stringify(row)).not.toContain("Hello");
  });

  it("sends through the configured driver with the sender from settings, and marks the job sent", async () => {
    await configureEmail({ driver: "cloudflare", from: "no-reply@officebox.test", fromName: "Acme Studio" });
    const message = await queuedJob();
    const { driver, sent } = fakeDriver([{ kind: "sent", messageId: "pm-42" }]);
    expect(await run(message, driver)).toEqual({ kind: "ack" });
    expect(sent[0]).toMatchObject({
      id: message.jobId,
      to: "ana@example.com",
      from: { email: "no-reply@officebox.test", name: "Acme Studio" },
      subject: "Hello",
    });
    expect(await state(message.jobId)).toMatchObject({ state: "sent", attempts: 1, provider_message_id: "pm-42" });
  });

  it("is idempotent by job ID: a redelivered job that was sent isn't sent again", async () => {
    await configureEmail();
    const message = await queuedJob();
    const { driver, sent } = fakeDriver([]);
    await run(message, driver);
    expect(await run(message, driver, 2)).toEqual({ kind: "ack" });
    expect(sent).toHaveLength(1);
  });

  it("a permanent failure is recorded with the provider's code and not retried", async () => {
    await configureEmail();
    const message = await queuedJob();
    const { driver } = fakeDriver([{ kind: "permanent", code: "E_SENDER_NOT_VERIFIED" }]);
    expect(await run(message, driver)).toEqual({ kind: "ack" });
    expect(await state(message.jobId)).toMatchObject({ state: "failed", last_error: "E_SENDER_NOT_VERIFIED" });
    // Later deliveries of the same job do nothing.
    const again = fakeDriver([]);
    await run(message, again.driver, 2);
    expect(again.sent).toHaveLength(0);
  });

  it("a transient failure is retried with exponential delay (1 minute, doubling, capped at 2 hours)", async () => {
    await configureEmail();
    const message = await queuedJob();
    for (let attempt = 1; attempt < MAX_EMAIL_TRIES; attempt++) {
      const { driver } = fakeDriver([{ kind: "transient", code: "E_RATE_LIMIT_EXCEEDED" }]);
      expect(await run(message, driver, attempt)).toEqual({
        kind: "retry",
        delaySeconds: emailRetryDelaySeconds(attempt),
      });
      expect(await state(message.jobId)).toMatchObject({
        state: "queued",
        attempts: attempt,
        last_error: "E_RATE_LIMIT_EXCEEDED",
      });
    }
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9].map(emailRetryDelaySeconds)).toEqual([
      60, 120, 240, 480, 960, 1920, 3840, 7200, 7200,
    ]);
  });

  it("the 8th failed try marks the job dead and sends it to the dead-letter queue", async () => {
    await configureEmail();
    const message = await queuedJob();
    const { driver } = fakeDriver([{ kind: "transient", code: "network" }]);
    expect(await run(message, driver, MAX_EMAIL_TRIES)).toEqual({
      kind: "dead_letter",
      reason: "email_retries_exhausted",
    });
    expect(await state(message.jobId)).toMatchObject({ state: "dead", attempts: 8, last_error: "network" });
  });

  it("through the consumer framework: retry delays reach the runtime, and exhausted jobs reach the DLQ", async () => {
    await configureEmail();
    const message = await queuedJob();
    const dlq: unknown[] = [];
    const consume = createQueueConsumer(
      {
        queues: [
          {
            queue: "officebox-email",
            deadLetter: () => ({ send: (body: unknown) => Promise.resolve(void dlq.push(body)) }) as unknown as Queue,
            handlers: [
              emailQueueHandler({
                driverFor: () =>
                  fakeDriver([
                    { kind: "transient", code: "http_503" },
                    { kind: "transient", code: "http_503" },
                  ]).driver,
              }),
            ],
          },
        ],
      },
      quiet,
    );
    const delays: (number | undefined)[] = [];
    const acks: string[] = [];
    const delivery = (attempts: number) => ({
      id: `m${attempts}`,
      timestamp: new Date(),
      attempts,
      body: message,
      ack: () => void acks.push(`m${attempts}`),
      retry: (options?: QueueRetryOptions) => void delays.push(options?.delaySeconds),
    });
    await consume(
      {
        queue: "officebox-email",
        messages: [delivery(3)],
        retryAll: () => {},
        ackAll: () => {},
      } as unknown as MessageBatch,
      env,
    );
    expect(delays).toEqual([240]);
    await consume(
      {
        queue: "officebox-email",
        messages: [delivery(8)],
        retryAll: () => {},
        ackAll: () => {},
      } as unknown as MessageBatch,
      env,
    );
    expect(acks).toEqual(["m8"]);
    expect(dlq).toHaveLength(1);
    expect(dlq[0]).toMatchObject({ reason: "email_retries_exhausted", queue: "officebox-email" });
  });

  it("email that's no longer configured fails the job without sending", async () => {
    await configureEmail();
    const message = await queuedJob();
    await configureEmail({ driver: "none" });
    expect(await run(message, null)).toEqual({ kind: "ack" });
    expect(await state(message.jobId)).toMatchObject({ state: "failed", last_error: "not_configured" });
  });

  it("the real driver selection: a provider without its secret isn't configured", async () => {
    const { driverFor, emailStatus } = await import("../../src/features/email/config");
    const deps = {
      fetch: () => Promise.reject(new Error("no")),
      connect: () => {
        throw new Error("no");
      },
      now: Date.now,
      canonicalOrigin: "https://officebox.test",
    };
    const resend = { driver: "resend" as const, from: "no-reply@officebox.test" };
    expect(emailStatus(env, resend)).toEqual({ driver: "resend", configured: false, missing: ["RESEND_API_KEY"] });
    expect(driverFor(env, resend, deps)).toBeNull();
    expect(driverFor({ ...env, RESEND_API_KEY: "re_test" }, resend, deps)?.kind).toBe("resend");
    expect(emailStatus(env, { driver: "ses", from: "a@officebox.test", region: "eu-west-1" }).missing).toEqual([
      "SES_ACCESS_KEY_ID",
      "SES_SECRET_ACCESS_KEY",
    ]);
    expect(emailStatus(env, { driver: "cloudflare", from: "a@officebox.test" }).configured).toBe(true);
    expect(
      emailStatus({ ...env, EMAIL: undefined }, { driver: "cloudflare", from: "a@officebox.test" }).configured,
    ).toBe(false);
    // The e2e sink replaces the driver only on a loopback origin.
    expect(
      driverFor({ ...env, EMAIL_TEST_SINK: "1" }, resend, { ...deps, canonicalOrigin: "https://officebox.test" }),
    ).toBeNull();
    expect(
      driverFor({ ...env, EMAIL_TEST_SINK: "1", RESEND_API_KEY: "k" }, resend, {
        ...deps,
        canonicalOrigin: "http://localhost:8788",
      })?.kind,
    ).toBe("sink");
    expect(driverFor({ ...env, EMAIL_TEST_SINK: "1", RESEND_API_KEY: "k" }, resend, deps)?.kind).toBe("resend");
  });
});

describe("email settings (Platform §7: email_provider is owner-only; no default domain)", () => {
  it("lists settings with who may change each, and the email status (secret names only)", async () => {
    await configureEmail({ driver: "none" });
    const list = await ws.browser.json<{
      settings: { key: string; value: unknown; changeableBy: string; canChange: boolean }[];
      email: unknown;
    }>("/api/admin/settings");
    expect(list.status).toBe(200);
    expect(list.body.settings.find((s) => s.key === "email_provider")).toMatchObject({
      value: { driver: "none" },
      changeableBy: "owner",
      canChange: true,
    });
    expect(list.body.settings.find((s) => s.key === "magic_link_enabled")).toMatchObject({
      value: true,
      changeableBy: "admin",
    });
    expect(list.body.email).toEqual({ driver: "none", configured: false, missing: [] });
  });

  it("an owner sets the driver and sender; it's audited with the address hashed", async () => {
    const patch = await ws.browser.json("/api/admin/settings", {
      method: "PATCH",
      body: { key: "email_provider", value: { driver: "resend", from: "no-reply@officebox.test", fromName: "Acme" } },
    });
    expect(patch.status).toBe(200);
    const list = await ws.browser.json<{ email: { configured: boolean; missing: string[] } }>("/api/admin/settings");
    expect(list.body.email).toEqual({ driver: "resend", configured: false, missing: ["RESEND_API_KEY"] });
    const audit = await env.DB.prepare(
      "SELECT metadata FROM audit_log WHERE action = 'settings.email' ORDER BY created_at DESC",
    ).first<{ metadata: string }>();
    expect(audit!.metadata).not.toContain("no-reply@officebox.test");
    // Invalid values are refused; there is no default sender domain.
    const invalid = await ws.browser.json("/api/admin/settings", {
      method: "PATCH",
      body: { key: "email_provider", value: { driver: "cloudflare" } },
    });
    expect(invalid.status).toBe(400);
    const injection = await ws.browser.json("/api/admin/settings", {
      method: "PATCH",
      body: {
        key: "email_provider",
        value: { driver: "cloudflare", from: "a@officebox.test", fromName: "x\r\nBcc: y" },
      },
    });
    expect(injection.status).toBe(400);
  });

  it("admins can't change the email driver (owner_required) but can change magic links; members can't see settings", async () => {
    const admin = await addMember("admin");
    const refused = await admin.browser.json("/api/admin/settings", {
      method: "PATCH",
      body: { key: "email_provider", value: { driver: "none" } },
    });
    expect(refused.body).toMatchObject({ error: { code: "forbidden", reason: "owner_required" } });
    const list = await admin.browser.json<{ settings: { key: string; canChange: boolean }[] }>("/api/admin/settings");
    expect(list.body.settings.find((s) => s.key === "email_provider")!.canChange).toBe(false);
    const ok = await admin.browser.json("/api/admin/settings", {
      method: "PATCH",
      body: { key: "magic_link_enabled", value: false },
    });
    expect(ok.status).toBe(200);
    await admin.browser.json("/api/admin/settings", {
      method: "PATCH",
      body: { key: "magic_link_enabled", value: true },
    });
    expect(
      (await env.DB.prepare("SELECT count(*) AS n FROM audit_log WHERE action = 'settings.magic_link'").first<{
        n: number;
      }>())!.n,
    ).toBeGreaterThanOrEqual(2);
    const member = await addMember("member");
    expect((await member.browser.json("/api/admin/settings")).status).toBe(403);
    expect(
      (await member.browser.json("/api/admin/settings", { method: "PATCH", body: { key: "nope", value: 1 } })).status,
    ).toBe(403);
    expect(
      (await ws.browser.json("/api/admin/settings", { method: "PATCH", body: { key: "nope", value: 1 } })).status,
    ).toBe(404);
  });

  it("settings need a session and the CSRF header", async () => {
    expect((await new Browser().json("/api/admin/settings")).status).toBe(401);
    const csrf = await ws.browser.json("/api/admin/settings", {
      method: "PATCH",
      body: { key: "magic_link_enabled", value: true },
      noCsrf: true,
    });
    expect(csrf.body).toMatchObject({ error: { code: "csrf_failed" } });
  });
});

describe("Send test email (TDD §7.6): admin-only, to the actor's own address, audited", () => {
  it("refuses while email isn't configured", async () => {
    await configureEmail({ driver: "none" });
    const result = await ws.browser.json("/api/admin/email/test", { body: {} });
    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({ error: { reason: "email_not_configured" } });
  });

  it("queues a test email to the owner's own address, and audits it", async () => {
    await configureEmail();
    const result = await ws.browser.json<{ to: string; jobId: string }>("/api/admin/email/test", { body: {} });
    expect(result.status).toBe(202);
    expect(result.body.to).toBe(ws.owner.email);
    const [message] = outbox.messages.filter((m) => m.jobId === result.body.jobId);
    expect(message).toMatchObject({ kind: "test", to: ws.owner.email, subject: "Test email from Acme Studio" });
    const audit = await env.DB.prepare(
      "SELECT actor_id, target_id FROM audit_log WHERE action = 'email.test_sent' AND target_id = ?",
    )
      .bind(result.body.jobId)
      .first<{ actor_id: string }>();
    expect(audit!.actor_id).toBe(ws.ownerId);
    // No recipient can be chosen.
    expect((await ws.browser.json("/api/admin/email/test", { body: { to: "someone@example.com" } })).status).toBe(400);
  });

  it("admins may send one (to themselves); members may not", async () => {
    await configureEmail();
    const admin = await addMember("admin");
    const sent = await admin.browser.json<{ to: string }>("/api/admin/email/test", { body: {} });
    expect(sent.body.to).toBe(admin.email);
    const member = await addMember("member");
    const refused = await member.browser.json("/api/admin/email/test", { body: {} });
    expect(refused.body).toMatchObject({ error: { code: "forbidden", reason: "not_permitted" } });
    await staleFreshAuth(admin.id);
    // No step-up needed.
    expect((await admin.browser.json("/api/admin/email/test", { body: {} })).status).toBe(202);
  });
});

import { permanent, sent, transient, type EmailDriver, type OutgoingEmail, type SendOutcome } from "./types";

/**
 * Cloudflare Email Service, the default driver (TDD §7.6): the `send_email` binding's structured
 * `send({ from, to, subject, html, text, headers })`, returning `{ messageId }`. No API keys: the
 * sending domain is onboarded in the customer's account (Cloudflare DNS, Workers Paid).
 *
 * Errors are thrown with a `code`. The rate-limit, daily-limit, delivery and internal codes are
 * transient; the sender, recipient and validation codes (and anything unknown) are permanent.
 */

export const CLOUDFLARE_TRANSIENT_CODES: ReadonlySet<string> = new Set([
  "E_RATE_LIMIT_EXCEEDED",
  "E_DAILY_LIMIT_EXCEEDED",
  "E_DELIVERY_FAILED",
  "E_INTERNAL_SERVER_ERROR",
]);

export function cloudflareOutcome(error: unknown): SendOutcome {
  const raw = error && typeof error === "object" && "code" in error ? error.code : null;
  const code = typeof raw === "string" ? raw : null;
  if (code === null) {
    // No code: a network or runtime failure rather than a refusal (default: transient).
    return transient("network");
  }
  return CLOUDFLARE_TRANSIENT_CODES.has(code) ? transient(code) : permanent(code);
}

export function cloudflareDriver(binding: SendEmail): EmailDriver {
  return {
    kind: "cloudflare",
    async send(email: OutgoingEmail): Promise<SendOutcome> {
      try {
        const result = await binding.send({
          from: email.from.name ? { email: email.from.email, name: email.from.name } : email.from.email,
          to: email.to,
          subject: email.subject,
          text: email.text,
          html: email.html,
          headers: { "X-Officebox-Job": email.id },
        });
        return sent(typeof result?.messageId === "string" ? result.messageId : null);
      } catch (error) {
        return cloudflareOutcome(error);
      }
    },
  };
}

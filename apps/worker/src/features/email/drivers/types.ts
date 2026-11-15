import type { EmailDriverKind } from "@officebox/shared";

/**
 * The email adapter's driver interface (TDD §7.6). A driver sends one message to one recipient and
 * reports the outcome as a **typed result**, never by throwing for an expected failure (AGENTS §4.1):
 *
 * - `sent`: the provider accepted it (with its message ID when it gives one)
 * - `transient`: worth retrying (network errors, HTTP 429 or 5xx, SMTP 4xx, the Cloudflare rate and
 *   daily-limit codes); the queue consumer retries with backoff, up to 8 tries
 * - `permanent`: retrying can't help (HTTP 4xx other than 429, SMTP 5xx, an unverified sender, a
 *   suppressed recipient); recorded with the provider's error and not retried
 *
 * `code` is the provider's own error code or a short label of ours (`network`, `http_503`), stored in
 * `email_deliveries.last_error`. It never contains the message, addresses or credentials.
 */

export interface OutgoingEmail {
  /** The delivery job's ULID: the idempotency key for providers that take one. */
  id: string;
  to: string;
  from: { email: string; name?: string };
  subject: string;
  text: string;
  html: string;
}

export type SendOutcome =
  | { kind: "sent"; messageId: string | null }
  | { kind: "transient"; code: string }
  | { kind: "permanent"; code: string };

export interface EmailDriver {
  readonly kind: Exclude<EmailDriverKind, "none"> | "sink";
  send(email: OutgoingEmail): Promise<SendOutcome>;
}

export const sent = (messageId: string | null): SendOutcome => ({ kind: "sent", messageId });
export const transient = (code: string): SendOutcome => ({ kind: "transient", code: code.slice(0, 120) });
export const permanent = (code: string): SendOutcome => ({ kind: "permanent", code: code.slice(0, 120) });

/** HTTP providers: 429 and 5xx are transient, every other 4xx is permanent (TDD §7.6). */
export function outcomeForStatus(status: number, providerCode?: string): SendOutcome {
  const code = providerCode ? `http_${status}:${providerCode}` : `http_${status}`;
  if (status === 429 || status >= 500) return transient(code);
  return permanent(code);
}

/** A `fetch` the HTTP drivers call; tests pass a fake. */
export type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/** The From header value: `"Name" <address>` or the bare address. Inputs are validated by Zod first. */
export function fromHeader(from: OutgoingEmail["from"]): string {
  if (!from.name) return from.email;
  return `"${from.name.replace(/["\\\r\n]/g, "")}" <${from.email}>`;
}

/** A provider error code from a JSON body, cut short; never the whole body (it may echo addresses). */
export async function providerCode(response: Response, field: string): Promise<string | undefined> {
  try {
    const body = await response.json<Record<string, unknown>>();
    const value = body[field];
    if (typeof value === "string" || typeof value === "number") return String(value).slice(0, 60);
  } catch {
    // Not JSON: the status alone is enough.
  }
  return undefined;
}

import type { WorkspacePresence } from "./features/realtime/presence-do";
import type { UserHub } from "./features/realtime/user-hub-do";
import type { SystemObject } from "./system-object";

/**
 * Worker bindings, matching `wrangler.jsonc` at the repository root.
 * Keep the two in step: a binding added there is declared here.
 */
export interface Env {
  /** Build-time version string; preflight checks it matches package.json. */
  OFFICEBOX_VERSION: string;

  DB: D1Database;
  FILES: R2Bucket;
  ASSETS: Fetcher;

  SYSTEM: DurableObjectNamespace<SystemObject>;
  USER_HUB: DurableObjectNamespace<UserHub>;
  PRESENCE: DurableObjectNamespace<WorkspacePresence>;

  EMAIL_QUEUE: Queue;
  EMAIL_DLQ: Queue;

  /** 5 requests per 60 s, keyed per IP: sign-in, setup, recovery, invitation acceptance (Platform §8). */
  AUTH_RATE_LIMITER: RateLimit;
  /** 300 requests per 60 s, keyed per session: general API (Platform §8). */
  API_RATE_LIMITER: RateLimit;

  /** 20 requests per 60 s, keyed per IP: passkey sign-in, registration and step-up (Platform §8). */
  PASSKEY_RATE_LIMITER: RateLimit;
  /** 10 requests per 60 s, keyed per IP: magic-link confirmation POSTs (Platform §8). */
  MAGIC_LINK_RATE_LIMITER: RateLimit;
  /** 60 requests per 60 s, keyed per IP: `GET /status/public` (Platform §8). */
  STATUS_RATE_LIMITER: RateLimit;

  /**
   * Cloudflare Email Service, the default email driver (TDD §7.6). Optional in the type: a deployment
   * whose account can't use it still runs, and the driver reports it as missing.
   */
  EMAIL?: SendEmail;

  // Secrets (Platform §16). Declared optional because a fresh deploy may not have them. Identity checks
  // them on use (features/identity/secrets.ts): from M1b-1, an unset or empty BETTER_AUTH_SECRET or
  // TOKEN_HASH_KEY falls back to a key the Worker generates into the SystemObject (core/keys.ts); one
  // that is set but invalid makes sign-in answer `unavailable` (/not-configured).

  /**
   * Optional first-run setup token (TDD §6.8), at least 32 characters. Unset: no token for the first
   * 60 minutes (the open claim window, M1b-1), then one generated into Workers Logs. Set: no window.
   */
  SETUP_TOKEN?: string;
  /**
   * HMAC key for our stored token hashes (enrolment tickets now; recovery links, invitations and RSVP
   * tokens later) and audit email hashes (Platform §16). Optional from M1b-1 (the Worker generates one);
   * at least 32 bytes when set.
   */
  TOKEN_HASH_KEY?: string;
  /**
   * better-auth's secret: signs the session cookie (Platform §16). Optional from M1b-1 (the Worker
   * generates one); at least 32 bytes when set.
   */
  BETTER_AUTH_SECRET?: string;
  /**
   * better-auth's rotation list, `<version>:<secret>,…` newest first (Platform §16). Rotating signs
   * everyone out: the session cookie is signed with the newest secret only (M1a-0 spike).
   */
  BETTER_AUTH_SECRETS?: string;
  /**
   * Owner recovery secret (Identity §4.6), at least 32 characters: `POST /api/recover` registers a new passkey
   * for one owner with it, once (M1c); while set and unconsumed it also satisfies the owners' invite gate.
   */
  RECOVERY_TOKEN?: string;

  // Email provider secrets (Platform §16), read only by the driver the owner chose in settings.
  /** Resend API key. */
  RESEND_API_KEY?: string;
  /** Postmark server token. */
  POSTMARK_SERVER_TOKEN?: string;
  /** Amazon SES (v2 API) access key ID and secret, for an IAM user allowed only `ses:SendEmail`. */
  SES_ACCESS_KEY_ID?: string;
  SES_SECRET_ACCESS_KEY?: string;
  /** SMTP password (the username is a setting). */
  SMTP_PASSWORD?: string;

  /**
   * Local end-to-end runs only: "1" swaps every configured driver for a sink that records each message
   * in a local D1 table instead of sending it (`features/email/drivers/sink.ts`). Never set in a deploy.
   */
  EMAIL_TEST_SINK?: string;
}

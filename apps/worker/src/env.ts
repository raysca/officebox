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

  EMAIL_QUEUE: Queue;
  EMAIL_DLQ: Queue;

  /** 5 requests per 60 s, keyed per IP: sign-in, setup, recovery, invitation acceptance (Platform §8). */
  AUTH_RATE_LIMITER: RateLimit;
  /** 300 requests per 60 s, keyed per session: general API (Platform §8). */
  API_RATE_LIMITER: RateLimit;

  /** 20 requests per 60 s, keyed per IP: passkey sign-in, registration and step-up (Platform §8). */
  PASSKEY_RATE_LIMITER: RateLimit;

  // Secrets (Platform §16). Declared optional because a fresh deploy may not have them yet: identity
  // checks them on use (features/identity/secrets.ts) and answers `unavailable` until they are set,
  // rather than failing at startup.

  /** Optional first-run setup token (TDD §6.8), at least 32 characters. Unset: generated into Workers Logs. */
  SETUP_TOKEN?: string;
  /**
   * HMAC key for our stored token hashes (enrolment tickets now; recovery links, invitations and RSVP
   * tokens later) and audit email hashes (Platform §16). Required from M1; at least 32 bytes.
   */
  TOKEN_HASH_KEY?: string;
  /** better-auth's secret: signs the session cookie (Platform §16). Required from M1; at least 32 bytes. */
  BETTER_AUTH_SECRET?: string;
  /**
   * better-auth's rotation list, `<version>:<secret>,…` newest first (Platform §16). Rotating signs
   * everyone out: the session cookie is signed with the newest secret only (M1a-0 spike).
   */
  BETTER_AUTH_SECRETS?: string;
  /** Owner recovery secret (Identity §4.6). M1a reads it only for the engine's "set and unconsumed" fact. */
  RECOVERY_TOKEN?: string;
}

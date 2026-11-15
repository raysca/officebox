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

  /** Optional first-run setup token (TDD §6.8). Read from M1. */
  SETUP_TOKEN?: string;
  /**
   * HMAC key for stored token hashes (Platform §16). Required from M1; until then audit metadata masks
   * email addresses instead of hashing them.
   */
  TOKEN_HASH_KEY?: string;
}

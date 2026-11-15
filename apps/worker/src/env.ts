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

  // Secrets (Platform §16). Declared optional because a fresh deploy may not have them yet: the
  // identity feature checks them (`features/identity/secrets.ts`) and answers `unavailable` until
  // they are set, rather than failing at startup.

  /**
   * Optional first-run setup token (TDD §6.8). At least 32 characters. Empty or unset: a one-time
   * token is generated and written to Workers Logs instead.
   */
  SETUP_TOKEN?: string;
  /**
   * HMAC key for stored token hashes: refresh tokens, sign-in throttle keys and (later) auth_tokens,
   * plus audit email hashes (Platform §16). Required from M1; at least 32 bytes.
   */
  TOKEN_HASH_KEY?: string;
  /** Signs access tokens, the `ob_session` cookie (Platform §16). Required from M1; at least 32 bytes. */
  SESSION_SIGNING_KEY?: string;
  /**
   * The previous signing key during a rotation **(default)**: access tokens it signed stay valid
   * until they expire (15 minutes). Delete it after that.
   */
  SESSION_SIGNING_KEY_PREVIOUS?: string;
  /**
   * Password pepper `PEPPER_1` (Identity §4.4). Further peppers `PEPPER_2`, `PEPPER_3`, ... are read
   * by name; new hashes use the highest-numbered one. Each at least 32 bytes.
   */
  PEPPER_1?: string;
  [pepper: `PEPPER_${number}`]: string | undefined;
}

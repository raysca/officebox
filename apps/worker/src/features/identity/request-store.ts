import { AsyncLocalStorage } from "node:async_hooks";
import type { PasskeyCreatedVia } from "@officebox/shared";
import type { Logger } from "../../core/log";

/**
 * Request-scoped, **server-set** state that better-auth's hooks read (M1a-0 spike, workaround 10).
 *
 * The identity middleware opens one store per request (`runWithStore`). Only our own server code
 * writes to it: the setup route sets `create` around its `createUser` call, the passkey mount sets
 * `registration`, and `POST /me/reauth` sets `reauth`. Nothing in a request (header, body, cookie)
 * can set any of it, so `databaseHooks.user.create.before` can require the `create` marker and every
 * user-creating better-auth path without it is refused (Identity §4.4).
 *
 * Needs `nodejs_compat` (AsyncLocalStorage), which `wrangler.jsonc` sets explicitly.
 */

/** Set by our setup (and, from M1b, invitation accept) route around better-auth's `createUser`. */
export interface CreateMarker {
  kind: "setup" | "accept";
  /** The setup claim nonce or accept attempt ID, recorded as `users.created_attempt_id`. */
  attemptId: string;
  role: "owner" | "admin" | "member";
  handle: string;
}

/** How a passkey registration request is authorised, decided by our mount before better-auth runs. */
export type RegistrationMode =
  { kind: "signed_in"; userId: string; sessionId: string } | { kind: "ticket"; ticketHash: string };

/** What an enrolment ticket said once it was consumed at registration verify. */
export interface ConsumedTicket {
  userId: string;
  via: PasskeyCreatedVia;
  /** The setup claim nonce, for setup completion (TDD §6.8). */
  claim: string | null;
}

export interface RequestStore {
  /** The request's logger (redacting); better-auth's own log lines go through it. */
  log?: Logger;
  /** The request's `waitUntil`, for work that mustn't hold up the response. */
  waitUntil?: (promise: Promise<unknown>) => void;
  /** Cloudflare's location facts for "My devices" (city, country). */
  cf?: { city?: unknown; country?: unknown };
  create?: CreateMarker;
  registration?: RegistrationMode;
  consumedTicket?: ConsumedTicket;
  /** Step-up: the session's user; the session-create hook records who verified and vetoes the session. */
  reauth?: { userId: string; verifiedUserId?: string };
  /** Captured before better-auth consumes it, so a refused assertion can be re-verified (clones). */
  passkeyChallenge?: string;
  /** Set when a refused assertion turned out to be a genuine one with a regressed counter. */
  cloneDetected?: { passkeyId: string; userId: string };
}

const storage = new AsyncLocalStorage<RequestStore>();

export function runWithStore<T>(store: RequestStore, fn: () => T): T {
  return storage.run(store, fn);
}

/** The current request's store, or undefined outside one (better-auth hooks then refuse what needs it). */
export function currentStore(): RequestStore | undefined {
  return storage.getStore();
}

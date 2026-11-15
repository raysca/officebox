// Request-scoped, server-set state that better-auth's hooks can read (Q4: "can a hook read a server-set marker?").
// Our Hono middleware opens a store per request; our own routes set `create` before calling better-auth on the server.
// Nothing in a request (header, body, cookie) can set it.
import { AsyncLocalStorage } from "node:async_hooks";

export type CreateMarker = { kind: "setup" | "accept"; attemptId: string };

export interface RequestStore {
  /** The request's ExecutionContext.waitUntil, so better-auth callbacks can defer work (mail sending). */
  waitUntil?: (p: Promise<unknown>) => void;
  /** Set only by our setup / accept routes around their createUser call. */
  create?: CreateMarker;
  /** Set by POST /me/reauth: the current session's user. The session-create hook vetoes the new session. */
  reauth?: { userId: string; verifiedUserId?: string };
  /** Captured by hooks.before on passkey verify-authentication, before better-auth consumes the challenge. */
  passkeyChallenge?: string;
  /** Set when the counter rule refused an assertion. */
  cloneDetected?: { passkeyId: string; userId: string; stored: number; presented: number };
}

export const requestStore = new AsyncLocalStorage<RequestStore>();

export function store(): RequestStore | undefined {
  return requestStore.getStore();
}

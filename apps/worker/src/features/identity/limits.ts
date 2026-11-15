import { defineLimit } from "../../core/rate-limit";

/**
 * Identity rate limits (Platform §8). Both share the `AUTH_RATE_LIMITER` binding (5 per 60 s), each
 * under its own name, so setup and sign-in from one IP are counted separately.
 *
 * The per-account sign-in limit with its progressive delay is a D1 counter in `sign-in.ts`.
 */
export const IDENTITY_LIMITS = {
  /** First-run setup: 5 per minute per IP. */
  setup: defineLimit({ mechanism: "binding", name: "setup", binding: "AUTH_RATE_LIMITER", periodSeconds: 60 }),
  /** Sign-in attempts: 5 per minute per IP. Every attempt counts, successful or not. */
  signInIp: defineLimit({ mechanism: "binding", name: "sign_in", binding: "AUTH_RATE_LIMITER", periodSeconds: 60 }),
};

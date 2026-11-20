import { env } from "cloudflare:workers";
import type { RateLimitBindingName } from "../src/core/rate-limit";

/**
 * A Workers Rate Limiting binding with an injected clock, for tests that assert an exact count.
 *
 * The real binding (and Miniflare's) counts in fixed windows aligned to the wall clock, so a burst
 * that starts near the end of a minute is split across two windows and its last call is let through
 * (a flaky 403 where 429 was expected). This one follows Miniflare's rules exactly (fixed `period`
 * windows; a call is allowed while the count is below the limit and then adds its `delta`; a refused
 * call isn't counted) but reads the time from `now`, so a test decides when
 * a window ends. Its limit and period come from `wrangler.jsonc` ({@link configuredLimit}), so a
 * test still checks the deployed configuration.
 */
export class FakeRateLimit implements RateLimit {
  private readonly buckets = new Map<string, { epoch: number; count: number }>();

  constructor(
    readonly config: { limit: number; period: number },
    private readonly now: () => number,
  ) {}

  limit({ key, delta = 1 }: RateLimitOptions): Promise<RateLimitOutcome> {
    const epoch = Math.floor(this.now() / (this.config.period * 1000));
    const bucket = this.buckets.get(key);
    const count = bucket?.epoch === epoch ? bucket.count : 0;
    if (count >= this.config.limit) return Promise.resolve({ success: false });
    this.buckets.set(key, { epoch, count: count + delta });
    return Promise.resolve({ success: true });
  }
}

/** A binding's `simple` limit as `wrangler.jsonc` declares it (bound by vitest.config.ts). */
export function configuredLimit(name: RateLimitBindingName): { limit: number; period: number } {
  const declared = env.TEST_RATE_LIMITS.find((r) => r.name === name);
  if (!declared) throw new Error(`${name} isn't declared in wrangler.jsonc`);
  return declared.simple;
}

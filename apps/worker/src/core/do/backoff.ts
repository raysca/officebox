/** Longest wait between retries of a failing timer or outbox send. */
export const MAX_BACKOFF_MS = 5 * 60 * 1000;

/**
 * Wait before the next try after the `attempts`-th failure (1-based): 2 s after the first failure,
 * then 4 s, 8 s, … capped at 5 minutes (TDD §3.3). Values below 1 are treated as 1.
 */
export function backoffMs(attempts: number): number {
  return Math.min(1000 * 2 ** Math.max(1, attempts), MAX_BACKOFF_MS);
}

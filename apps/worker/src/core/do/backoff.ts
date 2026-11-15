/** Longest wait between retries of a failing timer or outbox send. */
export const MAX_BACKOFF_MS = 5 * 60 * 1000;

/** Exponential backoff after `attempts` failures: 2 s, 4 s, 8 s, … capped at 5 minutes (TDD §3.3). */
export function backoffMs(attempts: number): number {
  return Math.min(1000 * 2 ** Math.max(1, attempts), MAX_BACKOFF_MS);
}

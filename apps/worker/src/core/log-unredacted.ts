import { consoleSink, type LogSink } from "./log";

/**
 * Writes one log line **without redaction**. Only for a value that must reach the operator verbatim
 * through Workers Logs, which only members of the Cloudflare account can read: the generated
 * first-run setup token (TDD §6.8).
 *
 * This is a separate module so ESLint can restrict who imports it (`no-restricted-imports` in
 * `eslint.config.js`: `features/identity/setup-token.ts` is the one allowed importer). Adding an
 * importer needs review.
 */
export function logUnredacted(
  event: string,
  fields: Record<string, string | number | boolean>,
  sink: LogSink = consoleSink,
): void {
  sink("warn", JSON.stringify({ ...fields, level: "warn", message: event, unredacted: true }));
}

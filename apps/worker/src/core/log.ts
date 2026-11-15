import { redact, type Redacted } from "./redact";

/**
 * Structured JSON logging. One JSON object per line, written with `console.*` so Workers Logs indexes
 * the fields (TDD §7).
 *
 * **Never log secrets or personal data.** Every field passes through `redact`: secret-named keys,
 * token-like strings and credential query parameters are removed and email addresses become
 * `[email]`. Even so, log IDs (user ID, channel ID), never names, emails, message text, IP addresses,
 * query strings or request bodies. `level` and `message` always come from the call, never from fields.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /**
   * Writes a line **without redaction**. Only for values that must reach the operator verbatim
   * through Workers Logs, which only members of the Cloudflare account can read: the generated
   * first-run setup token (TDD §6.8). ESLint restricts calls to the files allowed in
   * `eslint.config.js`; adding a caller needs review.
   */
  unredacted(event: string, fields: Record<string, string | number | boolean>): void;
  /** A logger that adds `fields` to every line. */
  child(fields: LogFields): Logger;
}

/** Where log lines go. Defaults to `console`; tests pass a capturing sink. */
export type LogSink = (level: LogLevel, line: string) => void;

const consoleSink: LogSink = (level, line) => {
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
};

const emailMask = (): string => "[email]";

export function createLogger(base: LogFields = {}, sink: LogSink = consoleSink): Logger {
  const write = (level: LogLevel, message: string, fields?: LogFields): void => {
    const record = redact({ ...base, ...fields }, { email: emailMask }) as { [key: string]: Redacted };
    delete record.level;
    delete record.message;
    let line: string;
    try {
      line = JSON.stringify({ level, message, ...record });
    } catch {
      line = JSON.stringify({ level, message, logError: "unserialisable fields" });
    }
    sink(level, line);
  };
  return {
    debug: (message, fields) => write("debug", message, fields),
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields),
    unredacted: (event, fields) =>
      sink("warn", JSON.stringify({ ...fields, level: "warn", message: event, unredacted: true })),
    child: (fields) => createLogger({ ...base, ...fields }, sink),
  };
}

/** Logger for code that runs outside a request (Durable Objects, queue consumers, cron jobs). */
export const rootLogger: Logger = createLogger();

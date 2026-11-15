import { apiError, err, ok, type ApiError, type Result } from "@officebox/shared";

/**
 * Typed D1 helper.
 *
 * Constraint violations (unique, foreign key, check, not null) are **expected outcomes** and come back
 * as `Err<DbError>`; anything else (D1 unreachable, a syntax error, a missing table) is a real failure
 * and throws (AGENTS §4.1). Row types are given by the caller; rows come from our own schema, so they
 * aren't re-validated. `batch` runs its statements in one transaction (D1 batches are atomic).
 */

export type ConstraintKind = "unique" | "foreign_key" | "check" | "not_null";

export interface DbError {
  kind: ConstraintKind;
  /** `table.column` names from the SQLite message, for unique and not-null violations. */
  columns: string[];
  /** The `ApiError` a route should return when it doesn't need anything more specific. */
  error: ApiError;
}

export type DbResult<T> = Result<T, DbError>;

export type SqlValue = string | number | boolean | null | ArrayBuffer;

export interface RunMeta {
  /** Rows written by the statement. */
  changes: number;
  lastRowId: number | null;
}

/**
 * Recognises a SQLite constraint failure in a D1 error and maps it to a typed error, or returns null.
 *
 * D1 reports constraint failures only as message text (`D1_ERROR: UNIQUE constraint failed: t.c:
 * SQLITE_CONSTRAINT`), so this matches SQLite's wording. That wording has been stable for many years,
 * but if D1 changes it, violations would surface as thrown errors (500s), not silent successes; the
 * tests in `test/db.test.ts` pin the behaviour against the runtime in use.
 */
export function constraintError(error: unknown): DbError | null {
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
  const message = error instanceof Error ? `${error.message} ${cause}` : String(error);
  const columnsAfter = (label: string): string[] => {
    const match = new RegExp(`${label} constraint failed: ([\\w.]+(?:, [\\w.]+)*)`).exec(message);
    return match?.[1] ? match[1].split(", ") : [];
  };
  if (/UNIQUE constraint failed|PRIMARY KEY constraint failed/.test(message)) {
    return {
      kind: "unique",
      columns: columnsAfter("UNIQUE"),
      error: apiError("conflict", "That already exists."),
    };
  }
  if (/FOREIGN KEY constraint failed/.test(message)) {
    return { kind: "foreign_key", columns: [], error: apiError("conflict", "This conflicts with related data.") };
  }
  if (/CHECK constraint failed/.test(message)) {
    return { kind: "check", columns: [], error: apiError("validation_failed", "A value is not allowed.") };
  }
  if (/NOT NULL constraint failed/.test(message)) {
    return {
      kind: "not_null",
      columns: columnsAfter("NOT NULL"),
      error: apiError("validation_failed", "A required value is missing."),
    };
  }
  return null;
}

async function attempt<T>(work: () => Promise<T>): Promise<DbResult<T>> {
  try {
    return ok(await work());
  } catch (error) {
    const mapped = constraintError(error);
    if (mapped) return err(mapped);
    throw error;
  }
}

function toMeta(meta: D1Meta): RunMeta {
  return { changes: meta.changes ?? 0, lastRowId: meta.last_row_id ?? null };
}

export class Database {
  constructor(readonly d1: D1Database) {}

  /** Prepares a statement with positional `?` parameters, for `batch` or for direct use. */
  statement(sql: string, ...params: SqlValue[]): D1PreparedStatement {
    return this.d1.prepare(sql).bind(...params);
  }

  async all<T extends object>(sql: string, ...params: SqlValue[]): Promise<DbResult<T[]>> {
    return attempt(async () => (await this.statement(sql, ...params).all<T>()).results);
  }

  async first<T extends object>(sql: string, ...params: SqlValue[]): Promise<DbResult<T | null>> {
    return attempt(() => this.statement(sql, ...params).first<T>());
  }

  async run(sql: string, ...params: SqlValue[]): Promise<DbResult<RunMeta>> {
    return attempt(async () => toMeta((await this.statement(sql, ...params).run()).meta));
  }

  /** Runs the statements atomically, in order. Returns each statement's rows. */
  async batch<T extends object = Record<string, unknown>>(statements: D1PreparedStatement[]): Promise<DbResult<T[][]>> {
    if (statements.length === 0) return ok([]);
    return attempt(async () => (await this.d1.batch<T>(statements)).map((r) => r.results));
  }

  /** Runs write statements atomically, in order. Returns each statement's changes. */
  async batchRun(statements: D1PreparedStatement[]): Promise<DbResult<RunMeta[]>> {
    if (statements.length === 0) return ok([]);
    return attempt(async () => (await this.d1.batch(statements)).map((r) => toMeta(r.meta)));
  }
}

/** Unwraps a result whose error can't happen in practice (for example a SELECT); throws if it does. */
export function expectOk<T>(result: DbResult<T>): T {
  if (!result.ok) throw new Error(`Unexpected ${result.error.kind} constraint failure`);
  return result.value;
}

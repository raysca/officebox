// A minimal Kysely dialect for D1 plus the epoch-millisecond plugin.
//
// better-auth's Kysely adapter detects a D1 binding by itself (`database: env.DB`) and uses its own internal D1 dialect,
// but it gives no way to add Kysely plugins on that path, and its D1 dialect isn't exported. Passing our own Kysely
// instance (`database: { db, type: "sqlite" }`) is the documented alternative and lets us add EpochMsPlugin.
import {
  CompiledQuery,
  Kysely,
  OperationNodeTransformer,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  type BinaryOperationNode,
  type ColumnUpdateNode,
  type DatabaseConnection,
  type DatabaseIntrospector,
  type Dialect,
  type DialectAdapter,
  type Driver,
  type InsertQueryNode,
  type KyselyPlugin,
  type OperationNode,
  type PluginTransformQueryArgs,
  type PluginTransformResultArgs,
  type QueryCompiler,
  type QueryResult,
  type RootOperationNode,
  type UnknownRow,
} from "kysely";

/** Every SQL statement better-auth runs, for the cost measurements (Q12). Reset per request by the caller. */
export const queryLog: { sql: string; params: readonly unknown[] }[] = [];
export let logQueries = false;
export function setQueryLogging(on: boolean): void {
  logQueries = on;
  queryLog.length = 0;
}

class D1Connection implements DatabaseConnection {
  constructor(private readonly db: D1Database) {}
  async executeQuery<R>(q: CompiledQuery): Promise<QueryResult<R>> {
    if (logQueries) queryLog.push({ sql: q.sql, params: q.parameters });
    const res = await this.db.prepare(q.sql).bind(...q.parameters).all<R>();
    return {
      rows: res.results ?? [],
      numAffectedRows: res.meta.changes != null ? BigInt(res.meta.changes) : undefined,
      insertId: res.meta.last_row_id != null ? BigInt(res.meta.last_row_id) : undefined,
    };
  }
  // eslint-disable-next-line require-yield
  async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error("D1 does not stream");
  }
}

class D1Driver implements Driver {
  private conn: D1Connection;
  constructor(db: D1Database) {
    this.conn = new D1Connection(db);
  }
  async init(): Promise<void> {}
  async acquireConnection(): Promise<DatabaseConnection> {
    return this.conn;
  }
  async beginTransaction(): Promise<void> {
    throw new Error("D1 has no interactive transactions");
  }
  async commitTransaction(): Promise<void> {
    throw new Error("D1 has no interactive transactions");
  }
  async rollbackTransaction(): Promise<void> {
    throw new Error("D1 has no interactive transactions");
  }
  async releaseConnection(): Promise<void> {}
  async destroy(): Promise<void> {}
}

class D1Dialect implements Dialect {
  constructor(private readonly db: D1Database) {}
  createAdapter(): DialectAdapter {
    return new SqliteAdapter();
  }
  createDriver(): Driver {
    return new D1Driver(this.db);
  }
  createQueryCompiler(): QueryCompiler {
    return new SqliteQueryCompiler();
  }
  createIntrospector(db: Kysely<unknown>): DatabaseIntrospector {
    return new SqliteIntrospector(db);
  }
}

/** Date columns in the better-auth-mapped tables. Only these are converted, and only from exact ISO-8601 strings. */
export const DATE_COLUMNS = new Set(["created_at", "updated_at", "expires_at", "access_token_expires_at", "refresh_token_expires_at"]);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const toMs = (v: unknown): unknown => (typeof v === "string" && ISO.test(v) ? Date.parse(v) : v);

function columnName(node: OperationNode | undefined): string | undefined {
  if (!node) return undefined;
  if (node.kind === "ColumnNode") return (node as unknown as { column: { name: string } }).column.name;
  if (node.kind === "ReferenceNode") return columnName((node as unknown as { column: OperationNode }).column);
  return undefined;
}

class EpochMsTransformer extends OperationNodeTransformer {
  // INSERT … (cols) VALUES (…): convert the values in date columns.
  protected override transformInsertQuery(node: InsertQueryNode): InsertQueryNode {
    const out = super.transformInsertQuery(node);
    const cols = (out.columns ?? []).map((c) => c.column.name);
    const values = out.values as unknown as { kind: string; values: { kind: string; values: unknown[] }[] } | undefined;
    if (!values || values.kind !== "ValuesNode") return out;
    const rows = values.values.map((row) => {
      if (row.kind === "PrimitiveValueListNode") {
        return { ...row, values: row.values.map((v, i) => (DATE_COLUMNS.has(cols[i] ?? "") ? toMs(v) : v)) };
      }
      if (row.kind === "ValueListNode") {
        return {
          ...row,
          values: (row.values as { kind: string; value?: unknown }[]).map((v, i) =>
            DATE_COLUMNS.has(cols[i] ?? "") && v.kind === "ValueNode" ? { ...v, value: toMs(v.value) } : v,
          ),
        };
      }
      return row;
    });
    return { ...out, values: { ...values, values: rows } as unknown as OperationNode };
  }
  // UPDATE … SET col = ?
  protected override transformColumnUpdate(node: ColumnUpdateNode): ColumnUpdateNode {
    const out = super.transformColumnUpdate(node);
    const name = columnName(out.column);
    const value = out.value as unknown as { kind: string; value?: unknown };
    if (name && DATE_COLUMNS.has(name) && value.kind === "ValueNode") {
      return { ...out, value: { ...value, value: toMs(value.value) } as unknown as OperationNode };
    }
    return out;
  }
  // WHERE col <op> ?
  protected override transformBinaryOperation(node: BinaryOperationNode): BinaryOperationNode {
    const out = super.transformBinaryOperation(node);
    const name = columnName(out.leftOperand);
    const right = out.rightOperand as unknown as { kind: string; value?: unknown };
    if (name && DATE_COLUMNS.has(name) && right.kind === "ValueNode") {
      return { ...out, rightOperand: { ...right, value: toMs(right.value) } as unknown as OperationNode };
    }
    return out;
  }
}

/**
 * Stores better-auth's dates as INTEGER epoch milliseconds. The SQLite path of better-auth's adapter factory has
 * `supportsDates: false`, so it writes `Date.toISOString()` strings and parses strings back with `new Date(string)`.
 * This plugin turns those ISO strings into numbers on the way in (inserts, updates, where clauses on date columns) and
 * numbers back into ISO strings on the way out, so better-auth still sees the strings it expects.
 */
export class EpochMsPlugin implements KyselyPlugin {
  private readonly t = new EpochMsTransformer();
  transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
    return this.t.transformNode(args.node);
  }
  async transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
    const rows = args.result.rows.map((row) => {
      let copy: UnknownRow | undefined;
      for (const k of Object.keys(row)) {
        if (DATE_COLUMNS.has(k) && typeof row[k] === "number") {
          copy ??= { ...row };
          copy[k] = new Date(row[k] as number).toISOString();
        }
      }
      return copy ?? row;
    });
    return { ...args.result, rows };
  }
}

export function createKysely(db: D1Database, { epochMs }: { epochMs: boolean }): Kysely<unknown> {
  return new Kysely<unknown>({ dialect: new D1Dialect(db), plugins: epochMs ? [new EpochMsPlugin()] : [] });
}

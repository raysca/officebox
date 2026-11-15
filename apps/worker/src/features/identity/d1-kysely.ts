import {
  Kysely,
  OperationNodeTransformer,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  type BinaryOperationNode,
  type ColumnUpdateNode,
  type CompiledQuery,
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

/**
 * A minimal Kysely dialect for D1, plus the **epoch-millisecond plugin** (M1a-0 spike, workaround 1;
 * TDD §8.1; Platform §14).
 *
 * better-auth's SQLite path has `supportsDates: false`: it writes `Date.toISOString()` strings and
 * parses strings back with `new Date(string)`. Our timestamps are INTEGER epoch ms (AGENTS §4.1), so
 * better-auth gets **our own Kysely instance** (`database: { db, type: "sqlite" }`; its built-in D1
 * detection offers no way to add a plugin) with {@link EpochMsPlugin}, which converts exact ISO
 * strings bound to the known date columns into numbers on the way in (inserts, updates and where
 * clauses) and numbers back into ISO strings on the way out. better-auth still sees the strings it
 * expects; nothing else touches this Kysely instance.
 *
 * **Upgrades:** a better-auth version that adds a date column must add it to {@link DATE_COLUMNS};
 * better-auth's runtime schema check and `test/identity/adapter.test.ts` catch a column stored as text.
 *
 * D1 has no interactive transactions. better-auth detects that (`transaction: false`) and runs its
 * multi-step writes as ordered statements; our ordered steps and the repair job cover partial writes.
 */

class D1Connection implements DatabaseConnection {
  constructor(private readonly db: D1Database) {}

  async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
    const result = await this.db
      .prepare(query.sql)
      .bind(...query.parameters)
      .all<R>();
    return {
      rows: result.results ?? [],
      numAffectedRows: result.meta.changes != null ? BigInt(result.meta.changes) : undefined,
      insertId: result.meta.last_row_id != null ? BigInt(result.meta.last_row_id) : undefined,
    };
  }

  // eslint-disable-next-line require-yield -- D1 has no streaming; Kysely requires the method.
  async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error("D1 does not stream query results");
  }
}

class D1Driver implements Driver {
  private readonly connection: D1Connection;

  constructor(db: D1Database) {
    this.connection = new D1Connection(db);
  }

  async init(): Promise<void> {}
  async acquireConnection(): Promise<DatabaseConnection> {
    return this.connection;
  }
  beginTransaction(): Promise<void> {
    return Promise.reject(new Error("D1 has no interactive transactions"));
  }
  commitTransaction(): Promise<void> {
    return Promise.reject(new Error("D1 has no interactive transactions"));
  }
  rollbackTransaction(): Promise<void> {
    return Promise.reject(new Error("D1 has no interactive transactions"));
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

/** Date columns in the better-auth-mapped tables. Only these are converted, and only exact ISO strings. */
export const DATE_COLUMNS: ReadonlySet<string> = new Set([
  "created_at",
  "updated_at",
  "expires_at",
  "access_token_expires_at",
  "refresh_token_expires_at",
]);

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function toMs(value: unknown): unknown {
  return typeof value === "string" && ISO.test(value) ? Date.parse(value) : value;
}

// Kysely's node types are structural; these narrow views name only what the transformer reads.
type ValueNodeView = { kind: string; value?: unknown };
type RowView = { kind: string; values: unknown[] };
type ValuesView = { kind: string; values: RowView[] };

function columnName(node: OperationNode | undefined): string | undefined {
  if (!node) return undefined;
  if (node.kind === "ColumnNode") return (node as unknown as { column: { name: string } }).column.name;
  if (node.kind === "ReferenceNode") return columnName((node as unknown as { column: OperationNode }).column);
  return undefined;
}

class EpochMsTransformer extends OperationNodeTransformer {
  // INSERT … (cols) VALUES (…)
  protected override transformInsertQuery(node: InsertQueryNode): InsertQueryNode {
    const out = super.transformInsertQuery(node);
    const columns = (out.columns ?? []).map((c) => c.column.name);
    const values = out.values as unknown as ValuesView | undefined;
    if (!values || values.kind !== "ValuesNode") return out;
    const rows = values.values.map((row) => {
      if (row.kind === "PrimitiveValueListNode") {
        return { ...row, values: row.values.map((v, i) => (DATE_COLUMNS.has(columns[i] ?? "") ? toMs(v) : v)) };
      }
      if (row.kind === "ValueListNode") {
        return {
          ...row,
          values: (row.values as ValueNodeView[]).map((v, i) =>
            DATE_COLUMNS.has(columns[i] ?? "") && v.kind === "ValueNode" ? { ...v, value: toMs(v.value) } : v,
          ),
        };
      }
      return row;
    });
    return { ...out, values: { ...values, values: rows } as unknown as OperationNode } as InsertQueryNode;
  }

  // UPDATE … SET col = ?
  protected override transformColumnUpdate(node: ColumnUpdateNode): ColumnUpdateNode {
    const out = super.transformColumnUpdate(node);
    const name = columnName(out.column);
    const value = out.value as unknown as ValueNodeView;
    if (name && DATE_COLUMNS.has(name) && value.kind === "ValueNode") {
      return { ...out, value: { ...value, value: toMs(value.value) } as unknown as OperationNode };
    }
    return out;
  }

  // WHERE col <op> ?
  protected override transformBinaryOperation(node: BinaryOperationNode): BinaryOperationNode {
    const out = super.transformBinaryOperation(node);
    const name = columnName(out.leftOperand);
    const right = out.rightOperand as unknown as ValueNodeView;
    if (name && DATE_COLUMNS.has(name) && right.kind === "ValueNode") {
      return { ...out, rightOperand: { ...right, value: toMs(right.value) } as unknown as OperationNode };
    }
    return out;
  }
}

/** Stores better-auth's dates as INTEGER epoch ms and hands them back as ISO strings. */
export class EpochMsPlugin implements KyselyPlugin {
  private readonly transformer = new EpochMsTransformer();

  transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
    return this.transformer.transformNode(args.node);
  }

  transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
    const rows = args.result.rows.map((row) => {
      let copy: UnknownRow | undefined;
      for (const key of Object.keys(row)) {
        const value = row[key];
        if (DATE_COLUMNS.has(key) && typeof value === "number") {
          copy ??= { ...row };
          copy[key] = new Date(value).toISOString();
        }
      }
      return copy ?? row;
    });
    return Promise.resolve({ ...args.result, rows });
  }
}

/** The Kysely instance better-auth uses: D1 with the epoch-ms plugin. */
export function createKysely(db: D1Database): Kysely<unknown> {
  return new Kysely<unknown>({ dialect: new D1Dialect(db), plugins: [new EpochMsPlugin()] });
}

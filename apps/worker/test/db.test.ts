import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { constraintError, Database } from "../src/core/db";

// Scratch tables for this file only, so the helper is tested without depending on feature schema.
beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE IF NOT EXISTS test_parent (id TEXT PRIMARY KEY, email TEXT UNIQUE)"),
    env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS test_child (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES test_parent(id), n INTEGER CHECK (n >= 0))",
    ),
  ]);
});

const db = () => new Database(env.DB);
const uid = () => crypto.randomUUID();

describe("Database helper", () => {
  it("runs, reads one and reads many with typed rows", async () => {
    const id = uid();
    const run = await db().run("INSERT INTO test_parent (id, email) VALUES (?, ?)", id, `${id}@x.test`);
    expect(run).toMatchObject({ ok: true, value: { changes: 1 } });
    expect(await db().first<{ id: string }>("SELECT id FROM test_parent WHERE id = ?", id)).toEqual({
      ok: true,
      value: { id },
    });
    expect(await db().first("SELECT id FROM test_parent WHERE id = ?", "missing")).toEqual({ ok: true, value: null });
    const all = await db().all<{ id: string }>("SELECT id FROM test_parent WHERE id IN (?, ?)", id, "missing");
    expect(all).toEqual({ ok: true, value: [{ id }] });
  });

  it("maps a unique violation to a typed conflict", async () => {
    const id = uid();
    await db().run("INSERT INTO test_parent (id, email) VALUES (?, ?)", id, `${id}@x.test`);
    const again = await db().run("INSERT INTO test_parent (id, email) VALUES (?, ?)", uid(), `${id}@x.test`);
    expect(again.ok).toBe(false);
    if (!again.ok) {
      expect(again.error.kind).toBe("unique");
      expect(again.error.columns).toEqual(["test_parent.email"]);
      expect(again.error.error.code).toBe("conflict");
    }
    const samePk = await db().run("INSERT INTO test_parent (id) VALUES (?)", id);
    expect(!samePk.ok && samePk.error.kind).toBe("unique");
  });

  it("maps foreign key, check and not-null violations", async () => {
    const fk = await db().run("INSERT INTO test_child (id, parent_id, n) VALUES (?, ?, 1)", uid(), "no-such-parent");
    expect(!fk.ok && fk.error.kind).toBe("foreign_key");

    const parent = uid();
    await db().run("INSERT INTO test_parent (id) VALUES (?)", parent);
    const check = await db().run("INSERT INTO test_child (id, parent_id, n) VALUES (?, ?, -1)", uid(), parent);
    expect(!check.ok && check.error.kind).toBe("check");
    expect(!check.ok && check.error.error.code).toBe("validation_failed");

    const notNull = await db().run("INSERT INTO test_child (id, parent_id) VALUES (?, NULL)", uid());
    expect(!notNull.ok && notNull.error).toMatchObject({ kind: "not_null", columns: ["test_child.parent_id"] });
  });

  it("runs batches atomically and maps their constraint errors", async () => {
    const a = uid();
    const ok = await db().batch<{ id: string }>([
      db().statement("INSERT INTO test_parent (id) VALUES (?)", a),
      db().statement("SELECT id FROM test_parent WHERE id = ?", a),
    ]);
    expect(ok).toEqual({ ok: true, value: [[], [{ id: a }]] });

    const b = uid();
    const failed = await db().batch([
      db().statement("INSERT INTO test_parent (id) VALUES (?)", b),
      db().statement("INSERT INTO test_parent (id) VALUES (?)", a), // duplicate
    ]);
    expect(!failed.ok && failed.error.kind).toBe("unique");
    // The first insert rolled back with the batch.
    expect(await db().first("SELECT id FROM test_parent WHERE id = ?", b)).toEqual({ ok: true, value: null });
    expect(await db().batch([])).toEqual({ ok: true, value: [] });
  });

  it("throws real failures instead of returning them", async () => {
    await expect(db().all("SELECT * FROM no_such_table")).rejects.toThrow();
    expect(constraintError(new Error("network down"))).toBeNull();
  });
});

describe("D1 migrations", () => {
  const migrations = env.TEST_MIGRATIONS;

  it("are named NNNN_<feature>_<change>.sql and numbered without gaps", () => {
    expect(migrations.length).toBeGreaterThan(0);
    migrations.forEach((m, i) => {
      expect(m.name).toMatch(/^\d{4}_[a-z0-9]+_[a-z0-9_]+\.sql$/);
      expect(Number(m.name.slice(0, 4))).toBe(i + 1);
    });
  });

  it("are safe to re-run (TDD §6.5)", async () => {
    for (const migration of migrations) {
      for (const query of migration.queries) {
        if (/^\s*ALTER\s+TABLE\s+\w+\s+ADD\s+COLUMN/i.test(query.replace(/^(\s*--[^\n]*\n)*/, ""))) {
          // SQLite has no ADD COLUMN IF NOT EXISTS. Such a file holds that one statement only, so it is
          // either applied or not; running it again fails with "duplicate column name" and changes nothing.
          await expect(env.DB.prepare(query).run()).rejects.toThrow(/duplicate column name/);
          continue;
        }
        await env.DB.prepare(query).run();
      }
    }
  });

  it("put each ALTER TABLE … ADD COLUMN in a file of its own (TDD §6.5)", () => {
    for (const migration of migrations) {
      const alters = migration.queries.filter((q) => /ALTER\s+TABLE\s+\w+\s+ADD\s+COLUMN/i.test(q));
      if (alters.length > 0) expect(migration.queries, migration.name).toHaveLength(1);
    }
  });
});

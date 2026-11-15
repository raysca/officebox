import { ok } from "@officebox/shared";
import { CoreDurableObject, type DoMigration, type RpcResult } from "./core/do/base";

/**
 * Installation-wide system Durable Object (single instance, named "system").
 *
 * Used by `/health` as the Durable Object ping (TDD §7.1). It has no tables of its own yet; its first
 * migration only records when the object was created, so the schema-versioning path runs in production.
 */
export class SystemObject extends CoreDurableObject {
  protected override migrations(): readonly DoMigration[] {
    return SYSTEM_MIGRATIONS;
  }

  ping(): Promise<RpcResult<{ schemaVersion: number }>> {
    return this.rpc(() => ok({ schemaVersion: this.schemaVersion }));
  }
}

const SYSTEM_MIGRATIONS: readonly DoMigration[] = [
  {
    version: 1,
    description: "record creation time",
    up(sql) {
      sql.exec("INSERT OR IGNORE INTO meta (key, value) VALUES ('created_at', ?)", String(Date.now()));
    },
  },
];

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";

/**
 * Installation-wide system Durable Object (single instance, named "system").
 *
 * M0a declares the class so the first `new_sqlite_classes` migration ships with the scaffold.
 * M0b moves it onto the core DO base class (schema versioning, alarm multiplexer) and uses it
 * for the `/health` Durable Object ping (TDD §7.1).
 */
export class SystemObject extends DurableObject<Env> {
  ping(): { ok: true } {
    return { ok: true };
  }
}

// Spike-only helpers: sample data and password-less login. Enabled only when DEV_LOGIN = "1".
import type { Env } from "./env";

export async function seed(env: Env): Promise<void> {
  const now = Date.now();
  const db = env.DB;
  await db.batch([
    db.prepare(
      `INSERT OR IGNORE INTO users (id, email, display_name, role, created_at) VALUES
        ('alice', 'alice@example.com', 'Alice', 'owner', ?1),
        ('bob', 'bob@example.com', 'Bob', 'member', ?1),
        ('carol', 'carol@example.com', 'Carol', 'member', ?1),
        ('dave', 'dave@example.com', 'Dave', 'member', ?1)`,
    ).bind(now),
    db.prepare("UPDATE users SET status = 'disabled' WHERE id = 'dave'"),
    db.prepare(
      `INSERT OR IGNORE INTO channels (id, type, name, created_by, created_at) VALUES
        ('general', 'public', 'general', 'alice', ?1),
        ('secret', 'private', 'secret', 'alice', ?1)`,
    ).bind(now),
    db.prepare(
      `INSERT OR IGNORE INTO channel_members (channel_id, user_id, role, joined_at) VALUES
        ('general', 'alice', 'admin', ?1), ('general', 'bob', 'member', ?1), ('general', 'carol', 'member', ?1),
        ('secret', 'alice', 'admin', ?1), ('secret', 'bob', 'member', ?1)`,
    ).bind(now),
    // spec: everyone can view; bob may edit. plan: restricted to alice.
    db.prepare(
      `INSERT OR IGNORE INTO documents (id, title, owner_id, general_access, created_at) VALUES
        ('spec', 'Spec', 'alice', 'workspace_view', ?1),
        ('plan', 'Plan', 'alice', 'restricted', ?1)`,
    ).bind(now),
    db.prepare(
      `INSERT OR IGNORE INTO resource_grants (resource_type, resource_id, principal_type, principal_id, role, created_at)
       VALUES ('document', 'spec', 'user', 'bob', 'editor', ?1)`,
    ).bind(now),
  ]);
}

# Officebox — Technical Design Document (TDD)

**Status:** Draft for engineering review  
**Version:** 1.2  
**Date:** 14 November 2026  
**Companion to:** [Officebox PRD v1.2](PRD.md)  
**Changes in 1.2:** Every open technical question now has a decision (§10). Platform facts checked against Cloudflare documentation (Appendix). New or redesigned:
- full-text search (§2.4)
- connection layout, fan-out and socket revocation (§3.5), with the UserHub and WorkspacePresence objects replacing InboxFanout
- compaction and revisions (§4.3)
- Vectorize permission filtering (§5.2–5.3)
- export and restore (§7.5)
- email delivery (§7.6).

The Durable Object value limit is corrected to 8 MB.  
**Changes in 1.1:** Storage ownership and message write path (§2.0, §3.3). Complete Phase 1 schema with permission resolution (§2.1). Deletion, retention and purge (§2.3). Release-sync upgrades, migrations and rollback (§6). First-run setup (§6.8). See [REVIEW.md](REVIEW.md) items C1–C5.

## 1. Architecture overview

Officebox is a single Cloudflare Worker application (with Durable Objects) plus Cloudflare-managed services. There is no origin server, no VPS, no Go runtime, no PostgreSQL and no LiveKit. The entire stack runs inside the customer's Cloudflare account.

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│                              BROWSER / PWA CLIENT                             │
│                                                                               │
│  ┌──────────────────┐  ┌──────────────────┐  ┌────────────────────────────┐  │
│  │ React Shell       │  │ Tiptap + Yjs      │  │ Realtime SFU Client SDK    │  │
│  │ (Workers Assets)  │  │ (y-websocket)     │  │ (WebRTC)                   │  │
│  └────────┬─────────┘  └────────┬─────────┘  └────────────┬───────────────┘  │
└───────────┼─────────────────────┼──────────────────────────┼──────────────────┘
            │ HTTPS               │ WSS                      │ WebRTC
            │                     │                          │
┌───────────▼─────────────────────▼──────────────────────────▼──────────────────┐
│                         CLOUDFLARE WORKER (edge)                              │
│                                                                               │
│  • REST API (auth, members, objects, inbox, search, admin)                    │
│  • WebSocket upgrade routing to Durable Objects                               │
│  • AI Gateway proxy and Vectorize retrieval                                   │
│  • R2 presigned upload/download                                               │
│  • SMTP relay dispatch via Queues                                             │
│  • Static asset serving for the React app                                     │
└───────────┬─────────────────────┬──────────────────────────┬──────────────────┘
            │                     │                          │
┌───────────▼─────────┐ ┌─────────▼──────────┐ ┌─────────────▼─────────────────┐
│  DURABLE OBJECTS    │ │        D1          │ │         R2 / VECTORIZE        │
│                     │ │                    │ │                               │
│  • ChatChannel DO   │ │  • users, groups   │ │  • R2: files, attachments,    │
│    (messages,       │ │  • channel_members │ │    exports                    │
│     presence)       │ │  • channels, grants│ │  • Vectorize: document and    │
│                     │ │  • documents       │ │    message embeddings         │
│  • DocRoom DO       │ │  • issues/tasks    │ │                               │
│    (Yjs document)   │ │  • projects        │ │                               │
│                     │ │  • inbox_items     │ │                               │
│  • BoardRoom DO     │ │  • audit_log       │ │                               │
│    (Yjs whiteboard) │ │  • messages (copy) │ │                               │
│                     │ │  • search (FTS5)   │ │                               │
│  • UserHub DO       │ │                    │ │                               │
│    (per-user)       │ │                    │ │                               │
│                     │ │                    │ │                               │
│  • Presence DO      │ │                    │ │                               │
│    (singleton)      │ │                    │ │                               │
└─────────────────────┘ └────────────────────┘ └───────────────────────────────┘
            │                     │                          │
            └─────────────────────┴──────────────────────────┘
                                  │
                    ┌─────────────▼─────────────┐
                    │   AI GATEWAY (BYOK)        │
                    │   Provider keys in         │
                    │   Secrets Store            │
                    └───────────────────────────┘
```

### 1.1 Component responsibilities

| Component | Responsibility | Cloudflare primitive |
|---|---|---|
| React shell | UI, routing, optimistic updates, PWA | Workers Assets |
| Worker API | Auth, domain logic, permissions, search, AI orchestration, R2 signing, SMTP dispatch | Workers |
| ChatChannel DO | Source of truth for channel messages: event log, ordering, outbox to D1, fan-out, presence, typing, history replay | Durable Object + SQLite |
| DocRoom DO | Authoritative Y.Doc per document, sync, awareness, snapshots | Durable Object + SQLite |
| BoardRoom DO | Authoritative Y.Doc per whiteboard | Durable Object + SQLite |
| UserHub DO | Per-user hub socket: inbox events, unread changes, presence, revocation | Durable Object |
| WorkspacePresence DO | Workspace-wide online status (single instance) | Durable Object + SQLite |
| Workflows | Export and restore jobs | Cloudflare Workflows |
| D1 | Identity, roles, groups, permissions, object metadata, searchable message copy, inbox, audit | D1 |
| R2 | Files, attachments, exports | R2 |
| Vectorize | Embeddings for permission-aware retrieval | Vectorize |
| Realtime SFU | Audio/video huddles, TURN | Cloudflare Realtime |
| AI Gateway | BYOK provider proxy, fallback, rate limiting | AI Gateway |
| Queues | Message and search projection to D1, purge jobs, email, AI indexing (each with a dead-letter queue) | Queues |
| Cron Triggers | Daily purge, retention, reconciliation and release check | Workers Cron Triggers |

### 1.2 Why Durable Objects for both chat and Yjs

Durable Objects provide a single-threaded, stateful coordinator with private SQLite storage and WebSocket hibernation. This is the right primitive for both:

- Chat: one DO per channel provides total ordering, presence and fan-out.
- Yjs: one DO per document/whiteboard provides authoritative CRDT state, conflict-free sync and persistent storage.

Yjs on Durable Objects is a proven pattern: one object holds one document, speaks the standard y-websocket protocol, relays presence, supports snapshots and compaction, and hibernates when idle. Durable Object SQLite can store both chat messages and Yjs updates without a separate database engine.

## 2. Data model

### 2.0 Storage ownership

Every kind of data has exactly one source of truth. Copies are derived from it, can always be rebuilt from it, and are never written to independently.

| Data | Source of truth | Derived copies |
|---|---|---|
| Channel messages, edits, deletions, reactions, threads | ChatChannel DO SQLite (`events`, `messages`) | D1 `messages` (search, inbox, notifications, cross-channel views); Vectorize (Phase 3) |
| Document and whiteboard content | DocRoom / BoardRoom DO SQLite (Yjs) | R2 snapshot copies (export and recovery); search text projection (see §10); Vectorize (Phase 3) |
| Identity, roles, groups, channel membership, grants, object metadata, inbox, audit | D1 | — |
| File bytes | R2 | — (metadata in D1 `files`) |
| Presence, typing, awareness | DO memory and WebSocket attachments | — (never persisted) |

The D1 `messages` copy can be fully rebuilt by replaying each ChatChannel DO's state (§3.3). Export reads channel messages from the DOs, not from D1.

### 2.1 D1 schema (core domain)

D1 uses SQLite semantics. Each D1 database has a 10 GB limit on Workers Paid (500 MB free), with 1 TB total per account. Officebox keeps one D1 database per installation, with logical separation by table.

Conventions:

- IDs are ULIDs stored as `TEXT`. Timestamps are Unix epoch milliseconds stored as `INTEGER`.
- Soft-deletable objects carry `deleted_at` and `purge_after` (§2.3). Normal queries filter `deleted_at IS NULL`.
- Foreign keys are declared wherever both ends live in D1; D1 enforces them by default. Polymorphic references (`resource_grants`, `object_links`, `inbox_items`, `files.parent_*`) can't use foreign keys. The purge pipeline (§2.3) keeps them consistent.
- The schema implements the role model and retention rules in PRD §10.1 and §10.2.

```sql
-- Installation (single row)
CREATE TABLE installation (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  installation_id TEXT NOT NULL,
  name TEXT NOT NULL,
  setup_token_hash TEXT,            -- generated-token mode only; cleared on setup (§6.8)
  setup_token_expires_at INTEGER,
  setup_claim TEXT,                 -- nonce of the request that completed setup
  setup_completed_at INTEGER,
  latest_release TEXT,              -- JSON from the daily release check (§6.7)
  settings TEXT NOT NULL DEFAULT '{}'  -- JSON: storage thresholds, retention overrides
);

-- Identity
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE COLLATE NOCASE,  -- NULL only once deleted
  display_name TEXT NOT NULL,
  password_hash TEXT,                -- NULL once deleted (and for future SSO-only accounts)
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'deleted')),
  session_epoch INTEGER NOT NULL DEFAULT 0,  -- increment to invalidate every session
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  CHECK (status = 'deleted' OR email IS NOT NULL)
);

CREATE TABLE invitations (
  id TEXT PRIMARY KEY,
  email TEXT COLLATE NOCASE,         -- optional for manually shared links
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  token_hash TEXT NOT NULL UNIQUE,   -- single-use; raw token only ever in the link
  invited_by TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL,
  accepted_at INTEGER,
  accepted_by TEXT REFERENCES users(id),
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_hash TEXT NOT NULL UNIQUE,
  session_epoch INTEGER NOT NULL,    -- must equal users.session_epoch to stay valid
  user_agent TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE mfa_factors (           -- Phase 2 (TOTP); table created in Phase 1
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('totp')),
  secret_encrypted TEXT NOT NULL,    -- encrypted with a Worker secret key
  recovery_codes_hash TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);

CREATE TABLE groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE TABLE group_members (
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  added_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX group_members_user ON group_members(user_id);

-- Channels
CREATE TABLE channels (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('public', 'private', 'dm')),
  name TEXT,                         -- NULL for DMs
  topic TEXT,
  dm_key TEXT UNIQUE,                -- sorted participant IDs; one DM per participant set
  created_by TEXT NOT NULL REFERENCES users(id),
  projected_seq INTEGER NOT NULL DEFAULT 0,  -- highest channel event applied to D1
  created_at INTEGER NOT NULL,
  archived_at INTEGER,
  deleted_at INTEGER,
  purge_after INTEGER,
  CHECK ((type = 'dm') = (dm_key IS NOT NULL))
);
CREATE UNIQUE INDEX channels_name ON channels(name) WHERE type != 'dm' AND deleted_at IS NULL;

CREATE TABLE channel_members (
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  last_read_seq INTEGER NOT NULL DEFAULT 0,  -- written by the client, debounced
  notify_level TEXT NOT NULL DEFAULT 'default'
    CHECK (notify_level IN ('default', 'all', 'mentions', 'none')),
  muted_until INTEGER,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX channel_members_user ON channel_members(user_id);

-- Messages: derived copy of ChatChannel DO state (§3.3); rebuildable
CREATE TABLE messages (
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,              -- seq of the message.created event
  id TEXT NOT NULL UNIQUE,
  sender_id TEXT REFERENCES users(id),
  parent_id TEXT,                    -- thread root message ID
  body TEXT,                         -- NULL once deleted
  attachments TEXT,                  -- JSON array of file IDs
  mentions TEXT,                     -- JSON array of user IDs
  reactions TEXT,                    -- JSON: { emoji: [user IDs] }
  created_at INTEGER NOT NULL,
  edited_at INTEGER,
  deleted_at INTEGER,
  last_event_seq INTEGER NOT NULL,   -- guards idempotent, order-independent upserts
  PRIMARY KEY (channel_id, seq)
);
CREATE INDEX messages_parent ON messages(parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX messages_sender ON messages(sender_id, created_at);

-- Documents and whiteboards
CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL DEFAULT 'document' CHECK (type IN ('document', 'whiteboard')),
  title TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id),
  general_access TEXT NOT NULL DEFAULT 'restricted'
    CHECK (general_access IN ('restricted', 'workspace_view', 'workspace_comment', 'workspace_edit')),
  origin_channel_id TEXT REFERENCES channels(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  purge_after INTEGER
);
CREATE INDEX documents_owner ON documents(owner_id);

-- Explicit grants on documents, whiteboards, folders, files (and projects in Phase 2)
CREATE TABLE resource_grants (
  resource_type TEXT NOT NULL CHECK (resource_type IN ('document', 'folder', 'file', 'project')),
  resource_id TEXT NOT NULL,
  principal_type TEXT NOT NULL CHECK (principal_type IN ('user', 'group', 'channel')),
  principal_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'commenter', 'viewer')),
  granted_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (resource_type, resource_id, principal_type, principal_id)
);
CREATE INDEX resource_grants_principal ON resource_grants(principal_type, principal_id);

-- Files
CREATE TABLE folders (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  parent_id TEXT REFERENCES folders(id),
  general_access TEXT NOT NULL DEFAULT 'workspace_view'
    CHECK (general_access IN ('restricted', 'workspace_view', 'workspace_comment', 'workspace_edit')),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  deleted_at INTEGER,
  purge_after INTEGER
);

CREATE TABLE files (
  id TEXT PRIMARY KEY,
  r2_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT,
  uploaded_by TEXT REFERENCES users(id),
  folder_id TEXT REFERENCES folders(id),   -- standalone file: folder access applies
  parent_type TEXT CHECK (parent_type IN ('message', 'document', 'issue')),
  parent_id TEXT,                          -- attachment: inherits the parent's access
  created_at INTEGER NOT NULL,
  deleted_at INTEGER,
  purge_after INTEGER,
  CHECK (NOT (folder_id IS NOT NULL AND parent_type IS NOT NULL))
);
CREATE INDEX files_parent ON files(parent_type, parent_id);
CREATE INDEX files_folder ON files(folder_id);

-- Relationships between workspace objects (never grant access)
CREATE TABLE object_links (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  relation TEXT NOT NULL DEFAULT 'references',  -- references, created_from, supports
  created_by TEXT REFERENCES users(id),
  created_at INTEGER NOT NULL,
  UNIQUE (source_type, source_id, target_type, target_id, relation)
);
CREATE INDEX object_links_target ON object_links(target_type, target_id);

-- Projects and issues (Phase 2; columns finalised then)
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'private')),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  deleted_at INTEGER,
  purge_after INTEGER
);

CREATE TABLE issues (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id),
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL,
  assignee_id TEXT REFERENCES users(id),
  due_date INTEGER,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  purge_after INTEGER
);
CREATE INDEX issues_assignee ON issues(assignee_id, status);

-- Follows, inbox and notification preferences
CREATE TABLE follows (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, object_type, object_id)
);

-- inbox_items is also the store for in-app notifications
CREATE TABLE inbox_items (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('notification', 'action', 'schedule', 'follow')),
  event_type TEXT NOT NULL,          -- mention, dm, assignment, review_request, ...
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  actor_id TEXT REFERENCES users(id),
  dedupe_key TEXT NOT NULL,          -- e.g. channel ID + event seq
  state TEXT NOT NULL DEFAULT 'unread'
    CHECK (state IN ('unread', 'read', 'snoozed', 'done', 'dismissed')),
  priority INTEGER NOT NULL DEFAULT 0,
  snooze_until INTEGER,
  due_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  resolved_at INTEGER,
  purge_after INTEGER,               -- resolved_at + 90 days
  UNIQUE (user_id, dedupe_key)
);
CREATE INDEX inbox_items_user_state ON inbox_items(user_id, state, created_at);
CREATE INDEX inbox_items_source ON inbox_items(source_type, source_id);

CREATE TABLE notification_preferences (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  delivery TEXT NOT NULL CHECK (delivery IN ('in_app', 'email', 'push')),
  enabled INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, event_type, delivery)
);

-- Audit (never stores message or document content)
CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  actor_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  metadata TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX audit_log_created ON audit_log(created_at);
CREATE INDEX audit_log_actor ON audit_log(actor_id, created_at);

-- Background work
CREATE TABLE purge_jobs (
  id TEXT PRIMARY KEY,
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  stage TEXT NOT NULL,               -- next step to run; see §2.3
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  run_after INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (object_type, object_id)
);

CREATE TABLE embedding_jobs (        -- Phase 3
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'indexed', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE INDEX embedding_jobs_source ON embedding_jobs(source_type, source_id);
```

**Permission resolution** (implements PRD §10.1). The Worker resolves access in this order and stops at the first match:

1. **Account:** the user's status must be `active`.
2. **Workspace role:** owners and admins get *management* rights (rename, archive, delete, manage members). They do **not** get implicit read access to private channels, DMs or restricted documents.
3. **Channels:** public channels are readable by every member. Private channels and DMs require a `channel_members` row.
4. **Documents, folders and files:**
   - Explicit `resource_grants` to the user, to any of their groups, or to a channel they belong to. The highest role wins.
   - Otherwise, `general_access`.
   - Attachments resolve through their parent object.
5. **Otherwise:** no access.

Every privileged action by an owner or admin on a private object is written to `audit_log`.

### 2.2 Durable Object SQLite schemas

**ChatChannel DO** — one per channel. This is the source of truth for the channel's messages.

```sql
-- Append-only event log; seq is assigned by the DO, gap-free and monotonic
CREATE TABLE events (
  seq INTEGER PRIMARY KEY,
  type TEXT NOT NULL,     -- message.created | message.edited | message.deleted
                          -- | reaction.added | reaction.removed
  message_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  client_id TEXT,         -- client idempotency key (message.created only)
  payload TEXT NOT NULL,  -- JSON; redacted when the message is deleted
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX events_client ON events(actor_id, client_id) WHERE client_id IS NOT NULL;
CREATE INDEX events_message ON events(message_id);

-- Current state of each message, updated in the same transaction as the event
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL UNIQUE,   -- seq of message.created
  sender_id TEXT NOT NULL,
  parent_id TEXT,
  body TEXT,                     -- NULL once deleted
  attachments TEXT,
  mentions TEXT,
  reactions TEXT,
  created_at INTEGER NOT NULL,
  edited_at INTEGER,
  deleted_at INTEGER,
  last_event_seq INTEGER NOT NULL
);
CREATE INDEX messages_parent ON messages(parent_id) WHERE parent_id IS NOT NULL;

-- Transactional outbox: events not yet copied to D1
CREATE TABLE outbox (
  seq INTEGER PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL
);

CREATE TABLE meta (
  key TEXT PRIMARY KEY,    -- schema_version, channel_id, log_horizon_seq, timers
  value TEXT
);
```

Presence and typing state are not stored in SQLite (§3.4).

**Event log horizon.** The `messages` table is kept for as long as the channel exists. The `events` log is only needed for reconnect replay, so it is trimmed to a horizon (default 30 days, never before `outbox` is drained). A client whose `afterSeq` is older than `log_horizon_seq` gets a `reset` and reloads from `messages` (§3.3).

**Deletion redaction.** A `message.deleted` event sets `messages.body`, `attachments`, `mentions` and `reactions` to NULL. In the same transaction it overwrites the `payload` of all earlier events for that message with `{"redacted":true}`. Deleted content is never served through replay.

**DocRoom / BoardRoom DO** — one per document/whiteboard:

```sql
CREATE TABLE updates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  update_blob BLOB NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE snapshots (
  id INTEGER NOT NULL,
  chunk INTEGER NOT NULL DEFAULT 0,  -- snapshots over 4 MB are split across rows
  state_blob BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (id, chunk)
);

-- Revision history index; version state is stored in R2
CREATE TABLE versions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('hourly', 'daily', 'named')),
  name TEXT,
  r2_key TEXT NOT NULL,
  created_by TEXT,
  created_at INTEGER NOT NULL
);

-- Outbox for the search text projection (same pattern as ChatChannel)
CREATE TABLE outbox (
  id INTEGER PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL
);

CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
```

Compaction, chunking and revision history are described in §4.3. A single SQLite row, string or BLOB can be up to 8 MB. Snapshots are split into 4 MB chunks so even large whiteboards fit with headroom. Binary assets such as images live in R2 and are referenced from the Yjs document, never embedded in it.

**UserHub DO** — one per user (`idFromName(user_id)`). It holds the user's hub WebSockets and delivers inbox events, unread changes, presence changes and revocations (§3.5). It has no tables beyond `meta` (`schema_version`): inbox items are durable in D1, and a reconnecting client reloads its state over REST.

**WorkspacePresence DO** — a single instance (`idFromName("presence")`):

```sql
CREATE TABLE online (
  user_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,          -- online, away, dnd
  since INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL
);
```

### 2.3 Deletion, retention and purge

This implements PRD §10.2.

**Soft delete (Trash).** Deleting a channel, document, whiteboard, folder, file, project or issue sets `deleted_at = now` and `purge_after = now + 30 days`. The object disappears from normal queries, search and previews straight away. An owner or admin restores it by clearing both fields.

**Purge pipeline.** A daily Cron Trigger finds rows with `purge_after < now` and inserts `purge_jobs` rows. Each job moves through idempotent stages, delivered on the `purge` Queue with retries and backoff. Failed jobs appear in admin health (§7.1).

| Object | Purge stages |
|---|---|
| Channel | ChatChannel DO `purge()` (`ctx.storage.deleteAll()`), then attached files (R2 delete), then D1 `messages`, `channel_members`, `inbox_items`, `object_links` and `resource_grants` where the channel is the principal, then vectors (Phase 3), then the `channels` row. |
| Document / whiteboard | DocRoom / BoardRoom DO `deleteAll()`, then R2 snapshot copies (prefix delete), then attached files, then grants, links and inbox items, then vectors, then the `documents` row. |
| Folder | Contained files and subfolders (each through its own job), then the row. |
| File | R2 object, then the `files` row. |

**Message deletion is immediate, not trashed.**

1. The DO redacts the message (§2.2) and appends a `message.deleted` event.
2. The D1 copy sets `body` to NULL via the normal projection (§3.3).
3. Attached files get purge jobs with `run_after = now`.
4. Vectors are invalidated (Phase 3).

**User deletion.** One D1 batch does the following and writes an audit entry:

- Sets `email` and `password_hash` to NULL and `display_name` to "Former member".
- Sets `status` to `deleted` and increments `session_epoch`.
- Deletes the user's `sessions`, `mfa_factors`, `notification_preferences`, `follows`, `inbox_items`, user-principal `resource_grants` and `group_members` rows.
- Transfers `documents.owner_id` to the acting admin.

Messages keep `sender_id`. Clients render deleted senders as "Former member". **Disable** only sets `status` to `disabled` and increments `session_epoch`.

**Time-based retention.** The daily Cron Trigger also:

- deletes `audit_log` rows older than the configured retention (default 365 days)
- deletes resolved `inbox_items` past `purge_after`
- trims each active ChatChannel DO's event log to its horizon
- deletes expired invitations and sessions.

**Platform recovery windows.** D1 Time Travel and Durable Object point-in-time recovery keep up to 30 days of history. Officebox recommends an R2 lifecycle rule that expires noncurrent object versions after 30 days. Purged data is therefore unrecoverable no more than about 30 days after purge, as stated in PRD §10.2.

### 2.4 Full-text search

Phase 1 search uses D1's FTS5 support over messages and documents.

```sql
-- Plain-text projection of document/whiteboard content (written by DocRoom via its outbox)
CREATE TABLE document_text (
  document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  source_update_id INTEGER NOT NULL,  -- guards idempotent, order-independent upserts
  updated_at INTEGER NOT NULL
);

CREATE VIRTUAL TABLE search_index USING fts5(
  title,
  body,
  object_type UNINDEXED,   -- message, document, whiteboard, file
  object_id UNINDEXED,
  scope_id UNINDEXED,      -- channel ID for messages; document or folder ID otherwise
  tokenize = 'unicode61 remove_diacritics 2'
);
```

**Indexing.**

- Messages: the message projection consumer (§3.3) inserts, replaces or deletes rows in `search_index` in the same D1 batch as the `messages` upsert.
- Documents and whiteboards: once updates have been quiet for 5 seconds (and at most once every 60 seconds), the DO extracts the title and plain text and queues it through its outbox to the `search-projection` Queue. The consumer upserts `document_text` and `search_index` together.
- File names are indexed when uploaded. File contents are not indexed in Phase 1.

**Querying.**

1. A CTE builds the requesting user's accessible scopes, following the §2.1 rules:
   - public channels
   - channels from `channel_members`
   - documents and folders reachable through `resource_grants`, group membership or `general_access`.
2. The FTS `MATCH` results are joined to those scopes and ranked by `bm25()`, with `snippet()` for highlights.
3. Results for deleted or trashed objects never appear, because deletion removes their rows from `search_index`.

**Export and storage.**

- `wrangler d1 export` doesn't support databases that contain virtual tables. So the Officebox export (§7.5) uses its own JSON Lines format, leaves out `search_index`, and rebuilds it on restore.
- The admin guide documents the raw-dump workaround: drop the FTS table, export, then recreate it and use **Rebuild search index**. D1 Time Travel is unaffected.
- FTS roughly doubles the storage used by indexed text. It counts towards D1's 10 GB limit, and storage monitoring includes it.


## 3. Application realtime design (Durable Objects)

### 3.1 Connection lifecycle

1. The client authenticates via the Worker (POST /auth/session) and receives a short-lived JWT.
2. The client opens a WebSocket to /ws/channels/:channelId or /ws/docs/:documentId, passing the JWT as a query parameter (browsers cannot set headers on WebSocket upgrades).
3. The Worker validates the JWT and permission, then forwards the request to the appropriate Durable Object.
4. The DO accepts the WebSocket using ctx.acceptWebSocket(server) and attaches serialized state (user ID, permissions, connection ID) via serializeAttachment.
5. On hibernation wake, the constructor runs and state is restored from the attachment.

### 3.2 Hibernation

All application WebSockets use the Hibernation WebSocket API. When no events arrive, the DO is evicted from memory; clients remain connected to Cloudflare's network and billable duration stops accruing. A message wakes the object automatically.

Design rule: minimize constructor work. Do not fetch from D1 or rebuild large state in the constructor; load only what is needed to handle the waking event, and persist durable state in DO SQLite or connection attachments.

### 3.3 Message write path and D1 copy

The ChatChannel DO is the source of truth. D1 receives a guaranteed, idempotent copy through a transactional outbox.

**Client operations** over the channel WebSocket:

| Operation | Fields | Allowed for |
|---|---|---|
| `message.send` | `clientId`, `body`, `parentId?`, `attachments?` | Channel members |
| `message.edit` | `messageId`, `body` | The author |
| `message.delete` | `messageId` | The author or a channel admin |
| `reaction.add` / `reaction.remove` | `messageId`, `emoji` | Channel members |

Limits: body up to 40 KB, which stays far below the 8 MB DO row limit; up to 20 attachments per message.

**Write path:**

1. The DO checks the payload and the caller's permission, using the connection attachment (§3.1).
2. Within one synchronous SQLite transaction (`ctx.storage.transactionSync`):
   - **Dedupe:** if `(actor_id, client_id)` already exists, re-acknowledge the existing `seq` and stop.
   - Assign `seq = last + 1`, insert into `events`, update `messages` (applying redaction for deletes), and insert an `outbox` row.
   - Schedule the alarm if no earlier one is set. The default batching delay is 250 ms.
3. After the commit, the DO sends `{type: "ack", clientId, seq, id}` to the sender and `{type: "event", seq, ...}` to every connected socket. DO output gating means no acknowledgement leaves the object before its write is durable.
4. The **alarm handler** drains the `outbox` in `seq` order, in batches of up to 100. For each event it sends the **current full state** of the affected message (from `messages`, not the event delta) to the `message-projection` Queue with `sendBatch`.
   - Rows are deleted only after the send succeeds.
   - On failure the DO increments `attempts` and reschedules with exponential backoff, capped at 5 minutes.
   - DOs have one alarm each. Other timers (typing expiry, log trimming) are kept in `meta.timers`, and the alarm is always set to the earliest due timer.
5. The **queue consumer** upserts into D1 `messages`:
   ```sql
   ... ON CONFLICT (channel_id, seq) DO UPDATE SET ...
       WHERE excluded.last_event_seq > messages.last_event_seq
   ```
   Because each delivery carries full state guarded by `last_event_seq`, duplicate or out-of-order delivery is harmless. The consumer also advances `channels.projected_seq` and creates inbox items for mentions, DMs and thread replies (`dedupe_key = channel_id:seq`), then hands them to notification delivery. Failed batches retry, then go to a dead-letter queue. DLQ depth is shown in admin health.
6. **Reconciliation:** a daily Cron Trigger compares `channels.projected_seq` with each recently active DO's latest `seq` and asks lagging DOs to re-enqueue the missing range. An admin action, **Rebuild message index**, replays every channel's full `messages` state into D1.

**Read paths:**

- The channel view, thread views, history paging and reconnect replay read from the **DO**. These are authoritative and immediately consistent.
- Search, Personal Inbox, notifications and cross-channel views read from **D1**. These are eventually consistent and normally a few seconds behind.
- Export reads from the **DOs**.

**Sync protocol:**

- `{type: "sync", afterSeq}`: the DO returns events with `seq > afterSeq`, up to 500 per page, with `more: true` when there are more. If `afterSeq < log_horizon_seq`, it returns `{type: "reset"}` instead.
- `{type: "history", beforeSeq, limit}`: returns pages of current message state from `messages`, used for scrollback and after a `reset`.
- Thread replies are ordinary messages with `parentId` in the same channel log. Thread views query `messages` by `parent_id`.

**DMs.** The Worker creates DM channels through the REST API. It computes `dm_key` from the sorted participant IDs, so each set of participants has exactly one DM. Channel DOs are addressed with `idFromName(channel_id)`.
### 3.4 Presence

Presence is ephemeral and stored in DO memory and connection attachments, not in D1. On connect/disconnect, the DO broadcasts presence.joined / presence.left. Typing indicators are presence states with a short TTL, refreshed by the client and expired by the DO.

Presence is never the source of truth for durable data.

### 3.5 Connection topology, fan-out and revocation

**At most three WebSockets per tab:**

1. **Hub socket** (always open) to the user's UserHub DO. It carries inbox and notification events, unread changes for *all* channels, workspace presence and revocation commands.
2. **Channel socket** to the ChatChannel DO of the channel currently on screen. Switching channels closes the previous one.
3. **Document socket** to the DocRoom or BoardRoom DO of the document currently open.

Tabs of the same browser elect a leader with `BroadcastChannel` and share one hub socket.

**Unread state.** On connect, the client loads unread and mention counts over REST. The unread count is the number of D1 `messages` with `seq > channel_members.last_read_seq` that the user didn't send. The mention count comes from unread `inbox_items`. After that, counts are kept current by hub events.

**Fan-out.** After applying a batch, the message projection consumer (§3.3, step 5):

1. Finds the highest new `seq` for each affected channel.
2. Gets the set of online users from WorkspacePresence: one RPC per batch, cached in the consumer for 5 seconds.
3. Sends **one** `activity` RPC per online member of the affected channels, carrying every affected channel and any new inbox items for that user. However many messages a batch holds, each UserHub receives at most one call per batch, and offline users cost nothing.
4. Notifies offline recipients of mentions and DMs through their notification preferences (email in Phase 1, web push in Phase 2). They see the inbox items on their next load.

**Workspace presence.**

- A UserHub calls `online(userId)` on WorkspacePresence when its first socket connects and `offline(userId)` when its last socket closes.
- While sockets are open, a UserHub alarm sends a heartbeat every 5 minutes. Entries with no heartbeat for 12 minutes expire.
- Presence changes are broadcast to online UserHubs. Changes are infrequent: connects, disconnects and status changes.
- Per-channel presence (who is viewing or typing) stays in ChatChannel DO memory (§3.4).

**Keepalive.** Every DO sets `setWebSocketAutoResponse` for application ping/pong. Keepalives then neither wake the object nor add billed duration. Clients pause document awareness updates while their tab is hidden, so idle open documents can hibernate.

**Revocation.** Whenever a user is disabled or deleted, a session is revoked, or the user loses access to a channel or document, the Worker calls `closeConnections(userId, reason, scope)`:

- on the user's UserHub, and
- on every affected ChatChannel, DocRoom or BoardRoom DO.

Each DO closes matching sockets with application close code `4401` (session revoked) or `4403` (access removed). The client re-authenticates or leaves the view. Because a session's hub socket is closed and refresh is refused, a disabled user loses all realtime access within seconds.

## 4. Collaborative editing design (Yjs on Durable Objects)

### 4.1 Server architecture

Each document or whiteboard is a DocRoom Durable Object. The DO:

- Holds the authoritative Y.Doc in memory.
- Accepts WebSocket connections using the standard Yjs sync protocol (y-websocket).
- Applies incoming updates to the Y.Doc.
- Persists updates to DO SQLite.
- Broadcasts updates to other connected clients.
- Compacts the update log into snapshots periodically.
- Manages awareness (presence, cursors) and relays it to peers.
- Enforces roles (owner/editor/commenter/viewer) server-side; read-only roles' updates are rejected.

### 4.2 Client architecture

The React client uses:

- Tiptap with the Collaboration extension for documents.
- A Yjs-based whiteboard component (e.g. Excalidraw with Yjs binding) for whiteboards.
- y-websocket provider pointed at /ws/docs/:id.
- IndexedDB persistence for offline support and reconnection.

The client sends a JWT in the WebSocket URL. The DO validates it via the authorize hook (implemented in the Worker before forwarding) and assigns a role.

### 4.3 Persistence, compaction and revisions

- Updates are appended to the `updates` table in DO SQLite.
- **Compaction** runs at whichever comes first:
  - 500 updates since the last snapshot
  - 1 MB of uncompacted updates
  - the last client disconnecting, so the object compacts before it hibernates.

  Compaction writes `Y.encodeStateAsUpdate(doc)` as a new snapshot, split into 4 MB chunks when needed, and then deletes the updates it folded in. Keystroke-level updates therefore never trigger constant compaction.
- **Cold start:** the DO loads the latest snapshot, joining any chunks, and replays later updates.
- **Recovery copy:** after compaction, the latest snapshot is copied to R2 at `docs/<id>/latest.ystate`, at most every 15 minutes.
- **Revision history** (PRD §5.5):
  - While a document is being edited, the DO writes a full-state version to R2 at most once an hour (`docs/<id>/versions/<ulid>.ystate`) and records it in `versions`. Named versions are written on request.
  - The daily Cron Trigger thins versions: hourly versions for 7 days, one per day for 90 days, named versions for the document's lifetime.
  - Versions are full states, so Yjs garbage collection stays enabled.
  - To view a version, the client loads it into a temporary read-only `Y.Doc`.
  - To restore one, the client writes that content into the live document as a new change. Collaborators converge normally and history is kept.
- **Search projection:** see §2.4.

### 4.4 Permissions

Permissions are resolved by the Worker before the WebSocket reaches the DO. The DO trusts the role passed in the connection attachment and enforces it:

- Owner/editor: may send Yjs updates.
- Commenter/viewer: may receive updates and awareness, but outbound updates are dropped and answered with a permission error.
- No access: connection is rejected.

Link previews and AI retrieval always re-check permissions in the Worker/D1; the DO is not the authority for cross-object access.

## 5. AI design (BYOK, permission-aware RAG)

### 5.1 BYOK flow

1. Administrator configures provider keys in AI Gateway → Provider Keys. AI Gateway stores them in Secrets Store; the application never handles the raw key.
2. The Worker calls AI Gateway with the provider path (e.g. /openai/chat/completions) and cf-aig-authorization for gateway auth.
3. AI Gateway substitutes the stored provider key at runtime.
4. Key rotation is done in the dashboard with no code changes.

### 5.2 Ingestion pipeline

1. On document save or message creation, the Worker enqueues an embedding_jobs record in D1 and a message on a Queue.
2. A queue consumer Worker loads the content (from D1 or DO), chunks it, generates embeddings via Workers AI, and upserts vectors into Vectorize.
3. Each vector carries only scope metadata: `object_type`, `object_id`, `scope_id` (the channel ID for messages, the document or folder ID otherwise) and `chunk`. Only `object_type` and `scope_id` are metadata indexes, using 2 of the 10 allowed. **Vectors hold no user or role lists.** Permission changes therefore never require rewriting vectors. Only deleting or moving an object does.
4. On deletion, or when a message moves out of a channel, the Worker queues an invalidation job that deletes the object's vectors.
5. Changing the embedding model requires a new index, because index dimensions are fixed at creation, followed by a full re-index. This is delivered as a release migration that builds the new index before switching to it.

### 5.3 Retrieval flow

1. User asks a question.
2. Worker generates a query embedding via Workers AI.
3. The Worker computes the user's accessible scopes, using the same CTE as search (§2.4).
4. If the scope list fits within Vectorize's 2,048-byte filter limit (about 60 IDs), the query uses `scope_id $in [...]`. Otherwise the query runs unfiltered with `topK = 50` and metadata returned.
5. Every candidate is then checked against D1 permissions, whichever query path was used. D1 is the authority.
6. If fewer permitted results remain than needed, they are topped up with permitted FTS keyword matches from §2.4 (hybrid retrieval). Users with narrow access still get useful answers.
7. The model receives only permitted snippets; the response cites source objects the user can access.

Design rule: permission filtering happens before model invocation, not after. No vector is passed to the model unless the requesting user is authorised to see its source.

### 5.4 Audit

AI tool invocations and mutating actions are written to audit_log with actor, action, target, model/provider and outcome. Retention is configurable; default retention is defined before Phase 3.

## 6. Deployment and upgrades

Upgrades are delivered as **release-sync pull requests** in the customer's own repository (PRD §13). The running application never holds Cloudflare or GitHub credentials.

### 6.1 Deploy to Cloudflare

The repository includes a `wrangler.jsonc` with:

- Durable Object namespaces (ChatChannel, DocRoom, BoardRoom, UserHub, WorkspacePresence) as SQLite-backed classes.
- Workflows (export and restore).
- D1 database.
- R2 bucket.
- Vectorize index.
- Workers AI binding.
- Queues and their dead-letter queues: `message-projection`, `search-projection`, `purge`, `email`, `indexing`.
- Rate Limiting binding (setup, login and invitation endpoints).
- Cron Triggers (daily maintenance: purge, retention, reconciliation, release check).
- Observability (Workers Logs) enabled. This is needed for generated setup tokens (§6.8).
- Build-time variable `OFFICEBOX_VERSION`.

The Deploy to Cloudflare button copies the repository into the customer's GitHub account, provisions the supported resources and runs the deploy command:

```text
node scripts/preflight.mjs && wrangler d1 migrations apply DB --remote && wrangler deploy
```

`SETUP_TOKEN` is declared in `.dev.vars.example`, which the Deploy flow uses to prompt for secrets. Cloudflare doesn't document whether a prompted secret can be left blank, so the generated-token fallback (§6.8) covers that case. The Deploy flow writes the IDs of newly created resources back into the `wrangler.jsonc` committed to the customer's repository. The release-sync merge script (§6.4, step 5) keeps them. The Deploy button also supports GitLab, but release-sync needs GitHub Actions, so the README recommends GitHub. AI Gateway, BYOK keys, Realtime SFU credentials, SMTP credentials and custom domains are not provisioned automatically. They appear in the admin post-deploy checklist.

### 6.2 Upstream releases and channels

- **Stable:** signed tags `vX.Y.Z` on upstream `main`.
- **Beta:** signed tags `vX.Y.Z-beta.N` on upstream `beta`.
- Tags are signed with the Officebox release key. The public key is pinned in the customer repository at `.officebox/release-signing-key.pub` and rotated only through a signed release.
- Each release publishes a machine-readable `release.json`:
  ```json
  {
    "version": "1.4.0",
    "channel": "stable",
    "security": false,
    "rollback_safe_to": "1.3.0",
    "migrations": ["0012_add_folders.sql"],
    "notes_url": "..."
  }
  ```
  `rollback_safe_to` is the oldest version that can run on this release's schema (§6.5).
- A static **release manifest** listing the latest release per channel is published with every release, on a static host such as GitHub Pages. Installations read this manifest instead of calling the GitHub REST API, because unauthenticated API rate limits apply per egress IP and Workers share egress IPs.

### 6.3 Customer repository layout

| Path | Purpose |
|---|---|
| `.officebox/config.json` | `{ "channel": "stable", "upstream": "<upstream repo URL>", "auto_merge": "none" }`. `auto_merge` is one of `none`, `security` or `patch`. The `channel` value is the authoritative channel setting; the admin UI only displays it. |
| `.officebox/version` | Upstream version the repository currently matches; used as the diff base. |
| `.officebox/release-signing-key.pub` | Pinned release-signing public key. |
| `.github/workflows/officebox-release-sync.yml` | The release-sync workflow. It updates itself through releases. |
| `custom/` | Supported extension point (theme, configuration, plugins). Upstream releases never modify it. |
| `wrangler.jsonc` | Contains the customer's resource IDs. Merged specially (§6.4, step 5). |

### 6.4 Release-sync workflow

- **Triggers:** daily schedule, plus `workflow_dispatch` (**Check for updates now**).
- **Permissions:** `contents: write`, `pull-requests: write`.
- **Repository setting:** *Allow GitHub Actions to create and approve pull requests* must be enabled. It is on the post-deploy checklist, and the workflow fails with an explanatory message if it is off.

Steps:

1. Read `.officebox/config.json` and `.officebox/version`. Fetch upstream tags and select the newest tag for the configured channel that is newer than the installed version. When switching from beta to stable, only a stable version newer than the installed beta qualifies.
2. Verify the tag signature against the pinned key. Stop if it is invalid.
3. If an open sync PR for that version already exists, stop. Close any older, superseded sync PRs.
4. On branch `officebox/release-vX.Y.Z`, apply the upstream diff between the installed tag and the new tag as a three-way patch:
   ```text
   git diff vOLD vNEW | git apply --3way
   ```
   Cloudflare doesn't document whether the customer's copy keeps upstream git history, so the design doesn't rely on it: a diff between tags works either way. Then update `.officebox/version`.
5. Merge `wrangler.jsonc` with `scripts/merge-wrangler.mjs`. It takes the upstream structure but keeps local resource IDs, names and customer-added bindings.
6. Open a PR titled "Upgrade Officebox to vX.Y.Z (channel)". The body carries release notes, the migration list, `rollback_safe_to` and any security flag.
   - **Conflicts:** the PR opens as a draft labelled `officebox-conflict`. It lists the conflicted files and links to resolution guidance. Conflict markers make the build fail, so a conflicted release can't deploy.
7. **Auto-merge:** if `auto_merge` allows it (a patch or security release on stable), the release has no conflicts and checks pass, the workflow merges the PR.

Notes:

- PRs created with `GITHUB_TOKEN` don't trigger other GitHub workflows. Workers Builds is triggered by the Cloudflare GitHub App on push to the production branch, so merging still deploys.
- GitHub disables scheduled workflows in public repositories after 60 days without activity. The post-deploy checklist therefore recommends a **private** customer repository. The admin UI also warns when the installed version has been behind the latest release for more than 7 days, because that may mean the workflow is disabled.

### 6.5 Build, migrations and compatibility

Merging to the production branch triggers Workers Builds:

1. **Preflight:** check that the required bindings exist, D1 is reachable, and the migration set is consistent with `release.json`.
2. `wrangler d1 migrations apply --remote`.
3. `wrangler deploy`.

If any step fails, the build stops and the previous Worker version stays live.

Migrations run **before** the new code goes live, and can be partly applied if a build fails. So every release follows an **expand/contract** rule: its schema must work with both its own code and the code of every version back to `rollback_safe_to`.

- **Allowed in any release:** new tables, new nullable or defaulted columns, new indexes, and backfills that older code tolerates.
- **Contract steps** (drop or rename columns, tighter constraints) ship only once no supported rollback target depends on the old shape. `rollback_safe_to` advances at that point and the release notes say so.
- Cloudflare doesn't document whether each migration file runs in a single transaction, so **migrations are treated as possibly partly applied**. Each file holds one logical change and is safe to re-run, using `IF NOT EXISTS` and guarded backfills. Applied files are tracked in D1's `d1_migrations` table.
- Upstream CI runs the previous release's integration tests against the new schema, to enforce the rule.

**Durable Object schemas** follow the same rule:

- Each DO stores `schema_version` in `meta`.
- It migrates lazily on first wake, inside `blockConcurrencyWhile`, so thousands of objects never need a coordinated migration.
- Older code must tolerate a newer, expanded DO schema.

**Durable Object class migrations** (`new_sqlite_classes` and so on) only ever *add* classes within a rollback window. Renames and deletions follow the contract rule.

The admin UI shows the applied migrations (from D1's migrations table) next to the running version, and flags a schema that is ahead of the code.

### 6.6 Rollback

- **Normal rollback:** roll back the Worker to any version at or after `rollback_safe_to`, from the dashboard or with `wrangler rollback`. No database restore is needed. The owner then reverts the upgrade merge commit in the repository, otherwise the next build redeploys the newer version. The admin UI walks through both steps.
- **Rolling back past `rollback_safe_to`:** this is an emergency procedure. It needs a D1 Time Travel restore and Durable Object point-in-time recovery, and loses changes made since the restore point. It is documented, not automated.
- Workers Builds keeps build history and logs for 90 days. Worker versions remain available for rollback after that.

### 6.7 Update awareness

The daily Cron Trigger fetches the release manifest (§6.2) and stores the result in `installation.latest_release`. The admin UI shows owners:

- the installed `OFFICEBOX_VERSION` and channel
- the latest release on that channel and its notes
- a link to the repository's open sync PR.

A security release that hasn't been installed after 48 hours raises a persistent banner for owners.

### 6.8 First-run setup

Until `installation.setup_completed_at` is set, every route except `/setup`, `/health` and static assets redirects to `/setup`.

**Token source:**

1. **`SETUP_TOKEN` secret set:** it is used as the token. It must be at least 32 characters.
2. **No secret:** on the first request, the Worker generates a 32-byte random token. It stores the SHA-256 hash and a 24-hour expiry with `INSERT … ON CONFLICT DO NOTHING`, so concurrent first requests produce a single token. It logs the token once to Workers Logs with a clear marker. Only members of the Cloudflare account can see these logs. An expired token is replaced and logged again on the next visit.

**Setup submission:** `POST /setup` with `{ token, workspaceName, ownerEmail, ownerName, password }`.

- Rate-limited by IP (Rate Limiting binding).
- Token hashes are compared in constant time.
- Completion is one atomic D1 batch, so only one request can ever win:
  ```sql
  UPDATE installation
     SET setup_claim = :nonce, setup_completed_at = :now, setup_token_hash = NULL
   WHERE id = 1 AND setup_completed_at IS NULL;

  INSERT INTO users (id, email, display_name, password_hash, role, status, created_at, updated_at)
  SELECT :id, :email, :name, :hash, 'owner', 'active', :now, :now
    FROM installation
   WHERE id = 1 AND setup_claim = :nonce;
  ```
- An audit entry is written.

**After setup:** `/setup` returns 404 permanently and `SETUP_TOKEN` is ignored. The admin UI recommends deleting the secret.

**Optional hardening:** the documentation describes putting Cloudflare Access in front of the workspace during setup.

## 7. Operations and observability

### 7.1 Health checks

A /health endpoint checks:

- Worker and D1 connectivity.
- Durable Object namespace availability (lightweight ping to a system DO).
- R2 bucket access.
- Vectorize index presence.
- AI Gateway configuration (if configured).
- Realtime SFU credentials (if configured).
- Message-projection lag (oldest outbox entry, DLQ depth) and failed purge jobs.
- Installed version, latest release on the channel, applied migrations vs. running code (§6.5–6.7).

### 7.2 Diagnostics bundle

The admin can download a support bundle containing:

- Worker version and deployment ID.
- Binding configuration (without secrets).
- Recent audit log entries.
- D1 storage usage.
- R2 usage summary.
- Durable Object error counts (last 24h).
- Queue backlog.

### 7.3 Alerts

Officebox uses Cloudflare's observability and optional external alerting (email/webhook) for:

- Elevated Worker error rate.
- D1 query failures.
- Durable Object exceptions.
- R2 write failures.
- Queue backlog growth.
- Storage approaching limits.

### 7.4 Backup and recovery guidance

- D1: Time Travel restores to any minute in the last 30 days. Officebox documents how to use it and warns when a restore point is needed.
- R2: lifecycle rules and object versioning; Officebox documents recommended configuration.
- DO SQLite: snapshots are copied to R2 for export; the export is the portable recovery path.
- Application export: see §7.5.

### 7.5 Export and restore

Implements PRD §13. Exports and restores run as **Cloudflare Workflows**: durable, retried, multi-step jobs that are not bound by request time limits.

```sql
CREATE TABLE exports (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('export', 'restore')),
  state TEXT NOT NULL CHECK (state IN ('running', 'complete', 'failed')),
  include_files INTEGER NOT NULL DEFAULT 1,
  manifest_r2_key TEXT,
  error TEXT,
  requested_by TEXT REFERENCES users(id),
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);
```

**Export format v1.** Written under `exports/<id>/` in the installation's R2 bucket:

| Path | Content |
|---|---|
| `manifest.json` | Format version, Officebox version, D1 schema version, creation time, row/object counts, SHA-256 for every part, each channel's exported `seq`, each document's state vector |
| `d1/<table>.jsonl` | One JSON object per row, written in pages of 1,000. Excludes `search_index`, `sessions`, `mfa_factors`, setup fields and job tables. |
| `channels/<id>/messages.jsonl` | Current message state from the ChatChannel DO, including tombstones |
| `docs/<id>/state.ystate` | Native Yjs state |
| `docs/<id>/content.md` or `content.json` | Readable rendering (Markdown for documents, JSON for whiteboards) |
| `docs/<id>/versions/` | Retained versions |
| `files/<file id>` | File bytes, if `include_files` is set. Otherwise the manifest lists keys and checksums only. |

**Rules:**

- **Secrets are never exported:** SMTP credentials, AI keys and the setup token stay out. MFA secrets are encrypted with an installation-specific key, so they are left out and users re-enrol after a restore. Password hashes are included, so passwords keep working.
- **Download:** owners download a single `.tar` streamed by the Worker. The command-line tool (`officebox export pull`) fetches parts with resume support.
- **Consistency:** each object is internally consistent. **Maintenance mode** makes the workspace read-only for a fully consistent export. It closes every socket through the UserHubs, reconnects them read-only, and makes the Worker reject writes.
- **Scheduled exports** (optional; weekly by default when enabled) keep the latest 4. Exports count towards R2 storage.

**Restore:**

1. The first-run setup page of a fresh installation offers **Restore from export**, which still requires the setup token (§6.8).
2. The archive is uploaded through the Worker with R2 multipart upload. Very large archives can instead be placed in the bucket with Wrangler, and `officebox-restore` then starts the Workflow.
3. The Restore Workflow checks the manifest and checksums. It accepts exports from the same Officebox version or older, and maps older logical schemas forward.
4. It inserts D1 rows in foreign-key order in batches. It rebuilds each ChatChannel DO with `importMessages`, keeping `seq`, and each DocRoom or BoardRoom with its state and versions. It writes files back to their R2 keys and rebuilds `search_index`.
5. It completes setup. All sessions are invalid and users with MFA must re-enrol.

**Testing:** CI exports a fixture installation, restores it into a fresh one and compares them, on every release.

### 7.6 Email delivery

Email sits behind an adapter interface with two kinds of driver:

1. **HTTP API providers** (recommended): Resend, Postmark, Amazon SES, Mailgun or SendGrid, called with `fetch`. The API key is a Worker secret. This is the simplest and most reliable option from Workers.
2. **Generic SMTP:** a TCP socket via `connect()`, using STARTTLS on port 587 (`secureTransport: "starttls"`, then `startTls()`) or implicit TLS on port 465, with AUTH PLAIN or LOGIN, through a maintained Workers-compatible SMTP library. Cloudflare blocks outbound port 25, so direct delivery to recipient mail servers isn't possible.

Cloudflare Email Workers are not used for invitations. Their sending binding is aimed at verified destination addresses rather than arbitrary recipients *(verify against current Cloudflare email offerings before ruling out)*.

**Delivery:**

- Messages are sent through the `email` Queue.
- The consumer retries transient failures (network errors, HTTP 429 or 5xx, SMTP 4xx) up to 8 times with exponential delay via `message.retry({ delaySeconds })`: 1 minute, doubling, capped at 2 hours.
- Permanent failures (HTTP 4xx other than 429, SMTP 5xx) are not retried. They are recorded with the provider's error.
- Messages that exhaust their retries go to the dead-letter queue. Admin health shows failures and DLQ depth.
- Each email carries an idempotency key (the job ID), passed to providers that support one.
- **Send test email** in the admin settings checks the configuration.
- Invitation links can always be copied manually, so onboarding never depends on email.

## 8. Security model

- Authentication: local accounts; passwords hashed with a memory-hard KDF; session JWTs short-lived and rotated.
- Authorisation: the role model in PRD §10.1, resolved as described in §2.1. Owners and admins get management rights but no implicit read access to private content. All checks occur in the Worker before DO access.
- First-run setup: protected by a one-time setup token with atomic claim; permanently disabled after use (§6.8).
- Session and access revocation: incrementing `users.session_epoch` invalidates refresh. `closeConnections` closes open WebSockets on the UserHub and the affected channel and document DOs within seconds (§3.5).
- Upgrades: no Cloudflare or GitHub credentials are held by the running application. Release tags are signature-verified against a pinned key before a sync PR is opened (§6.4).
- Secrets: provider keys in AI Gateway Secrets Store; SMTP credentials as Worker secrets; no provider keys in D1 or browser code.
- AI: retrieval permission-filtered; prompt-injection treated as untrusted input; tool calls permission-checked server-side; mutating actions require confirmation.
- WebSockets: JWT validated on upgrade; DO attachment stores user and role; read-only roles cannot write.
- Audit: administrative and AI-sensitive actions written to audit_log.
- Data ownership: all data in the customer's Cloudflare account; export endpoint for portability.

## 9. Testing and validation

### 9.1 Phase 1 validation tests

- Deploy test: fresh Cloudflare account → Deploy to Cloudflare → invited user can log in and send a message.
- Hibernation test: idle channel for >5 minutes; client remains connected; sending a message wakes the DO and delivers to all clients.
- Yjs sync test: two clients edit the same document concurrently; both converge; a stock Yjs client can connect.
- Persistence test: restart/evict DO; document state survives via snapshot + update replay.
- Permission test: viewer cannot write Yjs updates. (AI retrieval permission tests move to Phase 3.)
- Setup test: a fresh deployment refuses setup without the token. Concurrent setup requests create exactly one owner. `/setup` returns 404 afterwards. Both the secret and generated-token modes are tested.
- Message durability test: with the projection queue blocked or D1 writes failing, messages are still acknowledged, ordered and replayable from the DO. After recovery, D1 converges with no duplicates or loss. Duplicate `clientId` sends create one message.
- Edit/delete test: edits and deletions reach connected clients, reconnect replay and D1. A deleted message's content is absent from DO events, the D1 copy and search.
- Purge test: Trash restore works within 30 days. After `purge_after`, every stage completes and no D1, DO or R2 data remains. User deletion removes personal data and transfers document ownership.
- Access test: a member without access can't read a private channel, DM or restricted document through the REST API, WebSocket, search, previews or links. Admins without a grant can't read them either.
- Upgrade test: the release-sync workflow opens a correct PR from a fresh customer copy (with signature verification), including a `wrangler.jsonc` merge that keeps resource IDs. Merging deploys. A conflicted release opens as a draft and can't deploy. Stable → beta works.
- Rollback test: rolling back one version after a release with migrations works without a database restore (expand/contract). The previous release's integration tests pass against the new schema.
- Storage test: upload rejection triggers before D1/DO storage exhaustion; admin warning appears.
- Export/restore test: export a fixture installation, restore into a fresh installation from first-run setup, and compare row counts, checksums, channel `seq` positions and document content. Missing export configuration warns but does not block startup.
- Search test: results match permitted messages and documents only. Deleting or trashing removes results. **Rebuild search index** reproduces the index.
- Revocation test: disabling a user, or removing them from a private channel or document, closes their open sockets within 5 seconds.
- Fan-out test: a 100-message burst in a busy channel produces at most one UserHub call per online member per consumer batch, and offline members get none.
- Compaction test: a long editing session compacts on the size and count thresholds. A document with a snapshot over 4 MB loads correctly from chunks. Hourly versions appear and restore correctly.

### 9.2 Performance targets

- Chat message round-trip: p95 < 300 ms within region.
- Document sync latency: p95 < 200 ms for keystroke propagation.
- Cold document load: < 1 s for documents under 100 KB snapshot.
- Huddle join: < 2 s from click to audio.

## 10. Open technical questions

Every question open at v1.1 now has a decision:

| Question | Decision | Where |
|---|---|---|
| Vectorize filtering and a secondary index | Scope-only metadata (no user lists); `$in` filter when the scope list fits, otherwise unfiltered `topK = 50`; D1 permission check is always final; FTS top-up | §5.2–5.3 |
| InboxFanout DO vs. D1 polling | Neither: a per-user **UserHub** DO with a single hub socket, plus a single **WorkspacePresence** DO; batched fan-out to online users only | §2.2, §3.5 |
| Snapshot compaction tuning | Compact at 500 updates, 1 MB or last disconnect; 4 MB chunks; hourly and daily versions in R2 | §4.3 |
| Export format and restore tooling | Export format v1 (JSON Lines + Yjs + files) produced by Workflows; Restore from export in first-run setup; CLI for large archives | §7.5 |
| SMTP provider matrix and retry policy | HTTP API providers preferred; STARTTLS SMTP on port 587 or 465; 8 retries with exponential backoff capped at 2 h; DLQ | §7.6 |
| Deploy to Cloudflare behaviour | Checked: secrets come from `.dev.vars.example`; resource IDs are written back into `wrangler.jsonc`; git history not documented, so the design doesn't depend on it | §6.1, §6.4 |
| D1 migration transactions | Not documented, so migrations are treated as possibly partly applied: one change per file, safe to re-run, expand/contract | §6.5 |
| Event log horizon and outbox batching | Defaults: 30-day horizon, 250 ms batching delay, 100 events per batch | §2.2, §3.3 |
| Search text projection and FTS export | DocRoom extracts plain text through an outbox to `document_text` and FTS5; the export excludes FTS and restore rebuilds it | §2.4 |

Resolved in v1.1:
- Message storage split: the DO is the source of truth, with an outbox to a D1 copy (§2.0, §3.3).
- Upgrade mechanism: release-sync GitHub Actions PR plus Workers Builds; no deploy Worker (§6).

**Still to confirm by measurement, not decision:** the Phase 1 load test (REVIEW.md H2) should confirm or adjust these numeric defaults:
- compaction thresholds
- outbox batching
- fan-out cache time
- heartbeat interval
- the Durable Object request budget for a 25-person team, against the 1 million requests per month included in Workers Paid.

---

## Appendix — Key Cloudflare references

| Concern | Reference |
|---|---|
| Durable Object WebSocket hibernation | Hibernation API keeps clients connected while the DO sleeps, reducing cost |
| D1 limits | 10 GB per database on Workers Paid; 100,000 databases included |
| D1 Time Travel | Restore to any minute in the last 30 days |
| Vectorize + Workers AI RAG | Managed RAG pipeline with D1, Vectorize and Workers AI |
| AI Gateway BYOK | Keys stored in Secrets Store; rotate without code changes |
| Realtime SFU/TURN pricing | 1,000 GB free egress/month shared; $0.05/GB thereafter |
| Yjs on Durable Objects | One object per document; standard y-websocket; hibernation; snapshots |
| Deploy to Cloudflare | Clones repo, provisions resources, builds and deploys |
| Workers Builds retention | 90-day build/log retention; versions persist for rollback |
| Worker rollback | Roll back to a previous version via dashboard or Wrangler |

### Platform facts checked against Cloudflare documentation (14 November 2026)

| Fact | Value |
|---|---|
| Deploy to Cloudflare | Source repo must be public. Supports GitHub and GitLab (not self-hosted). Auto-provisions KV, D1, R2, Hyperdrive, Vectorize, Secrets Store secrets, Durable Objects, Workers AI and Queues. Writes new resource IDs back into the Wrangler config. Prompts for secrets from `.dev.vars.example`. Git history kept: not documented. |
| D1 | Supports FTS5. `wrangler d1 export` doesn't support databases with virtual tables. Foreign keys enforced by default. Migrations tracked in `d1_migrations`. Per-file transaction behaviour: not documented. |
| Durable Objects limits | 10 GB per SQLite-backed object. Up to 8 MB per row, string or BLOB. |
| Durable Objects pricing (Workers Paid) | 1M requests/month included, then $0.15 per million (WebSocket messages, RPC and alarms count; incoming WebSocket messages at a 20:1 ratio). 400,000 GB-s duration included. 5 GB-month SQLite storage included. `setWebSocketAutoResponse` adds no billed duration. |
| Vectorize | topK up to 50 with values or metadata, 100 without. 10 metadata indexes per index. 10 KiB metadata per vector. Filter operators `$eq $ne $in $nin $lt $lte $gt $gte`. Filter JSON under 2,048 bytes. |
| Workers TCP sockets | Outbound port 25 blocked. STARTTLS supported. |

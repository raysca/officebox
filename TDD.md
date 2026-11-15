# Officebox — Technical Design Document (TDD)

**Status:** Draft for engineering review  
**Version:** 1.5  
**Date:** 14 November 2026  
**Companion to:** [Officebox PRD v1.5](PRD.md) and the feature and cross-cutting specs in [`specs/`](specs/)  
**Changes in 1.5:** second independent review applied:
- core DDL fixed (`group_dm`, inbox records, availability, refresh grace, admin-reset flag, three file kinds); new tables listed (§2.1)
- channel config RPC, `call_chat`, Chat §4.6 system kinds, durable UserHub state and the ReminderScheduler outbox (§2.2)
- refresh grace window, per-request revocation check, email-change confirmation, `GET /me`, and setup creating identity objects only (§3.1, §6.8, §8.1)
- message size caps, dedupe keys and admin deletion in private channels (§3.3)
- the unread definition, `applyConfig` / `updateAccess`, and the durable room registry (§3.5)
- the `/calls` API with join and leave; "Phase 2" labels removed from calls (§3.6, §6.1, §9)
- secrets inventory, export exclusions, protective mode, scheduled jobs and foundation spike items (§6.1, §7.5, §7.7, §7.8, §10).

**Changes in 1.4:** brought in line with the eight specs ([Identity](specs/identity.md), [Chat](specs/chat.md), [Calls](specs/calls.md), [Calendar](specs/calendar.md), [Documents](specs/documents.md), [Permissions](specs/permissions.md), [Notifications](specs/notifications.md), [Platform](specs/platform.md)):
- baseline schema value lists and new tables, with spec data-model sections authoritative for feature tables (§2.1)
- the union permission rule and admin limits (§2.1)
- ChatChannel message, poll and preview state, plus the ReminderScheduler DO (§2.2)
- lifecycle and cascades delegated to Platform §3–§5 (§2.3)
- search through drive and folder inheritance (§2.4)
- passkeys, magic links and scanner-safe email links (§3.1)
- the six-socket budget and role-downgrade propagation (§3.5)
- call context keys, rings, handoff and in-call chat (§3.6)
- comment anchors and compare (§4.3–4.4)
- bindings, queues and settings (§6.1); export coverage (§7.5); scheduled jobs (§7.8)
- outbound fetching and link previews at launch (§8.2)
- new tests (§9.1) and open questions (§10).

**Changes in 1.3:**
- Huddles with screen sharing (HuddleRoom DO, §3.6) and present mode (§4.5).
- Cookie and ticket authentication for WebSockets (§3.1).
- Post-deploy checklist (§6.1).
- Storage protective mode, scheduled jobs, and the usage panel with telemetry (§7.7–7.9).
- Expanded security model (§8).
- Phase 2 validation (§9.3).
- Cost model (Appendix B).

**Changes in 1.2:** Every open technical question now has a decision (§10). Platform facts checked against Cloudflare documentation (Appendix). New or redesigned:
- full-text search (§2.4)
- connection layout, fan-out and socket revocation (§3.5), with the UserHub and WorkspacePresence objects replacing InboxFanout
- compaction and revisions (§4.3)
- Vectorize permission filtering (§5.2–5.3)
- export and restore (§7.5)
- email delivery (§7.6).

The Durable Object value limit is corrected to 8 MB.  
**Changes in 1.1:** Storage ownership and message write path (§2.0, §3.3). Complete Phase 1 schema with permission resolution (§2.1). Deletion, retention and purge (§2.3). Release-sync upgrades, migrations and rollback (§6). First-run setup (§6.8).

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
│  • R2 streamed upload/download (binding)                                      │
│  • Email dispatch via Queues                                                  │
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
│                     │ │                    │ │                               │
│  • HuddleRoom DO    │ │                    │ │                               │
│    (per huddle)     │ │                    │ │                               │
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
| Worker API | Auth, domain logic, permissions, search, AI orchestration, R2 streaming, email dispatch, huddle signalling via the SFU API | Workers |
| ChatChannel DO | Source of truth for channel messages: event log, ordering, outbox to D1, fan-out, presence, typing, history replay | Durable Object + SQLite |
| DocRoom DO | Authoritative Y.Doc per document, sync, awareness, snapshots | Durable Object + SQLite |
| BoardRoom DO | Authoritative Y.Doc per whiteboard | Durable Object + SQLite |
| UserHub DO | Per-user hub socket: inbox events, unread changes, presence, revocation | Durable Object |
| WorkspacePresence DO | Workspace-wide online status (single instance) | Durable Object + SQLite |
| Workflows | Export and restore jobs | Cloudflare Workflows |
| D1 | Identity, roles, groups, permissions, object metadata, searchable message copy, inbox, audit | D1 |
| R2 | Files, attachments, exports | R2 |
| Vectorize | Embeddings for permission-aware retrieval | Vectorize |
| HuddleRoom DO | Huddle roster, track registry, single-presenter control, host actions | Durable Object |
| Realtime SFU | Audio, video and screen-share media; TURN | Cloudflare Realtime |
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
- **Authority:**
  - This section is authoritative for the **core** tables: installation, users, sessions, invitations, groups, channels, channel members, the message copy, resource grants, audit, jobs.
  - The **spec data-model sections** are authoritative for feature tables, and this document is the integration point that lists them: Identity §5, Chat §15, Calls §10, Calendar §12, Documents §9, Notifications §7, Permissions §9, Platform §8, §11, §12 and §15.
  - [Platform §14](specs/platform.md) reconciles every change.
- **Enums that may grow are validated with Zod** in `packages/shared`, not with SQL `CHECK` constraints (Platform §14). The value lists are given as comments below. Fixed sets (for example `group_members.role`) may keep a `CHECK`.
- **Baseline rule:** spec changes to a table are folded into the baseline migration of the milestone that first creates it, so no table is rebuilt. After a release, changes follow expand/contract (§6.5).

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
  role TEXT NOT NULL DEFAULT 'member',  -- owner | admin | member | guest (guest reserved for Phase 2; Zod)
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'deleted')),
  session_epoch INTEGER NOT NULL DEFAULT 0,  -- increment to invalidate every session
  pending_security_notice TEXT,      -- shown on the sign-in page (Identity §4.6)
  admin_reset_at INTEGER,            -- no-email recovery flag shown to owners (Identity §4.6)
  admin_reset_by TEXT,
  admin_reset_acknowledged_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  CHECK (status = 'deleted' OR email IS NOT NULL)
);
-- Profile columns, `handle` (copy of the authoritative `handles` table) and the
-- `handles`, `passkeys` and `auth_tokens` tables are defined in Identity §5.
-- `auth_tokens.kind`: magic_link | password_reset | recovery | email_change (Zod), with a `payload` column.

CREATE TABLE invitations (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE, -- always required; copy-link invites are bound to it (Identity §4.2)
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
  previous_refresh_hash TEXT,        -- 30-second grace window after rotation (§8.1)
  rotated_at INTEGER,
  user_agent TEXT,
  device_label TEXT,
  approx_location TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE ws_tickets (            -- one-time WebSocket connect tickets (§3.1)
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target TEXT NOT NULL,              -- e.g. docs:<id>
  expires_at INTEGER NOT NULL,       -- 30 seconds after issue
  used_at INTEGER
);

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
  type TEXT NOT NULL,                -- public | private | dm | group_dm (Zod); dm_key required for dm and group_dm
  name TEXT,                         -- NULL for DMs
  topic TEXT,
  dm_key TEXT UNIQUE,                -- sorted participant IDs; one DM per participant set
  created_by TEXT NOT NULL REFERENCES users(id),
  projected_seq INTEGER NOT NULL DEFAULT 0,  -- highest channel event applied to D1
  config_version INTEGER NOT NULL DEFAULT 0, -- bumped on every config push to the DO (Chat §3.4)
  created_at INTEGER NOT NULL,
  archived_at INTEGER,
  deleted_at INTEGER,
  purge_after INTEGER,
  CHECK ((type IN ('dm', 'group_dm')) = (dm_key IS NOT NULL))  -- dm_key rule, not a growable enum list
);
CREATE UNIQUE INDEX channels_name ON channels(name) WHERE type NOT IN ('dm', 'group_dm') AND deleted_at IS NULL;
-- topic, description and posting_policy: Chat §15.

CREATE TABLE channel_members (
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  last_read_seq INTEGER NOT NULL DEFAULT 0,  -- written by the client, debounced
  notify_level TEXT NOT NULL DEFAULT 'default'
                                     -- default | all | mentions | mute (direct @you only) | nothing (Notifications §4)
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
  general_access TEXT NOT NULL DEFAULT 'restricted',  -- restricted | workspace_view | workspace_comment | workspace_edit (Zod)
  origin_channel_id TEXT REFERENCES channels(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  purge_after INTEGER
);
CREATE INDEX documents_owner ON documents(owner_id);

-- Explicit grants on documents, whiteboards, folders, files (and projects in Phase 2)
CREATE TABLE resource_grants (
  resource_type TEXT NOT NULL,       -- document | whiteboard | folder | file | drive | calendar | project (Zod; Permissions §9)
  resource_id TEXT NOT NULL,
  principal_type TEXT NOT NULL CHECK (principal_type IN ('user', 'group', 'channel')),
  principal_id TEXT NOT NULL,
  role TEXT NOT NULL,                -- owner | manager (drives) | editor | commenter | viewer | freebusy (calendars) (Zod)
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
  general_access TEXT NOT NULL DEFAULT 'restricted',  -- new items follow their container (Permissions §5.2)
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
  folder_id TEXT REFERENCES folders(id),   -- drive file: folder/drive access applies; versioned (Documents §6)
  parent_type TEXT,                        -- message | document | issue (Zod)
  parent_id TEXT,                          -- attachment: inherits the parent's access
  -- Three kinds (Platform §14): message-owned (parent_type = 'message') and document-owned
  -- (parent_type = 'document': images and file cards in a document) never get a folder or versions
  -- and are deleted with their parent; drive files have folder_id set and are versioned.
  -- "Save to folder" copies a message-owned file into a new drive file (copied_from_file_id).
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

-- inbox_items is also the store for in-app notifications. Shape per Notifications §3.1 and §7:
-- one record per recipient and dedupe key; a new event updates an open record and reopens a
-- resolved one in place (count reset to 1); message deletion retracts matching records.
CREATE TABLE inbox_items (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                -- notification | action | schedule | follow (Zod)
  event_type TEXT NOT NULL,          -- Notifications §3 catalogue (Zod)
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  message_id TEXT,                   -- latest message, for retraction on delete
  actor_id TEXT REFERENCES users(id),
  dedupe_key TEXT NOT NULL,          -- Notifications §3 keys, e.g. dm:<channelId>, mention:<channelId>:<messageId>
  count INTEGER NOT NULL DEFAULT 1,
  preview TEXT,                      -- plain-text excerpt, up to 140 characters, redactable
  state TEXT NOT NULL DEFAULT 'unread',  -- unread | read | snoozed | done | dismissed (Zod)
  priority INTEGER NOT NULL DEFAULT 0,
  snooze_until INTEGER,
  due_at INTEGER,
  created_at INTEGER NOT NULL,
  last_event_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  resolved_at INTEGER,
  purge_after INTEGER,               -- resolved_at + 90 days
  UNIQUE (user_id, dedupe_key)
);
CREATE INDEX inbox_items_user_state ON inbox_items(user_id, state, last_event_at);
CREATE INDEX inbox_items_source ON inbox_items(source_type, source_id);
CREATE INDEX inbox_items_message ON inbox_items(message_id) WHERE message_id IS NOT NULL;

-- user_preferences, user_availability and notify_anyway_log: Notifications §7.

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

**Schema changes from the specs.** Platform §14 has the complete table. In summary:

| Area | Change | Defined in |
|---|---|---|
| Identity | `users` profile columns, `handle` (copy of the authoritative `handles` table), `pending_security_notice` and the `admin_reset_*` flag; new `handles`, `passkeys`, `auth_tokens` (kinds `magic_link`, `password_reset`, `recovery`, `email_change`, plus `payload`); `invitations.group_ids`; `groups.handle`; `group_members.role` (manager, member); `sessions.device_label` / `approx_location` / `previous_refresh_hash` / `rotated_at` | Identity §5 |
| Chat | `channels.topic` / `description` / `posting_policy` / `config_version`; `channel_members.can_post` / `hidden` (no per-conversation email delay); message copy columns `kind` (`user`, `call_chat` or a Chat §4.6 system kind), `format`, `system_payload`, `reply_count`, `also_in_channel`, `forwarded_from`, `previews` (`body` stays the plain-text copy); new `thread_follows`, `saved_items` (`in_progress` / `done`), `sidebar_prefs`, `link_previews`, `message_previews` | Chat §15 |
| Permissions | `resource_grants` value lists; `general_access` values including `workspace_freebusy` (calendars only); `access_requests` with `expires_at` and a unique pending request per requester and object | Permissions §9 |
| Documents | `drives`, `file_versions`, `stars`, `recent_items`, `comment_threads`, `comments`, `item_activity`; `folders.drive_id` / `channel_id`; `documents.folder_id` / `drive_id` / `created_by`; `files.drive_id` / `current_version` / `copied_from_file_id` | Documents §9 |
| Calendar | `calendars`, `events` (with `range_start` / `range_end` UTC ms on every event), `event_exceptions`, `event_attendees`, `event_reminders`, `event_notes`, `time_off`, `ics_feeds`, `ics_subscriptions`. Holidays are generated, not stored. | Calendar §12 |
| Calls | `huddles.context_type` adds `event`; new `huddles.context_key` carries the active-call unique index; new `huddle_messages` (keyed to the context, no cascade from `huddles`) and `call_rings` (`state` includes `refused`) | Calls §10, §3.6 here |
| Notifications | `inbox_items` (above); `user_preferences` (email delay, DM text opt-in, DND, reminder defaults, offline cache, shortcuts), `user_availability` (derived-availability sources), `notify_anyway_log`; `notification_preferences` keyed by `user_id, event_type, delivery` | Notifications §3.1, §5.7, §7 |
| Timers | `scheduled_triggers` and `trigger_outbox` in the ReminderScheduler DO; D1 `pending_emails` | Platform §11 |
| Platform | `rate_counters` (D1 counters), `ics_opt_outs`, the durable UserHub room registry | Platform §8, §12, §15 |
| Files | Three kinds: message-owned (`parent_type = 'message'`), document-owned (`parent_type = 'document'`), drive files (`folder_id` set, versioned) | Platform §14, Documents §6 |

**Permission resolution** ([Permissions](specs/permissions.md) §5). The Worker resolves access as follows:

1. **Account:** the user's status must be `active`.
2. **Channels and messages** don't use grants. Access comes from channel type and membership, or DM participation. Members add people to private channels; channel admins remove them. Message-owned files inherit their message's access.
3. **Documents, whiteboards, files, folders and drives use the union rule.** The effective role is the **highest** of:
   - grants on the item
   - grants on each ancestor folder up to the drive root
   - grants on the drive, plus built-in drive roles (My files → owner; group drive → group members edit)
   - the channel-folder rule (channel members edit; public channel → everyone can view)
   - the general access of the item and of each ancestor.

   Grants count for the user, any of their groups, and any channel they're in. There is no deny: sharing can only widen. New items follow their container (Permissions §5.2), so nothing starts workspace-wide unless its folder is.
4. **Calendars** use the same rule without folders: grants, built-in kind rules and general access. **Event visibility then filters the result** (Calendar §4.5): private events show as busy blocks to editors who aren't the organiser or an attendee; invitees always see full details.
5. **Otherwise:** no access.

This replaces v1.3's "stop at the first match".

**Admin limits** (Permissions §6):
- Owners and admins get management rights (rename, archive, delete, manage members), with **no implicit read access** to private channels, DMs or restricted items. Admins can't join private channels.
- Admins may change email, issue recovery links, disable and delete **members** only. Acting on admins or owners, and inviting or promoting admins, needs an owner.
- Every recovery link or email change notifies the person (old address plus an in-app banner) and revokes their other pending tokens.
- Every privileged action on a private object is written to `audit_log`.
- An admin adding **themselves** to a group, or granting **themselves** a role on a drive or folder, needs an owner.
- Recovery links issued without email configured are flagged on the sign-in page and to every owner (`users.admin_reset_*`).
- Admins can delete messages in public channels and in private channels they're a member of.

**Resource decisions the engine encodes** (Permissions §4): document owners, editors and admins can remove others' comments; anyone who can open a document (viewers included) can start a call on it; event calls can be started or joined by the organiser, attendees and full-details viewers; owners and admins can delete a private event whose organiser is disabled or deleted without seeing its details; **restore from Trash** is allowed for the item's owner, the person who deleted it, drive managers of its drive, and admins.

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

**Message state and new event types** (Chat §15, §16):
- **Message state** adds `kind` (`user`, `call_chat`, or a system kind using the Chat §4.6 names, such as `member_joined`, `channel_renamed`, `call_started`, `call_ended`, `missed_call`, `poll_closed`, `message_pinned` or `welcome`), `format` (rich-text JSON), `body` (plain-text copy), `mentions`, `system_payload`, `reply_count`, `last_reply_at`, `thread_participants`, `also_in_channel`, `forwarded_from` (a live reference, never copied content) and `previews`.
- **New event types:** `message.pinned` / `message.unpinned`, `poll.created` / `poll.voted` / `poll.closed`, `preview.attached` / `preview.removed`.
- **Polls** live in the DO's `polls` table (with a per-poll `poll_secret`) and `poll_votes` (`poll_id`, `voter_key`, `option_ids`).
- **Anonymous poll exception:** for `poll.voted` on an anonymous poll, the event's `actor_id` is the per-poll **`voter_key` = HMAC(poll_secret, user ID)**, never a user ID. The member's identity can't be recovered from the event log, the outbox or exports (`poll_secret` is excluded from exports).
- **System messages** are written by typed RPCs, for example `postSystemEvent` from the HuddleRoom for `call_started`. They may post into announcement, read-only and archived channels.
- **`call_chat` messages** (in-call chat) are thread replies under `call_started` that create no thread follows, notifications, offline email or unread counts, with their own rate limit (Chat §4.7).
- **Channel configuration** is pushed by the Worker with the RPC `applyConfig({ version, type, postingPolicy, archived, readOnly, posters, members? })` and stored in DO `meta` (Chat §3.4). The DO ignores a config with a lower `version` than the one it holds. Changes to an open socket's rights are sent as `access.changed`.
- **Size caps:** rich-text JSON at most 100 KB, at most 50 distinct reactions and 3 previews per message, so the projected message state stays under 110 KB, inside the 128 KB queue message limit (Chat §4.1).

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

**UserHub DO** — one per user (`idFromName(user_id)`). It holds the user's hub WebSockets and delivers inbox events, unread changes, presence changes, rings and revocations (§3.5). State that must survive hibernation is stored in its SQLite (Platform §12):
- the **room registry** `(kind, room_id, connection_id)`, with kinds `channel`, `doc`, `board` and `huddle`
- live **ring state** and **`currentCall`** (Calls §4, §5)
- **held-notification state** during DND, focus and time off (Notifications §5)
- **derived availability**, recomputed by `refreshAvailability()` from `user_availability`, `user_preferences` and tab activity (Notifications §5.7).

Inbox records themselves are durable in D1, and a reconnecting client reloads them over REST.

**WorkspacePresence DO** — a single instance (`idFromName("presence")`):

```sql
CREATE TABLE online (
  user_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,          -- online, away, dnd
  since INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL
);
```

**ReminderScheduler DO** — a single instance, which can be sharded by `hash(userId)` later. It holds `scheduled_triggers` (Platform §11.1):
- **Trigger kinds:** `reminder`, `event_start` (raises `call_starting`), `focus_start` / `focus_end`, `time_off_start` / `time_off_end`, `status_expire`, `dnd_start` / `dnd_end`, `dnd_until_end`, `email_release`. Availability kinds call UserHub `refreshAvailability()`.
- **Filling:** a rolling 48-hour expansion of recurring events and per-attendee time zones. The calendar service updates triggers on every change, and an hourly refill job extends the window.
- **Firing (outbox pattern):** one alarm, set to the earliest of the next unfired trigger and the next outbox retry. In one DO transaction the trigger is marked fired and a `trigger_outbox` row is written; the alarm drains the outbox to the queue, deleting rows only after a successful send. The consumer is idempotent on the trigger ID, so each trigger has at most one effect, retried until delivered (Platform §11.1).
- **Catch-up:** triggers less than 1 hour overdue fire; older ones are dropped and logged.

**HuddleRoom** keys calls by `context_key` (§3.6).

### 2.3 Deletion, retention and purge

This implements PRD §10.2.

**Soft delete (Trash).** Deleting a channel, document, whiteboard, folder, drive, drive file, calendar, event, project or issue sets `deleted_at = now` and `purge_after = now + 30 days`. The object disappears from normal queries, search and previews straight away. Restoring it clears both fields. **Who may restore** (one rule everywhere, Platform §5): the item's owner, the person who deleted it, drive managers of its drive, and admins. `time_off` has no Trash: it keeps `deleted_at` for audit and is hard-deleted 30 days later.

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

**Cascades for new containers** ([Platform](specs/platform.md) §4 defines each row):
- **Channel purge** moves the documents in its channel folder to their creators' My files (an admin's if the creator was deleted), keeping explicit shares. It deletes message-owned files and link previews with the messages. It cleans up polls, pins, saved items, `thread_follows`, sidebar sections and grants where the channel is the principal. Huddle records keep their `context_id`.
- **Group deletion** sends the group drive to Trash, archives the group calendar, removes the group's grants and releases its handle. Expanded attendees stay as individuals.
- **Calendar deletion** (standalone and external kinds only) deletes its events, attendee rows and triggers.
- **Drive deletion** sends the drive and its contents to Trash; restore follows the rule above.
- **Group and channel calendar purge** moves each event to its organiser's personal calendar so attendees keep it; events whose organiser was deleted are deleted, with `event_cancel` sent to attendees (Platform §4).
- **Event deletion** applies to a series or an occurrence.
- **File purge** deletes every version.
- **Comment threads** are deleted with their document.

**Member lifecycle and personal-data erase.** [Platform](specs/platform.md) §3 defines, per feature, what happens on **disable** (everything kept; sign-in blocked; sockets closed, including calls) and **delete** (personal data erased). §3.1 there is the authoritative erase list. It covers profile fields, passkeys, auth tokens, sessions, preferences, follows, saved items, stars, recent items, time off, event notes and reminders, ICS feeds and subscriptions, inbox items, access requests, and the avatar object in R2. It also re-renders `@handle` text as "Former member" in message copies and the search index. Ownership transfers on delete: My files, organised events and owned calendars go to an admin. Messages keep `sender_id`.

**Retention and Trash** for every object are in [Platform](specs/platform.md) §5, including who may restore from each container. The daily cron runs those rules: audit log, resolved inbox items, event-log horizons, expired invitations, sessions, tickets and auth tokens, huddle metadata (365 days), call rings, outside-attendee emails, access requests and link previews. **In-call chat** for document and event calls is kept for the life of its context, not with huddle metadata.

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
- When a member is deleted, `@handle` text in the plain-text message copy and in `search_index` is re-rendered as "Former member" (Platform §3).

**Querying.**

1. A CTE builds the requesting user's accessible scopes, following the §2.1 rules:
   - public channels
   - channels from `channel_members`
   - documents, whiteboards, drive files and folders reachable under the **union rule** (§2.1): grants on the item, its ancestor folders and its drive, built-in drive roles, the channel-folder rule (members of the channel, or everyone for public channels), and general access along the chain
   - message-owned files, searchable by file name only within conversations the user can read.
2. The FTS `MATCH` results are joined to those scopes and ranked by `bm25()`, with `snippet()` for highlights.
3. Results for deleted or trashed objects never appear, because deletion removes their rows from `search_index`.

**Export and storage.**

- `wrangler d1 export` doesn't support databases that contain virtual tables. So the Officebox export (§7.5) uses its own JSON Lines format, leaves out `search_index`, and rebuilds it on restore.
- The admin guide documents the raw-dump workaround: drop the FTS table, export, then recreate it and use **Rebuild search index**. D1 Time Travel is unaffected.
- FTS roughly doubles the storage used by indexed text. It counts towards D1's 10 GB limit, and storage monitoring includes it.


## 3. Application realtime design (Durable Objects)

### 3.1 Connection lifecycle and authentication

1. The client signs in with `POST /auth/password`, a magic link or a passkey (below). The Worker sets two cookies, both `HttpOnly`, `Secure` and `SameSite=Lax`:
   - `ob_session`: a short-lived (15-minute) signed access token carrying user ID, session ID and `session_epoch`.
   - `ob_refresh`: a 30-day rotating refresh token, scoped to `/auth/refresh` and stored hashed in `sessions`.

   JavaScript can't read either token, and neither ever appears in a URL.
2. The client opens WebSockets to `/ws/hub`, `/ws/channels/:id`, `/ws/docs/:id` or `/ws/calls/:id` (after `POST /calls/:id/join`, §3.6). Browsers send same-origin cookies with the upgrade request.
3. The Worker validates the cookie and checks the `Origin` header against the installation's origin, which blocks cross-site WebSocket hijacking. It then resolves the user's role for the target and forwards the request to the Durable Object.
4. The DO accepts the socket with `ctx.acceptWebSocket(server)` and stores the user ID, session ID, role and connection ID with `serializeAttachment`.
5. Sockets deliberately outlive the 15-minute token. Revocation closes them (§3.5), not token expiry. The client refreshes the access cookie in the background so reconnects succeed.
6. **Clients that can't send cookies** (a stock Yjs client, future native apps) use a one-time connect ticket:
   - The client calls `POST /auth/ws-ticket` while authenticated.
   - The ticket is single-use, valid for 30 seconds and bound to one target. It is passed as `?ticket=` and stored hashed in `ws_tickets`.
   - A logged URL therefore never leaks a reusable credential.
7. When the DO wakes from hibernation, the constructor runs and state is restored from the attachments.

**Sign-in methods** (Identity §4.4):
- **Password:** `POST /auth/password`.
- **Magic link:** single-use and valid for 15 minutes, on any device.
- **Passkeys:** WebAuthn with **discoverable credentials**.
  - User verification is **"preferred"**.
  - `sign_count` is checked, and a backwards count is rejected as a possible clone.
  - Credentials are bound to the **relying-party ID (the domain)**: a domain change or a restore to a new domain leaves passkeys unusable. Registering on `*.workers.dev` warns about this.
- **Owners must keep a password**; members may be passkey-only.
- The WebAuthn library choice needs a spike before M1 (§10).

**Other identity endpoints** (Identity §6): `POST /setup` takes a `handle` with the owner's details; `GET /me` returns the signed-in member; `POST /auth/ws-ticket` issues connect tickets (above). Email change uses an `email_change` token (pending address in `auth_tokens.payload`) with a GET confirmation page and a POST that applies it; the old address is notified and other pending tokens are revoked.

**Email links are scanner-safe** (Platform §10). Magic-link, password-reset, recovery, invitation, email-confirmation and RSVP links open a **confirmation page**. Only a **POST** from that page uses the token, so mail scanners and link prefetchers can't use it up. Tokens live in `auth_tokens`, hashed. RSVP tokens are per attendee and reusable until the event ends.

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
| `message.delete` | `messageId` | The author, a channel admin, or a workspace admin (public channels, and private channels they're a member of) |
| `reaction.add` / `reaction.remove` | `messageId`, `emoji` | Channel members |

Limits: body up to 40 KB, which stays far below the 8 MB DO row limit; up to 20 attachments per message.

**Additions** (Chat §16, §17):
- `message.send` gains `format` (rich-text JSON, at most 100 KB), `mentions` (users and groups, plus channel and here flags) and `alsoInChannel` (thread replies). Forwarding is a REST operation (`POST …/forward`, Chat §17) that posts a live reference; `message.send` has no `forwardOf`.
- New operations: `message.pin` / `message.unpin`, `poll.create` / `poll.vote` / `poll.close` and `preview.remove`.
- The projected state includes the new message columns (§2.1, §2.2).
- **Group DMs:** `group_dm` channels (3–8 participants, fixed membership) use `dm_key` like DMs. Converting one to a private channel re-types it, clears `dm_key` and asks for a name.
- **Mentions of non-members:** in a public channel they notify; in a private channel the composer offers to add the person instead.
- **Rate limits** follow Platform §8: 10 messages per 10 s per conversation, `@channel` / `@here` once per 5 minutes, and in-call chat 20 per 10 s per call, all counted in the DO.
- **Size:** the full message state sent to the queue stays under 110 KB (100 KB format cap, 50 distinct reactions, 3 previews), inside the 128 KB queue message limit.

**Write path:**

1. The DO checks the payload and the caller's permission, using the connection attachment (§3.1) and the channel config pushed by `applyConfig` (§2.2).
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
   Because each delivery carries full state guarded by `last_event_seq`, duplicate or out-of-order delivery is harmless. The consumer also advances `channels.projected_seq` and creates or updates inbox records for mentions, DMs and thread replies, using the Notifications §3 dedupe keys (one record per DM conversation; one per mention), then hands them to notification delivery. Message deletion retracts matching records (Notifications §3.1). Failed batches retry, then go to a dead-letter queue. DLQ depth is shown in admin health.
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

**Connection budget** ([Platform](specs/platform.md) §12; replaces v1.3's "at most three"):

1. **Hub socket** (always open) to the user's UserHub DO. It carries inbox and notification events, unread changes for *all* channels, workspace presence, rings and revocation commands.
2. **Channel socket** to the ChatChannel DO of the conversation on screen. Switching closes the previous one.
3. **Document socket** to the DocRoom or BoardRoom DO of the item on screen.
4. **Call socket** to the HuddleRoom while in a call.
5. **Embedded whiteboard** sockets, only while "edit in place" is active.

Other embeds (messages, events, document previews, link previews) refresh through hub `activity` events and never open sockets. **Hard cap: 6 sockets per tab.** Opening another closes the least recently used embedded-board socket.

Tabs of the same browser elect a leader with `BroadcastChannel` and share one hub socket.

**Unread state** (Chat §7). On connect, the client loads unread and mention counts over REST. Unread counts **top-level messages and "also send to channel" copies** in D1 with `seq > channel_members.last_read_seq`, excluding the member's own messages, system messages, `call_chat` messages, deleted messages and thread replies (tracked per followed thread in `thread_follows`). The D1 copy can lag a few seconds; tests wait for it to converge. Read cursors are written by the client, debounced, and only move forward. The mention count comes from unread inbox records. After that, counts are kept current by hub events.

**Fan-out.** After applying a batch, the message projection consumer (§3.3, step 5):

1. Finds the highest new `seq` for each affected channel.
2. Gets the set of online users from WorkspacePresence: one RPC per batch, cached in the consumer for 5 seconds.
3. Sends **one** `activity` RPC per online member of the affected channels, carrying every affected channel and any new inbox items for that user. However many messages a batch holds, each UserHub receives at most one call per batch, and offline users cost nothing.
4. Notifies offline recipients of mentions and DMs through their notification preferences (email in the first release, web push in Phase 2). They see the inbox records on their next load.

**Workspace presence.**

- A UserHub calls `online(userId)` on WorkspacePresence when its first socket connects and `offline(userId)` when its last socket closes.
- While sockets are open, a UserHub alarm sends a heartbeat every 5 minutes. Entries with no heartbeat for 12 minutes expire.
- Presence changes are broadcast to online UserHubs. Changes are infrequent: connects, disconnects and status changes.
- Per-channel presence (who is viewing or typing) stays in ChatChannel DO memory (§3.4).

**Keepalive.** Every DO sets `setWebSocketAutoResponse` for application ping/pong. Keepalives then neither wake the object nor add billed duration. Clients pause document awareness updates while their tab is hidden, so idle open documents can hibernate.

**Role downgrades and inherited-access changes** (Permissions §8, Platform §12):
- When someone's effective role on an open object changes (for example editor → viewer, a folder or drive grant changes, an item moves, a channel is made private, or a poster loses `can_post`), the Worker calls the RPC **`updateAccess(userId, role | null)`** on the affected DOs through the room registry.
- The DO updates the socket attachment and sends **`{ type: "access.changed", role }`**. A DocRoom then treats the socket as read-only. When `role` is null (all access lost) the DO closes the socket with **`4403`**. This is the only name for the mechanism (Permissions §8, Platform §12).
- **Offline edits** that reach the server after access was lost are rejected. The client keeps them locally and offers to export them.

**Revocation.** Whenever a user is disabled or deleted, a session is revoked, or the user loses access to a channel, document or call context, the Worker calls `closeConnections(userId, reason, scope)`. The room registry kinds are `channel`, `doc` and **`huddle`**, so revocation also closes HuddleRoom sockets and the user's SFU tracks:

- on the user's UserHub, and
- on every affected ChatChannel, DocRoom, BoardRoom or HuddleRoom DO.

To find every affected DO, each ChatChannel, DocRoom, BoardRoom and HuddleRoom registers a new connection with the user's UserHub (`registerRoom(kind, roomId, connectionId)`), and reports its close. The registry is **stored in UserHub SQLite and never pruned by age** while the socket lives; a daily sweep asks each room whether the connection still exists. A **Worker-side fallback** recomputes affected rooms from D1 (channel membership, grants, call contexts) and calls `closeConnections` directly, so revocation works even if the registry is incomplete (Platform §12). For a user-wide revocation, the UserHub closes its own sockets and calls `closeConnections` on every registered room. Each DO closes matching sockets with application close code `4401` (session revoked) or `4403` (access removed). The client re-authenticates or leaves the view. Because a session's hub socket is closed and refresh is refused, a disabled user loses all realtime access within seconds.


### 3.6 Calls (huddles): audio, video and screen sharing

Media runs on **Cloudflare Realtime SFU**. Signalling and huddle state run in a **HuddleRoom DO**, one per active huddle (`idFromName(huddle_id)`). The Realtime app ID and secret and the TURN key are Worker secrets, set up from the post-deploy checklist (§6.1). Clients never see them.

**D1 tables:**

```sql
CREATE TABLE huddles (
  id TEXT PRIMARY KEY,
  context_type TEXT NOT NULL,          -- channel (including DMs) | document | event (project reserved) (Zod)
  context_key TEXT NOT NULL,           -- channel:<id> | document:<id> | event:<id> | event:<id>:<occurrenceStart>
  started_message_id TEXT,             -- channel/DM: the "call started" message (in-call chat thread root)
  context_id TEXT NOT NULL,
  started_by TEXT REFERENCES users(id),
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  peak_participants INTEGER NOT NULL DEFAULT 1,
  had_screen_share INTEGER NOT NULL DEFAULT 0,
  purge_after INTEGER                  -- started_at + 365 days
);
CREATE INDEX huddles_context ON huddles(context_type, context_id, started_at);
-- At most one active huddle per context
CREATE UNIQUE INDEX huddles_active ON huddles(context_key) WHERE ended_at IS NULL;

CREATE TABLE huddle_participants (
  huddle_id TEXT NOT NULL REFERENCES huddles(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  joined_at INTEGER NOT NULL,
  left_at INTEGER,
  PRIMARY KEY (huddle_id, user_id, joined_at)
);
```

Huddle records hold metadata only. No media is ever recorded.

**HuddleRoom DO state** is kept in memory and mirrored to SQLite `meta`, so it survives eviction. It holds:

- the host (the person who started the huddle)
- for each participant: user ID, SFU session ID, published tracks (`audio`, `video`, `screen`, `screen-audio`), mute state and raised hand
- the current presenter
- pending take-over requests.

**Join flow:**

1. The client calls `POST /calls` to start a call from a context, then **`POST /calls/:id/join`**. The Worker checks access to the context. When starting, it inserts the `huddles` row; the partial unique index means a concurrent start for the same context joins the existing call. Join returns `409 { currentCallId }` when the person is already in another call, unless `{ leaveCurrent: true }` is sent, and `409 { full }` at 25 participants. `POST /calls/:id/leave` leaves explicitly.
2. The client opens `/ws/calls/:id` to the HuddleRoom DO, authenticated as in §3.1. The upgrade is refused unless the call was joined.
3. The client creates one `RTCPeerConnection`. Its ICE servers are Cloudflare's STUN plus short-lived TURN credentials minted by the Worker.
4. **Publishing:** the client adds its local tracks and sends an SDP offer to `POST /calls/:id/tracks/publish`. Using the app secret, the Worker creates the participant's SFU session on first use and adds the tracks. It returns the SDP answer and tells the DO which track names the participant now publishes.
5. **Subscribing:** the DO broadcasts roster and track changes. To receive a track, the client calls `POST /calls/:id/tracks/subscribe` with the publisher's participant ID and track name. The Worker first asks the DO to confirm that the requester is a participant and that the publisher and track belong to *this* huddle. Only then does it ask the SFU to forward the remote track. A client can never pull tracks from sessions outside its huddle.
6. Renegotiation and closing tracks go through the same Worker routes to the SFU's renegotiate and close-track operations. Endpoint names follow the Realtime SFU API; confirm them at implementation.
7. When the last participant leaves, the DO waits 30 seconds (alarm), then ends the huddle. It closes the SFU sessions, sets `ended_at`, and posts a summary event (duration, participants) into the context.

**Screen sharing:**

- **Capture:** `getDisplayMedia()` with video constrained to the admin cap (1920×1080 or 1280×720) and up to 15 fps. Audio is requested so browsers that support tab audio can include it. The share is published as track `screen`, plus `screen-audio` if audio was granted, on the participant's **existing** peer connection.
- **Encoding:** `contentHint = "detail"` by default, so the encoder favours sharpness and may drop to a few frames per second on static content. *Motion* mode sets `contentHint = "motion"` and allows up to 30 fps.
- **Simulcast:** the presenter publishes two or three spatial layers (for example full, half and quarter resolution) through `sendEncodings`. Each viewer's client requests the layer that suits its viewport and network, so a slow viewer doesn't degrade others. Confirm the SFU's layer-selection controls at implementation. If simulcast isn't available, a single layer at the admin cap is sent.
- **Single presenter:** the HuddleRoom DO is the authority.
  - `screen.start` is granted only when nobody is presenting. Otherwise it becomes a take-over request sent to the presenter and the host.
  - On acceptance or a host hand-over, the DO tells the current presenter to stop. If they haven't stopped within 5 seconds, the DO closes their `screen` tracks through the Worker, then grants the new presenter.
- **Host controls:** the host, and channel admins for channel calls (document owners for document calls, organisers for event calls), can stop another participant's share or mute their audio. The DO enforces this, the Worker closes the track at the SFU, and the action is audited.
- **Policy:** the workspace sharing policy (`installation.settings.screen_share`: `everyone`, `admins` (workspace owners and admins plus channel admins for channel calls) or `off`) and the resolution cap are enforced by the DO before it grants a share, and the client applies the cap to `getDisplayMedia`.
- **Presenter client:**
  - sets presence status `presenting`, so the UserHub suppresses notification toasts on the presenter's devices
  - shows a persistent Stop bar
  - listens for the track's `ended` event (the browser's own "Stop sharing" button) to release the presenter slot.
- **Viewer client:** the share takes the main stage. Fullscreen and Picture-in-Picture (where supported) are available, and zoom and pan are handled client-side.
- **Mobile:** clients that lack `getDisplayMedia` hide the share control. Viewing works everywhere.

**Bandwidth planning.** SFU egress is roughly bitrate × viewers × duration. Planning figures per received stream:

| Stream | Bitrate |
|---|---|
| Audio | ~50 kbps |
| Video | 0.5–1.5 Mbps |
| 1080p detail screen share | 1–2.5 Mbps per viewer |

Example: a 30-minute share to 8 viewers at 2 Mbps is about 3.6 GB. The usage panel (§7.9) reports SFU egress against the 1,000 GB monthly free allowance.

**Security.** Media is encrypted in transit with DTLS-SRTP between each client and the SFU, and is decrypted at the SFU for forwarding. It is not end-to-end encrypted, and the PRD says so. The app secret never leaves the Worker.

**Additions** ([Calls](specs/calls.md); its data model, §10, is authoritative):
- **Contexts:**
  - channel and DM calls (M4); event calls (M5b; each recurring occurrence has its own `context_key`); document calls (M6)
  - announcement channels allow calls for anyone who can read them; **archived channels don't**
  - event calls can be started or joined by the organiser, attendees and anyone with details-level access to the calendar; document calls by anyone who can open the document.
- **API:** the complete REST and WebSocket list is in Calls §11 (`/calls/...`, `/ws/calls/:id`).
- **Ringing:**
  - DM and group-DM calls ring through each participant's UserHub (`call.ring`, `call.ring.cancel`, `call.accepted-elsewhere`), with a **30-second timeout alarm on the caller's UserHub**
  - DND, focus time and time off suppress rings; unanswered or suppressed rings write a `call_rings` record and a `missed_call` notification
  - **call waiting:** a person already in a call is rung with "you're in a call", and accepting asks them to leave first
  - rate limit: 5 rings per 10 minutes to the same person.
- **One connection per person:** joining from a second device hands the call over, and the old socket closes with `4002 "moved"`.
- **One call at a time:** the UserHub records `currentCall` in its SQLite, and joining another call needs `leaveCurrent` (above).
- **Revocation:** losing access to the call's context closes the HuddleRoom socket and SFU tracks with `4403`; disabling closes with `4401`.
- **Moderator hand-over:** if the host leaves, moderation passes to a present channel admin, document owner or event organiser. In DMs and group DMs any participant may stop a share. Otherwise it passes to the earliest remaining participant.
- **In-call chat:**
  - channel and DM calls post it as `call_chat` thread replies under `started_message_id`, through a typed ChatChannel RPC (no follows, notifications or unread counts)
  - document and event calls write `huddle_messages`, keyed to the **context**, through an **outbox**; it's kept for the life of the context and doesn't cascade from `huddles`.
- **Raise-hand queue and reactions** are relayed through the HuddleRoom and never stored.

## 4. Collaborative editing design (Yjs on Durable Objects)

### 4.1 Server architecture

Each document or whiteboard is a DocRoom Durable Object. The DO:

- Holds the authoritative Y.Doc in memory.
- Accepts WebSocket connections using the standard Yjs sync protocol (y-websocket).
- Applies incoming updates to the Y.Doc.
- Persists updates to DO SQLite.
- Broadcasts updates to other connected clients.
- Compacts the update log into snapshots periodically.
- Manages awareness (presence, cursors) and relays it to peers. The server relays the awareness wire format directly and keeps states in memory only. It does not use the y-protocols `Awareness` class, whose interval timer would stop the object from hibernating. Cursors are lost when the object hibernates, and clients re-announce them within about 15 seconds (confirmed by the realtime spike).
- Enforces roles (owner/editor/commenter/viewer) server-side; read-only roles' updates are rejected.

### 4.2 Client architecture

The React client uses:

- Tiptap with the Collaboration extension for documents.
- Excalidraw (MIT) for whiteboards, with an Officebox-maintained Yjs binding based on the community `y-excalidraw` approach. tldraw was rejected because it needs a commercial licence key in production.
- y-websocket provider pointed at /ws/docs/:id.
- IndexedDB persistence for offline support and reconnection.

The browser's session cookie authenticates the WebSocket upgrade. The Worker validates it and the `Origin`, resolves the document role and forwards the connection to the DO with that role (§3.1). Stock Yjs clients use a one-time ticket instead.

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
- **Comments** (Documents §4.4) are stored in D1 (`comment_threads`, `comments`), not in the Yjs document. Each thread is anchored with **Yjs relative positions** plus the quoted text.
  - Orphan detection runs on the client when rendering, and on the DocRoom during compaction for notifications.
  - After a version restore, threads are **re-anchored by matching their stored quote**; otherwise they become orphaned.
- **Compare versions** is custom work, because Tiptap's snapshot compare is a paid extension: a text diff of two document states rendered from ProseMirror JSON. It may move to Later if it's too large (§10).

### 4.4 Permissions

Permissions are resolved by the Worker before the WebSocket reaches the DO. The DO trusts the role passed in the connection attachment and enforces it:

- Owner/editor: may send Yjs updates.
- Commenter/viewer: may receive updates and awareness, but outbound updates are dropped and answered with a permission error.
- No access: connection is rejected.

Link previews and AI retrieval always re-check permissions in the Worker/D1; the DO is not the authority for cross-object access.

**Role downgrades on open sockets:** an `updateAccess` call with `access.changed` (§3.5) switches an editor's socket to read-only immediately, without reconnecting. Further updates are refused with the permission-denied message.


### 4.5 Present mode

Present mode uses no media:

- The presenter's client publishes a `presenting` field in its Yjs awareness state: `{ active, scrollAnchor, viewport, zoom, selection }`. `scrollAnchor` is a Yjs relative position, so it stays correct while others edit. The field is updated at most every 100 ms while it changes.
- Followers' clients apply it to their own view. A follower who scrolls or clicks breaks away and sees **Rejoin presenter**.
- The DocRoom or BoardRoom DO allows one presenter per document. A second claim is rejected with "Currently presenting: *name*". The claim is cleared when the presenter disconnects.
- Viewers with the viewer role can follow.
- Present mode keeps the DO active the same way normal editing does.

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
- **v1.4 additions:**
  - the **ReminderScheduler** Durable Object (§2.2)
  - Queues: `link-preview-fetch` and `ics-fetch` (outbound fetching, §8.2), and `unread-email`, whose delayed messages (`delaySeconds`, at most 24 hours) implement the per-recipient offline-email timer, deduplicated by the D1 `pending_emails` table; longer holds use ReminderScheduler `email_release` triggers (Platform §11)
  - the admin settings keys listed in Platform §7 (for example `external_invites`, `holiday_regions`, `offline_documents_enabled`, `welcome_post_enabled`, `default_channels`, `screen_share` and `link_previews_enabled`), stored in `installation.settings`.

The Deploy to Cloudflare button copies the repository into the customer's GitHub account, provisions the supported resources and runs the deploy command:

```text
node scripts/preflight.mjs && wrangler d1 migrations apply DB --remote && wrangler deploy
```

**Secrets** (complete inventory with purpose, required/optional and rotation in [Platform](specs/platform.md) §16): `SESSION_SIGNING_KEY` (access tokens), `TOKEN_HASH_KEY` (HMAC for stored token hashes), `DATA_ENCRYPTION_KEY` (ICS-in URLs; MFA secrets later), `POLL_SECRET_KEY` (or per-poll secrets in the DO), `SETUP_TOKEN`, `RECOVERY_TOKEN`, email provider keys, `REALTIME_APP_ID` / `REALTIME_APP_SECRET`, `TURN_KEY_ID` / `TURN_KEY_API_TOKEN`, and the optional analytics token.

`SETUP_TOKEN` is declared in `.dev.vars.example`, which the Deploy flow uses to prompt for secrets. Cloudflare doesn't document whether a prompted secret can be left blank, so the generated-token fallback (§6.8) covers that case. The Deploy flow writes the IDs of newly created resources back into the `wrangler.jsonc` committed to the customer's repository. The release-sync merge script (§6.4, step 5) keeps them. The Deploy button also supports GitLab, but release-sync needs GitHub Actions, so the README recommends GitHub. AI Gateway, BYOK keys, Realtime SFU credentials, SMTP credentials and custom domains are not provisioned automatically. They appear in the admin post-deploy checklist:

| Item | How | Needed for |
|---|---|---|
| Durable Objects, D1, R2, Vectorize, Queues, Workers AI | Automatic (Deploy button) | Everything |
| Setup token | Prompted at deploy, or generated (§6.8) | First-run setup |
| Allow GitHub Actions to create pull requests | Manual repository setting | Upgrades |
| Make the repository private | Recommended | Keeps scheduled release-sync running |
| Custom domain | Manual; recommended before inviting the team | Stable sign-in, PWA and push |
| Email provider API key or SMTP credentials | Manual (Worker secrets) | Email invitations, resets and notifications |
| Realtime SFU app and TURN key | Manual (Worker secrets) | Calls and screen sharing (M4) |
| AI Gateway and provider keys | Manual | AI (Phase 3) |
| Read-only analytics API token | Optional (Worker secret) | Usage panel with Cloudflare's own figures |
| Cloudflare billing notifications | Recommended (dashboard) | Cost alerts |
| R2 lifecycle rule for noncurrent versions | Recommended | Retention guarantee (§2.3) |

The admin UI checks each item it can detect and shows its status. R2 is reached only through the binding, so no R2 S3 credentials are needed (§8.3).

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
- A DO schema migration runs in a transaction. If it fails, the object refuses connections with a "migration failed" error, reports it to admin health and leaves its data untouched. The fix ships as a patch release.

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

**Setup submission:** `POST /setup` with `{ token, workspaceName, ownerEmail, ownerName, ownerHandle, password }`. Setup creates **identity objects only** (installation, the owner user, their handle, settings). `#general`, calendars and drives are created by the milestones that own them, with backfill jobs (Platform §13).

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
- Realtime SFU and TURN credentials (if configured; needed from M4).
- Storage levels and protective-mode state (§7.7), and post-deploy checklist status (§6.1).
- Message-projection lag (oldest outbox entry, DLQ depth) and failed purge jobs.
- Installed version, latest release on the channel, applied migrations vs. running code (§6.5–6.7).

### 7.2 Diagnostics bundle

The admin can download a support bundle containing:

- Worker version and deployment ID.
- Binding configuration (without secrets).
- Recent audit log entries: action types, timestamps and pseudonymous actor IDs only.
- D1 storage usage.
- R2 usage summary.
- Durable Object error counts (last 24h).
- Queue backlog.

The owner reviews the bundle before sharing it. It never contains message, document or file content, email addresses or secrets. Officebox support receives it only when the owner attaches it to a support request.

### 7.3 Alerts

Officebox uses Cloudflare's observability and optional external alerting (email/webhook) for:

- Elevated Worker error rate.
- D1 query failures.
- Durable Object exceptions.
- R2 write failures.
- Queue backlog growth.
- Storage approaching limits.
- Billing: owners are prompted to set Cloudflare billing notifications (§7.9).

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
| `d1/<table>.jsonl` | One JSON object per row, written in pages of 1,000. Excludes `search_index`, `sessions`, `mfa_factors`, setup fields, job tables, `passkeys`, `auth_tokens`, `ws_tickets`, ICS feed tokens and ICS-in URLs, `poll_secret`, `pending_emails`, `notify_anyway_log`, `scheduled_triggers`, `trigger_outbox` and `rate_counters` (Platform §6). |
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

**Coverage** ([Platform](specs/platform.md) §6 is authoritative):
- **Added:** calendars, events, attendees, time off, drives, folders, file versions, comments, polls (anonymous votes as hashed `voter_key` only), saved items, preferences, and in-call chat from both D1 and channel threads.
- **Excluded:**
  - sessions, `auth_tokens`, `ws_tickets` and MFA secrets
  - **passkeys** (bound to the domain; members re-register after a restore to a new domain)
  - ICS feed tokens, and ICS-in subscription URLs (subscriptions are exported without URLs and must be re-entered)
  - `poll_secret`.

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


### 7.7 Storage monitoring and protective mode

```sql
CREATE TABLE object_sizes (          -- reported by DOs after compaction or daily trimming
  object_type TEXT NOT NULL,         -- channel, document, whiteboard
  object_id TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  reported_at INTEGER NOT NULL,
  PRIMARY KEY (object_type, object_id)
);
```

| Store | How it's measured | Thresholds and actions |
|---|---|---|
| D1 (10 GB hard limit) | Database size from D1 query result metadata, sampled hourly *(confirm the metadata field at implementation)* | Warn at 70% and 85%. At 95%, **protective mode** (below). At 98%, D1 copying pauses and DO outboxes hold events safely until space is freed. |
| Durable Objects (10 GB each) | `ctx.storage.sql.databaseSize`, reported into `object_sizes` | Warn when any object passes 5 GB |
| R2 (no hard limit) | Calculated from D1: `files.size_bytes`, plus export and snapshot objects. No API token needed. | Optional owner budget: warn above it; block uploads above an optional hard budget |

**Protective mode.** The Worker refuses to create channels, documents, folders, drives, files, calendars, events, polls, time off and invitations. Messages continue: they are stored in their channel DOs, and the D1 copy keeps up until the 98% point.

**Recovery.** The admin UI guides the owner to free space:

- **Shorten search copy retention** (`installation.settings.search_copy_months`). This trims D1 `messages` and `search_index` rows older than N months. Those messages stay in their channel DOs, in the channel view and in exports; they just leave search.
- Empty Trash early.
- Enable retention policies.
- Export and delete archived channels.

**Growth guide:** 100 members × 100 messages a day is about 2 GB a year, including the FTS index. Trimming the search copy keeps D1 bounded indefinitely.

### 7.8 Scheduled jobs

Three Cron Triggers (every 5 minutes, hourly and daily) run the jobs below.

| Job | Schedule | Section |
|---|---|---|
| Snooze wake-ups | 5 minutes | PRD §5.3 |
| Due-date reminders, email digests (per preference), storage sampling | Hourly | PRD §5.3, §8; §7.7 |
| Purge due objects, time-based retention (audit log, inbox items, sessions, invitations, tickets, huddle records) | Daily | §2.3 |
| ChatChannel event-log trimming, D1 copy reconciliation, version thinning | Daily | §2.2, §3.3, §4.3 |
| Release manifest check | Daily | §6.7 |
| Usage panel refresh | Daily | §7.9 |
| ICS-in refresh (queue a fetch per due subscription) | Hourly | Platform §11 |
| Scheduled-trigger refill (48-hour window) | Hourly | §2.2, Platform §11.1 |
| RSVP-response batch per organiser | Hourly | Notifications §3 |
| Hourly and daily email digests (members with an hourly or daily delay) | Hourly | Notifications §6, Platform §11 |
| Room-registry sweep | Daily | Platform §12 |
| Scheduled export (if enabled) | Weekly (from the daily trigger) | §7.5 |

Timers that aren't cron jobs (Platform §11):
- **ReminderScheduler triggers:** reminders, event start, focus time, time off, status expiry, DND schedule, `dnd_until_end` (manual DND expiry) and `email_release` (email holds longer than 24 hours).
- **Delayed `unread-email` queue messages**, deduplicated by `pending_emails`. When one fires during DND or time off the email is held; when that ends it's re-evaluated and, if still unread, sent after the remaining delay or immediately if the delay has passed.
- **Channel DO** poll auto-close.
- **UserHub:** ring timeout, and the DND-end "while you were away" summary.
- **HuddleRoom:** call end and hand-over deadline.

### 7.9 Usage, cost and telemetry

- **Usage panel:**
  - With an optional read-only account analytics API token (a Worker secret), the daily job queries Cloudflare's GraphQL Analytics API. It reads Workers requests; DO requests, duration and storage; D1 rows and storage; R2 storage and operations; Queues operations; and Realtime SFU egress. The panel shows month-to-date usage against the Workers Paid allowances, with projected overage.
  - Without the token, the panel shows Officebox's own counters (messages, file bytes, D1 size, huddle minutes, share minutes) and links to Cloudflare billing.
- **Billing alerts:** owners are prompted to set Cloudflare billing notifications, because Cloudflare has no hard spending cap.
- **Telemetry:** off by default. When enabled, a weekly anonymous report sends Officebox:
  - a random installation ID
  - the version and channel
  - a member-count range
  - enabled features
  - error counts by category.

  It never sends content, names, emails or retained IPs. The exact payload is shown in the admin UI before telemetry is turned on.

## 8. Security model

The web application follows **OWASP ASVS Level 2** as its baseline.

### 8.1 Authentication and sessions

- **Passwords:**
  - Hashed with PBKDF2-HMAC-SHA256 via WebCrypto at **100,000 iterations with a 16-byte salt, after an HMAC-SHA256 pepper**: the PBKDF2 input is `HMAC-SHA256(PEPPER_<id>, password)`, with the pepper held in Worker secrets (platform §16), at least 32 random bytes.
  - **Why 100k plus a pepper:** the M0 foundation spike (§10) found that workerd's default limit enforcer caps PBKDF2 at 100,000; local `wrangler dev` lifts the cap, which is why 600,000 works locally. A D1 dump or export without the pepper can't be attacked offline. **Pending the production probe:** if deployed Workers accept 600,000, new hashes use `pbkdf2-sha256$600000$…` and existing ones upgrade at next sign-in.
  - Stored in a versioned format (`pbkdf2-sha256-hmac$<pepperId>$100000$<salt>$<hash>`), so parameters and peppers can change and hashes upgrade at next sign-in. Verification refuses stored iteration counts outside 100,000–1,000,000.
  - Pepper rotation, restore and the dummy derivation for unknown accounts (no timing enumeration) follow Identity §4.4.
  - Chosen over Argon2id because native WebCrypto avoids WASM memory limits and CPU spikes in Workers. Argon2id via `hash-wasm` needs its WASM imported as precompiled modules, since Workers forbid runtime WASM compilation (spike finding).
  - Sign-in needs Workers Paid: PBKDF2 at 100,000 iterations takes about 12 ms of CPU, above the Free plan's 10 ms limit.
  - Minimum length 10, checked against a bundled list of common passwords. No composition rules.
- **Sessions:**
  - Cookies as in §3.1.
  - Refresh-token rotation with reuse detection: presenting an old refresh token revokes the session, **except within a 30-second grace window** after rotation, when the previous token returns the same successor (two tabs refreshing at once).
  - **Every authenticated request** checks the session's `session_epoch` and the user's status (cached per isolate for at most 60 seconds), so a disabled member loses REST access within 60 seconds, as well as their sockets.
  - `session_epoch` revocation, a 30-day idle timeout, and **Sign out everywhere** for users and admins.
- **MFA (Phase 2):** TOTP with recovery codes. Owners can require MFA for owners and admins.
- **Rate limiting** (mechanisms per platform §8):
  - The Workers Rate Limiting binding supports periods of exactly 10 or 60 seconds, counts per Cloudflare location, and is approximate. The wrapper treats it as advisory and returns `rate_limited` with retry-after equal to the period. Longer windows and exact quotas use D1 or Durable Object counters.
  - Sign-in: 5 attempts per minute per IP (binding) and 10 per hour per account (D1 counter), with progressive delays. There is no hard lockout, which would let attackers lock users out.
  - Setup, recovery, invitation acceptance and password reset are limited the same way.
- **Tokens:** invitation, reset and recovery tokens are 32 random bytes, stored hashed and single-use. Invitations expire after 7 days and resets after 1 hour.
- **Owner recovery:** setting a `RECOVERY_TOKEN` secret enables `/recover` for one use: reset one owner's password and MFA. The action is audited, and a banner shows until the secret is deleted.
- **SSO through Cloudflare Access (Phase 2):**
  - When enabled, the Worker validates the `Cf-Access-Jwt-Assertion` header against the team's Access signing keys and application audience. Follow Cloudflare's current Access JWT validation guidance at implementation.
  - It maps the asserted email to an existing active user or a pending invitation, never creating accounts automatically, and skips the password step.
  - Owners can disable local passwords for members.

### 8.2 Web application

- **Authorisation:** the role model in PRD §10.1, resolved as described in §2.1. Owners and admins get management rights but no implicit read access to private content. Every check happens in the Worker before a DO is reached.
- **CSRF:** `SameSite=Lax` cookies, plus a required custom header (`X-Officebox-Request: 1`) and an `Origin` check on every state-changing REST request. WebSocket upgrades check `Origin` too (§3.1).
- **Headers:**
  - `Content-Security-Policy: default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'` plus the Realtime SFU endpoints.
  - HSTS, `X-Content-Type-Options: nosniff` and `Referrer-Policy: strict-origin-when-cross-origin`.
- **Rendering user content:**
  - The server never renders user HTML.
  - Rich text is ProseMirror JSON constrained by the Tiptap schema.
  - Markdown is rendered client-side and sanitised with DOMPurify.
  - Links get `rel="noopener noreferrer"`, and `javascript:` URLs are rejected.
- **Link previews:**
  - internal Officebox objects are always previewed, with permission checks
  - **external link previews ship at launch** (Chat §11) through the outbound-fetch rules below.
- **Outbound fetching** ([Platform](specs/platform.md) §9) covers link previews, ICS-in and preview images:
  - HTTPS only
  - private, loopback, link-local and metadata IP ranges blocked after DNS resolution and on every redirect; at most 3 redirects
  - timeouts of 5 s for previews and 10 s for ICS
  - streaming byte caps: 1 MB HTML, 5 MB ICS, 1 MB images
  - content-type checks, no cookies, a fixed user agent, and queued with per-user and per-workspace rate limits
  - preview images stored at original size, up to 1 MB, with **no server-side resizing**
  - ICS-in URLs encrypted with a Worker secret and masked in the UI.
- **Outside event invitations** (Calendar §8):
  - a fixed template, "*Name* invited you via Officebox (*Workspace*)", with title, description and location as escaped plain text
  - an opt-out link
  - 50 outside recipients per member per day; admins can turn them off or restrict them to admins.
- **Rate limits and quotas** are set out in Platform §8.
- **First-run setup:** protected by a one-time setup token with an atomic claim, and disabled after use (§6.8).
- **Upgrades:** the running application holds no Cloudflare or GitHub credentials. Release tags are signature-verified against a pinned key before a sync PR is opened (§6.4).
- **Secrets:** provider keys in the AI Gateway Secrets Store. Email, Realtime and TURN credentials as Worker secrets. No provider keys in D1 or browser code.
- **AI:** retrieval is permission-filtered, retrieved content is treated as untrusted input (prompt injection), tool calls are permission-checked server-side, and mutating actions require confirmation.
- **Audit:** administrative and AI-sensitive actions are written to `audit_log`.

### 8.3 Files

- **Uploads** stream through the Worker into R2 using the binding, so no R2 S3 credentials are needed.
  - Files over 50 MB use R2 multipart upload: the client sends 10 MB parts and the Worker creates the upload, uploads each part and completes it.
  - Each part is authorised against its upload session. The default maximum file size is 2 GB, configurable by owners. Owners can also deny chosen file extensions.
- **Downloads** go through the Worker after a permission check, with Range support.
  - Only allow-listed types are served inline: PNG, JPEG, GIF, WebP, PDF, MP4, WebM, MP3 and OGG.
  - Everything else, including HTML and SVG, is sent with `Content-Disposition: attachment`.
  - Every file response carries `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox`.
- **Previews:** images and PDFs render in the browser. PDFs keep the `Content-Security-Policy: sandbox` response header and show in an `<iframe>` **without** the `sandbox` attribute: the M0 foundation spike found that Chromium's PDF viewer renders under the CSP header, directly and in an iframe, but an `<iframe sandbox>` attribute blocks it whatever tokens it allows. Firefox and Safari are untested and are checked in M6 (Documents acceptance criteria); a browser that can't render falls back to PDF.js in a sandboxed iframe on a separate path. Office documents are not converted server-side in the first release.
- **Malware scanning** is out of scope (PRD §14), and the documentation says so.
- **Avatars** accept PNG, JPEG or WebP only, and are cropped on the client (Identity §4.7).
- **Three file kinds:** chat attachments belong to their message and are deleted with it; images and file cards pasted into a document belong to the document and are deleted with it; drive files live in folders and are versioned. "Save to folder" creates an independent drive file from a message-owned one (Documents §6).

### 8.4 Realtime, huddles and devices

- **WebSockets:** cookie or one-time ticket, `Origin` check, role stored in the attachment, and revocation (§3.1, §3.5).
- **Huddles:** track subscriptions are confined to their huddle, and the SFU secret stays in the Worker (§3.6).
- **Offline data:**
  - On sign-out, the client deletes the workspace's IndexedDB stores, Cache Storage entries and service-worker caches.
  - A socket closed with code `4401` triggers the same wipe.
  - Admins can turn off offline document caching.

### 8.5 Data

- **Ownership:** all data stays in the customer's Cloudflare account, and the export allows portability.
- **Location:** the D1 location hint is chosen at deploy time. The Phase 2 EU option uses EU jurisdiction for D1, R2 and Durable Objects where Cloudflare supports it; confirm per service at implementation.
- **Access:** content is not end-to-end encrypted. Members of the Cloudflare account have full technical access (PRD §10.1).

## 9. Testing and validation

### 9.1 Validation tests

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
- Storage test: as D1 fills, warnings appear at 70% and 85%. At 95%, protective mode blocks new objects while messages continue. At 98%, D1 copying pauses without losing anything. Trimming the search copy frees space. An R2 hard budget blocks uploads when set.
- Security test: CSRF and cross-origin WebSocket attempts are rejected. HTML and SVG files download instead of rendering. Reusing a refresh token revokes the session. Owner recovery works only with the secret and is audited. Sign-out clears local caches. One-time tickets can't be reused.
- Export/restore test: export a fixture installation, restore into a fresh installation from first-run setup, and compare row counts, checksums, channel `seq` positions and document content. Missing export configuration warns but does not block startup.
- Search test: results match permitted messages and documents only. Deleting or trashing removes results. **Rebuild search index** reproduces the index.
- Revocation test: disabling a user, or removing them from a private channel or document, closes their open sockets within 5 seconds.
- Fan-out test: a 100-message burst in a busy channel produces at most one UserHub call per online member per consumer batch, and offline members get none.
- Permission matrix test (Permissions §11): every action × role × object type in Permissions §4, including the union rule, channel-made-private warnings and private-event visibility. It runs in CI.
- Lifecycle matrix test (Platform §17): disable and delete for every feature, including closing call sockets and erasing personal data.
- Durable registry test: after UserHub eviction, revoking a member still closes every open socket; the Worker-side fallback closes sockets missing from the registry.
- Trigger delivery test: a crash between marking a trigger fired and sending its effect leads to exactly one effect after recovery (outbox, idempotent consumer).
- `pending_emails` dedupe: repeated events in one conversation produce one email; holds longer than 24 hours are released by `email_release`.
- Session tests: two tabs refreshing within 30 seconds both stay signed in; replaying a refresh token after the grace window revokes the session; a disabled member's REST calls fail within 60 seconds.
- Cascade tests: channel, group, calendar, drive and event deletions follow Platform §4, including channel purge moving folder documents to their creators.
- Export exclusions: no `auth_tokens`, passkeys, ICS tokens or URLs, or `poll_secret` in an export; anonymous votes appear only as voter keys.
- SSRF tests: previews and ICS fetches refuse private IPs, including after redirects and DNS rebinding.
- Scanner-safe links: a GET of a magic, reset, recovery, invitation or RSVP link changes nothing; only the confirmation POST does.
- Timer catch-up: after simulated downtime, ReminderScheduler triggers less than 1 hour overdue fire once, older ones are dropped, and no trigger fires twice.
- Compaction test: a long editing session compacts on the size and count thresholds. A document with a snapshot over 4 MB loads correctly from chunks. Hourly versions appear and restore correctly.

### 9.2 Performance targets

- Chat message round-trip: p95 < 300 ms within region.
- Document sync latency: p95 < 200 ms for keystroke propagation.
- Cold document load: < 1 s for documents under 100 KB snapshot.
- Call join: < 2 s from click to audio.
- Screen share start: < 3 s from choosing a source to viewers seeing it.
- Screen share latency: p95 < 500 ms glass-to-glass within region.

### 9.3 Calls and screen sharing validation (M4, M5b, M6)

- Join: 2 to 25 participants join from a channel, a DM, a document and a calendar event. Audio connects through restrictive networks using TURN.
- Screen sharing: screen, window and tab sharing work, including tab audio in Chromium. Desktop and mobile viewers see the share. A throttled viewer gets a lower layer without affecting others.
- Single presenter: a second share request becomes a take-over request, and hand-over completes within 5 seconds. Hosts and channel admins can stop a share. Workspace policy and the resolution cap are enforced.
- Isolation: a client can't subscribe to another huddle's tracks, even with valid SFU session IDs.
- Present mode: followers track the presenter in documents and whiteboards. Break-away and rejoin work. Only one presenter per document is allowed.
- Ending: when the last participant leaves, the huddle ends after 30 seconds and posts a summary to its context.

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

Decided in v1.3 (from the review):
- WebSocket auth: cookies plus `Origin` check; one-time tickets for clients without cookies (§3.1).
- Whiteboard: Excalidraw (MIT) with an Officebox-maintained Yjs binding (§4.2).
- Password hashing: PBKDF2-SHA256, versioned format (§8.1). Revised after the M0 foundation spike to 100,000 iterations plus an HMAC pepper, pending the production probe.
- File handling: streamed through the binding; multipart above 50 MB; allow-listed inline types (§8.3).
- Huddle signalling: HuddleRoom DO with Worker-mediated SFU calls and confined track subscriptions (§3.6).
- Screen sharing: one presenter, simulcast, detail and motion modes (§3.6). Present mode via Yjs awareness (§4.5).
- Storage: protective mode and trimming of the D1 search copy (§7.7).

To confirm at implementation: the Realtime SFU endpoint and simulcast controls (§3.6), the D1 size metadata field (§7.7), Cloudflare Access JWT validation (§8.1), and EU jurisdiction support per service (§8.5).

**M0 foundation spike** (before M1). Results are in [`spikes/foundation`](spikes/foundation/README.md), and the decisions below are applied in §8.1, §8.3, Identity §4.4 and platform §8, §11 and §16:
- **PBKDF2 production cap:** almost certainly 100,000. workerd's default limit enforcer caps it there; the standalone server used by `wrangler dev` removes the cap, which is why 600k works locally (74 ms vs 12 ms for 100k). workerd issue #1346 is still open. **Decision:** M1 uses **PBKDF2 100k + HMAC pepper** (`pbkdf2-sha256-hmac$<pepperId>$100000$salt$hash`, §8.1); switch to 600k and upgrade at sign-in if the production probe accepts it. Argon2id via `hash-wasm` fails as published (Workers forbid runtime WASM compilation) and works only with precompiled modules (~45 ms, +25 KiB). *Needs production run.*
- **WebAuthn library:** `@simplewebauthn/server` 14.0.3 (MIT) runs in workerd. Verified end to end with a Chromium virtual authenticator: registration, discoverable sign-in, replay refusal and `sign_count` clone detection. **Decision:** use it with `requireUserVerification: false`; compare counters ourselves after signature verification (≤ stored and not both 0 → `clone_detected`) and update with compare-and-set (`UPDATE … WHERE sign_count = ?`) (Identity §4.4). *Verified locally.*
- **Rate Limiting binding:** periods are exactly 10 or 60 s; limits are per Cloudflare location, approximate and eventually consistent (documented). Miniflare is exact. **Decision:** binding only for abuse throttles (sign-in per IP, setup/recovery/invites, link previews, general API); the wrapper treats results as advisory and returns `rate_limited` with retry-after equal to the period; the other platform §8 rows stay DO or D1. *Production semantics need a production run.*
- **Queue `delaySeconds` maximum:** **24 hours** (86,400 s) for send, sendBatch and retries per current docs, not 12 hours; Miniflare rejects 86,401. **Decision:** the `email_release` threshold is 24 h; delays are Zod-validated (0–86,400) and out-of-range values are typed results (platform §11). *Documented, local verified.*
- **PDF preview under `Content-Security-Policy: sandbox`:** Chromium's viewer renders it, directly and in an `<iframe>`. An `<iframe sandbox>` attribute blocks it. **Decision:** keep the CSP header and preview in an iframe without the `sandbox` attribute (§8.3); Firefox, Safari and branded Chrome are M6 acceptance checks, with PDF.js as the fallback. The headless shell has no PDF viewer. *Verified locally (Chromium 153).*

**New in v1.4:**
- **WebAuthn library spike before M1:** done. SimpleWebAuthn runs in Workers (see the M0 foundation spike above).
- **Holiday dataset before M5:** licence compatible with AGPL, plus the bundle size against the Worker limit.
- **Size version compare before M6b:** a custom diff of two document states (§4.3); it may move to Later.
- **ReminderScheduler load:** confirm a single instance handles a 100-member workspace's 48-hour trigger window, or shard it.
- **Excalidraw Yjs binding:** maintenance cost of the Officebox-owned binding (§4.2).

**Validated by the realtime spike** ([`spikes/realtime`](spikes/realtime/README.md)): the channel DO write path, dedupe, replay, redaction, outbox to D1 with retry, revocation, Yjs sync with a stock `y-websocket` client, viewer enforcement, compaction, snapshot chunking, and cookie and ticket authentication. Three implementation notes came out of it:
- The outbox drain must chunk by size: queue messages are limited to 128 KB and each `sendBatch` to 256 KB.
- Stock clients must fetch a fresh ticket before each reconnect, by updating `provider.params.ticket`.
- Server-side awareness avoids the y-protocols `Awareness` class (§4.1).

The spike also validated huddles and screen sharing (§3.6, §4.5) against a fake SFU, plus browser capture in Chromium:
- one huddle per context
- track isolation
- single presenter with take-over and forced hand-over
- moderator stop and mute
- sharing policy and resolution cap
- simulcast layer requests and switching
- huddle ending
- present mode.

The SFU client matches the documented Realtime API. Two implementation notes:
- Return typed results for expected denials rather than throwing across Durable Object RPC, which logs them as uncaught exceptions.
- Simulcast negotiation and TURN still need a run against a real Realtime app.

**Still to confirm by measurement, not decision:** a Phase 1 load test should confirm or adjust these numeric defaults:
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
| D1 limits | 10 GB per database on Workers Paid |
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

## Appendix B — Cost model (25-person team, before load testing)

**Assumptions (per month):**

- 22 working days of 8 hours.
- 25 members, each sending 60 messages a day.
- 5 members editing documents about 1 hour a day.
- Each member's hub is connected while they work.
- Typing and awareness updates are throttled as described in §3.5.
- Calls: 4 hours of 4-person audio and 1 hour of screen sharing to 5 viewers each week.

| Item | Estimate per month | Included in Workers Paid | Notes |
|---|---|---|---|
| DO requests: channel socket connects (100 per member per day) | ~55,000 | | |
| DO requests: document socket connects (20 per member per day) | ~11,000 | | |
| DO requests: incoming chat, typing, Yjs and awareness messages | ~60,000 | | Counted at 20:1 |
| DO requests: outbox alarms | ~33,000 | | Worst case: one per message |
| DO requests: UserHub fan-out | up to ~330,000 | | Upper bound of one call per online member per message; batching reduces it |
| DO requests: heartbeats and presence | ~250,000 | | |
| **DO requests total** | **up to ~740,000** | 1,000,000 | Then $0.15 per million |
| DO duration | ~50,000–100,000 GB-s | 400,000 GB-s | Mostly documents during active editing |
| DO SQLite storage | under 1 GB | 5 GB-month | |
| D1 storage | under 1 GB in year one | *(confirm current allowance)* | About 2 GB a year at 100 members |
| R2 storage | 10–50 GB typical | *(confirm current free tier and price)* | Depends entirely on files |
| Queues operations | ~150,000 | *(confirm current allowance)* | About 3 operations per message |
| Realtime SFU egress | audio ~1 GB, screen sharing ~5 GB, video varies | 1,000 GB | Then $0.05/GB |

**Not yet modelled (v1.4):**
- ReminderScheduler alarms: low thousands of triggers per 48 hours at 100 members
- hourly ICS-in fetches (at most 50 subscriptions per workspace by default)
- calendar change fan-out through UserHub
- delayed `unread-email` queue messages, one per unread conversation per offline recipient.

All are expected to be small next to chat traffic. The load test should include them.

**Conclusion:** a 25-person team should fit within the Workers Paid allowances. Even at four times these figures, Durable Object request overage would be under $1 a month. These are estimates. The Phase 1 load test (§10) replaces them with measurements, and the usage panel (§7.9) shows each installation's real figures.

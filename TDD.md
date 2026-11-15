# Officebox — Technical Design Document (TDD)

**Status:** Draft for engineering review  
**Version:** 1.8  
**Date:** 15 November 2026  
**Companion to:** [Officebox PRD v1.5](PRD.md) and the feature and cross-cutting specs in [`specs/`](specs/)  
**Changes in 1.8:** passwordless sign-in on **better-auth** (product-owner decision, 15 Nov 2026; [Identity](specs/identity.md) §2):
- passkeys and magic links only; passwords, password reset, peppers and PBKDF2 removed (§3.1, §8.1)
- better-auth (MIT) for sessions, magic links and passkeys on D1, its configuration, and the advisory policy (§8.1)
- database sessions with the cookie cache off; no refresh tokens or `session_epoch`; revocation closes sockets by session (§2.1, §3.1, §3.5)
- setup registers the owner's passkey (§6.8); `BETTER_AUTH_SECRET` replaces `SESSION_SIGNING_KEY` and `PEPPER_*` (§6.1)
- CSRF alongside better-auth's origin check (§8.2); export exclusions (§7.5); tests (§9.1); decisions, with the PBKDF2 spike result kept for the record (§10)
- after the product owner's answers and the review (same day): the canonical origin in `installation` (§2.1, §3.1, §8.1); user verification required; magic links for members only; tokens in URL fragments (§8.2); no session token reachable by JavaScript; sign-in limits in our middleware; our compare-and-set token consumption; the setup WebAuthn preflight, resume guard and expiry (§6.8); passkeys in exports (§7.5); session recheck for sockets (§3.5); and the M1a-0 better-auth spike scope (§10)
- after the second review and the product owner's answers (same day): step-up for sensitive actions, the two-step domain move and the security-notice banner (§8.1); one-batch claim expiry, nonce-checked completion and the identity repair job (§6.8, §7.8, §8.1); promotion rules; passkey public keys exported (§7.5, §9.1); M1a-0 go/no-go criteria (§10).

**Changes in 1.7:** brought in line with the [Admin & Operations spec](specs/admin.md) (§19 there):
- `exports` columns and states, the step-up session field (now `sessions.fresh_auth_at`, 1.8), new `installation` columns, and the admin tables (§2.1, §7.5)
- maintenance through `maintenance_epoch` and the room-level `setMaintenance` RPC, not `updateAccess` (§3.5, §7.5)
- checklist items, the `config.json` values embedded at build, alerts for updates, and restore (peppers dropped in 1.8) (§6.1, §6.3, §6.4, §6.7, §6.8)
- dispatcher-run health checks, owner-only diagnostics, and Admin §4 alerts as the in-app path (§7.1–§7.3)
- exports run by owners and admins, packing into one R2 object, download tokens, retention, per-member exports and the consistency barrier (§7.5)
- priority writes in protective mode, `storage_thresholds`, and the new dispatcher jobs (§7.7, §7.8).

**Changes in 1.6:** brought in line with the [Assistant spec](specs/assistant.md) (§17 there):
- assistant tables, reserved `system` and `assistant` user rows, purge jobs and the `assistant-purge` fan-out (§2.1, §2.3)
- ReminderScheduler kinds, the room-registry kind `assistant` and the `/ws/assistant` socket (§2.2, §3.1, §3.5)
- derived file text and call notes in `search_index` and Vectorize, with ingestion gated on `assistant_enabled` (§2.4, §5.2, §5.3)
- assistant messages and nudge opt-ins in the projection consumer (§3.3)
- call notes, transcription and captions in the HuddleRoom (§3.6)
- the assistant design: Assistant DO, memory search, source mirror and purge, queue consumers, confirmation, `ModelProvider`, AI Gateway controls and voice (§5.5–§5.11); the audit split (§5.4)
- bindings and checklist (§6.1), export (§7.5), jobs and timers (§7.8), usage (§7.9), security (§8.2, §8.4), open questions (§10) and cost (Appendix B).

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
│                     │ │                    │ │                               │
│  • Assistant DO     │ │                    │ │                               │
│    (per member)     │ │                    │ │                               │
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
| HuddleRoom DO | Huddle roster, track registry, single-presenter control, host actions; call notes and captions (M9c) | Durable Object |
| Assistant DO | Per-member assistant: conversations, private memory, pending actions, live voice sessions (§5.5) | Durable Object + SQLite |
| Realtime SFU | Audio, video and screen-share media; TURN | Cloudflare Realtime |
| AI Gateway | BYOK provider proxy, fallback, rate limiting; logging and caching turned off for assistant calls (§5.10) | AI Gateway |
| Queues | Message and search projection to D1, purge jobs, email, AI indexing, assistant mentions, nudges, proactive runs and purges (each with a dead-letter queue) | Queues |
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
| Channel messages, edits, deletions, reactions, threads | ChatChannel DO SQLite (`events`, `messages`) | D1 `messages` (search, inbox, notifications, cross-channel views); Vectorize (M9; upserts only while the assistant is enabled, §5.2) |
| Document and whiteboard content | DocRoom / BoardRoom DO SQLite (Yjs) | R2 snapshot copies (export and recovery); search text projection (see §10); Vectorize (M9; upserts only while the assistant is enabled, §5.2) |
| Identity, roles, groups, channel membership, grants, object metadata, inbox, audit | D1 | — |
| File bytes | R2 | — (metadata in D1 `files`) |
| Presence, typing, awareness | DO memory and WebSocket attachments | — (never persisted) |
| Assistant conversations, memory and pending actions | Assistant DO SQLite, one per member (§5.5) | D1 `assistant_source_refs`: object references only, no content (§5.7) |
| Call transcripts and notes | D1 `call_transcript_segments`, `call_notes` (the HuddleRoom holds segments only until their D1 write succeeds, §3.6) | Vectorize; `search_index` |
| Derived file text | — (derived from the file bytes in R2) | D1 `file_derived_text`, `search_index`, Vectorize; rebuilt, not exported (§7.5) |

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
  - The **spec data-model sections** are authoritative for feature tables, and this document is the integration point that lists them: Identity §5, Chat §15, Calls §10, Calendar §12, Documents §9, Notifications §7, Permissions §9, Platform §8, §11, §12 and §15, Assistant §14.2, and Admin §16.
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
  setup_claim TEXT,                 -- nonce of the request that claimed setup
  setup_claimed_at INTEGER,         -- an incomplete claim expires after 24 hours (§6.8)
  setup_completed_at INTEGER,       -- set when the owner's first passkey is registered
  canonical_origin TEXT,            -- recorded at the claim; also the link origin for dispatcher email (Admin §4, which called it public_origin); rpID, link origin and Origin checks (§8.1)
  allowed_hosts TEXT,               -- JSON: hosts that redirect to the canonical origin
  pending_origin TEXT,              -- two-step domain move: started, not yet committed (§8.1)
  pending_origin_started_by TEXT,
  pending_origin_expires_at INTEGER,  -- 24 hours after the start (default)
  latest_release TEXT,              -- JSON from the daily release check (§6.7)
  settings TEXT NOT NULL DEFAULT '{}',  -- JSON: storage thresholds, retention overrides
  checklist TEXT,                   -- JSON: manual post-deploy checklist items marked done (§6.1, Admin §15)
  maintenance_epoch INTEGER NOT NULL DEFAULT 0,  -- incremented on every maintenance change (§7.5, Admin §13.2)
  scheduled_export_last_slot INTEGER  -- claimed scheduled-export slot, compare-and-set (§7.8, Admin §11.1)
);

-- Identity
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE COLLATE NOCASE,  -- NULL only once deleted; as entered, for display
  email_normalised TEXT UNIQUE,      -- trim, lowercase, NFKC: lookup, uniqueness, limiter keys
  display_name TEXT NOT NULL,
  email_verified INTEGER NOT NULL DEFAULT 0,  -- better-auth's emailVerified
  first_signed_in_at INTEGER,        -- first session; gates setup resume and invitation reopening
  created_attempt_id TEXT,           -- invitation accept attempt that created the user (repair job, §8.1)
  role TEXT NOT NULL DEFAULT 'member',  -- owner | admin | member | guest (guest reserved for Phase 2; Zod)
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'deleted', 'system')),
  pending_security_notice TEXT,      -- JSON list of notices; banner until acknowledged on a fresh passkey sign-in (Identity §4.6a)
  admin_reset_at INTEGER,            -- no-email recovery flag shown to owners (Identity §4.6)
  admin_reset_by TEXT,
  admin_reset_acknowledged_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  CHECK (status IN ('deleted', 'system') OR email IS NOT NULL)
);
-- No password_hash and no session_epoch: sign-in is passwordless, and revocation deletes sessions (§3.5, §8.1).
-- better-auth's `user` model maps onto this table (Identity §5): name -> display_name,
-- emailVerified -> email_verified, image -> avatar_key; role, status, handle and profile columns are
-- additionalFields with input: false. IDs are ULIDs (advanced.database.generateId).
-- Reserved rows: id 'system' and id 'assistant', status 'system', no email (default).
-- They exist so messages.sender_id can reference them (Chat §4.6, Assistant §14.2). They are not
-- members: excluded from the directory, seat counts, sign-in and the permission engine (§2.1
-- "Permission resolution", step 1). The baseline migration inserts both with INSERT OR IGNORE.
-- Profile columns, `handle` (copy of the authoritative `handles` table) and the
-- `handles`, `passkeys`, `auth_accounts`, `auth_verifications` and `auth_tokens` tables are defined in Identity §5.
-- `auth_tokens.kind`: recovery | email_change | passkey_enrol (Zod), with a `payload` column.
-- Magic-link tokens live in better-auth's `auth_verifications`.

CREATE TABLE invitations (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE, -- always required; copy-link invites are bound to it (Identity §4.2)
  email_normalised TEXT NOT NULL,    -- trim, lowercase, NFKC
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  token_hash TEXT NOT NULL UNIQUE,   -- single-use; raw token only ever in the link
  invited_by TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL,
  accepted_at INTEGER,
  accepted_by TEXT REFERENCES users(id),
  accepted_attempt_id TEXT,          -- set by the accept compare-and-set (repair job, §8.1)
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX invitations_pending_email ON invitations(email_normalised)
  WHERE accepted_at IS NULL AND accepted_attempt_id IS NULL AND revoked_at IS NULL;

CREATE TABLE sessions (             -- better-auth `session` model, mapped (Identity §5)
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,        -- better-auth session token; the cookie carries it signed with BETTER_AUTH_SECRET
  ip_address TEXT,
  user_agent TEXT,
  device_label TEXT,                 -- additionalFields, set in databaseHooks.session.create.before
  approx_location TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,       -- last refresh of the sliding expiry ("last seen", at most a day old)
  fresh_auth_at INTEGER,             -- last passkey assertion on this session: step-up for sensitive actions and downloads (§8.1, Admin §11.3, which called it authenticated_at)
  fresh_auth_method TEXT,            -- passkey | magic_link
  expires_at INTEGER NOT NULL
);
-- No refresh token, epoch or revoked_at: revoking a session deletes its row (§3.5, §8.1).
-- Exact columns follow the generated SQL of the pinned better-auth version.
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
  sender_id TEXT REFERENCES users(id),  -- a member, or the reserved 'system' / 'assistant' rows
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

-- Cron overlap guard (§7.8): one lease per schedule. Excluded from export (job table).
CREATE TABLE cron_leases (
  schedule TEXT PRIMARY KEY,         -- five_minutes | hourly | daily (Zod-validated, no CHECK)
  holder TEXT NOT NULL,              -- ULID of the run holding the lease
  expires_at INTEGER NOT NULL        -- an expired lease can be taken over
);

CREATE TABLE embedding_jobs (        -- Phase 3 (M9); upserts only while assistant_enabled (§5.2)
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
| Identity | `users` profile columns, `handle` (copy of the authoritative `handles` table), `pending_security_notice`, the `admin_reset_*` flag and `email_verified`; no `password_hash` or `session_epoch`; new `handles`, `passkeys` (better-auth's model plus `verified_sign_count`), better-auth's `auth_accounts` and `auth_verifications`, our `magic_link_issues` and `user_devices`, `users.email_normalised` (unique), `first_signed_in_at` and `created_attempt_id`, `handles.created_attempt_id`, `invitations.email_normalised` (unique while pending) and `accepted_attempt_id`, `sessions.fresh_auth_at`, `recovery_token_uses`, `passkeys.created_via`, and `auth_tokens` (kinds `recovery`, `email_change`, `passkey_enrol`, plus `payload` and `revoked_at`); `installation.canonical_origin` / `allowed_hosts` / `setup_claimed_at` / `pending_origin*` (above); `invitations.group_ids`; `groups.handle`; `group_members.role` (manager, member); `sessions.device_label` / `approx_location` | Identity §5 |
| Chat | `channels.topic` / `description` / `posting_policy` / `config_version`; `channel_members.can_post` / `hidden` (no per-conversation email delay); message copy columns `kind` (`user`, `call_chat` or a Chat §4.6 system kind), `format`, `system_payload`, `reply_count`, `also_in_channel`, `forwarded_from`, `previews` (`body` stays the plain-text copy); new `thread_follows`, `saved_items` (`in_progress` / `done`), `sidebar_prefs`, `link_previews`, `message_previews` | Chat §15 |
| Permissions | `resource_grants` value lists; `general_access` values including `workspace_freebusy` (calendars only); `access_requests` with `expires_at` and a unique pending request per requester and object | Permissions §9 |
| Documents | `drives`, `file_versions`, `stars`, `recent_items`, `comment_threads`, `comments`, `item_activity`; `folders.drive_id` / `channel_id`; `documents.folder_id` / `drive_id` / `created_by`; `files.drive_id` / `current_version` / `copied_from_file_id` | Documents §9 |
| Calendar | `calendars`, `events` (with `range_start` / `range_end` UTC ms on every event), `event_exceptions`, `event_attendees`, `event_reminders`, `event_notes`, `time_off`, `ics_feeds`, `ics_subscriptions`. Holidays are generated, not stored. | Calendar §12 |
| Calls | `huddles.context_type` adds `event`; new `huddles.context_key` carries the active-call unique index; new `huddle_messages` (keyed to the context, no cascade from `huddles`) and `call_rings` (`state` includes `refused`) | Calls §10, §3.6 here |
| Notifications | `inbox_items` (above); `user_preferences` (email delay, DM text opt-in, DND, reminder defaults, offline cache, shortcuts), `user_availability` (derived-availability sources), `notify_anyway_log`; `notification_preferences` keyed by `user_id, event_type, delivery` | Notifications §3.1, §5.7, §7 |
| Timers | `scheduled_triggers` and `trigger_outbox` in the ReminderScheduler DO; D1 `pending_emails` | Platform §11 |
| Platform | `rate_counters` (D1 counters), `ics_opt_outs`, the durable UserHub room registry | Platform §8, §12, §15 |
| Files | Three kinds: message-owned (`parent_type = 'message'`), document-owned (`parent_type = 'document'`), drive files (`folder_id` set, versioned) | Platform §14, Documents §6 |
| Assistant | New `assistant_interactions`, `assistant_source_refs`, `assistant_optins`, `personal_reminders`, `file_derived_text`, `call_notes`, `call_transcript_segments`; `messages.kind` adds `assistant` and `call_notes` (sender `'assistant'`); `scheduled_triggers.kind` adds `assistant_brief`, `assistant_prep`, `personal_reminder`; `inbox_items.event_type` adds `assistant_brief`, `assistant_prep`, `assistant_nudge`, `assistant_reply`, `personal_reminder`; `rate_counters` scopes `assistant_requests`, `assistant_voice`, `assistant_media`, `assistant_call_notes`; reserved handles `assistant` and the display-name handle; reserved `users` rows `'system'` and `'assistant'` (`status = 'system'`, above) | Assistant §14.2 |
| Admin | New `admin_alerts` (one row per `kind, subject`), `health_checks`, `maintenance_windows` (single-open-window unique index), `admin_jobs` (CSV invites and bulk actions) and `download_tokens` (token hashes only); `exports` columns and states (§7.5), including the partial unique index allowing one running workspace export; the `installation` columns above (the step-up field is `sessions.fresh_auth_at`, Identity §5); `inbox_items.event_type` adds `admin_alert` and `maintenance_scheduled`; shared error codes `reauth_required` and `maintenance` | Admin §16 |

**Permission resolution** ([Permissions](specs/permissions.md) §5). The Worker resolves access as follows:

1. **Account:** the user's status must be `active`. The reserved `status = 'system'` rows never pass, so the system sender and the assistant are never principals and can't be granted anything (Assistant §1).
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

**Engine implementation** (M1p). The engine is one pure function, `decide(actor, check, now)` in `packages/shared/src/permissions.ts`, returning `Result<void, DenialReason>`. It does no I/O and reads no clock: the actor carries role, status and the session's step-up facts (`fresh_auth_at`, `fresh_auth_method`), each check carries the facts its rule needs (target role and status, active-owner count, passkey counts, whether `RECOVERY_TOKEN` is set and unconsumed, whether magic links work, group managers), and `now` is passed in. A decision runs in three steps: only `active` actors act (`system` rows give `system_actor`, others `inactive`); the action's rule; then step-up for the sensitive actions, so a role denial always wins over `reauth_required`. The engine **fails closed**: an unknown role, status or action is denied, and guests are refused everything until Phase 2. The fact-free part (status, role, the action's audience) is exported as `decideWithoutFacts` and runs before any fact is loaded, so a request about to be denied costs no queries and can't learn whether its target exists. **The last-owner decision is never the last line of defence:** the write that disables, deletes or demotes an owner is also conditional (`UPDATE … WHERE (SELECT count(*) …) >= 1`, Admin §5.3), because the owner count can change between the check and the write. The Worker wraps it in `apps/worker/src/core/permissions.ts`: `authorize(ctx, request)` takes a route-facing request (an action and IDs), loads the facts through injectable `PermissionFacts` loaders, parses people with the shared Zod schemas, and returns `forbidden` or `reauth_required` (both 403, with the engine's `reason`), or `not_found` for a missing target (only for actors who could act on it) or when the route hides existence. Bulk jobs rebuild the actor and call `authorize` per item. **Extending it:** a feature adds a check type to the `PermissionCheck` union with its facts as plain values, a rule function dispatched from the engine's exhaustive `switch`, the action in `STEP_UP_ACTIONS` if sensitive, a loader per new fact and a request mapping in the wrapper, and literal rows in the matrix test. Resource roles are combined with `effectiveResourceRole` (the union rule) from the sources a loader collects, and compared with `resourceRoleAtLeast`.

### 2.2 Durable Object SQLite schemas

**Core tables in every DO** (`apps/worker/src/core/do/base.ts`, M0b). Every Durable Object extends the core base class, which owns four tables, versioned separately from the feature schema (`meta.core_schema_version`):

```sql
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);   -- schema_version, core_schema_version, feature keys
CREATE TABLE core_timers (                                -- alarm multiplexer: the alarm is set to MIN(due_at)
  name TEXT PRIMARY KEY,                                  -- '<kind>' or '<kind>:<id>', e.g. 'poll:01J…'
  due_at INTEGER NOT NULL,
  payload TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,                    -- failed runs; retried with backoff
  generation INTEGER NOT NULL DEFAULT 0                   -- bumped on reschedule, so a rescheduled timer is kept
);
CREATE TABLE core_outbox (                                -- generic transactional outbox, one stream per queue
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stream TEXT NOT NULL,
  body TEXT NOT NULL,                                     -- JSON message, at most 128 KB
  bytes INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,                    -- failures when sent alone
  next_attempt_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  strikes INTEGER NOT NULL DEFAULT 0,                     -- core migration 3: failures separated by a success
  last_strike_at INTEGER                                  -- core migration 3: when the row last gained a strike
);
CREATE TABLE core_outbox_dead (                           -- rows given up on (core migration 2); same columns
  id INTEGER PRIMARY KEY, stream TEXT NOT NULL, body TEXT NOT NULL, bytes INTEGER NOT NULL,
  attempts INTEGER NOT NULL, created_at INTEGER NOT NULL, dead_at INTEGER NOT NULL
);
```

Timers are rows in `core_timers` rather than a JSON value in `meta`, so the earliest is an indexed lookup and each timer is updated on its own. The per-feature `outbox` tables below show the shape each feature needs; a feature may use `core_outbox` (message stored at write time) or keep its own table when it must build the message at drain time, as ChatChannel does with full message state (reconciled in M3). The spike kept its timers in `meta.timers`; M3 moves ChatChannel onto `core_timers` when it promotes the spike code. **Outbox failure handling** (`apps/worker/src/core/do/outbox.ts`; `strikes` and `last_strike_at` are added by core migration 3, expand only):
- *Per-row failures.* Every row that was in a failed send during a drain, and wasn't sent later in it, counts an attempt and backs off on its own: `next_attempt_at = MAX(existing, now + backoff)`, 2 s doubling to 5 minutes, with up to 20 % jitter. Failing chunks are bisected down to single rows. Drains take due rows by `attempts, id`, so rows that never failed go first; failed rows move behind them, so good rows always make progress whatever bad rows are in front of them. `attempts` drives backoff and ordering only.
- *Order and ride-along.* Due rows are selected by `attempts, id` (at most 500). A drain sends in two phases: first rows that failed before, then fresh rows (attempts 0); the first phase gets at most half the 32-send budget when fresh rows are waiting, so fresh rows are never starved. When fresh rows are present and the stream is healthy (the previous drain delivered something; `outbox_failed_drains:<stream>` absent), up to 4 rows that failed before (most strikes, then most attempts) ride along in the first phase even if they aren't due yet (never during an outage, so backoff holds), so a lone bad row is tested whenever real traffic flows. Failing chunks are bisected right half first. Under a sustained backlog of more than 500 fresh rows per drain, rows that failed before (beyond the ride-along) wait until it clears.
- *Dead-letter rule: a strike needs proof of health after the failure, in the same drain* **(default)**. The stream keeps a success sequence, `outbox_success_seq:<stream>`, incremented the moment each successful send resolves. When a row fails **on its own** (after bisection) the sequence is noted; at the end of the drain it gains a strike only if a later send in that drain succeeded (end sequence > the noted one) and its previous strike, if any, was at least 10 minutes ago (`minStrikeGapMs`, **(default)**). At 10 strikes **(default)** it moves to `core_outbox_dead`. So an outage adds no strikes, nor does a queue that goes down after a success; a queue alternating between success and failure on every send **can still dead-letter a good row** after 10 strikes, which takes at least 90 minutes of it (accepted, **(default)**); a lone bad row is dead-lettered after ten drains, at least 10 minutes apart, in which fresh rows were sent after it (with no other traffic it is never dead-lettered and keeps retrying); rows written before migration 3 start at 0 strikes. Failures inside multi-row batches never add strikes.
- *Budget.* A drain makes at most 32 sends and runs at most 4 minutes (both configurable), under the 5-minute outbox timer timeout. If a drain sends nothing, the due rows it didn't reach are pushed back by a stream backoff without attempts, so a down queue isn't re-drained in a tight loop; from 10 such drains in a row it logs at error level.
- *Guarantees.* At least once. Rows that never failed go out in row-ID order; after failures, newer rows overtake older ones being retried, so consumers must be idempotent and order-tolerant.
- *`meta` keys used by the outbox:* `outbox_success_seq:<stream>` (successful sends so far; the strike sequence), `outbox_last_success_at:<stream>` (epoch ms of the last one, reported by `stats()` only) and `outbox_failed_drains:<stream>` (consecutive drains that sent nothing; the stream backoff exponent, removed on success; from 10 it logs "no send succeeded in N drains: queue outage or all rows failing"). `Outbox.stats()` reports pending, dead, oldest pending age, max attempts and strikes, success sequence, last success and stream backoff.

**Nothing reads or re-drives `core_outbox_dead` until M7**, which adds it to admin health with a re-drive action; until then dead rows are visible only in the error log and `Outbox.stats()` (admin note).

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
  key TEXT PRIMARY KEY,    -- schema_version, channel_id, log_horizon_seq (timers: core_timers above)
  value TEXT
);
```

Presence and typing state are not stored in SQLite (§3.4).

**Event log horizon.** The `messages` table is kept for as long as the channel exists. The `events` log is only needed for reconnect replay, so it is trimmed to a horizon (default 30 days, never before `outbox` is drained). A client whose `afterSeq` is older than `log_horizon_seq` gets a `reset` and reloads from `messages` (§3.3).

**Deletion redaction.** A `message.deleted` event sets `messages.body`, `attachments`, `mentions` and `reactions` to NULL. In the same transaction it overwrites the `payload` of all earlier events for that message with `{"redacted":true}`. Deleted content is never served through replay.

**Message state and new event types** (Chat §15, §16):
- **Message state** adds `kind` (`user`, `call_chat`, `assistant`, `call_notes`, or a system kind using the Chat §4.6 names, such as `member_joined`, `channel_renamed`, `call_started`, `call_ended`, `missed_call`, `poll_closed`, `message_pinned` or `welcome`), `format` (rich-text JSON), `body` (plain-text copy), `mentions`, `system_payload`, `reply_count`, `last_reply_at`, `thread_participants`, `also_in_channel`, `forwarded_from` (a live reference, never copied content) and `previews`.
- **New event types:** `message.pinned` / `message.unpinned`, `poll.created` / `poll.voted` / `poll.closed`, `preview.attached` / `preview.removed`.
- **Polls** live in the DO's `polls` table (with a per-poll `poll_secret`) and `poll_votes` (`poll_id`, `voter_key`, `option_ids`).
- **Anonymous poll exception:** for `poll.voted` on an anonymous poll, the event's `actor_id` is the per-poll **`voter_key` = HMAC(poll_secret, user ID)**, never a user ID. The member's identity can't be recovered from the event log, the outbox or exports (`poll_secret` is excluded from exports).
- **System messages** are written by typed RPCs, for example `postSystemEvent` from the HuddleRoom for `call_started`. They may post into announcement, read-only and archived channels.
- **Assistant messages** (kinds `assistant` and `call_notes`, Assistant §6, §12.3) are written by a typed RPC with `sender_id = 'assistant'`, handled like `'system'`: no posting-policy check, `system_payload = { invoked_by, sources }`. Mention replies use `client_id = 'assistant:' + mentionMessageId`, so the existing `events_client` index makes repeated deliveries post one reply.
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
- the **room registry** `(kind, room_id, connection_id)`, with kinds `channel`, `doc`, `board`, `huddle` and `assistant` (the member's `/ws/assistant` sockets, §5.5)
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
- **Trigger kinds:** `reminder`, `event_start` (raises `call_starting`), `focus_start` / `focus_end`, `time_off_start` / `time_off_end`, `status_expire`, `dnd_start` / `dnd_end`, `dnd_until_end`, `email_release`, and from M9 `assistant_brief`, `assistant_prep` (both enqueue to `assistant-proactive`, §5.8) and `personal_reminder` (raises the `personal_reminder` inbox item, Assistant §7.1). Availability kinds call UserHub `refreshAvailability()`. `assistant_brief` and `assistant_prep` are suspended while the member is disabled or lacks assistant access, `personal_reminder` while disabled, and all three are deleted with the member (Assistant §10.1, §13).
- **Filling:** a rolling 48-hour expansion of recurring events and per-attendee time zones. The calendar service updates triggers on every change, and an hourly refill job extends the window.
- **Firing (outbox pattern):** one alarm, set to the earliest of the next unfired trigger and the next outbox retry. In one DO transaction the trigger is marked fired and a `trigger_outbox` row is written; the alarm drains the outbox to the queue, deleting rows only after a successful send. The consumer is idempotent on the trigger ID, so each trigger has at most one effect, retried until delivered (Platform §11.1).
- **Catch-up:** triggers less than 1 hour overdue fire; older ones are dropped and logged.

**HuddleRoom** keys calls by `context_key` (§3.6).

**Assistant DO** — one per member (`idFromName(user_id)`), M9. Its SQLite schema (conversations, turns, memory items, source references, FTS tables, pending actions, prefs) is defined in [Assistant §14.1](specs/assistant.md), which is authoritative. The design is in §5.5–§5.11.

### 2.3 Deletion, retention and purge

This implements PRD §10.2.

**Soft delete (Trash).** Deleting a channel, document, whiteboard, folder, drive, drive file, calendar, event, project or issue sets `deleted_at = now` and `purge_after = now + 30 days`. The object disappears from normal queries, search and previews straight away. Restoring it clears both fields. **Who may restore** (one rule everywhere, Platform §5): the item's owner, the person who deleted it, drive managers of its drive, and admins. `time_off` has no Trash: it keeps `deleted_at` for audit and is hard-deleted 30 days later.

**Purge pipeline.** A daily Cron Trigger finds rows with `purge_after < now` and inserts `purge_jobs` rows. Each job moves through idempotent stages, delivered on the `purge` Queue with retries and backoff. Failed jobs appear in admin health (§7.1).

| Object | Purge stages |
|---|---|
| Channel | ChatChannel DO `purge()` (`ctx.storage.deleteAll()`), then attached files (R2 delete), then D1 `messages`, `channel_members`, `inbox_items`, `object_links` and `resource_grants` where the channel is the principal, then the channel's `call_notes` and transcripts (M9), then vectors, then the `channels` row. |
| Document / whiteboard | DocRoom / BoardRoom DO `deleteAll()`, then R2 snapshot copies (prefix delete), then attached files, then grants, links and inbox items, then the document's `call_notes` and transcripts (M9), then vectors, then the `documents` row. |
| Folder | Contained files and subfolders (each through its own job), then the row. |
| File | R2 object(s), then `file_derived_text` and its vectors (M9), then the `files` row. |

**Message deletion is immediate, not trashed.**

1. The DO redacts the message (§2.2) and appends a `message.deleted` event.
2. The D1 copy sets `body` to NULL via the normal projection (§3.3).
3. Attached files get purge jobs with `run_after = now`.
4. Vectors are invalidated (M9; this runs whether or not the assistant is enabled, §5.2).
5. The `assistant-purge` fan-out runs (below).

**Cascades for new containers** ([Platform](specs/platform.md) §4 defines each row):
- **Channel purge** moves the documents in its channel folder to their creators' My files (an admin's if the creator was deleted), keeping explicit shares. It deletes message-owned files and link previews with the messages. It cleans up polls, pins, saved items, `thread_follows`, sidebar sections and grants where the channel is the principal. Huddle records keep their `context_id`.
- **Group deletion** sends the group drive to Trash, archives the group calendar, removes the group's grants and releases its handle. Expanded attendees stay as individuals.
- **Calendar deletion** (standalone and external kinds only) deletes its events, attendee rows and triggers.
- **Drive deletion** sends the drive and its contents to Trash; restore follows the rule above.
- **Group and channel calendar purge** moves each event to its organiser's personal calendar so attendees keep it; events whose organiser was deleted are deleted, with `event_cancel` sent to attendees (Platform §4).
- **Event deletion** applies to a series or an occurrence.
- **File purge** deletes every version.
- **Comment threads** are deleted with their document.
- **Call notes and transcripts** (M9) are deleted, with their vectors, when their channel, event or document is deleted (Platform §4). `call_notes` is keyed to the context and doesn't cascade from `huddles`.

**Assistant copies follow deletion** (Assistant §4.4). Every pipeline that deletes content also feeds the `assistant-purge` queue: message deletion, channel purge, document or whiteboard purge, a file version dropped or purged, event deletion, and call notes or transcripts purged by retention or a context cascade. The pipeline looks up D1 `assistant_source_refs` for the deleted objects and enqueues one job per affected member; the consumer and the DO side are described in §5.7. These jobs run while the assistant is off and for disabled members, because they are housekeeping, not requests.

**Member lifecycle and personal-data erase.** [Platform](specs/platform.md) §3 defines, per feature, what happens on **disable** (everything kept; sign-in blocked; sockets closed, including calls) and **delete** (personal data erased). §3.1 there is the authoritative erase list. It covers profile fields, passkeys, auth tokens, sessions, preferences, follows, saved items, stars, recent items, time off, event notes and reminders, ICS feeds and subscriptions, inbox items, access requests, and the avatar object in R2. It also re-renders `@handle` text as "Former member" in message copies and the search index. Ownership transfers on delete: My files, organised events and owned calendars go to an admin. Messages keep `sender_id`. From M9 the erase list adds the member's **Assistant DO storage** (`deleteAll()`), their `assistant_interactions`, `assistant_optins`, `assistant_source_refs` and `personal_reminders` rows and their assistant triggers; `call_notes.started_by` and `call_transcript_segments.speaker_id` show "Former member", like messages (Assistant §13). Every Worker path checks the member's status in D1 before addressing an Assistant DO, so a queued job never recreates a deleted member's DO.

**Retention and Trash** for every object are in [Platform](specs/platform.md) §5, including who may restore from each container. The daily cron runs those rules: audit log, resolved inbox items, event-log horizons, expired invitations, sessions, tickets and auth tokens, huddle metadata (365 days), call rings, outside-attendee emails, access requests and link previews. **In-call chat** for document and event calls is kept for the life of its context, not with huddle metadata.

**Assistant purge jobs** (M9, Assistant §14.3) run in the same daily cron: expired `assistant_interactions` (`assistant_interaction_retention_days`), `call_transcript_segments` past `call_transcript_retention_days` together with their vectors (notes stay for the life of the context), `file_derived_text` for purged versions, and `personal_reminders` 30 days after done or dismissed. Conversations and memory are swept inside each Assistant DO by its own `retention_sweep` timer (§5.5). All of these keep running while the assistant is turned off.

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
  object_type UNINDEXED,   -- message, document, whiteboard, file, call_notes (M9)
  object_id UNINDEXED,
  scope_id UNINDEXED,      -- channel ID for messages; document or folder ID otherwise; Assistant §9 for M9 types
  tokenize = 'unicode61 remove_diacritics 2'
);
```

**Indexing.**

- Messages: the message projection consumer (§3.3) inserts, replaces or deletes rows in `search_index` in the same D1 batch as the `messages` upsert.
- Documents and whiteboards: once updates have been quiet for 5 seconds (and at most once every 60 seconds), the DO extracts the title and plain text and queues it through its outbox to the `search-projection` Queue. The consumer upserts `document_text` and `search_index` together.
- File names are indexed when uploaded. File contents are not indexed in Phase 1.
- **From M9** (Assistant §9), two more kinds of text are indexed, by the `indexing` consumer (§5.2):
  - **derived file text** from `file_derived_text`, per file version (`scope_id`: the file's folder or drive, or its message's channel; checked as the file)
  - **call notes and transcripts** as object type `call_notes` (`scope_id`: the channel for channel and DM calls, the document for document calls; checked as that context). Notes and transcripts of **event** calls are not indexed; they are reached through the event with event access checked.
  - Because they come from the assistant pipeline, their **upserts** follow its gate (only while `assistant_enabled` is on, §5.2). Their **deletions** always run: Trash removes derived text from search, restore re-indexes it, purge and retention delete it, and **Delete assistant index** removes every derived-text row.
- **Events are never indexed** (Assistant §9): their access depends on calendar role, attendee status and visibility, which no single scope can express.
- When a member is deleted, `@handle` text in the plain-text message copy and in `search_index` is re-rendered as "Former member" (Platform §3).

**Querying.**

1. A CTE builds the requesting user's accessible scopes, following the §2.1 rules:
   - public channels
   - channels from `channel_members`
   - documents, whiteboards, drive files and folders reachable under the **union rule** (§2.1): grants on the item, its ancestor folders and its drive, built-in drive roles, the channel-folder rule (members of the channel, or everyone for public channels), and general access along the chain
   - message-owned files, searchable by file name (and, from M9, derived text) only within conversations the user can read
   - from M9, call notes in channels the user can read and documents the user can open (Assistant §9).
2. The FTS `MATCH` results are joined to those scopes and ranked by `bm25()`, with `snippet()` for highlights.
3. Results for deleted or trashed objects never appear, because deletion removes their rows from `search_index`.

**Export and storage.**

- `wrangler d1 export` doesn't support databases that contain virtual tables. So the Officebox export (§7.5) uses its own JSON Lines format, leaves out `search_index`, and rebuilds it on restore.
- The admin guide documents the raw-dump workaround: drop the FTS table, export, then recreate it and use **Rebuild search index**. D1 Time Travel is unaffected.
- FTS roughly doubles the storage used by indexed text. It counts towards D1's 10 GB limit, and storage monitoring includes it.


## 3. Application realtime design (Durable Objects)

### 3.1 Connection lifecycle and authentication

1. The client signs in with a passkey or a magic link (below), through **better-auth** (§8.1), on the **canonical origin** only. better-auth sets one **session cookie** (`HttpOnly`, `Secure`, `SameSite=Lax`, host-only with path `/`, `__Host-` prefixed where better-auth allows; §10) holding its session token, signed with `BETTER_AUTH_SECRET`. The session row lives in `sessions` (§2.1): 30 days, sliding (`expiresIn` 30 days, `updateAge` 1 day). There are **no access or refresh tokens**.

   JavaScript can't read the token, it never appears in a URL, and no response body carries it: get-session isn't exposed (the web app uses `GET /me`) and a response filter strips session tokens from better-auth's JSON (§8.1).
2. The client opens WebSockets to `/ws/hub`, `/ws/channels/:id`, `/ws/docs/:id`, `/ws/calls/:id` (after `POST /calls/:id/join`, §3.6) or, from M9, `/ws/assistant` (always the member's own Assistant DO, §5.5). Browsers send same-origin cookies with the upgrade request.
3. The Worker validates the cookie with better-auth (`auth.api.getSession`, which reads the session row from the D1 primary because the cookie cache is off) and checks that the user is `active`. It checks the `Origin` header against the installation's **canonical origin** (`installation.canonical_origin`, the same value better-auth's `trustedOrigins` and the passkey relying-party ID use), which blocks cross-site WebSocket hijacking. It then resolves the user's role for the target and forwards the request to the Durable Object.
4. The DO accepts the socket with `ctx.acceptWebSocket(server)` and stores the user ID, session ID, role and connection ID with `serializeAttachment`.
5. Sockets live until they close or are revoked (§3.5). Revoking a session deletes its row and closes every socket whose attachment carries that session ID. A session that **expires** on its own is caught by the UserHub's periodic session recheck (§3.5).
6. **Clients that can't send cookies** (a stock Yjs client, future native apps) use a one-time connect ticket:
   - The client calls `POST /auth/ws-ticket` while authenticated.
   - The ticket is single-use, valid for 30 seconds and bound to one target. It is passed as `?ticket=` and stored hashed in `ws_tickets`.
   - A logged URL therefore never leaks a reusable credential.
7. When the DO wakes from hibernation, the constructor runs and state is restored from the attachments.

**Sign-in methods** (Identity §4.4). **Passwordless:** there are no passwords, password resets or peppers (product-owner decision, 15 Nov 2026).
- **Passkeys** (better-auth `@better-auth/passkey`, SimpleWebAuthn underneath): WebAuthn with **discoverable credentials**.
  - **User verification is required** on every sign-in and registration, for everyone, enforced on the server (product owner, 15 Nov 2026).
  - The counter rule (at or below the stored value, not both 0, is `clone_detected`) is enforced by the library or by our after hook, as the M1a-0 spike decides (§8.1, §10).
  - Credentials are bound to the **relying-party ID**, the canonical origin's host (§8.1): a domain change or a restore onto another origin leaves passkeys unusable. Registering on `*.workers.dev` warns about this. Each passkey records how it was created, and every addition raises a `security_notice`.
  - The first passkey after setup, invitation acceptance or recovery is registered with an **enrolment ticket** cookie instead of a session (`registration.requireSession: false`, `resolveUser`), bound to the challenge and consumed at verify.
- **Magic link** (better-auth `magicLink` plugin), **members only**: single-use and valid for 15 minutes, on any device; never creates an account (`disableSignUp`); never sent to owners or admins. Scanner-safe through our confirmation page (below). A sign-in from a new device raises a `security_notice`.
- Every account is passkey-only, plus magic links for members when email is configured. Owners need a second passkey or a set, unconsumed `RECOVERY_TOKEN` before inviting (§8.1).

**better-auth routes** are mounted at `/api/auth/*` and handed to `auth.handler(c.req.raw)`. Only an allowlist is reachable from outside, **default-deny on the exact normalised method and path**: sign-out, the magic-link request, and passkey sign-in and registration. Get-session and everything else answer 404, and our routes call the rest on the server through `auth.api` (Identity §6). Our own routes under that prefix (`/api/auth/ws-ticket`, `/api/auth/recover`) are registered first.

**Other identity endpoints** (Identity §6): `POST /setup` takes a `handle` with the owner's details, records the canonical origin, and sets an enrolment ticket cookie for the owner's passkey; `GET /me` returns the signed-in member; `POST /auth/ws-ticket` issues connect tickets (above); "My devices" wraps better-auth's list and revoke and never returns session tokens. Email change uses an `email_change` token (pending address in `auth_tokens.payload`) with a confirmation page (token in the fragment) and a POST that applies it; the old address is notified and other pending tokens and magic links are revoked. better-auth's own change-email route isn't exposed.

**Email links are scanner-safe** (Platform §10). Magic-link, recovery, invitation, email-confirmation and RSVP links open a **confirmation page**. Only a **POST** from that page uses the token, so mail scanners and link prefetchers can't use it up. Identity links carry the token in the **URL fragment** and are built from the canonical origin (§8.2). Our tokens live in `auth_tokens`, hashed, consumed by compare-and-set. RSVP tokens are per attendee and reusable until the event ends. **Magic links:** better-auth verifies with a GET, so its link is never sent. `sendMagicLink({ email, token, url })` records the token's hash in `magic_link_issues` and emails a link to our confirmation page (`/sign-in/link#t=…`); the page's POST (`POST /api/sign-in/link`) consumes that row by compare-and-set, then calls `auth.api` magic-link verification on the server and returns better-auth's session cookie. better-auth's GET verify route isn't reachable from outside.

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
- **Assistant (M9, Assistant §6, §8):**
  - `message.send` recognises the `assistant` mention token (offered only when the assistant and `assistant_mentions` are on and the sender has assistant access) and enqueues to `assistant-mentions`, limited to 5 per 60 seconds per conversation in the DO. It creates no inbox record and no "add to channel?" prompt.
  - Replies arrive through the assistant-message RPC (§2.2).

**Write path:**

1. The DO checks the payload and the caller's permission, using the connection attachment (§3.1) and the channel config pushed by `applyConfig` (§2.2).
2. Within one synchronous SQLite transaction (`ctx.storage.transactionSync`):
   - **Dedupe:** if `(actor_id, client_id)` already exists, re-acknowledge the existing `seq` and stop.
   - Assign `seq = last + 1`, insert into `events`, update `messages` (applying redaction for deletes), and insert an `outbox` row.
   - Schedule the alarm if no earlier one is set. The default batching delay is 250 ms.
3. After the commit, the DO sends `{type: "ack", clientId, seq, id}` to the sender and `{type: "event", seq, ...}` to every connected socket. DO output gating means no acknowledgement leaves the object before its write is durable.
4. The **alarm handler** drains the `outbox` in `seq` order, in batches of up to 100. For each event it sends the **current full state** of the affected message (from `messages`, not the event delta) to the `message-projection` Queue with `sendBatch`.
   - Rows are deleted only after the send succeeds.
   - On failure the DO increments `attempts` and reschedules with exponential backoff, capped at 5 minutes. M0b's generic outbox (§2.2) adds bisection of failing chunks, a per-drain send budget, the ride-along and the strike rule for dead-lettering; a queue alternating on every send can still dead-letter a good row after 10 strikes, at least 90 minutes **(default)**.
   - DOs have one alarm each. Other timers (typing expiry, log trimming) are named timers in `core_timers` (§2.2), and the alarm is always set to the earliest due timer.
5. The **queue consumer** upserts into D1 `messages`:
   ```sql
   ... ON CONFLICT (channel_id, seq) DO UPDATE SET ...
       WHERE excluded.last_event_seq > messages.last_event_seq
   ```
   Because each delivery carries full state guarded by `last_event_seq`, duplicate or out-of-order delivery is harmless. The consumer also advances `channels.projected_seq` and creates or updates inbox records for mentions, DMs and thread replies, using the Notifications §3 dedupe keys (one record per DM conversation; one per mention), then hands them to notification delivery. Message deletion retracts matching records (Notifications §3.1). Failed batches retry, then go to a dead-letter queue. DLQ depth is shown in admin health.
   - **Sender `assistant`** (M9): the consumer projects assistant messages like user messages, including unread counts (Chat §7, §3.5 below), but creates no mention inbox record for the assistant itself.
   - **Commitment nudges** (M9, Assistant §8): for each new message, the consumer checks D1 `assistant_optins` and enqueues to `assistant-nudges` **only** when the author has nudges on (and the assistant and `assistant_proactive.nudges` are enabled). Other members' messages are never sent for classification.
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
6. **Assistant socket** (`/ws/assistant`, M9) to the member's Assistant DO, only while an assistant surface is on screen (Assistant §3).

Other embeds (messages, events, document previews, link previews) refresh through hub `activity` events and never open sockets. **Hard cap: 6 sockets per tab.** Opening another closes the least recently used embedded-board socket.

Tabs of the same browser elect a leader with `BroadcastChannel` and share one hub socket.

**Unread state** (Chat §7). On connect, the client loads unread and mention counts over REST. Unread counts **top-level messages and "also send to channel" copies** in D1 with `seq > channel_members.last_read_seq`, excluding the member's own messages, system messages, `call_chat` messages, deleted messages and thread replies (tracked per followed thread in `thread_follows`). Assistant messages (`sender_id = 'assistant'`) count like user messages **(default, Chat §7)**. The D1 copy can lag a few seconds; tests wait for it to converge. Read cursors are written by the client, debounced, and only move forward. The mention count comes from unread inbox records. After that, counts are kept current by hub events.

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
- **Maintenance mode doesn't use `updateAccess`.** Open rooms get a room-level `setMaintenance(epoch, active)` RPC that sets a read-only flag separate from each socket's role (§7.5, Admin §13.2).
- **Offline edits** that reach the server after access was lost are rejected. The client keeps them locally and offers to export them.

**Revocation.** Whenever a user is disabled or deleted, a session is revoked, or the user loses access to a channel, document or call context, the Worker calls `closeConnections(userId, reason, scope)`. The room registry kinds are `channel`, `doc`, **`huddle`** and **`assistant`**, so revocation also closes HuddleRoom sockets and the user's SFU tracks, and the member's `/ws/assistant` sockets:

- on the user's UserHub, and
- on every affected ChatChannel, DocRoom, BoardRoom or HuddleRoom DO, and the member's Assistant DO.

Losing assistant access (removal from `assistant_access`) closes `/ws/assistant` sockets with `4403`; disabling closes them with `4401` (Assistant §10.1, §13).

To find every affected DO, each ChatChannel, DocRoom, BoardRoom, HuddleRoom and Assistant DO registers a new connection with the user's UserHub (`registerRoom(kind, roomId, connectionId)`), and reports its close. The registry is **stored in UserHub SQLite and never pruned by age** while the socket lives; a daily sweep asks each room whether the connection still exists. A **Worker-side fallback** recomputes affected rooms from D1 (channel membership, grants, call contexts, and the member's own Assistant DO, which is always included for a user-wide revocation or loss of assistant access) and calls `closeConnections` directly, so revocation works even if the registry is incomplete (Platform §12). For a user-wide revocation, the UserHub closes its own sockets and calls `closeConnections` on every registered room. Each DO closes matching sockets with application close code `4401` (session revoked) or `4403` (access removed). The client re-authenticates or leaves the view. Because a session's hub socket is closed and its session row is deleted, a disabled user loses all realtime access within seconds.

**Sessions that expire on their own.** While a user has sockets open, the UserHub's alarm **rechecks each connected session's row** (every 5 minutes with the presence heartbeat **(default)**) and calls `closeConnections` for sessions whose row is gone **or whose `expires_at` is before now**. This catches natural expiry, and is the fallback wherever better-auth has no session-delete hook.

**Session revocation and better-auth** (Identity §4.5). `closeConnections(userId, reason, scope)` takes a scope of one **session ID** (sockets carry it in their attachment) or the whole user, so no `session_epoch` is needed. better-auth deletes session rows; we trigger the socket close from one helper, called by better-auth **after hooks** on its sign-out route (and a session-delete database hook where the pinned version has one) and directly by our routes that revoke through `auth.api`: My devices, sign out everywhere, admin sign-out, disable, recovery and owner recovery.


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

Huddle records hold metadata only. No media is ever recorded. When call notes are on (M9c), the transcript is stored as text in D1; audio is never stored (below).

**HuddleRoom DO state** is kept in memory and mirrored to SQLite `meta`, so it survives eviction. It holds:

- the host (the person who started the huddle)
- for each participant: user ID, SFU session ID, published tracks (`audio`, `video`, `screen`, `screen-audio`), mute state and raised hand
- the current presenter
- pending take-over requests.

**Join flow:**

1. The client calls `POST /calls` to start a call from a context, then **`POST /calls/:id/join`**. The Worker checks access to the context. When starting, it inserts the `huddles` row; the partial unique index means a concurrent start for the same context joins the existing call. Join returns `409 { currentCallId }` when the person is already in another call, unless `{ leaveCurrent: true }` is sent, and `409 { full }` at 25 participants. While call notes are on, it returns `notes_ack_required` unless `{ ackNotes: true }` is sent (below). `POST /calls/:id/leave` leaves explicitly.
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

**Call notes and captions** (M9c; [Assistant](specs/assistant.md) §12.3, §12.4 are authoritative for behaviour, §14.2 for `call_notes` and `call_transcript_segments`):
- **Notetaker.** `POST /calls/:id/notes` (a participant with assistant access, while `assistant_call_notes` is on and the workspace call-notes cap isn't reached) adds a **virtual notetaker** to HuddleRoom state. It is shown in the roster, has no tracks, isn't a `huddle_participants` row and doesn't count toward the 25-person limit. One notetaker per call. `DELETE /calls/:id/notes` stops it (any participant). Start and stop are serialised in the DO in arrival order; a restart is refused for 10 seconds after a stop. Each start and stop posts a system message to in-call chat and is written to `audit_log`.
- **HuddleRoom state** adds the notes windows (`start`, `stop`, `started_by`, `stopped_by`, by HuddleRoom server time), the open `call_notes` ID and the set of participants with captions on, mirrored to SQLite `meta` like the rest of its state.
- **Mandatory join notice.** While notes are on, `POST /calls/:id/join` without `ackNotes: true` returns `notes_ack_required` with the notice text (who started notes, who will see them, and whether captions are on), even when the client would skip the pre-join screen. Until the person repeats the join with `ackNotes: true` they are not in the call, publish nothing and are not transcribed. A notes start that races a join applies the same check.
- **Per-track transcription.** The HuddleRoom receives each participant's audio track from the SFU through the Realtime **WebSocket audio adapter** and transcribes each track separately with streaming speech-to-text through `ModelProvider` (§5.10), so speakers are attributed by track. Audio is transcribed only while a window is open by HuddleRoom time; audio in flight at a stop is dropped. Audio is never stored. **This path is gated by the voice spike** (§10): whether the adapter can deliver 25 tracks to one DO, and whether one HuddleRoom has the memory, CPU and wall time for it or a separate per-call transcriber DO is needed.
- **Captions.** `POST` / `DELETE /calls/:id/captions` turns captions on or off for the caller only (when `call_captions` is on). They use the same per-track pipeline and store nothing. While anyone has captions on, the DO broadcasts a "Captions on" indicator to every participant.
- **Segments and durability.** Transcript segments are written to D1 `call_transcript_segments` in batches through the outbox helper (§3.3). The HuddleRoom holds a segment only until its D1 write succeeds and keeps nothing after finalising, so **D1 is the only lasting copy** and retention and cascades act on D1 and vectors alone. After eviction or a redeploy mid-call, the DO reconnects transcription on wake and records a transcription gap in `call_notes.gaps`.
- **HuddleRoom timers** (alarm multiplexer): `notes_idle` stops notes when no human participants remain; `notes_finalize` writes the notes (summary, decisions, action items) after the call ends or after a crash, retrying the model 3 times with backoff before posting the "transcript available" fallback, and discarding the result if the context was deleted meanwhile.
- **Output.** Channel and DM calls get a `call_notes` message through the assistant-message RPC (§2.2); event calls a "Call notes" section on the event; document calls the document's Activity section. Notes and transcripts are then indexed per §2.4 and §5.2.
- **Caps and cost.** Call minutes while notes or anyone's captions are on count against `assistant_call_notes_monthly_minutes` (D1 `rate_counters` scope `assistant_call_notes`).
- **Injection.** The notetaker has no tools; transcripts are untrusted input wherever they are later read (§5.5).

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

The AI release is the workspace assistant, milestone M9 (Phase 3). [Assistant](specs/assistant.md) is authoritative for its behaviour, rules and feature tables; this section is the technical design. AI stays optional: with the assistant off or its model unreachable, every other feature works unchanged.

### 5.1 BYOK flow

Every model role (`chat`, `summaries`, `stt`, `tts`, `vision`) uses **Workers AI by default**, so the assistant works straight after deploy. An owner can move a role to their own provider through AI Gateway (`assistant_models`, Assistant §10.1), where AI Gateway supports that role:

1. An owner configures provider keys in AI Gateway → Provider Keys. AI Gateway stores them in Secrets Store; the application never handles the raw key.
2. The Worker calls AI Gateway with the provider path (e.g. /openai/chat/completions) and cf-aig-authorization for gateway auth.
3. AI Gateway substitutes the stored provider key at runtime.
4. Key rotation is done in the dashboard with no code changes.

Logging and caching controls for assistant traffic are in §5.10.

### 5.2 Ingestion pipeline

**Gate** (Assistant §9). The pipeline **upserts only while `assistant_enabled` is on**, and only content that **at least one member with assistant access can read** (with `assistant_access = everyone`, that is all content). Deletions, invalidations and vector deletes **always run**, even while the assistant is off, so the index never holds deleted content. Turning the assistant on for the first time **back-fills** the index through the `indexing` queue; turning it off stops new ingestion but keeps existing vectors and derived text current through deletions, so re-enabling back-fills only the gap. An owner's **Delete assistant index** (`DELETE /admin/assistant/index`, audited) purges every vector and all derived text.

1. On document save or message creation, the Worker enqueues an embedding_jobs record in D1 and a message on a Queue.
2. A queue consumer Worker loads the content (from D1 or DO), chunks it, generates embeddings via Workers AI, and upserts vectors into Vectorize.
3. Each vector carries only scope metadata: `object_type`, `object_id`, `scope_id` (the channel ID for messages, the document or folder ID otherwise) and `chunk`. Only `object_type` and `scope_id` are metadata indexes, using 2 of the 10 allowed. **Vectors hold no user or role lists.** Permission changes therefore never require rewriting vectors. Only deleting or moving an object does.
4. On deletion, or when a message moves out of a channel, the Worker queues an invalidation job that deletes the object's vectors.
5. Changing the embedding model requires a new index, because index dimensions are fixed at creation, followed by a full re-index. This is delivered as a release migration that builds the new index before switching to it.

**Object types** (Assistant §9 has the scope table):
- messages, documents and whiteboards, from their search-text projection (§2.4)
- **derived file text** (`file_derived_text`, per file version; version `1` for files without versions). PDF, Office, text, Markdown and CSV files are converted with Workers AI `toMarkdown` on upload; images (vision model) and audio (speech-to-text, in chunks) are processed on demand and cached per version. All of it runs as `indexing` jobs. The same text feeds `search_index` (§2.4). Unsupported or oversize files, including video, are indexed by name and metadata only.
- **call notes and transcripts** of channel, DM and document calls, when notes are finalised (`scope_id` the channel or document). Event-call notes are not vector-indexed.
- **Events are never indexed**; the assistant reads them only through the calendar permission rules (`find_events`, `my_day`).

Derived text follows its file: Trash removes it from retrieval, restore re-indexes it, and purge deletes it and its vectors (§2.3). Transcripts past retention are deleted with their vectors by the daily purge job.

### 5.3 Retrieval flow

1. User asks a question.
2. Worker generates a query embedding via Workers AI.
3. The Worker computes the user's accessible scopes, using the same CTE as search (§2.4).
4. If the scope list fits within Vectorize's 2,048-byte filter limit (about 60 IDs), the query uses `scope_id $in [...]`. Otherwise the query runs unfiltered with `topK = 50` and metadata returned.
5. Every candidate is then checked against D1 permissions, whichever query path was used. D1 is the authority.
6. If fewer permitted results remain than needed, they are topped up with permitted FTS keyword matches from §2.4 (hybrid retrieval). Users with narrow access still get useful answers.
7. The model receives only permitted snippets; the response cites source objects the user can access.

Design rule: permission filtering happens before model invocation, not after. No vector is passed to the model unless the requesting user is authorised to see its source.

**Who the scopes belong to.** In the member's private surfaces, step 3 uses the member's access. For an `@mention` reply, step 3 uses the **audience's** allowed set (Assistant §6.4), which is usually larger than the filter limit, so the unfiltered path with D1 checks and FTS top-up is used; for small conversations step 5 also checks that **each** member can open the candidate (§5.8). Retrieved snippets, file text, transcripts and recalled memory are all placed in the prompt as marked, untrusted data (Assistant §1 rule 4).

### 5.4 Audit

The audit split (Assistant §11):
- **Every assistant invocation** writes one row to D1 **`assistant_interactions`**: member, time, surface, model role, provider and model, tools run, IDs of objects read and changed, outcome, and token and audio-second counts. Never prompts, replies, tool arguments or memory. Retention is `assistant_interaction_retention_days` (default 30 days, PRD §10.2). Owners and admins see it through `GET /admin/assistant/interactions` with object IDs and types only; titles are resolved only for objects the viewing admin can open. Members see their own rows.
- **`audit_log`** receives only confirmed write actions (actor = the member, the tool and its target, `metadata.via = "assistant"`; for DMs and group DMs the object type only, Permissions §4.1), assistant settings changes, call-notes start and stop, "Forget everything", index deletion and transcript purges.

### 5.5 Assistant Durable Object

One SQLite-backed **Assistant DO per member**, holding that member's conversations, turns, remembered items, embeddings, source references, pending actions and prefs. The schema, named timers and RPC surface are in [Assistant §14.1](specs/assistant.md).

- **Base class.** It extends the core DO base class (AGENTS §4.2): `schema_version` with lazy migration (§6.5), the alarm multiplexer and the hibernation rules (§3.2). Cloudflare's `agents` SDK is a source of patterns only, unless a spike shows it can wrap the base class cleanly.
- **Addressing.** `idFromName(user_id)`, where the Worker takes the ID **only** from the authenticated session or, for system jobs, from a D1 row it has just status-checked. No route accepts a user ID for this DO; a route-enumeration test proves it. Every path checks the member's status in D1 first, so a queue consumer or alarm never creates a DO for a deleted member.
- **Socket.** `/ws/assistant` streams turns (`assistant.delta`, `assistant.done`, `assistant.action_result`), registered in the UserHub room registry as kind `assistant` (§3.5) and counted in the socket budget.
- **Typed results.** Every RPC returns `Result<T, AssistantError>` with concrete fields and never throws an expected denial (AGENTS §4.1).
- **Named timers:** `retention_sweep` (daily; also reconciles the D1 mirror, §5.7), `conversation_close:<id>` (summary and extraction after 8 hours idle), `incognito_expire:<id>` and `pending_expire` (§5.9).
- **Deletion** is one DO transaction; SQLite triggers clear FTS rows, pending actions and source references, including on foreign-key cascades (Assistant §14.1).

### 5.6 Memory search inside the DO

Memory never leaves the member's DO and is never written to the shared Vectorize index.
- **Keyword:** FTS5 tables `turns_fts` and `memory_fts` inside the DO, maintained by triggers that skip incognito turns.
- **Semantic:** item and conversation-summary embeddings (the §5.2 model) are stored as float32 BLOBs in the DO. A query computes cosine similarity in chunks over all active embeddings, up to 5,000 **(default)**, and fuses the result with the FTS5 ranks (reciprocal rank fusion). Over the cap, the oldest embeddings are dropped, summaries first; their rows stay searchable by keyword.
- **Recall** reads only `status = 'active'` items and non-incognito turns, and re-checks every cited source through the permission engine before anything enters the prompt; sources the member can no longer open are hidden. The cost of that re-check for long histories is measured in M9a (§10).

### 5.7 Source mirror and purge

- **Mirror.** The DO's `source_refs` table records which turn, item or summary cites which object. After any transaction that changes it (including trigger-driven deletes on cascades, sweeps and incognito expiry), the DO recomputes the reference count per object and, **through the outbox helper (§3.3)**, inserts a D1 `assistant_source_refs (user_id, object_type, object_id)` row when the count goes from 0 to 1 and deletes it when it returns to 0. The mirror holds object references only, never content, and no route reads it. The daily `retention_sweep` reconciles the mirror with the DO.
- **Purge fan-out.** The deletion pipelines (§2.3) look up the mirror and enqueue one `assistant-purge` job per affected member. The consumer checks the member's status in D1 and skips **only deleted** members (their DO storage is already gone); it runs for disabled members, members without assistant access and while the assistant is off. It then calls `purgeSources(refs)`, which ignores refs the DO doesn't hold and deletes dependent reply text, items and conversation summaries.
- **`purge_epoch`.** Summary and extraction jobs make model calls that DO input gates don't cover. The DO keeps a `purge_epoch` counter, incremented by `purgeSources`, `deleteConversation`, `forgetAll` and pausing memory. A job records the epoch before its model call; its final write transaction discards the result if the epoch changed or a source it used is now hidden or purged, and re-queues the job with the new epoch unless its conversation was deleted or memory is paused.
- **Access loss** hides content at recall time immediately (§5.6). The daily sweep also re-checks citations in bounded batches and deletes content hidden for 7 days **(default)**.
- **Reconcile on return.** When a member is re-enabled, or `assistant_enabled` is turned back on, each affected DO runs a reconcile pass before serving requests: it re-checks every `source_refs` object for existence and access, purges what's gone and hides what's no longer accessible.

### 5.8 Queue consumers: mentions, nudges and proactive runs

Each queue has a dead-letter queue (§6.1). Every consumer except `assistant-purge` checks the member's status, assistant access and the relevant setting in D1 before doing work, and drops work for disabled or deleted members.

- **`assistant-mentions`: the stateless audience worker** (Assistant §6). Mentions never run in the asker's Assistant DO, so the asker's memory is structurally out of reach. The worker re-reads the mention message (cancelling if the mention was edited away or the message deleted), computes the audience and its allowed sources, retrieves (§5.3), builds a prompt from those sources, the question and the last 50 messages, and runs the model with the shared tool set only. It recomputes the audience before posting and regenerates once or drops the reply if a new member can't open a cited source. The reply is inserted through the assistant-message RPC with `clientId = 'assistant:' + mentionMessageId` (§2.2), so concurrent or repeated deliveries post one reply. On failure or DLQ, no shared reply is posted and the asker gets a notice in their assistant DM.
- **`assistant-nudges`.** Fed only for opted-in authors by the projection consumer (§3.3). The consumer skips messages that were deleted or edited before it runs, classifies the text, keeps nothing beyond the check, and offers a reminder in the member's assistant DM.
- **`assistant-proactive`.** Fed by ReminderScheduler `assistant_brief` and `assistant_prep` triggers (§2.2). The consumer checks the member's opt-in in `assistant_optins`, then calls `runProactive(kind)` on the member's DO. Delivery follows DND, focus time and time off (Notifications §5), with no inbox preview.
- **`assistant-purge`.** §5.7.

### 5.9 Confirmation state machine

Write tools never run from model output (Assistant §5.1). A write creates a **pending action** in the Assistant DO with the Zod-validated arguments and, for edits, the target's current version. The preview card is rendered from those arguments by deterministic code.

- **States:** `pending → executing → done | failed`, plus `pending → cancelled | expired`. Confirm moves `pending → executing` with a compare-and-set, so a second confirm returns the current state and never writes twice.
- **Execute.** The DO re-checks permission, then calls the target service with the **action ID as the idempotency key** and the stored version as **`expectedVersion`**. Calendar (events, RSVPs), Documents (create), status, personal reminders and Chat (`post_message`, using its existing `clientId`) accept the key and keep it with the created object for 24 hours, returning the existing result on a repeat. Calendar and Documents updates apply only if the version still matches, as an atomic compare-and-set, and otherwise return `conflict`; the action moves to `failed` and a fresh card is offered.
- **Resume.** If the DO is evicted or the call times out while `executing`, the next confirm or the `pending_expire` timer resumes the same call with the same key. Before resuming, the DO re-checks the member's status, assistant access, an active session and permission; if any fails, or the action is more than 10 minutes past its confirmation, it moves to `failed`.
- **Expiry and cleanup.** Pending actions expire after 10 minutes or when the member's sessions are revoked; finished, cancelled and expired actions are deleted after 24 hours.
- Write tools aren't available on shared surfaces, so a card is only ever shown to the asker.

### 5.10 Model access and AI Gateway controls

- **`ModelProvider`.** Every assistant model call goes through one `ModelProvider` interface, per role (`chat`, `summaries`, `stt`, `tts`, `vision`, resolved from `assistant_models`; embeddings stay on the §5.2 model). Tests use a **deterministic fake** that records prompts; the spec's "captured prompt" criteria assert on that record (Assistant §16).
- **Logging and caching off.** Every assistant model call goes through the configured gateway (`assistant_gateway_id`) with logging and caching off: BYOK requests send `cf-aig-collect-log: false` and `cf-aig-skip-cache: true`, and Workers AI binding calls pass the equivalent gateway options. With no gateway configured, Workers AI calls bypass the gateway, so nothing is gateway-logged. Whether these controls work per request is verified in M9a (§10).
- **Worker logs** never contain prompts, replies, transcripts or tool arguments; only IDs, counts and outcomes.
- **Output** is restricted Markdown, sanitised on the server into the message rich-text format: links only to Officebox objects, no external images or embeds, no raw HTML (Assistant §5).
- **Caps and cost.** Daily per-member caps (requests, voice seconds, media reads) and the workspace call-notes cap are D1 `rate_counters`; the burst limit uses the Rate Limiting binding. Expected cap hits are typed `rate_limited` results with `retryAfter`. Cost is estimated from the token and audio-second counts in `assistant_interactions` (§7.9).

### 5.11 Voice pipelines

- **Push-to-talk (M9c).** `POST /assistant/talk` uploads a clip of at most 2 minutes. The Worker runs speech-to-text through `ModelProvider`, discards the audio, and continues the turn over `/ws/assistant`. Replies are read aloud with text-to-speech only when the member turned that on.
- **Call notes and captions (M9c).** Per-track streaming transcription in the HuddleRoom (§3.6).
- **Live voice (M9d).** `POST /assistant/live` returns SFU session details. The member's audio travels over the Realtime SFU (§3.6) to their Assistant DO through the WebSocket audio adapter; the DO runs speech-to-text, the model and text-to-speech and streams audio back the same way. The DO is active (billed for wall time) while streaming, which is one reason sessions are capped at 30 minutes, one at a time per member. Spoken confirmation is a **deterministic phrase matcher**, never the model, accepted only after the card's preview has been read aloud; audio captured during text-to-speech playback is ignored. The session's text transcript is saved as a conversation. If the voice spike shows the SFU path doesn't work, live voice falls back to a direct WebSocket audio stream to the Assistant DO (§10).

## 6. Deployment and upgrades

Upgrades are delivered as **release-sync pull requests** in the customer's own repository (PRD §13). The running application never holds Cloudflare or GitHub credentials.

### 6.1 Deploy to Cloudflare

The repository's `wrangler.jsonc` grows to include the bindings below. It is added to milestone by milestone, so a fresh deploy never provisions unused resources: M0 ships the bindings M0 and M1 need, and each later milestone adds its own bindings and Durable Object migration tags (Vectorize and AI in M9a (Phase 3), Workflows in M7, feature DOs and queues with their milestone). The full set:

- Durable Object namespaces (ChatChannel, DocRoom, BoardRoom, UserHub, WorkspacePresence) as SQLite-backed classes.
- Workflows (workspace export, per-member export and restore).
- D1 database.
- R2 bucket.
- Vectorize index.
- Workers AI binding.
- Queues and their dead-letter queues: `message-projection`, `search-projection`, `purge`, `email`, `indexing`.
- Rate Limiting binding (setup, login and invitation endpoints).
- Cron Triggers (every 5 minutes, hourly and daily: health checks, purge, retention, reconciliation, release check; §7.8).
- Observability (Workers Logs) enabled. This is needed for generated setup tokens (§6.8).
- Build-time variable `OFFICEBOX_VERSION`.
- **v1.4 additions:**
  - the **ReminderScheduler** Durable Object (§2.2)
  - Queues: `link-preview-fetch` and `ics-fetch` (outbound fetching, §8.2), and `unread-email`, whose delayed messages (`delaySeconds`, at most 24 hours) implement the per-recipient offline-email timer, deduplicated by the D1 `pending_emails` table; longer holds use ReminderScheduler `email_release` triggers (Platform §11)
  - the admin settings keys listed in Platform §7 (for example `external_invites`, `holiday_regions`, `offline_documents_enabled`, `welcome_post_enabled`, `default_channels`, `screen_share` and `link_previews_enabled`), stored in `installation.settings`.
- **v1.6 additions** (M9, Assistant §14.3):
  - the **`Assistant`** Durable Object class (SQLite-backed, new migration tag)
  - Queues, each with a dead-letter queue: `assistant-mentions` (the audience worker), `assistant-nudges`, `assistant-proactive` and `assistant-purge` (§5.8, §5.7); the existing `indexing` queue gains file conversion, audio transcription and back-fill jobs
  - the Vectorize index and Workers AI binding, built in M9a with the ingestion pipeline (§5.2)
  - the assistant settings keys (Assistant §10.1), including `assistant_gateway_id`.

The Deploy to Cloudflare button copies the repository into the customer's GitHub account, provisions the supported resources and runs the deploy command:

```text
node scripts/preflight.mjs && wrangler d1 migrations apply DB --remote && wrangler deploy
```

**Secrets** (complete inventory with purpose, required/optional and rotation in [Platform](specs/platform.md) §16): `BETTER_AUTH_SECRET` (better-auth: session cookie signing and its other values; rotated through `BETTER_AUTH_SECRETS`, which signs everyone out: spike finding M1a-0, §8.1), `TOKEN_HASH_KEY` (HMAC for our stored token hashes), `DATA_ENCRYPTION_KEY` (ICS-in URLs; MFA secrets later), `POLL_SECRET_KEY` (or per-poll secrets in the DO), `SETUP_TOKEN`, `RECOVERY_TOKEN`, email provider keys, `REALTIME_APP_ID` / `REALTIME_APP_SECRET`, `TURN_KEY_ID` / `TURN_KEY_API_TOKEN`, and the optional analytics token.

**Missing secrets on deploy (kept from M1a).** The deploy step lists the Worker's secrets and creates any of **`BETTER_AUTH_SECRET`** and **`TOKEN_HASH_KEY`** that are missing, each from 32 random bytes piped to `wrangler secret put`. It never overwrites an existing secret, never prints a value, and stops the deploy if it fails. It no longer creates `SESSION_SIGNING_KEY` or `PEPPER_1` (15 Nov 2026). Until the required secrets exist, setup and sign-in show the **`/not-configured`** page and the Worker logs which secret is missing, never its value. Because there are no password hashes, losing a generated secret signs everyone out (and invalidates outstanding links) but locks nobody out for good: members sign in again with a passkey or magic link.

`SETUP_TOKEN` is declared in `.dev.vars.example`, which the Deploy flow uses to prompt for secrets. Cloudflare doesn't document whether a prompted secret can be left blank, so the generated-token fallback (§6.8) covers that case. The Deploy flow writes the IDs of newly created resources back into the `wrangler.jsonc` committed to the customer's repository. The release-sync merge script (§6.4, step 5) keeps them. The Deploy button also supports GitLab, but release-sync needs GitHub Actions, so the README recommends GitHub. AI Gateway, BYOK keys, Realtime SFU credentials, SMTP credentials and custom domains are not provisioned automatically. They appear in the admin post-deploy checklist, an owner page whose items, required marks and behaviour are set by [Admin](specs/admin.md) §15. Items marked **(R)** are required and can't be dismissed. Manual marks are stored in `installation.checklist`, not in settings.

| Item | How | Needed for |
|---|---|---|
| Durable Objects, D1, R2, Vectorize, Queues, Workers AI | Automatic (Deploy button) | Everything |
| Setup token | Prompted at deploy, or generated (§6.8) | First-run setup |
| Allow GitHub Actions to create pull requests **(R)** | Manual repository setting | Upgrades |
| Make the repository private | Recommended | Keeps scheduled release-sync running |
| Custom domain **(R)** before inviting the team | Manual; recommended **before the owner registers passkeys** (passkeys are bound to the domain) | Stable sign-in, PWA and push |
| Owner's second passkey, or `RECOVERY_TOKEN` | Prompted in setup and the checklist; **required before the owner can invite anyone** | Owner recovery; inviting |
| Email on a `*.workers.dev` address | The checklist says **"`workers.dev` usually means no email"**: the default driver needs a custom domain on Cloudflare DNS (§7.6). Without email there are no magic links, so recovery relies on second passkeys, recovery links and `RECOVERY_TOKEN`. | Magic links, emailed invitations |
| Cloudflare notifications for Worker errors and health **(R)** | Manual (dashboard) | Alerting when Officebox itself is down (§7.3) |
| Scheduled exports, or a first export **(R)** | Admin Data page (§7.5) | Recovery |
| Email: Cloudflare Email Service sender domain (default), or an email provider API key or SMTP credentials | Manual: onboard the domain in the dashboard, or add the Worker secrets | Email invitations, **magic links** and notifications |
| Realtime SFU app and TURN key | Manual (Worker secrets) | Calls and screen sharing (M4) |
| AI Gateway | Manual; **recommended** for assistant logging control: set `assistant_gateway_id` so every assistant call runs with logging and caching off (§5.10). The checklist tells owners that logging stays off for assistant traffic. | Assistant (M9a); Workers AI works without it |
| BYOK provider keys | Optional (AI Gateway Provider Keys); switching a role needs the owner to acknowledge that content goes to that provider | Assistant roles on another provider |
| Read-only analytics API token | Optional (Worker secret) | Usage panel with Cloudflare's own figures |
| Cloudflare billing notifications **(R)** | Manual (dashboard) | Cost alerts |
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
| `.officebox/config.json` | `{ "channel": "stable", "upstream": "<upstream repo URL>", "auto_merge": "none" }`. `auto_merge` is one of `none`, `security` or `patch`, default `none`; owners opt in by editing the file (Admin §14). The `channel` value is the authoritative channel setting. The running app holds no GitHub credentials, so the build embeds `channel` and `auto_merge`, and the Updates page shows them as deployed. |
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
7. **Auto-merge:** if `auto_merge` (`security` or `patch`) allows it for a patch or security release on stable, the release has no conflicts and checks pass, the workflow merges the PR. With `none` (the default), or for a minor or major release, the PR always waits for a manual merge.

Notes:

- PRs created with `GITHUB_TOKEN` don't trigger other GitHub workflows. Workers Builds is triggered by the Cloudflare GitHub App on push to the production branch, so merging still deploys.
- GitHub disables scheduled workflows in public repositories after 60 days without activity. The post-deploy checklist therefore recommends a **private** customer repository. Owners also get the `release_sync_stuck` alert (Admin §4) when the installed version has been behind the latest release for 7 days, because that may mean the workflow is disabled.

### 6.5 Build, migrations and compatibility

Merging to the production branch triggers Workers Builds:

1. **Preflight:** check that the required bindings exist, D1 is reachable, and the migration set is consistent with `release.json`.
2. `wrangler d1 migrations apply --remote`.
3. `wrangler deploy`.

If any step fails, the build stops and the previous Worker version stays live.

**Alternative: GitHub Actions** (`.github/workflows/deploy.yml`). A repository can deploy from GitHub Actions instead of Workers Builds, using a Cloudflare API token and account ID stored as `production` environment secrets. The workflow runs after CI passes on the production branch. It deploys the exact commit CI tested, and only if that commit is still the branch tip. It runs `npm run deploy:ci` (`scripts/deploy-ci.mjs`): preflight, then it creates the D1 database by name if it's missing, applies the migrations, **creates the required random secrets if they're missing** (`BETTER_AUTH_SECRET` and `TOKEN_HASH_KEY`, 32 random bytes each, piped to `wrangler secret put`; an existing secret is never overwritten and no value is printed; `scripts/ensure-secrets.mjs`, M1a), then deploys. The Deploy button's path doesn't run this step: the button prompts for the secrets listed in `.dev.vars.example`. It skips with a notice until the secrets exist, so it is inert in Deploy-button copies. **Use one path or the other, not both:** two deploy pipelines on the same branch would race. A repository that adds the secrets disconnects Workers Builds (Worker → Settings → Builds).

Migrations run **before** the new code goes live, and can be partly applied if a build fails. So every release follows an **expand/contract** rule: its schema must work with both its own code and the code of every version back to `rollback_safe_to`.

- **Allowed in any release:** new tables, new nullable or defaulted columns, new indexes, and backfills that older code tolerates.
- **Contract steps** (drop or rename columns, tighter constraints) ship only once no supported rollback target depends on the old shape. `rollback_safe_to` advances at that point and the release notes say so.
- Cloudflare doesn't document whether each migration file runs in a single transaction, so **migrations are treated as possibly partly applied**. Each file holds one logical change and is safe to re-run, using `IF NOT EXISTS` and guarded backfills. SQLite has no `ADD COLUMN IF NOT EXISTS`, so a file that adds a column to an existing table holds **that one statement only**: it is either applied or not, and running it again fails with "duplicate column name" without changing anything (Platform §14; the re-run test accepts exactly that error for such files). Applied files are tracked in D1's `d1_migrations` table.
- Upstream CI runs the previous release's integration tests against the new schema, to enforce the rule.

**Durable Object schemas** follow the same rule:

- Each DO stores `schema_version` in `meta`.
- It migrates lazily on first wake, inside `blockConcurrencyWhile`, so thousands of objects never need a coordinated migration.
- Older code must tolerate a newer, expanded DO schema.
- A DO schema migration runs in a transaction. If it fails, the object refuses connections with a "migration failed" error, reports it to admin health and leaves its data untouched. The fix ships as a patch release.

**Durable Object class migrations** (`new_sqlite_classes` and so on) only ever *add* classes within a rollback window. Renames and deletions follow the contract rule.

The admin UI shows the applied migrations (from D1's migrations table) next to the running version. A schema ahead of the code raises the `schema_ahead` alert for owners (Admin §4).

### 6.6 Rollback

- **Normal rollback:** roll back the Worker to any version at or after `rollback_safe_to`, from the dashboard or with `wrangler rollback`. No database restore is needed. The owner then reverts the upgrade merge commit in the repository, otherwise the next build redeploys the newer version. The admin UI walks through both steps.
- **Rolling back past `rollback_safe_to`:** this is an emergency procedure. It needs a D1 Time Travel restore and Durable Object point-in-time recovery, and loses changes made since the restore point. It is documented, not automated.
- Workers Builds keeps build history and logs for 90 days. Worker versions remain available for rollback after that.

### 6.7 Update awareness

The daily Cron Trigger fetches the release manifest (§6.2) and stores the result in `installation.latest_release`. The admin UI shows owners:

- the installed `OFFICEBOX_VERSION` and channel
- the latest release on that channel and its notes
- a link to the repository's open sync PR
- the `channel` and `auto_merge` values as deployed (§6.3).

Admins can view the page; only owners act on it ([Admin](specs/admin.md) §14). A security release that hasn't been installed after 48 hours raises the serious `security_release` alert for owners, with its banner, inbox item and email (Admin §4). Being behind for 7 days raises `release_sync_stuck` (§6.4).

### 6.8 First-run setup

Until `installation.setup_completed_at` is set, every route except `/setup`, `/setup/resume`, better-auth's passkey registration routes (which still need an enrolment ticket), `/not-configured`, `/health` and static assets redirects to `/setup`.

**Token source:**

1. **`SETUP_TOKEN` secret set:** it is used as the token. It must be at least 32 characters.
2. **No secret:** on the first request, the Worker generates a 32-byte random token. It stores the SHA-256 hash and a 24-hour expiry with `INSERT … ON CONFLICT DO NOTHING`, so concurrent first requests produce a single token. It logs the token once to Workers Logs with a clear marker. Only members of the Cloudflare account can see these logs. An expired token is replaced and logged again on the next visit.

**WebAuthn preflight:** before anything is submitted, the setup page checks for WebAuthn (`PublicKeyCredential` feature detection) and stops with "This browser can't create a passkey. Use another device or a security key." Roaming authenticators are allowed, and the setup token works on another device (resume, below).

**Setup submission:** `POST /setup` with `{ token, workspaceName, ownerEmail, ownerName, ownerHandle }`. There is no password: the response sets an **enrolment ticket** cookie, and the owner **registers a passkey** straight away through better-auth's passkey registration (`resolveUser` accepts the ticket). Setup creates **identity objects only** (installation, the owner user, their handle, settings). `#general`, calendars and drives are created by the milestones that own them, with backfill jobs (Platform §13).

- Rate-limited by IP (Rate Limiting binding).
- Token hashes are compared in constant time.
- The **claim** is one atomic D1 batch, so only one request can ever win:
  ```sql
  UPDATE installation
     SET setup_claim = :nonce, setup_claimed_at = :now,
         canonical_origin = :origin, allowed_hosts = :hosts
   WHERE id = 1 AND setup_claim IS NULL AND setup_completed_at IS NULL;

  INSERT INTO users (id, email, display_name, email_verified, role, status, created_at, updated_at)
  SELECT :id, :email, :name, 0, 'owner', 'active', :now, :now
    FROM installation
   WHERE id = 1 AND setup_claim = :nonce;
  ```
  The owner row is written through better-auth's adapter in the real code, with the server-set setup marker that `databaseHooks.user.create.before` requires (Identity §4.4); the batch shows the intent. `:origin` is the origin the setup request arrived on, and becomes the **canonical origin** (§8.1); `:hosts` starts as that host alone.
- **Completion:** when the owner's first passkey is registered, a better-auth after hook sets `setup_completed_at` and clears `setup_token_hash` **only if the claim nonce is still current** (`… WHERE setup_claim = :nonce AND setup_completed_at IS NULL`), and the owner is signed in. The hourly identity repair job (§7.8) completes setup when the owner has a passkey but `setup_completed_at` is still NULL.
- **Resume (default):** until completion, `POST /setup/resume` with the same token issues a new enrolment ticket **for the claimed owner only**, and only while that owner has **zero passkeys and `first_signed_in_at` is NULL**; otherwise it answers **410**. It works from any device, so an owner whose browser lacks WebAuthn can move to another one.
- **One clock:** the claim window runs from `setup_claimed_at`. In generated-token mode, the token that made the claim stays valid for resume until the claim expires, even after its own 24-hour expiry.
- **Expiry (default):** a claim not completed within **24 hours** of `setup_claimed_at` is released, by the next setup request or the hourly job, in **one conditional batch**:
  ```sql
  DELETE FROM users
   WHERE id = :owner AND role = 'owner'
     AND NOT EXISTS (SELECT 1 FROM passkeys WHERE user_id = :owner)
     AND first_signed_in_at IS NULL
     AND (SELECT setup_completed_at FROM installation WHERE id = 1) IS NULL
     AND (SELECT setup_claimed_at FROM installation WHERE id = 1) < :now - 86400000;

  UPDATE installation
     SET setup_claim = NULL, setup_claimed_at = NULL, canonical_origin = NULL, allowed_hosts = NULL
   WHERE id = 1 AND setup_completed_at IS NULL AND changes() > 0;   -- only if the delete matched
  ```
  (The handle row goes with it in the same batch, guarded the same way; the exact "only if matched" form is checked in M1a-0, since D1 batches aren't documented as transactions.) An owner who registered a passkey or signed in is never deleted, and the claim is never half-cleared. With a `SETUP_TOKEN` secret the same secret works again; in generated-token mode a new token is generated and logged.
- The page then recommends a **second passkey** and shows the `*.workers.dev` warning when it applies (Identity §4.1).
- An audit entry is written for the claim and for completion.

**Required secrets:** if `BETTER_AUTH_SECRET` or `TOKEN_HASH_KEY` is missing, `/setup` and sign-in show `/not-configured` instead (§6.1).

**Restore.** Restore from export (§7.5) uses the same setup token and the same claim, which records the restore's origin as the canonical origin (Admin §11.4). There are no password hashes or peppers to carry over. If the restore's origin equals the export's canonical origin, the exported passkey public keys keep working; otherwise the restoring owner registers a passkey as above and the restore report lists who needs a magic link or a recovery link (§7.5). The `RECOVERY_TOKEN` flow (§8.1) covers an owner who can't register.

**After setup:** `/setup` returns 404 permanently and `SETUP_TOKEN` is ignored. The admin UI recommends deleting the secret.

**Optional hardening:** the documentation describes putting Cloudflare Access in front of the workspace during setup.

## 7. Operations and observability

### 7.1 Health checks

The cron dispatcher (§7.8) runs the checks every 5 minutes with cheap probes: no real email, model calls or SFU sessions. Only the dispatcher writes the results, to `health_checks` (status, consecutive runs in that status, and when it last changed), and raises or clears `admin_alerts` with compare-and-set on the stored state, so concurrent runs can't send duplicate emails. A failure counts after two consecutive runs ([Admin](specs/admin.md) §4). The admin health page (`GET /admin/health`, owners and admins) reads the stored state, and loading it never raises alerts. The public `/health` endpoint stays minimal (Platform §15). Members learn feature availability from `GET /status` and `GET /status/public` (Admin §8.2).

The checks:

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

**Owners** download a support bundle, after a preview of its full contents ([Admin](specs/admin.md) §8.3). Admins can't. The download is audited (`diagnostics.downloaded`). The bundle contains:

- Worker version and deployment ID.
- Binding configuration (without secrets).
- Recent audit log entries: action types, timestamps and pseudonymous actor IDs only.
- D1 storage usage.
- R2 usage summary.
- Durable Object error counts (last 24h).
- Queue backlog.

The owner reviews the bundle before sharing it. It never contains message, document or file content, email addresses or secrets. Officebox support receives it only when the owner attaches it to a support request.

### 7.3 Alerts

**In-app alerts** follow [Admin](specs/admin.md) §4: one `admin_alerts` record per `<kind>:<subject>` (storage, protective mode, paused D1 copy, failed or missing exports, failing checks and services, releases, schema, projection backlog, purges, assistant budget), raised and cleared by the dispatcher (§7.1, §7.8) with hysteresis. Delivery is a persistent banner and an `admin_alert` inbox item for owners and admins, plus email to owners for serious alerts, with links built from `installation.canonical_origin` (§8.1).

**Outages of the alert path.** Alerts live in D1 and run in the Worker, so a D1 or Worker outage can't raise one. **Cloudflare's own notifications** for Worker errors and health cover these; setting them up is a required checklist item (§6.1). Billing: owners are prompted to set Cloudflare billing notifications (§7.9).

### 7.4 Backup and recovery guidance

- D1: Time Travel restores to any minute in the last 30 days. Officebox documents how to use it and warns when a restore point is needed.
- R2: lifecycle rules and object versioning; Officebox documents recommended configuration.
- DO SQLite: snapshots are copied to R2 for export; the export is the portable recovery path.
- Application export: see §7.5.

### 7.5 Export and restore

Implements PRD §13 and [Admin](specs/admin.md) §11–§13. Exports and restores run as **Cloudflare Workflows**: durable, retried, multi-step jobs that are not bound by request time limits.

**Who.** Owners **and admins** run and download workspace exports and per-member exports. The permission engine checks `workspace.export` or `member.export` when an export starts and on every download request (Admin §11.1, §12). Members have no export endpoint. Only owners can choose an export in maintenance mode.

**`exports` table.** Created in M7's baseline with the columns in Admin §16 (that list is authoritative):
- `kind`: `export` | `member_export` | `restore` (Zod)
- `state`: `running` | `packing` | `complete` | `failed` | `cancelled` | `expired` | `deleted` (Zod)
- `include_files`, `in_maintenance`, `scheduled`; `subject_user_id` for member exports
- `schema_version`, `size_bytes`, `object_count`, `archive_r2_key`, `manifest_r2_key`, `restore_report` (JSON, restores), `error` (short, non-sensitive)
- `requested_by` (a system actor for scheduled exports), `schedule_set_by`, `created_at`, `completed_at`, `expires_at`.

One workspace export runs at a time; starting another returns `conflict`:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS one_running_export
  ON exports(kind) WHERE kind = 'export' AND state IN ('running', 'packing');
```

Per-member exports are limited to one running per subject and 10 per actor per day, and don't block workspace exports (Admin §12).

**Export format v1.** Written under `exports/<id>/` in the installation's R2 bucket:

| Path | Content |
|---|---|
| `manifest.json` | Format version, Officebox version, D1 schema version, creation time, row/object counts, SHA-256 for every part, each channel's exported `seq`, each document's state vector |
| `d1/<table>.jsonl` | One JSON object per row, written in pages of 1,000. Excludes `search_index`, `sessions`, `auth_accounts`, `auth_verifications`, `magic_link_issues`, `user_devices`, `mfa_factors`, setup fields, job tables, `auth_tokens`, `ws_tickets`, ICS feed tokens and ICS-in URLs, `poll_secret`, `pending_emails`, `notify_anyway_log`, `scheduled_triggers`, `trigger_outbox` and `rate_counters` (Platform §6), and the operational tables `exports`, `maintenance_windows`, `admin_alerts`, `health_checks`, `admin_jobs` and `download_tokens`, so a restore never starts read-only or with stale alerts (Admin §11.1). **Passkey public keys are included** (Identity §2). From M9 also `file_derived_text` (rebuilt like `search_index`) and `assistant_source_refs` (a mirror of assistant memory, which isn't exported) **(default)**. |
| `channels/<id>/messages.jsonl` | Current message state from the ChatChannel DO, including tombstones |
| `docs/<id>/state.ystate` | Native Yjs state |
| `docs/<id>/content.md` or `content.json` | Readable rendering (Markdown for documents, JSON for whiteboards) |
| `docs/<id>/versions/` | Retained versions |
| `files/<file id>` | File bytes, if `include_files` is set. Otherwise the manifest lists keys and checksums only. |

**Rules:**

- **Contents:** everything, including private content (DMs, private channels, restricted documents, time off with type and note, personal reminders), so a restore is complete (Admin §2).
- **Secrets are never exported:** SMTP credentials, AI keys, `BETTER_AUTH_SECRET`, `TOKEN_HASH_KEY` and the setup token stay out. MFA secrets are encrypted with an installation-specific key, so they are left out and users re-enrol after a restore. There are no password hashes (sign-in is passwordless), so a restore needs no secret carried over.
- **Passkey public keys** are included in **workspace** exports, so a restore onto the same canonical origin keeps passkeys working (Identity §2). They aren't secrets, but they're credentials metadata, so they're **never** in per-member exports.
- **Packing:** the Workflow writes the parts to `exports/<id>/`, then packs them into a single `export.tar` in R2 with a multipart upload, re-chunking into equal parts across Workflow steps and persisting the upload state between steps. The parts are deleted once packing succeeds. Packing needs about twice the archive's size in R2 temporarily, so the budget check at start counts double (Admin §11.1).
- **Download:** the Worker streams that one object and supports `Range` requests, so an interrupted download resumes. Archives over **20 GB** aren't packed; they stay as parts and are downloaded with the command-line tool (`officebox export pull`), which resumes. The tool **downloads through the Worker**: it signs in with device sign-in, needs step-up re-authentication, passes the same engine check and uses download tokens. The exports bucket never has public access or a custom domain.
- **Step-up and download tokens:** a download start needs `sessions.fresh_auth_at` (a passkey assertion) within the last 10 minutes, otherwise it returns `reauth_required` and the client re-authenticates with `POST /me/reauth` (§8.1, Admin §11.3). A successful start issues a download token valid for 1 hour and bound to the session; only its HMAC hash is stored in `download_tokens`. A browser gets it as an HttpOnly cookie scoped to the download path and the command-line tool sends it in a header, so it never appears in a URL. **Every request** re-checks the session, the engine (including a per-member subject's current role) and that the export isn't deleted, expired or cancelled.
- **Consistency:** each object is internally consistent, but without maintenance mode the export isn't one instant across the workspace. An owner can export **in maintenance mode** for a fully consistent snapshot (Admin §13.4):
  - Maintenance state lives in `maintenance_windows` and is derived from the row and the clock on every read. Each change increments `installation.maintenance_epoch` (Admin §13.2).
  - The Worker refuses writes through the settings cache (30 seconds at most). Durable Objects check the epoch lazily before a refused write, from a 10-second cached value and the epoch in each socket's attachment, so hibernated DOs aren't woken.
  - On each transition the Worker calls a room-level **`setMaintenance(epoch, active)`** RPC on open rooms only, found through the UserHub room registry. The room sets a read-only flag separate from each socket's role and sends `status.changed`. **No socket is closed or reconnected**, and `updateAccess` isn't used (§3.5).
  - **Consistency barrier:** before the snapshot, the export waits until the settings cache has expired, every open room has acknowledged `setMaintenance`, and the projection outbox has drained. It times out after 2 minutes; the export then fails and a window it started ends.
  - Which writes are refused, exempt or deferred during maintenance is set by Admin §13.3.
- **Schema changes mid-run:** the export records `schema_version` at the start and fails with a clear message if a deploy changes the schema during the run.
- **Cancel and failure:** a running export can be cancelled; a cancelled or failed export deletes its partial objects. A failure raises `export_failed` (§7.3).
- **Scheduled exports** (`scheduled_export`; off by default, weekly when enabled, files included) run at a weekday and time in `workspace_timezone`. An hourly dispatcher job claims the slot with compare-and-set on `installation.scheduled_export_last_slot`; a missed slot runs within 24 hours, then is skipped (Admin §11.1). They keep the latest 4 complete exports, deleting older ones only after a new one completes.
- **Retention:** on-demand exports are deleted 45 days after completion (`export_retention_days`), per-member exports after 7 days. Downloads check `expires_at` themselves; the daily job removes expired archives. Deleting an export marks it deleted at once, so its tokens stop working on their next request, and the object is removed within the hour. Exports aren't rewritten when a member is later deleted (Admin §11.2).
- **Storage:** exports count towards R2 usage. Above `r2_hard_budget_gb`, new exports are refused. Exports are allowed in protective mode (§7.7).
- **Per-member exports** (`kind = 'member_export'`) cover one member's data for a data-protection request, with the scope and exclusions in Admin §12 (no credentials, no assistant conversations or memory, nothing written by others). They are packed and downloaded like workspace exports. The subject gets a `security_notice` when the export completes.
- **Audit:** the `export.*` and `member_export.*` events (Admin §7).

**Restore:**

1. The first-run setup page of a fresh installation offers **Restore from export**, which still requires the setup token (§6.8).
2. The archive is uploaded through the Worker with R2 multipart upload. Very large archives can instead be placed in the bucket with Wrangler, and `officebox-restore` then starts the Workflow.
3. The Restore Workflow checks the manifest and checksums. It accepts exports from the same Officebox version or older, and maps older logical schemas forward.
4. It inserts D1 rows in foreign-key order in batches. It rebuilds each ChatChannel DO with `importMessages`, keeping `seq`, and each DocRoom or BoardRoom with its state and versions. It writes files back to their R2 keys and rebuilds `search_index`. Derived file text and vectors are rebuilt by the assistant back-fill (§5.2) once the assistant is enabled; assistant memory is not part of a restore (Assistant §13).
5. It completes setup and records the restore's origin as the canonical origin. **If it equals the export's canonical origin, exported passkeys keep working** and members sign in as before. Otherwise the passkeys are dropped: the restoring owner (chosen from the export's owners by email) registers a passkey, as in §6.8; members sign in with a magic link (email configured) or a recovery link; admins and owners get recovery links. The restore summary lists who needs one. All sessions are invalid, and users with MFA must re-enrol. The Workflow writes a restore report (`exports.restore_report`) listing what members and owners must redo (Admin §11.4).

**Coverage** ([Platform](specs/platform.md) §6 is authoritative):
- **Added:** **passkey public keys** (with credential IDs, counters, names and how each was created; product owner, 15 Nov 2026), calendars, events, attendees, time off (with type and note), drives, folders, file versions, comments, polls (anonymous votes as hashed `voter_key` only), saved items, preferences, and in-call chat from both D1 and channel threads. From M9: `assistant_interactions` metadata, `personal_reminders`, and `call_notes` and `call_transcript_segments` within retention (Assistant §13).
- **Excluded:**
  - sessions, better-auth's `auth_accounts` and `auth_verifications`, `magic_link_issues`, `user_devices`, `auth_tokens`, `ws_tickets` and MFA secrets
  - ICS feed tokens, and ICS-in subscription URLs (subscriptions are exported without URLs and must be re-entered)
  - `poll_secret`
  - **assistant conversations, including the assistant DM, and memory** (they live only in Assistant DOs, which admins can't read). Nobody can export them; members see their memory in "What Butler remembers" (Admin §2, Assistant §13). There is no member self-export.
  - `file_derived_text`, rebuilt like `search_index`
  - the operational tables listed above.

**Testing:** CI exports a fixture installation, restores it into a fresh one and compares them, on every release.

### 7.6 Email delivery

Email sits behind an adapter interface with three kinds of driver (product-owner decision, 15 Nov 2026):

1. **Cloudflare Email Service (default):** the `send_email` Worker binding (`"send_email": [{ "name": "EMAIL" }]`, then `env.EMAIL.send({ from, to, subject, html, text, headers, attachments })`, returning `{ messageId }`).
   - There are no API keys to manage. Onboarding the sender domain adds SPF, DKIM, DMARC and bounce records automatically.
   - **Requirements:** the workspace's sending domain must use **Cloudflare DNS** and be onboarded in Email Service, and the account must be on **Workers Paid** (3,000 emails a month included, then $0.35 per 1,000).
   - **Limits:** 50 recipients per message, 25 MiB per message, and a daily quota that starts low and grows. Officebox sends one recipient per message.
   - Errors are thrown with a `code`, which the driver maps to typed results. `E_RATE_LIMIT_EXCEEDED`, `E_DAILY_LIMIT_EXCEEDED`, `E_DELIVERY_FAILED` and `E_INTERNAL_SERVER_ERROR` are transient. `E_SENDER_NOT_VERIFIED`, `E_SENDER_DOMAIN_NOT_AVAILABLE`, `E_RECIPIENT_SUPPRESSED`, `E_VALIDATION_ERROR` and the other validation codes are permanent.
   - **Still in public beta** (launched April 2026). This is why the other drivers stay.
   - `wrangler dev` sends real mail through remote bindings, so tests use a fake driver.
2. **HTTP API providers:** Resend, Postmark, Amazon SES, Mailgun or SendGrid, called with `fetch`. The API key is a Worker secret. Use this for a workspace whose domain isn't on Cloudflare DNS, or as a fallback while Cloudflare's service is in beta.
3. **Generic SMTP:** a TCP socket via `connect()`, using STARTTLS on port 587 (`secureTransport: "starttls"`, then `startTls()`) or implicit TLS on port 465, with AUTH PLAIN or LOGIN, through a maintained Workers-compatible SMTP library. Cloudflare blocks outbound port 25, so direct delivery to recipient mail servers isn't possible.

The admin picks the driver and enters the **sender address** (for example `no-reply@<your-domain>`) in settings. Nothing defaults to a particular domain (AGENTS §4.1). **Send test email** checks the configuration. A workspace on `*.workers.dev` with no custom domain can't use the Cloudflare driver, so it uses an HTTP provider or SMTP, or no email at all, since copy-link invites always work.

**Receiving email** (Email Routing to a Worker `email()` handler) is not used at launch. Reply-by-email and email-to-channel are listed under Later in the notifications and chat specs.

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
| D1 (10 GB hard limit) | Database size from D1 query result metadata, sampled hourly *(confirm the metadata field at implementation)* | Thresholds come from the `storage_thresholds` setting (Platform §7; 70, 85, 95 and 98 % by default). Warn at the first two. At the third, **protective mode** (below). At the fourth, D1 copying pauses and DO outboxes hold events safely until space is freed. |
| Durable Objects (10 GB each) | `ctx.storage.sql.databaseSize`, reported into `object_sizes` | Warn when any object passes 5 GB |
| R2 (no hard limit) | Calculated from D1: `files.size_bytes`, plus export and snapshot objects. No API token needed. | Optional owner budget (`r2_budget_gb`): warn above it; block uploads and new exports above an optional hard budget (`r2_hard_budget_gb`) |

Each threshold raises the matching Admin §4 alert (`storage`, `protective_mode`, `d1_copy_paused`), which clears with hysteresis.

**Protective mode.** The Worker refuses to create channels, documents, folders, drives, files, calendars, events, polls, time off and invitations. Messages continue: they are stored in their channel DOs, and the D1 copy keeps up until the 98% point. Exports are allowed, because they write mostly to R2.

**Priority writes.** Audit, alert and export-status writes are small and continue in protective mode. At the fourth threshold the D1 copy pauses, but these writes continue ([Admin](specs/admin.md) §9).

**Recovery.** The admin UI guides the owner to free space:

- **Shorten search copy retention** (`installation.settings.search_copy_months`). This trims D1 `messages` and `search_index` rows older than N months. Those messages stay in their channel DOs, in the channel view and in exports; they just leave search.
- Empty Trash early.
- Enable retention policies.
- Delete old exports.
- Export and delete archived channels.

**Growth guide:** 100 members × 100 messages a day is about 2 GB a year, including the FTS index. Trimming the search copy keeps D1 bounded indefinitely.

### 7.8 Scheduled jobs

Three Cron Triggers (every 5 minutes, hourly and daily) run the jobs below. The dispatcher (`apps/worker/src/core/cron.ts`) runs each schedule's jobs one after another, each with its own timeout (60 s by default) and error isolation. A run takes the schedule's lease in `cron_leases` (§2.1), so a trigger that fires while the previous run of the same schedule is still going skips; leases expire after 15 minutes, and a schedule's job timeouts must add up to less than that. If the lease can't be checked (D1 unavailable), the jobs run unguarded and the error is logged **(default)**: jobs are idempotent, and skipping would stall purges.

| Job | Schedule | Section |
|---|---|---|
| Snooze wake-ups | 5 minutes | PRD §5.3 |
| Health checks, alert raise and clear (compare-and-set on `health_checks` and `admin_alerts`) | 5 minutes | §7.1, §7.3, Admin §4 |
| Maintenance: clock transitions, notices and the 24-hour cap | 5 minutes | §7.5, Admin §13 |
| Scheduled-export slot (claimed with compare-and-set; a missed slot runs within 24 hours) | Hourly | §7.5, Admin §11.1 |
| Export and member-export expiry; expired download tokens and job previews | Daily | §7.5, Admin §16 |
| Sending pending CSV invitations (wait while maintenance or protective mode is on) | Daily | Admin §5.1 |
| Due-date reminders, email digests (per preference), storage sampling | Hourly | PRD §5.3, §8; §7.7 |
| Purge due objects, time-based retention (audit log, inbox items, expired sessions and `auth_verifications`, `magic_link_issues` and `auth_tokens` 7 days after use or expiry, `user_devices` unused for 400 days, invitations, tickets, huddle records) | Daily | §2.3 |
| Identity repair: complete setup if the owner has a passkey; roll forward or release partial invitation accepts (§8.1); expire setup claims and pending domain moves | Hourly | §6.8, §8.1 |
| Assistant purge jobs: expired `assistant_interactions`, transcripts past retention and their vectors, `file_derived_text` for purged versions, finished `personal_reminders` (M9) | Daily | §2.3, Assistant §14.3 |
| ChatChannel event-log trimming, D1 copy reconciliation, version thinning | Daily | §2.2, §3.3, §4.3 |
| Release manifest check | Daily | §6.7 |
| Usage panel refresh | Daily | §7.9 |
| ICS-in refresh (queue a fetch per due subscription) | Hourly | Platform §11 |
| Scheduled-trigger refill (48-hour window) | Hourly | §2.2, Platform §11.1 |
| RSVP-response batch per organiser | Hourly | Notifications §3 |
| Hourly and daily email digests (members with an hourly or daily delay) | Hourly | Notifications §6, Platform §11 |
| Room-registry sweep | Daily | Platform §12 |

During maintenance, purges, retention sweeps, ICS refresh, content-creating timers and scheduled exports are **deferred** until it ends; reminders and other notification-only triggers fire on time (Admin §13.3). The audit-log purge uses `audit_retention_days`, keeping `export.*` and `member_export.*` entries for at least 365 days (Admin §7).

Timers that aren't cron jobs (Platform §11):
- **ReminderScheduler triggers:** reminders, event start, focus time, time off, status expiry, DND schedule, `dnd_until_end` (manual DND expiry), `email_release` (email holds longer than 24 hours), and from M9 `assistant_brief`, `assistant_prep` and `personal_reminder`.
- **Delayed `unread-email` queue messages**, deduplicated by `pending_emails`. When one fires during DND or time off the email is held; when that ends it's re-evaluated and, if still unread, sent after the remaining delay or immediately if the delay has passed.
- **Channel DO** poll auto-close.
- **UserHub:** ring timeout, and the DND-end "while you were away" summary.
- **HuddleRoom:** call end and hand-over deadline; from M9c `notes_idle` and `notes_finalize` (§3.6).
- **Assistant DO** (M9): `retention_sweep` (daily, per member; also mirror reconcile and hidden-source purge), `conversation_close:<id>`, `incognito_expire:<id>` and `pending_expire` (§5.5).

### 7.9 Usage, cost and telemetry

- **Usage panel:**
  - With an optional read-only account analytics API token (a Worker secret), the daily job queries Cloudflare's GraphQL Analytics API. It reads Workers requests; DO requests, duration and storage; D1 rows and storage; R2 storage and operations; Queues operations; and Realtime SFU egress. The panel shows month-to-date usage against the Workers Paid allowances, with projected overage.
  - Without the token, the panel shows Officebox's own counters (messages, file bytes, D1 size, huddle minutes, share minutes) and links to Cloudflare billing.
  - **Assistant section** (M9, Assistant §10.2): requests, voice minutes, call-notes minutes and **estimated cost** by model role and by surface, with aggregates per member and never content. Because gateway logging is off for assistant traffic, cost is estimated from the token and audio-second counts in `assistant_interactions` with a price table per model. Background work (summaries, extraction, indexing, nudge classification) is counted here even though it doesn't count against member caps. Once an owner sets `assistant_monthly_budget`, owners and admins get warn-only notices at 50, 80 and 100 %; the assistant keeps working (whether to allow a hard stop is open, Assistant §19).
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

**Passwordless** (product-owner decision, 15 Nov 2026; Identity §2). Sign-in is **passkeys for everyone and magic links for members only**. There are no passwords, so there is no password hashing, PBKDF2, pepper, password reset, password change or password throttle. The M0 spike's PBKDF2 result is kept for the record in §10.

**Library: better-auth** (MIT; [docs](https://www.better-auth.com/docs)) for sessions, magic links (`magicLink` plugin) and passkeys (`@better-auth/passkey`, built on SimpleWebAuthn). It replaces the hand-built sign-in and session code of the M1a design. The **M1a-0 spike** (§10) checks the assumptions below before M1a builds on them.

- **Runtime:** D1 through Kysely. It needs `nodejs_compat` (AsyncLocalStorage); `wrangler.jsonc` uses 2026-11-01. Hono passes the mounted routes to `auth.handler(c.req.raw)`; our routes call `auth.api` on the server. *Spike finding (M1a-0, 15 Nov 2026)*: `nodejs_compat` is on by default from 2026-08-04 in local workerd, but M1a adds it to `wrangler.jsonc` explicitly (PLAN §4). better-auth stores dates as ISO text on SQLite, so M1a passes **our own Kysely instance** (`database: { db, type: "sqlite" }`) with the **epoch-ms plugin** from the spike, which converts better-auth's date columns to INTEGER epoch milliseconds.
- **Canonical origin, one instance per installation.** The passkey relying-party ID and better-auth's `baseURL` and `trustedOrigins` must not be configured per deployment (AGENTS §4.1), and must not follow an arbitrary request `Host` either. So the setup claim **records the canonical origin and an allowed-hosts list in `installation`** (§2.1, §6.8): workspace state, not configuration.
  - `rpID` is the canonical host, `rpName` the workspace name, `baseURL` and `trustedOrigins` the canonical origin. **One better-auth instance per installation origin**, built when the record is first read and rebuilt only when it changes (no per-host cache).
  - Auth routes answer only on the canonical origin; requests on other allowed hosts redirect there, and unknown hosts are refused. The `Origin` checks in §3.1 and §8.2 compare against the same value.
  - **Every emailed or copied link** (magic link, invitation, recovery link, email change) is built from the canonical origin, never the request's `Host`.
  - **A domain change is an explicit owner action** (`POST /admin/domain`, Identity §4.4): it rewrites the canonical origin and allowed hosts, signs everyone out and starts the recovery flow. WebAuthn related-origin requests, which could carry passkeys across a move, are listed under Later (Identity §10).
- **Configuration (summary):**

  | Option | Value | Why |
  |---|---|---|
  | `emailAndPassword.enabled` | `false` (the default, set explicitly) | Passwordless |
  | `baseURL`, `trustedOrigins` | the canonical origin from `installation` | No request-derived origins |
  | `session.expiresIn` / `updateAge` | 30 days / 1 day | 30-day sliding sessions |
  | `session.cookieCache` | **disabled** | Revocation is immediate only without it; advisory GHSA-fvxx-76fc-893x found revoked sessions surviving through the cache |
  | cookies | `HttpOnly`, `Secure`, `SameSite=Lax`, host-only, path `/`, **`__Host-` prefix** where better-auth's cookie options allow (M1a-0 checks; otherwise an Officebox prefix) | No subdomain can set or read them |
  | `advanced.ipAddress` | `ipAddressHeaders: ["cf-connecting-ip"]`, `ipv6Subnet` 64 | Correct client IP for limits and sessions; advisory GHSA-p6v2-xcpg-h6xw |
  | `advanced.database.generateId` | ULID | AGENTS §4.1 |
  | `modelName` and `fields` for user, session, account, verification and passkey | `users`, `sessions`, `auth_accounts`, `auth_verifications`, `passkeys`, snake_case | Our schema (Identity §5, Platform §14) |
  | `user.additionalFields` | `role`, `status`, `handle`, `email_normalised`, `first_signed_in_at`, profile columns, all `input: false` | No better-auth route can set them |
  | `magicLink` | `expiresIn: 900`, `disableSignUp: true`, `storeToken: "hashed"` if supported, `sendMagicLink` to our email adapter with **our** confirmation link, members only | 15-minute links; invite-only; scanner-safe (Platform §10) |
  | passkey plugin | `rpID` from the canonical origin, `rpName` the workspace name, and **`origin` set explicitly** to the canonical origin; **user verification required** in registration and authentication options, and required when verifying; `registration.requireSession: false` with `resolveUser` accepting only an enrolment-ticket cookie bound to the challenge. *Spike finding (M1a-0, 15 Nov 2026)*: when `origin` is unset the plugin trusts the request's `Origin` header; UV **can't be required by configuration** (the plugin verifies with `requireUserVerification: false` and hardcodes `"preferred"` in the authentication options), so our `registration.afterVerification` and `authentication.afterVerification` refuse `userVerified: false` and an after hook rewrites the authentication options to `"required"`; verify-registration creates a session only when the body has `createSession: true`, so our mount **forces** it for enrolment-ticket registrations and **strips** it when a session exists | Product-owner decision; first passkey without a session, never for an arbitrary user |
  | `databaseHooks.user.create.before` | refuse unless a **server-set marker** is present (the setup claim or our accept context) | better-auth has no invite-only mode; a pending invitation alone isn't enough |
  | `databaseHooks.session.create.before` | refuse unless the user's `status` is `active`; set `device_label` and `approx_location` (from `request.cf`) | No better-auth path signs in a disabled member; "My devices" |
  | `databaseHooks.session.create.after` | set `users.first_signed_in_at` if NULL | Gates setup resume and invitation reopening |
  | `hooks.after` | first passkey: complete setup or acceptance, label it, raise the `security_notice`; magic-link verify: new-device notice; sign-out: close sockets; passkey sign-in: counter check if we keep ours | Below and §3.5 |
  | `rateLimit` | enabled as a **backstop only**, with custom storage on `rate_counters`; never memory storage | Our middleware enforces the real limits (below) |
  | `secret` | `BETTER_AUTH_SECRET`; rotation through `BETTER_AUTH_SECRETS`, format `<version>:<secret>,…` newest first. *Spike finding (M1a-0, 15 Nov 2026)*: the session cookie is signed with the current secret only, so **rotation signs everyone out** | Platform §16 |

- **Route allowlist: default-deny on the exact normalised method and path.** Only sign-out, the magic-link request, and passkey sign-in and registration (options and verify) are reachable at `/api/auth/*`. The path is normalised before matching (repeated slashes, a trailing slash, case and percent-encoded segments such as `%2e`), and anything that doesn't match exactly, including `HEAD` and `OPTIONS` on allowed paths unless explicitly listed, answers 404. Get-session, the magic-link GET verify, session listing and revocation, passkey listing, renaming and deletion, user update, change email, delete user and every email-and-password route answer 404 from outside (Identity §6). An upgrade that adds routes adds nothing reachable until it's reviewed.
- **No session token reachable by JavaScript.** Get-session isn't exposed (the web app uses `GET /me`). A Hono **response filter** on the better-auth mount strips any `token` field, and any value equal to the session token, from every JSON body, and the structured logger redacts cookie and token values. A **required test** asserts that no response body or log line contains the session token.
- **Rate limits in our middleware, before `auth.handler`.** Every sign-in limit in Platform §8 runs in our middleware on atomic D1 `rate_counters` or the binding, keyed by `cf-connecting-ip` (IPv6 by /64) and the **normalised email** (trim, lowercase, NFKC). better-auth's limiter is only a backstop. The per-email magic-link limit **never extends its window**: requests over the limit send no mail and get the identical response, so nobody can keep a member from signing in by flooding their address.
- **Account creation, in order.** D1 isn't transactional through the adapter, so creation runs as ordered steps with compensation: (1) **consume the invitation** (or the setup claim) with a compare-and-set; (2) **create the user** through better-auth's adapter in our accept or setup context, which sets the server-set marker the create hook requires; (3) **claim the handle**. An idempotent **repair job** (hourly **(default)**) completes or rolls back partial states. Tests cover each creation path: setup, acceptance, a magic-link verify for an unknown email, passkey registration without a session or ticket, and each user-creating `auth.api` call without the marker, even with a pending invitation for that email.
- **Invitation repair (never resurrect).** The accept compare-and-set records `accepted_attempt_id`; the user and handle rows carry it as `created_attempt_id`; `accepted_by` records the user. The hourly repair job **releases** a consumed invitation only when all of these hold: consumed more than 10 minutes ago; not expired or revoked; **no `users` row (deleted users included) and no `handles` row carries the attempt ID**; and the release is a compare-and-set on `accepted_attempt_id`. Otherwise it **rolls forward** (finishes the user, handle and `accepted_by`).
- **Enrolment tickets.** Setup, invitation acceptance, recovery links, owner recovery and the domain-move link set a single-use ticket (32 random bytes, stored hashed as `auth_tokens.kind = 'passkey_enrol'`, 15 minutes, bound to one user) **only in an `HttpOnly`, `Secure`, `SameSite=Strict` cookie with the `__Host-` prefix and `Path=/`** (the prefix requires it), never in a JSON body; only the passkey registration routes read it. Generating registration options **binds the ticket to that challenge** (`payload.challengeId`); **registration verify consumes it** with a compare-and-set (`UPDATE auth_tokens SET used_at = :now WHERE token_hash = :h AND used_at IS NULL AND revoked_at IS NULL AND expires_at > :now`) and refuses a challenge that isn't the ticket's. Options alone consume nothing. Using a recovery link or owner recovery **revokes the user's other outstanding tickets**. `resolveUser` accepts nothing else when there's no session. Registering signs the person in.
- **Magic links** (Platform §10), **members only.** The confirm POST re-checks role `member` and status `active` at consume time. `sendMagicLink({ email, token, url })` ignores `url`. The request route does the **same work for every email** (normalise, look up, write a `magic_link_issues` row or a dummy of equal cost; *Spike finding (M1a-0, 15 Nov 2026)*: better-auth itself does no email lookup on the request and always calls `sendMagicLink`, so the lookup and the equal work are entirely ours, in the callback) and sends mail through `waitUntil`, so neither the response nor its timing reveals anything. Mail goes only to active users with role `member`; owners and admins never receive one. The email links to `/sign-in/link#t=…` on the canonical origin. The confirm POST consumes the `magic_link_issues` row by compare-and-set, then calls `auth.api` magic-link verification and returns better-auth's session cookie; concurrent POSTs with one token sign in at most once. An email change or recovery link marks the person's rows revoked by normalised email. A sign-in from a browser without a known-device cookie (`__Host-` cookie with `Path=/`, set on every successful passkey or magic-link sign-in, hashed in `user_devices`, kept 400 days after last use) raises a `security_notice` **(default)**. Magic links need email: Cloudflare Email Service by default, or another driver (§7.6).
- **Passkey user verification is required** (product owner, 15 Nov 2026): `userVerification: "required"` in the options, and verification refuses assertions and attestations without the UV flag, for every user.
- **Passkey labels and notices.** Each passkey stores `created_via` (setup, invitation, recovery link, owner recovery, magic link, signed in, domain move), shown in the passkey list. Every addition raises a `security_notice` naming the passkey and how it was created, except the first passkey at setup or acceptance.
- **Step-up** (product owner, 15 Nov 2026; Identity §4.5). `sessions.fresh_auth_at` records the last passkey assertion on the session (at sign-in, or through `POST /me/reauth`, which runs better-auth's passkey authentication for the signed-in user and updates the current session instead of keeping a new one; the mechanism is an M1a-0 item). Adding or removing a passkey, starting a domain move, changing a role or promoting, issuing a recovery link and changing an email need `fresh_auth_at` within **10 minutes**, otherwise the typed error **`reauth_required`**. The check runs after the permission engine. A magic-link sign-in records `fresh_auth_method = 'magic_link'`, which doesn't satisfy step-up, except for a member with no passkeys adding their first **(default)**. Registration through an enrolment ticket needs no step-up.
- **Security-notice banner** (product owner; Identity §4.6a). Notices are appended to the `users.pending_security_notice` list and shown as a banner after sign-in; email goes out when configured. `POST /me/security-notices/ack` needs a fresh **passkey** assertion, so a stolen session can't hide a notice.
- **Two-step domain move** (product owner; Identity §4.4). `POST /admin/domain` (owner, step-up) stores `pending_origin` with a 24-hour expiry **(default)** and returns a single-use move link for the new origin. While pending, the new host answers only the move-completion routes, with a better-auth instance built for the pending origin. The move link's POST sets an enrolment ticket there; the owner's **passkey registration with the new origin as relying party commits the move**: the canonical origin is switched (nonce-checked against the pending row), the old host is appended to `allowed_hosts`, every session is revoked, old-origin magic links, invitations and enrolment tickets are revoked, the other owners get a `security_notice`, and it's audited. No server-side fetch verifies the host, so there's no SSRF path. Afterwards the old host answers **302 (GET/HEAD) or 307** to the same path on the canonical origin, built from the installation record (never a request-supplied host), with `Cache-Control: no-store`, never 301. `allowed_hosts` entries come only from the setup claim and committed moves.
- **Step-up for sensitive downloads** ([Admin](specs/admin.md) §11.3): export archives, member and audit CSVs and per-member exports use the same `fresh_auth_at` rule (a passkey assertion within 10 minutes) and `reauth_required`. `POST /me/reauth` is limited to 5 attempts per 10 minutes per session (Platform §8); failures also count toward the per-IP passkey sign-in limit (there is no per-account password throttle any more) and are audited (`auth.reauth_failed`).
- **Promotion.** Promoting to admin requires at least one passkey; promoting to owner requires two passkeys or a `RECOVERY_TOKEN` that is set and not yet consumed (a value with no row in `recovery_token_uses`). Both need step-up.
- **No CORS.** Auth routes, and every `/api` route, never send `Access-Control-Allow-*` headers.
- **Passkey counter rule.** The M0 spike's rule stays: a counter **at or below** the stored value, unless both are 0, is `clone_detected`; no session is left behind, and the member and owners get a `security_notice` (Notifications §3). SimpleWebAuthn may already refuse such assertions, so **the M1a-0 spike decides** between:
  - relying on the library and raising `clone_detected` (and the notice) from its error path, or
  - keeping our own check: a before hook reads `passkeys.verified_sign_count`, the after hook compares it with the verified authenticator data and advances it by compare-and-set, revoking the session better-auth just created on a regression. The spike must prove the hook sees regressions.

  Either way, **a lost compare-and-set race between two legitimate concurrent sign-ins is refused and retried, not reported**: only a real counter regression raises an owner alert.

  **Decided by the M1a-0 spike (15 Nov 2026):** SimpleWebAuthn rejects exactly this rule before any passkey hook runs, and better-auth reports it as a generic `AUTHENTICATION_FAILED`, so the second option can't see regressions. It is replaced by **re-verify on `AUTHENTICATION_FAILED` to detect clones**: a before hook captures the challenge, and on `AUTHENTICATION_FAILED` the after hook re-verifies the assertion (signature, canonical origin, RP ID, UV) with the stored counter set aside; a genuine assertion whose counter is at or below the stored value (not both 0) is `clone_detected` and raises the notice. `verified_sign_count` is dropped. ([spike README](spikes/better-auth/README.md) Q3c)
- **Session reads hit the primary.** With D1 read replication, session and status lookups read the primary (or carry a D1 Sessions API bookmark), so a revocation is never undone by a lagging replica.

**Sessions:**
- better-auth database sessions in `sessions`, cookie as above and in §3.1. **No refresh tokens**: no rotation, reuse detection or grace window. better-auth doesn't offer refresh-token rotation, and with the cookie cache off every request reads the session row, so a stolen cookie stops working as soon as its session is revoked.
- **Every authenticated request** loads the session through better-auth and checks the user's `status`, so a revoked session or a disabled member is refused on the next request (no 60-second cache any more). *Spike finding (M1a-0, 15 Nov 2026)*: the read refreshes the session once a day (`updateAge`) and then emits a `Set-Cookie`, so every route or middleware that reads the session calls `getSession` with `returnHeaders: true` and **forwards that `Set-Cookie`**.
- **`session_epoch` is removed**: §3.5 doesn't need it, because sockets carry their session ID. Revoking deletes session rows; naturally expired sessions are caught by the UserHub recheck (§3.5).
- **My devices** uses better-auth's list and revoke (one, others, all) through our routes, which return session IDs and device fields but never tokens. **Sign out everywhere** is revoke-all. Admins sign a member out through our permission-checked route, which calls better-auth's revoke for that user. **The admin plugin isn't used** (product owner, 15 Nov 2026): no impersonation (Permissions §6).
- Every revocation closes the matching sockets (§3.5).

**Other controls:**
- **MFA (Phase 2):** TOTP with recovery codes. Owners can require MFA for owners and admins. (Less needed with passkeys and required user verification; revisit before Phase 2.)
- **Rate limiting** (mechanisms per platform §8):
  - The Workers Rate Limiting binding supports periods of exactly 10 or 60 seconds, counts per Cloudflare location, and is approximate. The wrapper treats it as advisory and returns `rate_limited` with retry-after equal to the period. Longer windows and exact quotas use D1 or Durable Object counters.
  - Sign-in limits run in our middleware (above). There is nothing to guess, so the password throttle (per-account progressive delays, and the slow mode drafted in M1a) is removed.
- **Tokens:** invitation, recovery, email-change and enrolment tokens are 32 random bytes, stored hashed, single-use and consumed by compare-and-set. Invitations expire after 7 days, recovery links after 24 hours, enrolment tickets after 15 minutes. Magic-link tokens are better-auth's, in `auth_verifications`, mirrored by hash in `magic_link_issues`.
- **Owners' gate before inviting.** An owner can't invite anyone until they have a second passkey or a `RECOVERY_TOKEN` that is set and not yet consumed, checked on **every** owner invite. Admins may still invite members **(default)** (Identity §2).
- **Owner recovery:** setting a `RECOVERY_TOKEN` secret (**at least 32 characters**) enables `/recover`: **register a new passkey for one owner** (named by email) and sign out that owner's sessions. The secret is compared in constant time and the route is rate-limited per IP. After use, the secret's hash is inserted into `recovery_token_uses` (one row per value used), so the same value is refused afterwards; using it again needs a fresh value. The action is audited, the other owners get a `security_notice` (Notifications §3), and a banner shows until the secret is deleted.
- **Advisory policy.** better-auth has published **49 security advisories since December 2024**, many High or Critical, including GHSA-4vcf-q4xf-f48m (any user could delete other users' passkeys; High), GHSA-gv75-j3v8-3crm (passkey origin and user verification not enforced; Low), GHSA-fvxx-76fc-893x (revoked sessions surviving through the cookie cache) and GHSA-p6v2-xcpg-h6xw (client IP detection). So:
  - **pin exact versions** of `better-auth`, `@better-auth/passkey` and the SimpleWebAuthn packages they bring, at versions with every known advisory fixed
  - enable **Dependabot security updates or GitHub advisory alerts** for the repository
  - a **CI gate** fails the build when a High or Critical advisory is open against these packages at the pinned versions
  - **review the better-auth advisories list on every upgrade**, and record the review in the PR
  - a fixed better-auth advisory that affects our configuration ships as an Officebox **security release within 7 days** of the fix being published **(default)**; customer repositories receive it through the release-sync PR and the 48-hour security banner (§6.4, §6.7), and forks that don't run release-sync are told through the release notes and the security advisory on the upstream repository
  - keep our own defences where an advisory showed the library's could fail: passkey deletion only through our routes, which check ownership; origin checks in our CSRF middleware; user verification enforced on our side; the cookie cache off; tests for each.
- **SSO through Cloudflare Access (Phase 2):**
  - When enabled, the Worker validates the `Cf-Access-Jwt-Assertion` header against the team's Access signing keys and application audience. Follow Cloudflare's current Access JWT validation guidance at implementation.
  - It maps the asserted email to an existing active user or a pending invitation, never creating accounts automatically, and creates a better-auth session for them.

### 8.2 Web application

- **Authorisation:** the role model in PRD §10.1, resolved as described in §2.1. Owners and admins get management rights but no implicit read access to private content. Every check happens in the Worker before a DO is reached.
- **CSRF:** `SameSite=Lax` cookies, plus a required custom header (`X-Officebox-Request: 1`) and an `Origin` check on every state-changing REST request. WebSocket upgrades check `Origin` too (§3.1).
  - **With better-auth** (unchanged from M1a): our CSRF middleware runs **before** `auth.handler`, so better-auth's routes need the header and a same-origin `Origin` like every other route. better-auth's own origin check (against `trustedOrigins`, which is the request's own origin) runs as well; neither replaces the other. The web app's better-auth client sends the header on every request.
  - The magic-link confirmation, recovery, invitation and email-change POSTs come from our own pages, so they carry the header; scanners' GETs reach only the pages.
- **Tokens in links** (Identity §2, Platform §10). Identity links put their token in the **URL fragment** (`/sign-in/link#t=…`, `/auth/recover#t=…`, `/invitations/accept#t=…`, `/me/email/confirm#t=…`), so it never reaches the Worker, Cloudflare logs, proxies or `Referer`. The page's script reads it, POSTs it in a JSON body and removes it with `history.replaceState`. Those pages are served with `Referrer-Policy: no-referrer` and `Cache-Control: no-store`. All such links are built from the canonical origin (§8.1).
- **Headers:**
  - `Content-Security-Policy: default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'` plus the Realtime SFU endpoints.
  - HSTS, `X-Content-Type-Options: nosniff` and `Referrer-Policy: strict-origin-when-cross-origin`.
  - API responses (`/api/*`, `/health`) are `Cache-Control: no-store`. A route's own `Cache-Control` is parsed into directive names (split on commas, trimmed, the name before any `=`, lower-cased) and kept only if it has a bare `private` (no `=` qualifier) or `no-store`, and no `public` or `s-maxage` (for example `private, max-age=60`). Everything else, including no header and `no-cache` alone (which still lets shared caches store the response), is replaced with `no-store`, so API data is never stored by shared caches.
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
- **AI:** retrieval is permission-filtered, retrieved content is treated as untrusted input (prompt injection), tool calls are permission-checked server-side, and mutating actions require confirmation. For the assistant (§5.3–§5.10): the assistant is a system actor, never a principal; recalled memory is untrusted data too; workspace content, file text, transcripts and long pasted text taint a conversation for good, so memory written from it is only pending (Assistant §4.2); model-proposed tool arguments are Zod-validated; confirmation cards are rendered from validated arguments, never model text; shared replies are built without the asker's memory or private sources; output is sanitised restricted Markdown; and prompts, replies and transcripts never reach Worker logs or, with a gateway configured, AI Gateway logs.
- **Audit:** administrative and destructive actions are written to `audit_log`. For the assistant, only confirmed writes and its admin and destructive events go there; every invocation's metadata goes to `assistant_interactions` (§5.4).

### 8.3 Files

- **Uploads** stream through the Worker into R2 using the binding, so no R2 S3 credentials are needed.
  - Files over 50 MB use R2 multipart upload: the client sends 10 MB parts and the Worker creates the upload, uploads each part and completes it.
  - Each part is authorised against its upload session. The default maximum file size is 2 GB, configurable by owners. Owners can also deny chosen file extensions.
- **Downloads** go through the Worker after a permission check, with Range support.
  - Only allow-listed types are served inline: PNG, JPEG, GIF, WebP, PDF, MP4, WebM, MP3 and OGG.
  - Everything else, including HTML and SVG, is sent with `Content-Disposition: attachment`.
  - Every file response carries `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox`.
- **Previews:** images and PDFs render in the browser. PDFs keep the `Content-Security-Policy: sandbox` response header and show in an `<iframe>` **without** the `sandbox` attribute: the M0 foundation spike found that Chromium's PDF viewer renders under the CSP header, directly and in an iframe, but an `<iframe sandbox>` attribute blocks it whatever tokens it allows. Firefox and Safari are untested and are checked in M6 (Documents acceptance criteria); a browser that can't render falls back to PDF.js in a sandboxed iframe on a separate path. Office documents are not converted server-side for preview. From M9a their text is extracted with Workers AI `toMarkdown` for search and the assistant only, while the assistant is enabled (§5.2).
- **Malware scanning** is out of scope (PRD §14), and the documentation says so.
- **Avatars** accept PNG, JPEG or WebP only, and are cropped on the client (Identity §4.7).
- **Three file kinds:** chat attachments belong to their message and are deleted with it; images and file cards pasted into a document belong to the document and are deleted with it; drive files live in folders and are versioned. "Save to folder" creates an independent drive file from a message-owned one (Documents §6).

### 8.4 Realtime, huddles and devices

- **WebSockets:** cookie or one-time ticket, `Origin` check, role stored in the attachment, and revocation (§3.1, §3.5).
- **Huddles:** track subscriptions are confined to their huddle, and the SFU secret stays in the Worker (§3.6).
- **Call notes and captions** (M9c): nobody joining a call with notes on publishes audio, or is transcribed, before acknowledging the notice (`notes_ack_required` / `ackNotes`); everyone sees the notes banner and the "Captions on" indicator because audio then goes to the model provider; the notetaker has no tools, so words spoken in a call never run one (§3.6).
- **Assistant socket:** `/ws/assistant` reaches only the authenticated member's own Assistant DO; disabling closes it with `4401` and losing assistant access with `4403` (§3.5, §5.5).
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
- Permission test: viewer cannot write Yjs updates. (AI retrieval permission tests arrive with M9; the assistant's acceptance criteria, Assistant §16, run against the deterministic `ModelProvider` fake, §5.10.)
- Setup test: a fresh deployment refuses setup without the token. Concurrent setup requests create exactly one owner. `/setup` returns 404 afterwards. Both the secret and generated-token modes are tested.
- Message durability test: with the projection queue blocked or D1 writes failing, messages are still acknowledged, ordered and replayable from the DO. After recovery, D1 converges with no duplicates or loss. Duplicate `clientId` sends create one message.
- Edit/delete test: edits and deletions reach connected clients, reconnect replay and D1. A deleted message's content is absent from DO events, the D1 copy and search.
- Purge test: Trash restore works within 30 days. After `purge_after`, every stage completes and no D1, DO or R2 data remains. User deletion removes personal data and transfers document ownership.
- Access test: a member without access can't read a private channel, DM or restricted document through the REST API, WebSocket, search, previews or links. Admins without a grant can't read them either.
- Upgrade test: the release-sync workflow opens a correct PR from a fresh customer copy (with signature verification), including a `wrangler.jsonc` merge that keeps resource IDs. Merging deploys. A conflicted release opens as a draft and can't deploy. Stable → beta works.
- Rollback test: rolling back one version after a release with migrations works without a database restore (expand/contract). The previous release's integration tests pass against the new schema.
- Storage test: as D1 fills, warnings appear at 70% and 85%. At 95%, protective mode blocks new objects while messages continue. At 98%, D1 copying pauses without losing anything. Trimming the search copy frees space. An R2 hard budget blocks uploads when set.
- Security test: CSRF and cross-origin WebSocket attempts are rejected. HTML and SVG files download instead of rendering. A revoked better-auth session is refused on its next request (cookie cache off). better-auth routes outside the allowlist answer 404. Owner recovery works only with the secret and is audited. Sign-out clears local caches. One-time tickets can't be reused.
- Export/restore test: export a fixture installation, restore into a fresh installation from first-run setup, and compare row counts, checksums, channel `seq` positions and document content. Missing export configuration warns but does not block startup.
- Search test: results match permitted messages and documents only. Deleting or trashing removes results. **Rebuild search index** reproduces the index.
- Revocation test: disabling a user, or removing them from a private channel or document, closes their open sockets within 5 seconds.
- Fan-out test: a 100-message burst in a busy channel produces at most one UserHub call per online member per consumer batch, and offline members get none.
- Permission matrix test (Permissions §11): every action × role × object type in Permissions §4, including the union rule, channel-made-private warnings and private-event visibility. It runs in CI.
- Lifecycle matrix test (Platform §17): disable and delete for every feature, including closing call sockets and erasing personal data.
- Durable registry test: after UserHub eviction, revoking a member still closes every open socket; the Worker-side fallback closes sockets missing from the registry.
- Trigger delivery test: a crash between marking a trigger fired and sending its effect leads to exactly one effect after recovery (outbox, idempotent consumer).
- `pending_emails` dedupe: repeated events in one conversation produce one email; holds longer than 24 hours are released by `email_release`.
- Session tests: a session unused for 30 days is rejected and one used on day 29 is extended; signing out one device, other devices or everywhere closes those sessions' sockets; a disabled member's next REST call fails.
- Passwordless tests: every account-creation path is refused without the setup or accept marker (`databaseHooks.user.create.before`), even with a pending invitation; no session is created for a disabled member; a counter regression is `clone_detected` with no session left behind, and a lost compare-and-set race raises no alert; an assertion or registration without user verification is refused; an assertion for another origin or relying-party ID is refused; auth routes on a non-canonical host are refused and emailed links use the canonical origin; a member can't delete another member's passkey; magic links are never sent to owners or admins.
- **Token tests (required):** no response body or log line contains a session token; concurrent confirm POSTs with one magic-link token, and concurrent verifies with one enrolment ticket, succeed at most once; an enrolment ticket is consumed at verify, not options, and only with its own challenge; reopening an invitation or resuming setup after a passkey or session answers 410; the route allowlist holds against `//`, a trailing slash, case, `%2e` and other encoded segments, and `HEAD`/`OPTIONS`; flooding magic-link requests for one email doesn't extend its window; `RECOVERY_TOKEN` can't be reused.
- **Identity hardening tests:** step-up returns `reauth_required` for each sensitive action without a fresh passkey assertion; the security-notice banner can't be acknowledged without one; the domain move commits only on a passkey registration on the new origin, expires when pending, and leaves the old host redirecting (302/307, `no-store`, never a request-supplied host); promotion refuses too few passkeys; claim expiry never deletes an owner with a passkey or session and clears the claim only when its delete matched; stale-nonce completion is refused; the repair job completes setup and never releases an invitation whose attempt ID is on a user (deleted included) or handle; no auth route sends CORS headers.
- **End-to-end:** Playwright drives passkeys with a Chromium virtual authenticator (user verification on) and magic links through a test email sink.
- Cascade tests: channel, group, calendar, drive and event deletions follow Platform §4, including channel purge moving folder documents to their creators.
- Export exclusions: no sessions, `auth_tokens`, `auth_accounts`, `auth_verifications`, `magic_link_issues`, `user_devices`, ICS tokens or URLs, or `poll_secret` in an export; anonymous votes appear only as voter keys. **Passkey public keys are exported**, and a restore onto the same canonical origin keeps them working.
- SSRF tests: previews and ICS fetches refuse private IPs, including after redirects and DNS rebinding.
- Scanner-safe links: a GET of a magic, recovery, invitation or RSVP link changes nothing; only the confirmation POST does. better-auth's GET magic-link verify route answers 404 from outside.
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
| Email driver matrix and retry policy | Cloudflare Email Service binding by default (beta; needs Cloudflare DNS and Workers Paid); HTTP API providers and STARTTLS SMTP on port 587 or 465 as alternatives; 8 retries with exponential backoff capped at 2 h; DLQ | §7.6 |
| Deploy to Cloudflare behaviour | Checked: secrets come from `.dev.vars.example`; resource IDs are written back into `wrangler.jsonc`; git history not documented, so the design doesn't depend on it | §6.1, §6.4 |
| D1 migration transactions | Not documented, so migrations are treated as possibly partly applied: one change per file, safe to re-run, expand/contract | §6.5 |
| Event log horizon and outbox batching | Defaults: 30-day horizon, 250 ms batching delay, 100 events per batch | §2.2, §3.3 |
| Search text projection and FTS export | DocRoom extracts plain text through an outbox to `document_text` and FTS5; the export excludes FTS and restore rebuilds it | §2.4 |
| Sign-in methods (15 Nov 2026) | **Passwordless:** passkeys for everyone, magic links for members only; no passwords, reset, peppers or PBKDF2 (product-owner decision) | §3.1, §8.1 |
| Authentication library (15 Nov 2026) | **better-auth** (MIT): database sessions (cookie cache off, 30-day sliding), `magicLink` behind our confirmation page, `@better-auth/passkey` with user verification required and the counter rule (library or our hook, decided in M1a-0); one instance per installation origin; sign-in limits in our middleware; exact pins, a CI advisory gate and the advisory policy | §8.1 |
| Sessions (15 Nov 2026) | No refresh rotation or `session_epoch`; revocation deletes session rows and closes sockets by session ID; a UserHub recheck catches natural expiry | §3.1, §3.5, §8.1 |
| Canonical origin (15 Nov 2026) | Recorded in `installation` at the setup claim; relying-party ID, `trustedOrigins`, `Origin` checks and every emailed link come from it; one better-auth instance per installation origin; domain changes are an explicit owner action | §6.8, §8.1 |
| Passkey policy (15 Nov 2026) | User verification required for everyone; magic links for members only; exports include passkey public keys | §7.5, §8.1 |

Resolved in v1.1:
- Message storage split: the DO is the source of truth, with an outbox to a D1 copy (§2.0, §3.3).
- Upgrade mechanism: release-sync GitHub Actions PR plus Workers Builds; no deploy Worker (§6).

Decided in v1.3 (from the review):
- WebSocket auth: cookies plus `Origin` check; one-time tickets for clients without cookies (§3.1).
- Whiteboard: Excalidraw (MIT) with an Officebox-maintained Yjs binding (§4.2).
- ~~Password hashing: PBKDF2-SHA256, versioned format. Revised after the M0 foundation spike to 100,000 iterations plus an HMAC pepper; the production probe confirmed the cap.~~ **Superseded 15 Nov 2026:** sign-in is passwordless (§8.1).
- File handling: streamed through the binding; multipart above 50 MB; allow-listed inline types (§8.3).
- Huddle signalling: HuddleRoom DO with Worker-mediated SFU calls and confined track subscriptions (§3.6).
- Screen sharing: one presenter, simulcast, detail and motion modes (§3.6). Present mode via Yjs awareness (§4.5).
- Storage: protective mode and trimming of the D1 search copy (§7.7).

To confirm at implementation: the Realtime SFU endpoint and simulcast controls (§3.6), the D1 size metadata field (§7.7), Cloudflare Access JWT validation (§8.1), better-auth's adapter and hook details (below, v1.7), and EU jurisdiction support per service (§8.5).

**M0 foundation spike** (before M1). Results are in [`spikes/foundation`](spikes/foundation/README.md), and the decisions below are applied in §8.1, §8.3, Identity §4.4 and platform §8, §11 and §16 (the PBKDF2 result no longer applies, since sign-in is passwordless):
- **PBKDF2 production cap** (**no longer used**: sign-in became passwordless on 15 Nov 2026, §8.1; kept for the record): **100,000, confirmed in production** (the probe's 100,001 and 600,000 calls fail with "iteration counts above 100000 are not supported"). The standalone server used by `wrangler dev` removes the cap, which is why 600k works locally. **Decision at the time:** M1 would use **PBKDF2 100k + HMAC pepper** (`pbkdf2-sha256-hmac$<pepperId>$100000$salt$hash`); superseded by the passwordless decision. Argon2id via `hash-wasm` fails as published (Workers forbid runtime WASM compilation) and works with precompiled modules, also in production (19 MiB/t=2 in ~85 ms round trip); scrypt N=2^17 also runs. *Confirmed in production.*
- **WebAuthn library:** `@simplewebauthn/server` 14.0.3 (MIT) runs in workerd (M0 spike; *Spike finding (M1a-0, 15 Nov 2026)*: through `@better-auth/passkey` 1.7.15 it is **13.3.3**). Verified end to end with a Chromium virtual authenticator: registration, discoverable sign-in, replay refusal and `sign_count` clone detection. **Decision:** use it with `requireUserVerification: false`; compare counters ourselves after signature verification (≤ stored and not both 0 → `clone_detected`) and update with compare-and-set (`UPDATE … WHERE sign_count = ?`) (Identity §4.4). *Verified locally.* **Since 15 Nov 2026** SimpleWebAuthn comes through better-auth's passkey plugin; user verification is now **required** (product owner), and the counter rule carries over, enforced by the library, with clones identified by re-verifying on `AUTHENTICATION_FAILED` (M1a-0 decision, §8.1).
- **Rate Limiting binding:** periods are exactly 10 or 60 s; limits are per Cloudflare location, approximate and eventually consistent (documented). Miniflare is exact. **Decision:** binding only for abuse throttles (passkey sign-in and magic-link confirmation per IP, setup/recovery/invites, link previews, general API); the wrapper treats results as advisory and returns `rate_limited` with retry-after equal to the period; the other platform §8 rows stay DO or D1. Production let **one call over** the limit (6 of 12 at limit 5) and accepted an unvalidated per-call `period`, so the wrapper never passes one. *Confirmed in production (one colo).*
- **Queue `delaySeconds` maximum:** **24 hours** (86,400 s) for send, sendBatch and retries per current docs, not 12 hours; Miniflare rejects 86,401. **Decision:** the `email_release` threshold is 24 h; delays are Zod-validated (0–86,400) and out-of-range values are typed results (platform §11). Production rejects 86,401 on `send` (10210) and `sendBatch` (10202). *Confirmed in production.*
- **PDF preview under `Content-Security-Policy: sandbox`:** Chromium's viewer renders it, directly and in an `<iframe>`. An `<iframe sandbox>` attribute blocks it. **Decision:** keep the CSP header and preview in an iframe without the `sandbox` attribute (§8.3); Firefox, Safari and branded Chrome are M6 acceptance checks, with PDF.js as the fallback. The headless shell has no PDF viewer. *Verified locally (Chromium 153).*

**New in v1.4:**
- **WebAuthn library spike before M1:** done. SimpleWebAuthn runs in Workers (see the M0 foundation spike above); since 15 Nov 2026 it is used through better-auth's passkey plugin.

**New in v1.7: the M1a-0 better-auth spike** (time-boxed, before M1a; PLAN §4). Each item ends in a recorded decision, and a failed item is fixed in the design before M1a starts.

**M1a-0 complete (15 Nov 2026): GO**, accepted by the product owner. All three no-go criteria pass. Answers, evidence and implications are in the [spike README](spikes/better-auth/README.md). **M1a requirements:** the 16 workarounds in the README's "Workarounds M1a must carry" list (epoch-ms Kysely plugin; UV through `afterVerification` hooks and an options rewrite; explicit passkey `origin` and `rpID`; clone detection by re-verifying on `AUTHENTICATION_FAILED`; forcing or stripping `createSession`; the enrolment ticket consumed in `registration.afterVerification`; the token filter; `__Host-` cookies; the CSRF header on the GET options routes; the AsyncLocalStorage marker; step-up by vetoing the new session; forwarding `getSession`'s `Set-Cookie`; users created with `emailVerified: true`; explicit `rateLimit`, `telemetry`, `joins` and `nodejs_compat`; rotation signing everyone out; and the upgrade checks in CI). Pins: better-auth 1.7.15, @better-auth/passkey 1.7.15 (SimpleWebAuthn 13.3.3). `spikes/better-auth` is reference only.

**Go/no-go.** better-auth is a **no-go** if any of these fails: it can't run correctly on D1 without transactions (with our ordered steps and repair job); `user.create.before` can't be shown to cover every user-creation path; or a hook can't see the authenticator counter (or the library's own regression error) reliably. **Fallback:** keep the hand-built sessions from the M1a branch (PR #17), add passkeys with `@simplewebauthn/server` directly and our own magic links, keeping every rule in Identity §4, and report back to the product owner before M1a proceeds. Other failures are design fixes, not a no-go.

Spike items:
- **D1 adapter:** custom table and field names, epoch-millisecond dates (otherwise an exception recorded in Platform §14), and behaviour **without transactions** (confirming the ordered steps and repair job in §8.1).
- **Magic links:** `auth.api` magic-link verify called in-process returns the session cookie headers we can forward; `storeToken: "hashed"`; the request route's behaviour for unknown emails under `disableSignUp` (same response, no account).
- **Passkeys:** whether verify with `requireSession: false` and `resolveUser` creates a session itself; whether user verification can be required in both options and verification; how a hook reads the authenticator counter, and whether SimpleWebAuthn already refuses regressions, which settles the counter-check choice in §8.1.
- **Hooks:** whether `user.create.before` covers every `auth.api` creation path; whether `session.create.before` can refuse; whether a session-delete hook exists (otherwise the UserHub recheck is the only path for expiry, §3.5).
- **Secrets:** the `BETTER_AUTH_SECRETS` rotation format.
- **Cookies:** whether the `__Host-` prefix works with better-auth's cookie options.
- **Origin and CSRF:** better-auth's origin check together with our `X-Officebox-Request` middleware; the token-stripping response filter.
- **Rate limits:** the limiter's custom storage interface, as a backstop behind our middleware.
- **Canonical origin:** `trustedOrigins`, `baseURL` and `rpID` from the installation record, with one instance per installation origin.
- **Step-up:** re-authenticating with a passkey while signed in through better-auth, updating the current session's `fresh_auth_at` without leaving a second session.
- **Domain move:** a second better-auth instance for the pending origin, used only by the completion routes.
- **Runtime:** that `nodejs_compat` is on by default from compatibility date 2026-08-04 (from the better-auth docs; not yet checked against Cloudflare's), the per-request cost of reading the session row from the primary, and the bundle size of better-auth and its passkey plugin against the Worker limit (AGENTS §4.4).
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

**New in v1.6** (Assistant §19, technical questions; the product questions stay in the spec):
- **Voice spike (gates M9c and M9d):** on production Cloudflare, confirm that the Realtime SFU's WebSocket audio adapter (beta) can deliver each participant's audio track to a Durable Object and stream audio back; which Workers AI speech-to-text model supports streaming; the live-voice latency target (under 1.5 s from end of speech to first audio, a spike result, not a CI test); and the memory, CPU and wall time of transcribing 25 tracks in one HuddleRoom versus a separate per-call transcriber DO. If the SFU path fails, live voice falls back to a direct WebSocket audio stream to the Assistant DO (§3.6, §5.11).
- **AI Gateway controls (verify in M9a):** whether `cf-aig-collect-log` and `cf-aig-skip-cache` can be set per request and a per-request "no log" is honoured; whether the Workers AI binding accepts equivalent gateway options; which providers AI Gateway supports for speech-to-text, text-to-speech and vision (roles without support stay on Workers AI) (§5.10).
- **Video files:** Workers can't run ffmpeg. Options are Cloudflare Stream's audio extraction (a new dependency and cost), transcribing only containers that speech-to-text accepts directly, or deferring video. Until decided, video is unsupported and indexed by name and metadata only (§5.2).
- **Recall re-check cost:** re-checking every cited source on every recall may be slow for long histories. Measure in M9a and, if needed, cache access decisions per request (§5.6).
- **`toMarkdown` formats and limits:** confirm in M9a which of PDF, DOCX, XLSX, PPTX, text, Markdown and CSV Workers AI `toMarkdown` supports, and its limits; any format it doesn't support is treated as unsupported (§5.2).

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

**Not yet checked, for the assistant (M9; Assistant §19, §10 here).** These are assumptions in §3.6 and §5 until checked against documentation and production: the Realtime SFU WebSocket audio adapter (described as beta) delivering per-participant audio to a Durable Object and back; a streaming Workers AI speech-to-text model; per-request AI Gateway log and cache controls (`cf-aig-collect-log`, `cf-aig-skip-cache`) and their equivalent on the Workers AI binding; AI Gateway provider support for speech-to-text, text-to-speech and vision; and the formats and limits of Workers AI `toMarkdown`. Results are recorded here when checked.

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
| Assistant (M9): Workers AI or BYOK model usage, speech-to-text and text-to-speech minutes, Vectorize, Assistant DO duration, SFU audio to DOs | Not yet estimated | — | Measured in the voice spike and M9a, then added here. Each installation's estimate appears in the usage panel's assistant section (§7.9), capped by `assistant_daily_caps` and `assistant_call_notes_monthly_minutes`. |

**Not yet modelled (v1.4):**
- ReminderScheduler alarms: low thousands of triggers per 48 hours at 100 members
- hourly ICS-in fetches (at most 50 subscriptions per workspace by default)
- calendar change fan-out through UserHub
- delayed `unread-email` queue messages, one per unread conversation per offline recipient.

All are expected to be small next to chat traffic. The load test should include them.

**Conclusion:** a 25-person team should fit within the Workers Paid allowances. This excludes the assistant (M9), which is off by default and not yet estimated (above). Even at four times these figures, Durable Object request overage would be under $1 a month. These are estimates. The Phase 1 load test (§10) replaces them with measurements, and the usage panel (§7.9) shows each installation's real figures.

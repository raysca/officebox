# Officebox — Technical Design Document (TDD)

**Status:** Draft for engineering review  
**Version:** 1.0  
**Date:** 14 November 2026  
**Companion to:** [Officebox PRD v1.0](PRD.md)

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
│  • ChatChannel DO   │ │  • users           │ │  • R2: files, attachments,    │
│    (messages,       │ │  • memberships     │ │    exports                    │
│     presence)       │ │  • channels        │ │  • Vectorize: document and    │
│                     │ │  • documents       │ │    message embeddings         │
│  • DocRoom DO       │ │  • issues/tasks    │ │                               │
│    (Yjs document)   │ │  • projects        │ │                               │
│                     │ │  • inbox_items     │ │                               │
│  • BoardRoom DO     │ │  • audit_log       │ │                               │
│    (Yjs whiteboard) │ │  • notifications   │ │                               │
│                     │ │                    │ │                               │
│  • InboxFanout DO   │ │                    │ │                               │
│    (per-user)       │ │                    │ │                               │
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
| ChatChannel DO | Message ordering, fan-out, presence, typing, history replay | Durable Object + SQLite |
| DocRoom DO | Authoritative Y.Doc per document, sync, awareness, snapshots | Durable Object + SQLite |
| BoardRoom DO | Authoritative Y.Doc per whiteboard | Durable Object + SQLite |
| InboxFanout DO | Per-user notification fan-out and unread aggregation | Durable Object |
| D1 | Durable domain records, permissions, audit, inbox items | D1 |
| R2 | Files, attachments, exports | R2 |
| Vectorize | Embeddings for permission-aware retrieval | Vectorize |
| Realtime SFU | Audio/video huddles, TURN | Cloudflare Realtime |
| AI Gateway | BYOK provider proxy, fallback, rate limiting | AI Gateway |
| Queues | Async email, webhook, AI indexing jobs | Queues |

### 1.2 Why Durable Objects for both chat and Yjs

Durable Objects provide a single-threaded, stateful coordinator with private SQLite storage and WebSocket hibernation. This is the right primitive for both:

- Chat: one DO per channel provides total ordering, presence and fan-out.
- Yjs: one DO per document/whiteboard provides authoritative CRDT state, conflict-free sync and persistent storage.

Yjs on Durable Objects is a proven pattern: one object holds one document, speaks the standard y-websocket protocol, relays presence, supports snapshots and compaction, and hibernates when idle. Durable Object SQLite can store both chat messages and Yjs updates without a separate database engine.

## 2. Data model

### 2.1 D1 schema (core domain)

D1 uses SQLite semantics. Each D1 database has a 10 GB limit on Workers Paid (500 MB free), with 1 TB total per account. Officebox keeps one D1 database per installation, with logical separation by table.

```sql
-- Identity
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE memberships (
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  role TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, workspace_id)
);

-- Workspace objects
CREATE TABLE channels (
  id TEXT PRIMARY KEY,
  name TEXT,
  type TEXT NOT NULL, -- public, private, dm
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'document', -- document, whiteboard
  owner_id TEXT NOT NULL,
  origin_channel_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE object_links (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE issues (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL,
  assignee_id TEXT,
  due_date INTEGER,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Inbox and notifications
CREATE TABLE inbox_items (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL, -- notification, action, schedule, follow
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'unread',
  priority INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE notification_preferences (
  user_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  channel TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, event_type, channel)
);

-- Audit
CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  actor_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  metadata TEXT,
  created_at INTEGER NOT NULL
);

-- AI indexing state
CREATE TABLE embedding_jobs (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  state TEXT NOT NULL, -- pending, indexed, failed
  attempts INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
```

### 2.2 Durable Object SQLite schemas

**ChatChannel DO** — one per channel:

```sql
CREATE TABLE messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  sender_id TEXT NOT NULL,
  body TEXT NOT NULL,
  metadata TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE presence (
  connection_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  state TEXT NOT NULL, -- online, away, typing
  updated_at INTEGER NOT NULL
);
```

Message sequence (seq) is assigned by the DO, giving a total order within a channel. Clients use seq for gap detection and replay after reconnect. Message bodies are also written to D1 for cross-channel search and retention, but the DO is the realtime source of ordering.

**DocRoom / BoardRoom DO** — one per document/whiteboard:

```sql
CREATE TABLE updates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  update_blob BLOB NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  state_blob BLOB NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
```

Updates append to a log; every N updates (configurable, default 50) the log folds into a snapshot to bound storage and load time. A snapshot or update must stay under 2 MB (Durable Object storage limit); the DO rejects or chunks oversized payloads.

**InboxFanout DO** — one per user:

```sql
CREATE TABLE pending (
  id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
```

Used for low-latency fan-out of inbox events to connected clients. Durable record lives in D1.

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

### 3.3 Message flow

1. Client sends { type: "message.send", body, clientId } over the channel WebSocket.
2. DO validates payload, assigns seq, writes to DO SQLite, and broadcasts { type: "message.created", seq, id, ... } to all connected sockets.
3. DO enqueues a D1 write for cross-channel search and durability (via an internal alarm or Queues).
4. Client uses clientId for optimistic reconciliation.

Message history is replayable: clients send { type: "sync", afterSeq } and the DO returns messages with seq > afterSeq. Hibernation does not lose this capability because the log is in DO SQLite.

### 3.4 Presence

Presence is ephemeral and stored in DO memory and connection attachments, not in D1. On connect/disconnect, the DO broadcasts presence.joined / presence.left. Typing indicators are presence states with a short TTL, refreshed by the client and expired by the DO.

Presence is never the source of truth for durable data.

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

### 4.3 Persistence and compaction

- Updates append to updates table in DO SQLite.
- Every SYNC_COMPACT_EVERY updates (default 50), the DO merges the log into a single snapshot in snapshots and truncates the update log.
- On cold start, the DO loads the latest snapshot and replays any subsequent updates.
- Snapshots are also copied to R2 for export and disaster recovery (via an alarm or Queues job).

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
3. Each vector carries metadata for permission filtering: workspace_id, object_type, object_id, allowed_roles, allowed_user_ids, channel_id.
4. On document deletion or permission change, the Worker enqueues an invalidation job that removes or re-scopes vectors.

### 5.3 Retrieval flow

1. User asks a question.
2. Worker generates a query embedding via Workers AI.
3. Vectorize query returns candidate vectors with metadata.
4. Worker filters candidates by the requesting user's permissions (roles, channel membership, explicit grants) before passing content to the model.
5. The model receives only permitted snippets; the response cites source objects the user can access.

Design rule: permission filtering happens before model invocation, not after. No vector is passed to the model unless the requesting user is authorised to see its source.

### 5.4 Audit

AI tool invocations and mutating actions are written to audit_log with actor, action, target, model/provider and outcome. Retention is configurable; default retention is defined before Phase 3.

## 6. Deployment and upgrades

### 6.1 Deploy to Cloudflare

The repository includes a wrangler.jsonc with bindings for:

- Durable Object namespaces (ChatChannel, DocRoom, BoardRoom, InboxFanout).
- D1 database.
- R2 bucket.
- Vectorize index.
- AI Gateway.
- Queues.

The Deploy to Cloudflare button clones the repo, provisions supported resources automatically, and runs the deploy script. D1 migrations run as part of the deploy script.

### 6.2 Channels and releases

- main branch → stable channel.
- beta branch → beta channel.
- Each release is a Worker version with an associated tag.
- Customers choose a channel in the admin UI.

### 6.3 Upgrade flow

1. Admin selects "Upgrade to latest stable" or "Upgrade to beta."
2. Worker triggers a deployment from the corresponding branch (via Workers Builds or a webhook to a small deploy Worker).
3. Pre-upgrade checks validate bindings and D1 migrations.
4. D1 migrations run; progress is surfaced.
5. If migration fails, the Worker remains on the previous version and the admin receives a clear error with rollback guidance.
6. On success, the new version becomes active.

### 6.4 Rollback

Workers retain version history; rollback to a previous version creates a new deployment and becomes active. Build history and logs are retained for 90 days; versions remain available for rollback after that.

Limitation: D1 migrations that are not backward-compatible cannot be automatically rolled back. The PRD requires documenting rollback limitations for each migration and recommending export before irreversible upgrades.

## 7. Operations and observability

### 7.1 Health checks

A /health endpoint checks:

- Worker and D1 connectivity.
- Durable Object namespace availability (lightweight ping to a system DO).
- R2 bucket access.
- Vectorize index presence.
- AI Gateway configuration (if configured).
- Realtime SFU credentials (if configured).

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
- Application export: a Worker endpoint produces a database-consistent export (D1 dump + R2 manifest + DO snapshots) for portability.

## 8. Security model

- Authentication: local accounts; passwords hashed with a memory-hard KDF; session JWTs short-lived and rotated.
- Authorisation: role-based at workspace level; resource-level checks for channels, documents, projects and files. All checks occur in the Worker before DO access.
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
- Permission test: viewer cannot write Yjs updates; AI retrieval excludes inaccessible documents.
- Upgrade test: stable → beta upgrade succeeds; rollback to previous version succeeds.
- Storage test: upload rejection triggers before D1/DO storage exhaustion; admin warning appears.
- Backup test: export produces a restorable manifest; missing export configuration warns but does not block startup.

### 9.2 Performance targets

- Chat message round-trip: p95 < 300 ms within region.
- Document sync latency: p95 < 200 ms for keystroke propagation.
- Cold document load: < 1 s for documents under 100 KB snapshot.
- Huddle join: < 2 s from click to audio.

## 10. Open technical questions

- Exact D1 vs. DO SQLite split for message durability (how much history lives in D1 vs. DO).
- Vectorize metadata filtering limits and whether a secondary D1 index is needed for permission checks at scale.
- Whether InboxFanout DO per user is necessary in Phase 1 or can be a D1 polling model.
- Snapshot compaction tuning (frequency, size thresholds).
- Whether to use Workers Builds entirely or a small deploy Worker for channel upgrades.
- Export format and restore tooling.
- SMTP relay provider matrix and queue retry policy.

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

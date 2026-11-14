# Officebox PRD/TDD Review

**Reviewed:** PRD v1.0 and TDD v1.0 (14 November 2026)
**Review date:** 14 November 2026

## Summary

The original `PRD.md` held two documents back to back. They are now split into [PRD.md](PRD.md) (product) and [TDD.md](TDD.md) (technical design). The wording is unchanged. Only the Markdown formatting changed: headings, lists, tables and cross-links.

The product vision is clear and well argued. It has sensible principles, honest phasing and good instincts on permissions and AI safety. The weak points are where the vision meets the deployment and business model, and where the TDD makes Phase 1 claims that the schema and protocols don't yet support.

**Verdict:** this is a strong direction document, but it is not ready to build from. Five issues are structural and could change the architecture or the business model, so resolve them first: C1 to C5 below. Most other findings are gaps that can be filled in place.

Cloudflare limits and prices change often. Figures originally marked *(verify)* were checked against Cloudflare documentation on 14 November 2026. Corrections are noted inline, and the checked facts are listed in the TDD appendix.

## Status after PRD/TDD v1.1

| Item | Status | Where |
|---|---|---|
| C1 Business model | **Resolved.** AGPL-3.0; every release free, including security fixes; revenue from paid support, priority fixes and assisted setup/migration; free beta. | PRD §1, §2, §4, Appendix A |
| C2 Upgrades | **Resolved.** A release-sync GitHub Actions workflow opens a signed-release PR built from a three-way diff; merging deploys via Workers Builds; expand/contract migrations with `rollback_safe_to`; no credentials in the app. | PRD §13; TDD §6.2–6.7 |
| C3 First-run setup | **Resolved.** One-time setup token (deploy secret or generated and logged); atomic claim; disabled after use. | PRD §6; TDD §6.8 |
| C4 Message storage | **Resolved.** The DO event log is the source of truth; transactional outbox to an idempotent D1 copy; edits, deletes and reactions as events; `clientId` dedupe; reconciliation. | PRD §5.4; TDD §2.0, §2.2, §3.3 |
| C5 Schema / roles / retention | **Resolved (baseline).** Role model and retention rules are defined as baselines for customer validation; full Phase 1 schema with indexes and permission resolution; purge pipeline. | PRD §10.1–10.2; TDD §2.1, §2.3 |

The v1.1 changes also fixed these contradictions: "pay once", GitHub vs GitLab, where messages are stored, `memberships.workspace_id`, the missing `notifications` table, and the AI test in Phase 1.

Some new design points depend on Deploy-button and D1 behaviour that needs checking. They are listed in TDD §10.

The High and Medium items below were open at v1.1.

## Status after PRD/TDD v1.2: open questions decided

Every open question in PRD §17 and TDD §10 now has a recommended decision, recorded in those sections. Deciding them also resolved or reduced several review items:

| Item | Status | Where |
|---|---|---|
| H1 Connection layout and fan-out | **Resolved.** UserHub hub socket plus WorkspacePresence; batched fan-out to online users only | TDD §3.5 |
| H2 Cost model | **Reduced.** Auto-response keepalives and paused awareness in hidden tabs; the load test is still required | TDD §3.5, §10 |
| H3 WebSocket auth and revocation | **Partly resolved.** `closeConnections` revokes open sockets. Still open: JWT in the query string vs. cookie or one-time ticket. | TDD §3.5 |
| H4 Full-text search | **Resolved.** FTS5 design, document text projection, export workaround | TDD §2.4 |
| H5 Vectorize permissions | **Resolved.** Scope-only metadata, D1 final check, FTS top-up | TDD §5.2–5.3 |
| H6 Backup and restore | **Mostly resolved.** Export format v1, Restore from export, per-object consistency and maintenance mode. Cross-store point-in-time restore remains a documented limitation. | PRD §13; TDD §7.5 |
| M1 Yjs storage | **Resolved.** Size and count compaction, 4 MB chunks, assets in R2 | TDD §4.3 |
| M2 Revision history | **Resolved.** Hourly and daily versions in R2; restore as a new change | PRD §5.5; TDD §4.3 |
| M3 Editor licences | **Partly resolved.** MIT Tiptap packages only. Still open: the whiteboard component choice. | PRD §5.5 |
| M6 SMTP from Workers | **Resolved.** HTTP API drivers preferred; STARTTLS SMTP; retry policy | TDD §7.6 |

Still open: H2 (load test), H3 (token transport), H7, H8 and the remaining Medium items.

---

## Critical: resolve before any build work

### C1. The business model does not fit the deployment model
*PRD §1, Appendix A ("Business model"), §17*

- The Deploy to Cloudflare button only works on a **public** repository. It copies that repository into the customer's own GitHub or GitLab account. So every customer, and anyone else, gets the full source and can pull later releases for free. Nothing technical lets Officebox charge for "big fixes and upgrades" or for beta access (the §17 question).
- "big fixes" is almost certainly a typo for "bug fixes". Even so, **charging for bug fixes** is a weak proposition. It also works against the "Safe upgrades" principle: customers who don't pay stay on vulnerable versions.
- "Pay once, $5/month" contradicts itself. $5/month is a recurring fee paid to Cloudflare, not a one-off payment to Officebox.
- The licence of Officebox itself is never stated. Open source? Source-available? Commercial?

**Recommendation:** decide the licence and the revenue model first. Options include open core, paid support or SLA, a paid hosted upgrade service, a commercial licence above N users, or donations or sponsorship. Then rewrite the headline. As a minimum policy, security fixes should always be free.

### C2. One-click upgrade cannot work as described
*PRD §13 "Upgrades and rollback", TDD §6.2–6.3*

- The Deploy button creates a **new repository with no upstream link**; it is not a fork. Workers Builds then builds from the *customer's* copy. That copy never receives changes from Officebox's `main` or `beta` branches, so "deploy from the corresponding branch" has nothing to pull from.
- A Worker cannot redeploy itself without either:
  - a stored Cloudflare API token with Workers edit rights, which is high-privilege and must be stored and rotated, or
  - a GitHub token that can push to the customer's repo.

  The TDD hand-waves this as "via Workers Builds or a webhook to a small deploy Worker".
- If customers edit their copy, upgrades will hit merge conflicts. The documents don't say whether customer changes are supported.
- The channel concept assumes Officebox builds and publishes releases somewhere. There's no release artifact, signing or integrity check.

**Recommendation:** write an ADR for the upgrade mechanism. Candidates:
- (a) A GitHub Action in the customer's repo that syncs upstream tags and opens a PR. Workers Builds deploys on merge.
- (b) A deploy Worker holding a scoped API token that uploads signed, pre-built bundles from Officebox releases.
- (c) Customers switch channels by re-pointing their repo.

Each has different security and UX costs. Also specify how an installation learns that an update or security advisory exists, for example by polling GitHub Releases.

### C3. First-run admin setup can be hijacked
*PRD §6 ("First-run setup creates the initial administrator")*

After deployment the `*.workers.dev` URL is public straight away. Whoever loads it first becomes administrator of a workspace that will hold the company's data.

**Recommendation:** gate first-run setup behind a secret the deployer controls. Options:
- a setup token generated at deploy time and shown in build output or as a Worker secret, or
- a requirement to set an `ADMIN_EMAIL` secret, or
- protection with Cloudflare Access until setup completes.

Add this to the Phase 1 validation list.

### C4. Where messages are stored is undecided and inconsistent
*PRD §5.4 and §13 "Storage", TDD §2.1, §2.2, §3.3, §10*

- PRD §5.4 says messages are "stored in D1". PRD §13 also lists "message history per channel" under Durable Object SQLite. The TDD writes to DO SQLite first and copies to D1 asynchronously.
- **The D1 schema has no `messages` table**, although TDD §2.2 says bodies are written to D1 for search.
- The dual write has no defined consistency model:
  - What if the D1 write fails, or the DO's single alarm is already in use?
  - Which store is the source of truth for export, retention and deletion?
- Phase 1 chat features have no schema or protocol: threads, reactions, edits, deletes, attachments, mentions and read cursors. The sync protocol (`afterSeq`) only replays *new* messages. It cannot carry edits or deletes.
- `clientId` is used for reconciliation but never stored, so retries after a reconnect can create duplicate messages.

**Recommendation:** pick one source of truth, ideally DO SQLite per channel plus a D1 search projection. Use a **transactional outbox** table in DO SQLite drained by a Queue, so the D1 copy is guaranteed eventually. Model the channel log as an *event* stream (create, edit, delete, react, thread-reply) so `afterSeq` replay covers every change, and dedupe on `clientId`. This is listed as an open technical question but it is a Phase 1 foundation, so move it out.

### C5. Phase 1 schema is far from complete, and retention must come first
*TDD §2.1, PRD §17*

The PRD rightly says retention and deletion rules must be settled before the schema freezes, but the schema doesn't reflect that yet.

- **Missing tables for Phase 1 features:**
  - channel membership: needed for private channels, unread counts and every permission check
  - document and file ACLs
  - groups and teams
  - `files` and attachments metadata
  - invitations
  - sessions and refresh tokens
  - MFA secrets and recovery codes
  - read cursors
  - follows
  - notifications (shown in the diagram but not in the schema)
  - FTS index tables
  - installation settings: SMTP config, storage thresholds, channel choice
- `memberships.workspace_id` contradicts the single-workspace model. `users.role` and `memberships.role` duplicate each other.
- There are no `deleted_at` or soft-delete columns, foreign keys or indexes. Without indexes, `inbox_items(user_id, state)` and `object_links(source_*/target_*)` will be scanned on every query.
- `users.password_hash NOT NULL` doesn't allow invited-but-not-yet-registered users or future SSO accounts.
- `inbox_items` can't support the PRD's snooze, due dates, de-duplication or grouping. It has no `snooze_until`, `due_at` or `dedupe_key`.

**Recommendation:** finish the role and permission model (§17's first open question) and the retention rules. Then write the full Phase 1 schema with indexes and a migration strategy.

---

## High: significant design gaps

### H1. Connection layout and fan-out are not designed
*TDD §1, §3, InboxFanout DO*

- The design opens one WebSocket per channel or document. A user in 40 channels can't hold 40 sockets. Even so, unread indicators and presence need updates from **every** channel the user belongs to.
- Nothing explains how a ChatChannel DO tells members it isn't connected to about mentions or unread counts. One DO call per member per message gets expensive in large channels.
- Workspace-wide presence (online dots in DMs and the member list) can't live in per-channel DOs.

**Recommendation:** use one per-user (or per-session) gateway DO that holds the client's single socket and subscribes to channels, or define a clear "active channel socket + user socket" model. Specify the fan-out path and batching. This also settles the open question of "InboxFanout DO vs D1 polling".

### H2. Hibernation and cost assumptions are optimistic
*PRD §4 and §16 cost criterion, TDD §3.2, §3.4*

- Typing indicators, Yjs awareness heartbeats (sent about every 15 s by default) and app-level pings all **wake the DO**. A document left open in a background tab never hibernates.
- Use `setWebSocketAutoResponse` for ping/pong. Throttle or suspend awareness in hidden tabs. Typing TTL expiry also needs alarms or wake-ups.
- Incoming WebSocket messages count as billable DO requests, at a 20:1 ratio (confirmed). Workers Paid includes 1 million DO requests per month. Keystroke-level Yjs updates add up.
- The "$5/month for 25 people" claim has no supporting model. Several services bill separately or have their own allowances:
  - Workers AI neurons for embeddings
  - Vectorize stored and queried dimensions
  - DO SQLite storage
  - Queues operations
  - R2 storage beyond the free tier
  - Realtime SFU / TURN

  Cloudflare also has **no hard spend cap**, so a runaway loop or a large upload means a surprise bill.

**Recommendation:** add a cost model appendix with usage assumptions per user per day. Add a load test that measures real request, duration and storage use for a simulated 25-person team. Add billing and usage alerts to the admin UI.

### H3. WebSocket auth and revoking access
*TDD §3.1, §4.4, §8*

- A JWT in the query string leaks into logs, analytics and browser history. Browsers *do* send same-origin cookies on the WebSocket handshake, so cookie auth works. A one-time connect ticket is another option.
- Sockets live much longer than a "short-lived" JWT. Permissions are copied into the attachment once, at connect time. **Disabling a user, removing them from a private channel or downgrading their document role does not affect sockets already open.** PRD §6 promises session revocation.

**Recommendation:** define a revocation path. The Worker notifies affected DOs, which close or re-scope matching sockets. Also re-validate periodically. Specify session storage: HttpOnly cookies, refresh rotation and CSRF protection.

### H4. Full-text search is a Phase 1 deliverable with no design
*PRD §15 Phase 1, §16; TDD has no section*

- Document text lives as Yjs binary inside DOs. Nothing extracts plain text into a searchable index or explains how titles and content flow back to D1.
- D1 supports FTS5. However, `wrangler d1 export` does not support databases with virtual tables (confirmed), which affects the export plan (C5 / M4).
- Filtering results by permission at query time (joins against ACLs) isn't designed.

**Recommendation:** add a search section covering the indexing pipeline (debounced extraction from DocRoom), FTS schema, permission filtering and how export or rebuild works.

### H5. Vectorize permission filtering won't work as written
*TDD §5.2–5.3*

- Metadata such as `allowed_user_ids` and `allowed_roles` is a list. Vectorize filters support `$eq/$ne/$in/$nin/range` on indexed scalar fields, with 10 metadata indexes and 10 KiB of metadata per vector (confirmed). Filter JSON must be under 2,048 bytes. "Array contains user" isn't really supported.
- If filtering happens after the vector query, a user with narrow access can get **zero results**. topK is capped at 50 when returning metadata, 100 without (corrected from about 20).
- Every permission change means rewriting vectors.
- Changing the embedding model (the PRD allows "different model choices… for embeddings") means a **full reindex**, because index dimensions are fixed when the index is created.
- `workspace_id` metadata adds nothing in a single-tenant install.

**Recommendation:** store only `object_type`, `object_id` and coarse scope (for example a channel or doc ID used with `$in` against the user's accessible scopes). Check exact permissions in D1 after retrieval, over-fetching as needed. Document the reindex procedure.

### H6. Backup and restore promises go beyond what the platform provides
*PRD §13, TDD §7.4*

- D1 Time Travel restores **only D1**. SQLite-backed DOs have their own per-object point-in-time recovery, and R2 versioning is separate again. You can't restore D1, thousands of DOs and R2 to the same consistent moment, so cross-store references can break after a restore.
- A "database-consistent export" across D1, DOs and R2 is impossible without pausing writes. Define what "consistent" means here.
- **There is no import or restore tool.** An export you can't restore isn't a backup, and "move an installation to another account" is a product promise.
- "Delete their data at any time" conflicts with 30-day Time Travel, DO point-in-time recovery, R2 versions and snapshot copies. All of these keep deleted data around.

**Recommendation:** define export format v1 together with restore and import tooling, and test both in Phase 1. Write down the exact restore procedure and its consistency limits. Reword the deletion promise to cover the retention windows.

### H7. Migrations and rollback across D1 and Durable Objects
*TDD §6.3–6.4*

- D1 migrations are not atomic as a set. "The Worker remains on the previous version" says nothing about a half-applied migration.
- Rolling back code after a migration leaves old code running on a new schema. The design needs an **expand/contract** rule: every migration must stay compatible with the previous release.
- **DO SQLite schema migrations aren't mentioned.** Each of potentially thousands of DOs migrates lazily when it wakes. Rolled-back code then meets DOs already on a newer schema.
- Wrangler DO class migrations (`new_sqlite_classes`, renames, deletes) are also unmanaged.

**Recommendation:** add a migrations section covering D1 (expand/contract, a version table, pre-flight checks), DO schemas (a per-object version in `meta`, forward-compatible reads) and DO class changes.

### H8. Several resources can't be provisioned in one click
*PRD §1, §13, TDD §6.1*

The Deploy button provisions bindings such as D1, R2, DO, Queues and Vectorize. It does **not** set up:
- Realtime SFU app ID and secret
- TURN keys
- AI Gateway auth tokens and BYOK keys in Secrets Store
- SMTP credentials
- R2 S3 API credentials (needed for the presigned URLs in TDD §1)
- custom domains

Some of these are later-phase or optional, but the "one-click, zero-ops" message should say which steps need manual setup.

**Recommendation:** add a post-deploy setup checklist to the admin UI and a matrix of automatic vs manual steps. Consider proxying R2 uploads through the Worker using the binding and multipart upload, instead of presigned URLs that need S3 credentials.

---

## Medium

| # | Area | Issue | Recommendation |
|---|---|---|---|
| M1 | Yjs storage (TDD §2.2, §4.3) | DO SQLite rows, strings and BLOBs are limited to 8 MB (corrected from 2 MB). "Rejects or chunks" is undecided. Whiteboards with embedded images will hit it. Compacting every 50 updates means compacting every ~50 keystrokes, which wastes CPU. | Chunk snapshots across rows. Keep binary assets in R2 and only references in Yjs. Compact on size or time thresholds. |
| M2 | Revision history (PRD §5.5, TDD §4.3) | Truncating the update log destroys history. Yjs version snapshots need `gc: false` or retained snapshots, which affects storage. | Specify the revision model (named versions vs. periodic snapshots) and retention. |
| M3 | Editor and whiteboard licences (TDD §4.2, PRD §12) | Some Tiptap features (comments, version history and others) are tied to Tiptap's paid platform. Check which are MIT. Excalidraw has no official Yjs binding (only community `y-excalidraw`). tldraw needs a commercial licence key in production. | Finish the component evaluation register before committing. The PRD gives the "commenter" role but specifies no document comments feature. |
| M4 | Storage monitoring (PRD §13, TDD §9.1) | A Worker can't easily read R2 bucket size or total DO storage from bindings; this needs the GraphQL Analytics API and an API token. R2 has no real exhaustion limit (it's a cost issue). The hard limits are **D1's 10 GB** and per-DO storage. The validation test checks "upload rejection before D1/DO exhaustion", but uploads go to R2. | Redefine thresholds for each store. Estimate D1 growth: 100 users × 100 msgs/day ≈ 2 GB/yr before FTS overhead, so 10 GB is reached in a few years. Plan archiving or splitting. |
| M5 | Scheduled work | Digests, due-date reminders, retention purges, storage checks, snapshot-to-R2 copies and expired invites all need **Cron Triggers**, which aren't mentioned anywhere. | Add a scheduled-jobs section. |
| M6 | SMTP from Workers (PRD §7) | Workers can only do SMTP over `connect()` TCP sockets with STARTTLS. Port 25 is blocked, and an SMTP client library is needed. | Assess Cloudflare's email-sending options and HTTP-API relays (Resend, Postmark, SES) alongside raw SMTP. Fill in the "provider matrix" question. |
| M7 | File security (PRD §5.7) | Serving user-uploaded HTML or SVG from the app origin is an XSS route. There's no max file size, MIME allow-list or decision on malware scanning. Previews of Office/PDF files have no design. | Serve downloads with `Content-Disposition: attachment` or from a separate origin. Set limits. |
| M8 | Web security basics (TDD §8) | No mention of CSP, CSRF, sanitising Tiptap and Markdown HTML, rate limiting or lockout on login and invite endpoints, or SSRF if external link unfurling is added. "Memory-hard KDF" isn't specified: Argon2 in WASM vs. native PBKDF2, within Worker CPU and memory limits. | Expand §8 into a threat model. Pick the KDF and its parameters. Use the Workers Rate Limiting binding. |
| M9 | Admin lockout / break-glass (PRD §6) | If the only admin loses their password or TOTP device and no SMTP is configured, there's no recovery path. | Document a recovery path using Wrangler or the D1 console, and suggest a second admin. |
| M10 | Huddle signalling (PRD §5.8, TDD) | No DO or state for call sessions (who's in a call, which session ID). Realtime SFU needs app credentials and server-side session handling. | Add a `HuddleRoom` DO design before Phase 2. |
| M11 | Global teams (TDD §9.2) | A D1 primary sits in one region, and DOs are placed near whoever first uses them. "p95 < 300 ms within region" leaves out remote members. There's no data-residency option, although DO and D1 jurisdictions exist. | Decide on location hints and jurisdiction settings at deploy time. This matters to the "data control" audience (EU startups). |
| M12 | Leavers and ownership (PRD §6, §10) | Documents have one `owner_id`. Nothing says what happens to their documents, DMs and assignments when an owner is disabled or deleted. | Define ownership transfer and the difference between disabling and deleting a user. |
| M13 | Admin data access policy | Can workspace admins read private channels and DMs? The Cloudflare account owner can always read D1 and DOs directly. That should be stated plainly for trust and compliance. | Add a "who can see what" section to PRD §10. |
| M14 | Offline cache (TDD §4.2) | IndexedDB persistence keeps document content on shared or lost devices after logout. | Clear local stores on logout. Consider settings for offline caching. |
| M15 | Vendor feedback loop | No telemetry, update check or way to deliver security advisories. The success criteria can't be measured from inside customer installs. | Add opt-in anonymous telemetry, an update and advisory check, and a way to measure success (surveys, opt-in metrics). |

---

## Product gaps (missing from the PRD)

- **Non-functional requirements:** accessibility (WCAG level), supported browsers, i18n and localisation, availability expectations, and hard limits (max members, channel size, file size, document size).
- **Guests and external collaborators:** contractors and clients are common at 5–100-person startups. Supported or explicitly out of scope?
- **Importing from Slack, Notion, Google Docs, etc.:** switching from current tools is the biggest adoption barrier for this audience. It appears in neither scope nor out-of-scope.
- **Integrations, webhooks, bots and a public API:** the TDD mentions webhook Queues, but the PRD never mentions integrations.
- **Custom domain setup** and its impact on PWA, cookies and push.
- **Cloudflare Access as an optional front door:** an easy route to SSO and MFA without building OIDC. Worth stating as a supported option.
- **User personas don't map to roles:** "Workspace administrator, team lead…" don't match the TDD's roles (member/owner/editor/commenter/viewer). This ties to the open role-model question.
- **Measurable success metrics:** §16 lists qualitative criteria only. Add targets such as time-to-deploy, activation and weekly active use.
- **Support model:** who customers contact and what "support bundle" delivery means for privacy, since the bundle includes audit log entries.

---

## Contradictions and inconsistencies

| Where | Conflict |
|---|---|
| PRD §1 vs. Appendix A | "Pay once" vs. a $5 *monthly* fee; "big fixes" (typo) |
| PRD §1 vs. §13 | Deploy clones into "GitHub account" vs. "GitHub/GitLab account" |
| PRD §5.4 vs. §13 vs. TDD §3.3 | Messages "stored in D1" vs. DO SQLite primary with async D1 copy (C4) |
| PRD §5.9 / §11 vs. §15 | Describes the "first AI release" in detail, but AI is Phase 3 |
| TDD §9.1 vs. PRD §15 | Phase 1 permission test covers "AI retrieval", which is Phase 3 |
| TDD §7.1 vs. PRD §15 | Phase 1 health checks include Realtime SFU (Phase 2) |
| TDD §9.2 | Performance target for huddle join, which is Phase 2 |
| PRD §5.3 vs. §15 / §16 | Personal Inbox is "first-class" with a "first release" scope, but ships in Phase 2 |
| PRD §10 vs. TDD §2.1 | Single workspace vs. a `memberships.workspace_id` column |
| PRD §6 vs. TDD §3.1 | Session revocation promised vs. JWTs baked into long-lived sockets (H3) |
| PRD §13 vs. TDD §9.1 | Upload rejection tied to D1/DO exhaustion, but uploads go to R2 |
| TDD §4.2 | "The DO validates it via the authorize hook (implemented in the Worker…)": the Worker validates, not the DO |
| TDD §2.1 vs. diagram | `notifications` table shown in the diagram but missing from the schema |
| TDD Appendix | "100,000 databases included" isn't relevant to a single-database design. Put all limit and price figures in one table with a "verified on" date. |

---

## Suggested additions to the open questions

**PRD §17:**
- Licence and revenue model (C1).
- Guest accounts; import from existing tools; public API and integrations.
- Admin access to private content (M13).
- Data residency and jurisdiction (M11).

**TDD §10** (move C4 and H1 *out* of open questions: they're Phase 1 blockers):
- Upgrade delivery mechanism and the security of any stored deploy credentials (C2).
- DO schema migration strategy (H7).
- Search indexing pipeline and FTS export compatibility (H4).
- Socket revocation (H3).
- Cost model validation (H2).

## Recommended next steps

1. Decide C1 (licence and business model) and C2 (upgrade mechanism). These are product-defining, and some outcomes change the repo and deployment design.
2. Fix C3 now. It's small and must ship in the very first build.
3. Write ADRs for message storage (C4), connection layout (H1) and migrations (H7).
4. Settle the role model and retention rules, then produce the complete Phase 1 schema (C5).
5. Build a throwaway spike that measures DO request, duration and storage use for a simulated 25-person team (H2). It confirms or refutes the headline $5 claim before marketing relies on it.

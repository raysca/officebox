# Officebox — Build Plan

**Status:** Draft for review
**Date:** 14 November 2026
**Inputs:** [PRD](PRD.md) v1.3, [TDD](TDD.md) v1.3, and findings from the realtime spike ([`spikes/realtime`](spikes/realtime/README.md))

## 1. Approach

We build a **foundation first** and then add features as **vertical slices** on top of it. Each milestone ships something a team can deploy and use.

- **Foundation before features.** Every feature depends on the same few things: identity and permissions, the realtime backbone, storage conventions and the app shell. Building them once, properly, keeps each feature small.
- **Vertical slices.** A milestone includes its database schema, Durable Objects, API, UI, tests and docs. Nothing is "backend done, UI later".
- **Always deployable.** `main` deploys to a fresh Cloudflare account with the Deploy button at every milestone.
- **Promote the spike, don't copy it.** The spike proved the designs. Production code re-implements them inside the new module structure and applies the spike's findings, most importantly typed RPC results instead of thrown errors (§6).

**Feature order:** authentication → chat → Campfire (huddles) → calendar → documents. Other work fits around these (§4).

## 2. Codebase structure

One repository, one deployed Worker (API and Durable Objects), with the React app served through Workers Assets. This follows TDD §1.

```text
officebox/
├── apps/
│   ├── worker/                 Cloudflare Worker + Durable Objects
│   │   ├── src/core/           router, auth middleware, errors/results, ids, db helpers, audit,
│   │   │                       settings, rate limits, cron dispatcher, queues + outbox, DO base class
│   │   ├── src/features/       one folder per feature: routes, Durable Objects, services, jobs
│   │   │   ├── auth/  members/  realtime/  chat/  files/  campfire/
│   │   │   ├── calendar/  docs/  inbox/  search/  admin/
│   │   ├── migrations/         D1 migrations (single sequence; files named by feature)
│   │   └── test/               Workers-runtime integration tests
│   └── web/                    React SPA (Vite)
│       ├── src/app/            shell, routing, layout, theming
│       ├── src/features/       mirrors the worker features
│       └── src/lib/            API client, realtime client, design system
├── packages/
│   ├── shared/                 types, API and WebSocket message schemas, permission rules, constants
│   └── ui/                     design-system components (when the web app outgrows src/lib)
├── e2e/                        Playwright end-to-end tests
├── spikes/                     reference prototypes (kept until each part is promoted, then removed)
└── PRD.md  TDD.md  PLAN.md
```

**Recommended stack.** These need your confirmation (§8).

| Concern | Choice | Why |
|---|---|---|
| Language | TypeScript (strict) everywhere | Already agreed (PRD Appendix A) |
| Worker routing | Hono | Small, Workers-native, typed routes and middleware |
| Validation | Zod schemas in `packages/shared` | One schema validates both the API and the WebSocket messages, and gives client types |
| Frontend | React 19, Vite, TanStack Router, TanStack Query | Typed routing; server-state caching works well with realtime invalidation |
| UI | Tailwind CSS with Radix UI primitives | Accessible building blocks (WCAG 2.2 AA goal, PRD §18); no heavyweight design framework |
| Editor / whiteboard | Tiptap (MIT packages) / Excalidraw (MIT) | Decided in PRD §5.5 and TDD §4.2 |
| Dates and recurrence | Temporal polyfill, `rrule` | Correct time zones and RFC 5545 recurrence for the calendar |
| Tests | Vitest + `@cloudflare/vitest-plugin`; Playwright | Proven in the spike, including headless screen capture |
| Package manager | npm workspaces | Matches the spike. `--legacy-peer-deps` is needed until the npm peer-resolution bug is fixed. |

## 3. Milestones at a glance

| # | Milestone | Delivers | Depends on | Size |
|---|---|---|---|---|
| M0 | **Foundation** | Repo, CI, deployable shell, core platform services | — | M |
| M1 | **Identity and access** | Setup, sign-in, sessions, invitations, email, profiles, roles, groups, permission engine | M0 | L |
| M2 | **Realtime backbone** | UserHub, presence, realtime client, fan-out, notifications and inbox basics, revocation | M1 | M |
| M3 | **Chat** | Channels, DMs, threads, reactions, files, search, notifications | M2 | XL (3 slices) |
| M4 | **Campfire** | Audio, video, screen sharing, present mode | M3, real-media run passed | L |
| M5 | **Calendar** | Personal, group and workspace calendars, holidays, time off, events, reminders | M2 (M4 for "join Campfire" links) | L |
| M6 | **Documents** | Docs, whiteboards, sharing, comments, history, present mode, search | M2 | L |
| M7 | **Operations** | Health, storage protection, usage panel, export/restore, upgrades | M1 (grows alongside) | M |
| M8 | **Personal Inbox** | Today / Upcoming / Assigned / Following views | M3, M5, M6 | M |
| Later | Projects and issues · MFA and SSO · imports · API and webhooks · AI | PRD Phases 2–3 | — | — |

Sizes are relative: M ≈ 1×, L ≈ 2×, XL ≈ 3×.

After M2, **chat, calendar and documents are independent** (separate Durable Objects and tables). Two people or agents can build them in parallel. Campfire waits for chat and for a passing real-media run.

## 4. Milestones in detail

Each milestone has a **must** scope (needed for the exit criteria), a **should** scope (in the milestone if time allows) and **later** items, which are tracked but deferred.

### M0 — Foundation

**Goal:** an empty but real Officebox that deploys, signs nobody in yet, and has every shared platform service later features need.

**Must:**
- **Repository and tooling:**
  - npm workspaces, strict TypeScript, ESLint and Prettier
  - shared `tsconfig`, with separate configs for the Worker and DOM code (a spike finding)
- **CI** (GitHub Actions, on every PR):
  - typecheck, lint
  - Worker unit and integration tests
  - web unit tests
  - a Playwright smoke test against `wrangler dev`
- **Deployment:**
  - `wrangler.jsonc` with every binding (TDD §6.1)
  - a working Deploy to Cloudflare button
  - the deploy command (preflight, migrations, deploy)
- **Core platform** (`apps/worker/src/core`):
  - Hono app with request context, structured logging, and errors as typed results (`Result<T, E>`) mapped to HTTP statuses
  - ULID ids, the D1 query helper, and the audit-log writer
  - the installation settings store and the Rate Limiting binding wrapper
  - **Durable Object base class:** schema versioning with lazy migration in `blockConcurrencyWhile`, the alarm multiplexer (one alarm, many named timers), WebSocket attachment helpers and auto-response keepalive
  - **Outbox helper** (the spike's pattern, generalised) and a **queue consumer framework** with DLQs
  - **Cron dispatcher:** three triggers (5 minutes, hourly, daily) feeding named jobs (TDD §7.8)
  - `/health`
- **Web app shell:**
  - Vite + React + TanStack Router, the layout (sidebar, header, content) and empty states
  - light and dark theme tokens and the accessibility baseline (focus rings, landmarks, reduced motion)
  - API client and error handling
- **Shared package:** Zod schema conventions, message envelope `{ type, id?, ... }`, error codes.

**Exit criteria:**
- A fresh Cloudflare account deploys from the button and shows the app shell. `/health` is green.
- CI is green and runs in under 10 minutes.
- A sample Durable Object migrates its schema lazily and survives eviction in a test.

### M1 — Identity and access

**Goal:** a team can set up a workspace, invite people and sign in safely. Every later permission check runs on this milestone's permission engine.

**Must:**
- **First-run setup** with the setup token, either the deploy secret or a generated token in the logs, and an atomic claim (TDD §6.8).
- **Sign-in:**
  - email and password, hashed with PBKDF2-SHA256 at 600k iterations in a versioned format
  - `HttpOnly` session cookie plus rotating refresh cookie, reuse detection, and `session_epoch` revocation
  - sign out and sign out everywhere
- **Invitations:**
  - single-use links that expire after 7 days, roles at invite time
  - **copy link** (no email needed) and **email**
  - accept flow that creates the account
- **Email:** the adapter interface with HTTP-API drivers (Resend, Postmark, SES) and SMTP over STARTTLS. Includes the queue, retries, DLQ and **Send test email** (TDD §7.6).
- **Password reset** when email is configured.
- **Profiles:** display name, avatar (R2), **time zone**, **working hours** and **location/region** (the calendar needs all three), and status text with an emoji.
- **Roles and groups:** owner, admin and member; admin-managed groups (PRD §10.1).
- **Members administration:** list, invite, change role, disable, delete (anonymise), and transfer document ownership.
- **Permission engine** in `packages/shared` plus Worker services. It resolves workspace role → channel membership → resource grants (user, group, channel) → general access, as in TDD §2.1. Every feature calls it, and it has its own test suite.
- **Security:**
  - CSRF header and `Origin` checks, the CSP and security headers
  - rate limits on sign-in, setup, invitations and reset
  - audit entries for every admin action
- **Owner recovery** through the `RECOVERY_TOKEN` secret.

**Should:** the "allowed email domains" setting for invitations; a session list in the profile showing devices and last seen.

**Later:** TOTP MFA; Cloudflare Access SSO; passkeys (PRD §6).

**Exit criteria:**
- These end-to-end tests pass: setup with a token, invite by link with no email configured, invite by email, password reset, disable user, and an expired invitation being refused.
- The permission engine passes a matrix test across every role and resource type.

### M2 — Realtime backbone

**Goal:** one realtime layer that every feature plugs into.

**Must:**
- **UserHub** and **WorkspacePresence** Durable Objects, promoted from the spike:
  - presence and status (online, away, do-not-disturb), heartbeats and expiry
  - the room registry for revocation (TDD §3.5)
- **Realtime client** (`apps/web/src/lib/realtime`):
  - one hub socket per browser, shared across tabs through `BroadcastChannel` leader election
  - reconnect with backoff, and room sockets for whatever is on screen
  - wipe local caches on a `4401` close
- **Fan-out framework:** a feature declares "these users care about this change" and the backbone delivers it to online hubs in batches (the spike's fan-out, generalised).
- **Notifications core:**
  - `inbox_items`, notification preferences per event and per channel
  - a do-not-disturb schedule
  - email delivery for offline recipients (digest optional)
  - an in-app notification panel
- **Revocation:** disabling a user or removing their access closes their sockets in every room.

**Exit criteria:**
- Presence shows in the UI across two browsers.
- Disabling a user closes their sockets within 5 seconds.
- The tab leader hands over correctly when the leading tab closes.

### M3 — Chat

Delivered in three slices, each releasable on its own.

**M3a — Messaging core:**
- **Channels:** public and private channels; browse, join and leave; name, topic and description; archive and unarchive.
- **Direct messages:** one-to-one DMs and group DMs (up to 8 people, deterministic `dm_key`).
- **ChatChannel Durable Object** (promoted from the spike):
  - event log and ordering, `clientId` dedupe, replay and log horizon
  - outbox to the D1 copy
- **Composer:** Markdown-style formatting, code blocks, emoji picker, `@mention` autocomplete, multi-line input, drafts saved per channel, and optimistic send with retry.
- **Message list:**
  - virtualised history with scrollback
  - day dividers, an unread marker and "jump to first unread"
  - permalinks to messages
- **Unread state:** read cursors, unread and mention badges, and mark as read.
- **Presence in chat:** typing indicators and member presence.

**M3b — Rich conversation:**
- **Threads:** a reply pane, "also send to channel", and thread followers.
- **Reactions:** quick reactions and a full emoji picker.
- **Editing:** edit and delete messages, with redaction (TDD §2.2).
- **Files:**
  - upload through the Worker into R2 (multipart above 50 MB)
  - drag-and-drop and paste
  - image previews and the allow-listed inline types (TDD §8.3)
  - a files tab per channel
- **Pins and saved items:** pinned messages per channel; "saved for later" per user.
- **Mentions:** `@channel` / `@here`, restricted to channel admins in large channels; links to Officebox objects shown as permission-checked previews.
- **Search:**
  - FTS5 over messages and file names
  - filters `from:`, `in:`, `has:file` and dates
  - jump to a result in context.

**M3c — Notifications and polish:**
- **Notifications:** mention and DM notifications into the inbox and to email, per-channel notification levels and mute, and a "huddle/Campfire started" system message slot.
- **Moderation:** channel admins remove messages and manage members; admins archive channels.
- **Keyboard:** quick switcher (Cmd/Ctrl+K) and other keyboard shortcuts.

**Later:**
- scheduled messages, message reminders and polls
- slash commands and external link unfurling
- custom emoji
- Slack import (PRD §19).

**Exit criteria:**
- These end-to-end tests pass:
  - two users chat in a public channel, a private channel and a DM
  - a thread reply and a reaction
  - a file upload with preview
  - edit and delete, with the deleted text absent from search
  - unread counts are correct after a reconnect.
- p95 message round trip is under 300 ms in-region (TDD §9.2).

### M4 — Campfire (huddles)

**Goal:** instant audio-first calls from any channel, DM, document or calendar event, with screen sharing.

**Gate:** the real-media run (`spikes/realtime`, `npm run test:media`) passes on a real Realtime SFU app. If it shows problems, fix the design before building the UI.

**Must:**
- **HuddleRoom Durable Object and Worker signalling,** promoted from the spike. Expected denials become typed results, not thrown errors.
- **SFU integration:** sessions, publish and subscribe, renegotiation, simulcast layers, and TURN credentials.
- **Campfire UI:**
  - join and leave; mute, camera and raise hand
  - participant tiles and active-speaker highlight
  - device selection and reconnect handling
- **Context indicators:** "Campfire in progress" in the channel header and sidebar, plus start/end system messages with duration and attendees.
- **Screen sharing (PRD §5.8):**
  - one presenter, with take-over requests
  - text-first quality with a motion mode
  - viewer full screen, picture-in-picture, zoom and pan
  - moderator stop
  - the workspace policy and resolution cap.
- **Present mode** for documents and whiteboards (TDD §4.5). It needs M6's editor, so if M4 ships first, it lands in M6 instead.
- **Mobile:** viewing and audio on mobile browsers; the share control is hidden where screen capture isn't available.

**Later:** transcription and summaries (Phase 3); recording stays out of scope.

**Exit criteria:**
- `test:media` passes in CI against the production Worker.
- Two people can talk and share a screen between Chrome and Safari.
- A host stop ends the stream within 3 seconds.

### M5 — Calendar

Calendar is **new scope**. The PRD currently plans only an outbound ICS feed in Phase 2 (PRD §5.3). This milestone makes it a first-class feature, and the PRD and TDD need updating once the scope below is agreed (§7).

**Calendars:**

| Kind | Owner | Typical contents | Who sees it |
|---|---|---|---|
| **Personal** | Each member (created automatically) | Own events, time off | The member; others see free/busy only, unless shared |
| **Group / team** | A group or a channel | Team meetings, team deadlines, everyone's time off | Members of the group or channel |
| **Workspace** | Admins | All-hands, company holidays, office closures | Everyone |
| **Public holidays** | Generated | Official holidays for the regions the workspace selects | Everyone; each member is highlighted for their own region |

**Must:**
- **Events:**
  - title, description, location, all-day or timed, with an explicit IANA time zone
  - **recurrence** (RFC 5545 RRULE) with "this event / this and following / all events" edits and exceptions
  - attendees (users and groups) with RSVP: yes, no, maybe
  - visibility: normal, private (others see "busy"), or public within the calendar
  - an optional **"Campfire" link**, so joining the event starts or joins its Campfire (once M4 has shipped)
  - links to related documents and channels
- **Views:**
  - day, week, month and agenda views
  - overlaying several calendars with a colour each
  - members' working hours and time zones shown in week view
  - a "find a time" free/busy grid for attendees
- **Holidays:**
  - admins pick countries and subdivisions for the workspace
  - members set their region in their profile
  - public holidays are generated locally from a bundled open dataset, so there's no external API
  - admins add **company holidays** on the workspace calendar
- **Time off:**
  - members declare out-of-office periods (vacation, sick, other) with an optional note
  - time off appears on their team calendars and shows as an "away until …" status in chat
- **Reminders:** per-event reminders delivered as inbox notifications (and email if the member chose it) with **minute precision**.
- **Notifications:** invitations, updates, cancellations and RSVP responses through the M2 notifications core.
- **ICS feed:** a private, revocable per-member ICS feed URL to subscribe to from Google, Outlook or Apple calendars (PRD §5.3).

**Should:**
- an **approval step for time off** (an approver per group)
- subscribing to external ICS calendars (read-only)
- an "invite this channel" shortcut.

**Later:** two-way Google and Microsoft calendar sync; room and resource booking.

**Design notes** (to go into the TDD):
- **D1 tables:**
  - `calendars` (kind, owner, group, channel, colour, visibility)
  - `events` (timestamps stored in UTC with the IANA zone, plus `rrule`, `exdates` and `visibility`)
  - `event_exceptions` (overrides and cancellations per original start)
  - `event_attendees` (principal and RSVP)
  - `event_reminders`
  - `time_off`
  - `holiday_regions` (workspace settings)
- **Recurrence** is expanded on the server for the requested window using `rrule` and Temporal, with explicit tests for daylight-saving transitions and all-day events across zones.
- **Reminders** use a single **ReminderScheduler** Durable Object whose alarm is always set to the next due reminder. This gives minute precision, which the 5-minute cron can't.
- **Holidays** are computed in the Worker from the bundled dataset for the selected regions only, which keeps bundle size down. The dataset's licence still needs checking.
- **Realtime:** calendar changes notify attendees through UserHub fan-out. Calendars need no Durable Object of their own.
- **Permissions:** calendars are a new resource type in the permission engine.

**Exit criteria:**
- These end-to-end tests pass:
  - create a weekly recurring meeting with attendees, edit one occurrence, then "this and following"
  - RSVP from another account
  - a reminder arrives on time
  - a holiday shows for a member's region
  - time off appears on the team calendar and in chat status
- Daylight-saving tests pass for at least three time zones.

### M6 — Documents and whiteboards

**Must:**
- **Documents list:** folders, recent, shared with me, Trash (30-day restore).
- **Editing:**
  - DocRoom Durable Object (promoted from the spike): compaction, chunked snapshots, awareness and permission enforcement
  - Tiptap editor with the MIT extension set (PRD §5.5): headings, lists, tables, task lists, links, images, mentions
- **Sharing:** roles (owner, editor, commenter, viewer), general access, sharing with groups and channels (PRD §10.1).
- **Comments:** comment threads on text selections, resolve and reopen, and mentions that reach the inbox.
- **Revision history:** hourly and daily versions in R2, named versions, view, compare and restore (TDD §4.3).
- **Search:** title and content in FTS5 via the document text projection (TDD §2.4).
- **Context:**
  - create a document from a conversation, keeping the source link
  - document links in chat show as rich previews
- **Whiteboards:** Excalidraw with an Officebox-maintained Yjs binding.
- **Present mode** (if it wasn't delivered with M4).

**Later:** templates, import from Notion and Google Docs (PRD §19), and offline editing beyond the IndexedDB cache.

**Exit criteria:**
- Two people co-edit and converge.
- A viewer can't edit.
- History restore works.
- A comment mention reaches the inbox.
- Search finds document text and respects permissions.

### M7 — Operations

This grows in parallel with the features above. Items are pulled in when a feature needs them.

- **Health:** the admin health page, the post-deploy checklist and the diagnostics bundle (TDD §6.1, §7.1–7.2).
- **Storage:** monitoring and **protective mode** (TDD §7.7), plus the Trash and purge pipeline and retention jobs (TDD §2.3).
- **Usage panel and telemetry:** the usage and cost panel, and opt-in telemetry (TDD §7.9).
- **Export and restore** with Workflows (TDD §7.5). This needs to exist before the first customer, because it's how they protect and move their data.
- **Upgrades:** the release-sync workflow and update awareness (TDD §6.2–6.7). Deferred for now at your request; it must ship before the first release that someone else installs.

### M8 — Personal Inbox

The Today, Upcoming, Inbox, Assigned to me and Following views (PRD §5.3).
- **Sources:** chat (mentions and DMs), calendar (today's events, reminders, invitations), documents (comments, shares, review requests), and later issues.
- **Behaviour:** snooze, grouping and automatic resolution.

## 5. Definition of done (every slice)

- Schema changes follow expand/contract, and Durable Object schemas carry a version (TDD §6.5).
- Permission checks go through the permission engine, with tests for allowed and denied cases.
- Tests:
  - unit and Workers-runtime integration tests for the server
  - component tests for complex UI
  - at least one Playwright end-to-end test per user-facing flow.
- Accessibility: keyboard-navigable, labelled, and checked with axe in end-to-end tests.
- Audit entries for administrative and destructive actions.
- No secrets in client code. Expected failures are typed results, not thrown errors.
- User-facing behaviour is documented in the app's help and admin guide.
- The `main` Deploy button still works.

## 6. Reusing the spike

| Spike module | Becomes | Changes when promoted |
|---|---|---|
| `auth.ts` | `core/auth`, `features/auth` | Add refresh rotation, password hashing and invitations; move dev login behind a test-only flag |
| `chat-channel.ts`, `projection.ts` | `features/chat` | Typed results; generic outbox from `core`; files and pins events |
| `doc-room.ts` | `features/docs` | Search projection, versions to R2, comment anchors |
| `user-hub.ts`, `presence.ts`, `fanout.ts` | `features/realtime` | Generic fan-out API; tab leader election on the client |
| `huddle-room.ts`, `sfu.ts`, `fake-sfu.ts` | `features/campfire` | Typed results instead of thrown denials; keep the fake SFU for tests |
| `client/screen-share.ts`, `client/probe.ts` | `apps/web/src/features/campfire` | UI around it; keep the media run as a CI job |
| `test/*` helpers | `apps/worker/test` | Unique-ID fixtures (storage isn't isolated between tests) |

When a module has been promoted and its tests pass in the new structure, its spike counterpart is deleted.

## 7. Documentation updates this plan implies

- **PRD:**
  - add a **Calendar** section (§5.x) with the scope in M5
  - move calendar from "ICS feed in Phase 2" to its own phase
  - adopt **Campfire** as the product name for huddles, if confirmed (§8)
  - update the phase lists to match this milestone order.
- **TDD:** add the calendar data model, the ReminderScheduler Durable Object, the holiday dataset, the codebase structure (§2) and the typed-result convention.

## 8. Decisions needed

1. **The name "Campfire."** 37signals sells a group-chat product called *Campfire* (the ONCE product). Using the same name for our calls feature could confuse people, or raise a trademark question. Options:
   - keep "Campfire" after a quick trademark check
   - choose another name, such as "Hearth", "Huddle" or "Lounge"
   - keep "huddles" as the feature name.
2. **Calendar scope for the first release.** Is the M5 **must** list right? In particular: do you want time-off **approvals** in the first release, and how soon do you need two-way Google and Microsoft sync?
3. **Holiday regions.** Which countries matter first? Is a bundled open dataset with no external API acceptable?
4. **Stack.** Confirm Hono, Zod, TanStack Router and Query, and Tailwind with Radix (§2).
5. **Milestone order.** The plan follows your order (auth → chat → Campfire → calendar → documents). Calendar and documents could run in parallel with chat after M2 if you want features sooner.
6. **Upgrades.** Confirm the release-sync upgrade work stays deferred until just before the first external install (M7).

# Officebox — Build Plan

**Status:** Draft for review
**Date:** 14 November 2026
**Inputs:** [PRD](PRD.md) v1.4, [TDD](TDD.md) v1.4, and findings from the realtime spike ([`spikes/realtime`](spikes/realtime/README.md))
**Feature specs:** [Identity & Access](specs/identity.md) · [Chat](specs/chat.md) · [Calls](specs/calls.md) · [Calendar](specs/calendar.md) · [Documents, Whiteboards & Files](specs/documents.md) · [Assistant](specs/assistant.md).
**Cross-cutting specs:** [Permissions](specs/permissions.md) · [Notifications & Attention](specs/notifications.md) · [Platform Rules](specs/platform.md) (lifecycle, cascades, retention, export, settings, limits, timers, schema).

The specs supersede the scope lists in §4 wherever they differ; each spec assigns its features to slices. Working rules are in [AGENTS.md](AGENTS.md).

## 1. Approach

We build a **foundation first** and then add features as **vertical slices** on top of it. Each milestone ships something a team can deploy and use.

- **Foundation before features.** Every feature depends on the same few things: identity and permissions, the realtime backbone, storage conventions and the app shell. Building them once, properly, keeps each feature small.
- **Vertical slices.** A milestone includes its database schema, Durable Objects, API, UI, tests and docs. Nothing is "backend done, UI later".
- **Always deployable.** `main` deploys to a fresh Cloudflare account with the Deploy button at every milestone.
- **Promote the spike, don't copy it.** The spike proved the designs. Production code re-implements them inside the new module structure and applies the spike's findings, most importantly typed RPC results instead of thrown errors (§6).

**Feature order:** authentication → chat → calls → calendar → documents. Other work fits around these (§4).

## 2. Codebase structure

One repository, one deployed Worker (API and Durable Objects), with the React app served through Workers Assets. This follows TDD §1.

```text
officebox/
├── apps/
│   ├── worker/                 Cloudflare Worker + Durable Objects
│   │   ├── src/core/           router, auth middleware, errors/results, ids, db helpers, audit,
│   │   │                       settings, rate limits, cron dispatcher, queues + outbox, DO base class
│   │   ├── src/features/       one folder per feature: routes, Durable Objects, services, jobs
│   │   │   ├── auth/  members/  realtime/  chat/  files/  calls/
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

**Stack** (confirmed, §8).

| Concern | Choice | Why |
|---|---|---|
| Language | TypeScript (strict) everywhere | Already agreed (PRD Appendix A) |
| Worker routing | Hono | Small, Workers-native, typed routes and middleware |
| Validation | Zod schemas in `packages/shared` | One schema validates both the API and the WebSocket messages, and gives client types |
| Frontend | React 19, Vite, TanStack Router, TanStack Query | Typed routing; server-state caching works well with realtime invalidation |
| UI | Tailwind CSS only (no component library for now) | Lightweight; the visual design comes later. Accessibility (WCAG 2.2 AA, PRD §18) is handled in our own components. |
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
| M4 | **Calls** | Channel and DM calls: audio, video, screen sharing, ringing | M3, real-media run passed | L |
| M5 | **Calendar** (M5a–M5c) | Calendars, events, holidays, time off, invitations, reminders, ICS. Event calls land in M5b. | M2, M4 | L |
| M6 | **Documents** (M6a–M6c) | Drives, docs, whiteboards, sharing, comments, history, files, offline. Document calls and present mode land here. | M2, M4 | L |
| M7 | **Operations** | Health, storage protection, usage panel, export/restore, upgrades | M1 (grows alongside) | M |
| M8 | **Personal Inbox** | Today / Upcoming / Assigned / Following views | M3, M5, M6 | M |
| M9 | **Assistant** (M9a–M9d) | Personal assistant with memory, channel mentions, proactive help, push-to-talk, call notes, live voice | M8, M4; voice spike passed (M9c, M9d) | XL (4 slices) |
| Later | Projects and issues · MFA and SSO · imports · API and webhooks | PRD Phase 2 (Phase 3 is M9; AI actions on tasks and issues arrive with projects) | — | — |

Sizes are relative: M ≈ 1×, L ≈ 2×, XL ≈ 3×.

After M2, **chat, calendar and documents are independent** (separate Durable Objects and tables). Two people or agents can build them in parallel. Calls wait for chat and for a passing real-media run. The calendar and document parts of calls ship with M5b and M6.

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
  - `wrangler.jsonc` with the bindings M0 and M1 need; each later milestone adds its bindings and Durable Object migration tags (Vectorize and AI in M9, Workflows in M7, feature DOs and queues with their milestone) (TDD §6.1)
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
- **Foundation spike.** Short, throwaway checks on production Cloudflare, before M1 code depends on them. Each result is recorded in TDD §10. **Answered** in [`spikes/foundation`](spikes/foundation/README.md), and **confirmed in production** by the probe run of 15 November 2026 (PBKDF2 capped at 100k, rate limits approximate, queue delays up to 24 h).
  - **PBKDF2 limit:** answered: production caps at 100k. **No longer used:** sign-in became passwordless on 15 Nov 2026 (Identity §2); the result is kept for the record (TDD §10).
  - **WebAuthn:** answered: `@simplewebauthn/server` runs in Workers (verified end to end locally). M1 uses it through better-auth's passkey plugin.
  - **Rate Limiting binding:** answered: periods are exactly 10 or 60 s, per location and approximate; platform §8 assignments unchanged. *Pending production run* for measured behaviour.
  - **Queue delays:** answered: the maximum `delaySeconds` is 24 hours (platform §11 updated).
  - **PDF preview under `Content-Security-Policy: sandbox`:** answered: Chromium renders it; previews use an iframe without the `sandbox` attribute (TDD §8.3). Firefox and Safari are checked in M6.

**Exit criteria:**
- A fresh Cloudflare account deploys from the button and shows the app shell. `/health` is green.
- CI is green and runs in under 10 minutes.
- A sample Durable Object migrates its schema lazily and survives eviction in a test.

### M1 — Identity and access

**Goal:** a team can set up a workspace, invite people and sign in safely, **without passwords**. Every later permission check runs on this milestone's permission engine.

**Must** (passwordless on better-auth, product-owner decisions of 15 Nov 2026; Identity §2, TDD §8.1):
- **First-run setup** with the setup token, either the deploy secret or a generated token in the logs, and an atomic claim (TDD §6.8). A WebAuthn check runs before the claim; the claim records the **canonical origin**; the owner **registers a passkey during setup** (resumable on another device, expiring after 24 hours); setup recommends a second passkey.
- **better-auth foundation:** `better-auth` and `@better-auth/passkey` pinned to exact versions, on D1, with its tables mapped onto ours and checked-in `NNNN_identity_*` migrations generated with `npx auth generate`; one instance per installation origin, with the relying-party ID, `trustedOrigins` and link origin taken from the canonical origin; the default-deny route allowlist; the token-stripping response filter; server-set markers for account creation; the advisory policy and CI gate (TDD §8.1).
- **Sign-in:**
  - **sign in with a passkey**, user verification required for everyone, with the counter rule (`clone_detected`)
  - **magic links for members only**, through **our confirmation page** (token in the fragment) and a server-side better-auth verify, consumed by our compare-and-set (platform §10)
  - `security_notice` on every passkey addition and on a magic-link sign-in from a new device
  - better-auth database sessions: 30 days sliding, cookie cache off, no refresh tokens or `session_epoch`, no session token reachable by JavaScript
  - sign out, sign out everywhere, and "My devices"; every revocation closes live sockets (from M2, when sockets exist)
- **Invitations:**
  - single-use links that expire after 7 days, roles at invite time
  - **copy link** (no email needed) and **email**
  - accept flow that creates the account and **registers a passkey**; reopening only while the account has no passkey and no session
  - owners need a second passkey or `RECOVERY_TOKEN` before inviting
- **Email:** the adapter interface, with the **Cloudflare Email Service** binding as the default driver, plus HTTP-API drivers (Resend, Postmark, SES) and SMTP over STARTTLS. Includes the queue, retries, DLQ and **Send test email** (TDD §7.6). Magic links need it.
- **Recovery:** recovery links (copy link) for members by admins, and for admins and owners by owners; magic links for members when email is configured; owner recovery through the `RECOVERY_TOKEN` secret. Each registers a new passkey.
- **Email change** with a confirmation link and the `security_notice` sign-in banner.
- **Profiles:** display name, avatar (R2), **time zone**, **working hours** and **location/region** (the calendar needs all three), and status text with an emoji.
- **Roles and groups:** owner, admin and member; admin-managed groups (PRD §10.1).
- **Members administration:** list, invite, change role, disable, delete (anonymise). Content transfer for deleted members arrives with the features that own the content.
- **Permission engine** in `packages/shared` plus Worker services, implementing [specs/permissions.md](specs/permissions.md). It uses the union rule across item, folders, drive and general access, and includes the admin-power limits. Its **matrix test grows per milestone**: M1 covers workspace roles, groups and profiles; channels, calls, calendars and documents are added by their milestones.
- **Only identity objects are created in M1** (users, handles, groups, invitations, sessions, better-auth accounts and verifications, passkeys, settings). `#general` and default channels arrive in M3a, calendars in M5a, and drives and folders in M6a. Each of those milestones provisions its objects with an idempotent backfill for existing people and groups (platform §13).
- **Security:**
  - CSRF header and `Origin` checks against the canonical origin (alongside better-auth's origin check), the CSP and security headers
  - rate limits in our middleware, before better-auth, on magic-link requests (per normalised email and per IP, never extending a victim's window), passkey sign-in, setup, invitations and recovery
  - audit entries for every admin action
  - the deploy step that creates missing secrets (`BETTER_AUTH_SECRET`, `TOKEN_HASH_KEY`) and the `/not-configured` page.

**Must (also):** the "My devices" session list. **Should:** the "allowed email domains" setting for invitations.

**Slices** (product-owner decision, 15 Nov 2026; revised the same day for passwordless sign-in and after review). Each is one branch and PR with its own independent review, built in this order, except M1p, which can be built in parallel:
- **M1a-0 — better-auth spike (time-boxed, throwaway, in `spikes/`):** answers the feasibility list in TDD §10 (v1.7): the D1 adapter with our names, epoch-ms dates and no transactions; in-process magic-link verify, `storeToken: "hashed"` and unknown emails under `disableSignUp`; passkey `requireSession: false` with `resolveUser`, required user verification, and how a hook reads the counter (settling our own clone check versus the library's); hook coverage for user creation, session creation and deletion; the `BETTER_AUTH_SECRETS` format; the `__Host-` cookie prefix; the origin check with our CSRF header and the token-stripping filter; the rate-limit storage interface; `trustedOrigins`, `baseURL` and `rpID` from the installation record; step-up re-authentication without a second session; a second instance for a pending domain move; `nodejs_compat` and bundle size. Each answer is recorded in TDD §10, and any design change lands in the specs before M1a starts.
  - **Go/no-go:** better-auth is a no-go if it fails on D1 without transactions, if `user.create.before` can't be shown to cover every user-creation path, or if no hook (or library error) reliably exposes counter regressions.
  - **Fallback:** keep the hand-built sessions from the M1a branch (PR #17), add passkeys with `@simplewebauthn/server` directly and our own magic links, keep every Identity §4 rule, and **report back to the product owner** before M1a proceeds (TDD §10).
- **M1a — better-auth foundation, setup with a passkey and sessions:**
  - better-auth wired into Hono (`auth.handler`), pinned, configured from the canonical origin, with the default-deny allowlist, the token-stripping filter, mapped tables and generated migrations
  - first-run setup with the setup token and an atomic claim: WebAuthn preflight, canonical origin, **the owner's passkey** (enrolment ticket bound to the challenge, consumed at verify), resume guard and 24-hour expiry
  - **passkey sign-in** with user verification required and the counter rule chosen in M1a-0
  - better-auth sessions (30 days sliding, cookie cache off, primary reads, `session.create.before` status check), sign out, sign out everywhere and "My devices", with socket-revocation hooks wired for M2
  - **step-up** (`fresh_auth_at`, `POST /me/reauth`, the typed `reauth_required`)
  - **signed-in passkey management:** add, rename and remove passkeys, with step-up, the last-passkey rules, labels for how each was created, the owners' second-passkey reminder and the `*.workers.dev` warning. It's here so an owner can meet the M1b invite gate.
  - the **security-notice banner list** (`users.pending_security_notice`) with acknowledgement on a fresh passkey sign-in. **Interim:** notices for passkeys added in M1a are written to the banner list only; email for them starts in M1b.
  - the hourly identity repair job's setup half (complete setup when the owner has a passkey) and one-batch claim expiry
  - CSRF header and canonical `Origin` checks; rate limits in our middleware on setup and passkey sign-in
  - the `/not-configured` page and the deploy step that creates `BETTER_AUTH_SECRET` and `TOKEN_HASH_KEY` if missing
  - the M1a branch's password sign-in, refresh rotation, `session_epoch`, sign-in throttle, slow mode and `PEPPER_1` / `SESSION_SIGNING_KEY` are replaced, not merged
- **M1p — Permission engine core:** the permission engine in `packages/shared` with workspace roles, and the first matrix test. **Why separate:** it is pure shared-package logic with no dependency on better-auth, so taking it out keeps M1a reviewable in one sitting and lets it run in parallel after M0. It must land before M1b, whose invitation rules use it. (Lettered "p" so the other slice letters stay as approved.)
- **M1b — Email, invitations and magic links:**
  - the email adapter (Cloudflare Email Service binding by default; Resend, Postmark, SES and SMTP over STARTTLS as alternatives), its queue, retries and dead-letter queue, and **Send test email**
  - invitations: copy link and email, single-use, 7-day expiry, role at invite time, one pending invitation per normalised email, links built from the canonical origin with the token in the fragment; the owners' gate (second passkey, or `RECOVERY_TOKEN` set and unconsumed) on every owner invite
  - the accept flow: invitation consumed by compare-and-set with an attempt ID, account created through better-auth with the accept marker, handle claimed, the repair job's invitation half (never resurrecting a consumed invitation); the passkey registered; reopening guarded (410)
  - **magic links for members only** through our confirmation page, consumed by our compare-and-set, limited per normalised email and per IP without extending a victim's window
  - **email delivery of security notices** (notifications §9 M1), joining the M1a banner, for passkey additions and new-device magic-link sign-ins
  - the "allowed email domains" setting (Should)
- **M1c — Recovery, passkey management and email change:**
  - recovery links (copy link, step-up to issue, resumable until a passkey is registered), with the notices, owner flag, token revocation and invalidation of other enrolment tickets
  - owner recovery with `RECOVERY_TOKEN` (`recovery_token_uses` rows, constant-time compare, IP limit, notice to the other owners)
  - the **email-change flow** (step-up, confirmation link, notice to the old address, magic links revoked by email)
  - the owner's **two-step domain move** (step-up start, commit by passkey registration on the new origin, 24-hour expiry, old-host redirect, token revocation, notices)
- **M1d — Profiles and directory:**
  - display name, avatar (R2), time zone, working hours, location or region, status text with emoji
  - @handles
  - the member directory
- **M1e — Groups and administration:**
  - admin-managed groups
  - members administration: list, change role (with step-up and the promotion passkey rules), disable, delete (anonymise), sign out all sessions
  - admin-power limits
  - audit coverage for every admin action
  - the full M1 permission matrix (workspace roles, groups, profiles)

**Later:** TOTP MFA; Cloudflare Access SSO (PRD §6); WebAuthn related-origin requests for domain moves.

**Exit criteria:**
- These end-to-end tests pass in Playwright, with passkeys on a **Chromium virtual authenticator** (user verification on) and email through a **test email sink**: setup with a token (registering a passkey), **sign in with a passkey**, invite by link with no email configured (accepting registers a passkey), invite by email, **magic link via the confirmation page**, recovery link, **owner recovery with `RECOVERY_TOKEN`**, email change, disable user, and an expired invitation being refused.
- **Clone detection:** a counter regression is refused as `clone_detected` with no session left behind, and a race between two legitimate sign-ins raises no alert.
- **Concurrent tokens:** two concurrent confirm POSTs with one magic-link token, two concurrent registration verifies with one enrolment ticket, and two concurrent accepts of one invitation each succeed at most once.
- **Session expiry** (injected clock): a session unused for 30 days is rejected and one used on day 29 is extended; a revoked session fails on its next request.
- **Invite gate:** an owner with one passkey and no unconsumed `RECOVERY_TOKEN` is refused on every invite (negative), and succeeds once they add a second passkey or set the secret (positive); a consumed secret no longer satisfies it; an admin can still invite members.
- **Further tests** (Identity §9), each passing:
  - user verification: an assertion or registration without UV is refused
  - the 410 guards on setup resume, invitation reopening and recovery-link reuse
  - setup: claim expiry (one batch, never deleting an owner with a passkey or session) and the WebAuthn preflight
  - magic links refused for owners, admins, unknown, disabled and promoted users, with an identical response
  - auth routes refused on a non-canonical host
  - fragment-token pages and their `Referrer-Policy: no-referrer` and `Cache-Control: no-store` headers
  - CSRF denial on our routes and better-auth's
  - rate limits, including no extension of a flooded email's window
  - the repair job: setup completion, and never releasing an invitation whose attempt ID is on a user (deleted included) or handle
  - the domain move: step-up, commit only by registration on the new origin, expiry, the old-host redirect, token revocation
  - step-up: `reauth_required` for each sensitive action without a fresh passkey assertion
  - banner acknowledgement only on a fresh passkey sign-in
- No response body or log line contains a session token, and the route allowlist holds against path-normalisation tricks.
- Every account-creation path without the setup or accept marker is refused (Identity §9).
- The permission engine passes its M1 matrix test (workspace roles, groups, profiles).

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
- Revoking one session (My devices, sign out everywhere, an admin signing someone out) closes that session's sockets within 5 seconds, and a session that expires on its own loses its sockets at the next UserHub recheck (Identity §4.5, TDD §3.5).
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
- **Editing:** edit and delete messages, with redaction (TDD §2.2), in M3a per Chat §18.
- **Provisioning:** `#general`, default-channel auto-join and the welcome post, with a backfill for members who joined before M3a (platform §13).

**M3b — Rich conversation:**
- **Threads:** a reply pane, "also send to channel", and thread followers.
- **Reactions:** quick reactions and a full emoji picker.
- **Files:**
  - upload through the Worker into R2 (multipart above 50 MB)
  - drag-and-drop and paste
  - image previews and the allow-listed inline types (TDD §8.3)
  - a files tab per channel
- **Pins and saved items:** pinned messages per channel; "saved for later" per user.
- **Mentions:** anyone can use `@channel` / `@here`, with a confirmation in channels over 20 members; links to Officebox objects shown as permission-checked previews.
- **Search:**
  - FTS5 over messages and file names
  - filters `from:`, `in:`, `has:file` and dates
  - jump to a result in context.

**M3c — Notifications and polish:**
- **Notifications:** mention and DM notifications into the inbox and to email, per-channel notification levels and mute, and a "call started" system message slot.
- **Moderation:** channel admins remove messages and manage members; admins archive channels.
- **Keyboard:** quick switcher (Cmd/Ctrl+K) and other keyboard shortcuts.

**Later:**
- scheduled messages and message reminders
- slash commands

(Polls, pins, saved items and external link previews are first-release features. The chat spec assigns them to slices.)
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

### M4 — Calls (huddles)

**Goal:** instant audio-first calls from any channel, DM, document or calendar event, with screen sharing.

**Gate:** the real-media run (`spikes/realtime`, `npm run test:media`) passes on a real Realtime SFU app. If it shows problems, fix the design before building the UI.

**Must:**
- **HuddleRoom Durable Object and Worker signalling,** promoted from the spike. Expected denials become typed results, not thrown errors.
- **SFU integration:** sessions, publish and subscribe, renegotiation, simulcast layers, and TURN credentials.
- **Call UI:**
  - join and leave; mute, camera and raise hand
  - participant tiles and active-speaker highlight
  - device selection and reconnect handling
- **Context indicators:** "Call in progress" in the channel header and sidebar, plus start/end system messages with duration and attendees.
- **Screen sharing (PRD §5.8):**
  - one presenter, with take-over requests
  - text-first quality with a motion mode
  - viewer full screen, picture-in-picture, zoom and pan
  - moderator stop
  - the workspace policy and resolution cap.
- **Present mode** for documents and whiteboards (TDD §4.5). It needs M6's editor, so if M4 ships first, it lands in M6 instead.
- **Mobile:** viewing and audio on mobile browsers; the share control is hidden where screen capture isn't available.

**Moved:** event calls ship with M5b, and document calls and present mode with M6 ([specs/calls.md](specs/calls.md)).

**Later:** call notes, transcripts and live captions arrive with the assistant in M9c ([specs/assistant.md](specs/assistant.md) §12.3–§12.4); recording stays out of scope.

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
  - an optional **call**, so joining the event starts or joins its call (M5b)
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
  - members declare out-of-office periods (vacation, sick, personal, other) with an optional note visible only to them
  - time off appears on their team calendars and shows as an "away until …" status in chat
- **Reminders:** per-event reminders delivered as inbox notifications (and email if the member chose it) with **minute precision**.
- **Notifications:** invitations, updates, cancellations and RSVP responses through the M2 notifications core.
- **ICS feed:** a private, revocable per-member ICS feed URL to subscribe to from Google, Outlook or Apple calendars (PRD §5.3).

**Also must:** subscribing to external ICS calendars (read-only, personal only).

**Should:** an "invite this channel" shortcut.

**Slices:** M5a (calendars, events, recurrence, views, holidays, time off), M5b (invitations and RSVP, external invitations, reminders, find a time, focus time and working location, event calls), M5c (ICS in and out, group view polish). See [specs/calendar.md](specs/calendar.md).

**Gate:** choose the holiday dataset (licence and bundle size) before M5 starts.

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

**Slices:** M6a (drives, folders, document editor, sharing, search), M6b (comments, version history, embeds, export and import), M6c (whiteboards, file versions, offline). Document calls and present mode ship with M6. See [specs/documents.md](specs/documents.md).

**Later:** templates, public links, import from Notion and Google Docs (PRD §19).

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
- **Upcoming** also lists personal reminders once they arrive with M9a ([specs/assistant.md](specs/assistant.md) §7.1).
- **Behaviour:** snooze, grouping and automatic resolution.

### M9 — Assistant

**Spec:** [specs/assistant.md](specs/assistant.md) (Approved). The assistant's display name is an admin setting that defaults to "Butler". It comes after M8, so every data source it reads already exists.

- **M9a: retrieval foundation and text assistant**, delivered as two PRs:
  - **M9a-1 (retrieval foundation):** the Phase 3 ingestion pipeline (TDD §5.2: chunking, embeddings, Vectorize, invalidation), gated on `assistant_enabled` with back-fill; PDF and Office conversion; permission-aware hybrid retrieval (TDD §5.3); `ModelProvider` interface with a test fake; AI Gateway controls verified.
  - **M9a-2 (text assistant):** Assistant DO with conversations, private memory and the source-purge pipeline; "What Butler remembers"; incognito; tools with the confirmation state machine and idempotency keys on target services; personal reminders; admin settings, caps and metadata log; BYOK.
- **M9b: mentions and proactive help.** Audience-safe `@mention` replies in conversations; daily brief, meeting prep and commitment nudges (opt-in).
- **M9c: voice, call notes and captions.** Push-to-talk; call notetaker with banner, mandatory join notice and stop-by-anyone; per-speaker transcripts and notes posted to the call's context; live captions (separate from notes, with an indicator); image and audio files.
- **M9d: live voice.** Spoken conversation over the Realtime SFU.

**Gate:** the voice spike (SFU-to-Durable-Object audio path, streaming speech-to-text, latency, and the memory, CPU and wall time of transcribing 25 tracks; [specs/assistant.md](specs/assistant.md) §19) passes before M9c starts. M9d also needs its latency target met.

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
| `auth.ts` | `core/auth`, `features/auth` | Replace with better-auth (sessions, magic links, passkeys) and add invitations; move dev login behind a test-only flag |
| `chat-channel.ts`, `projection.ts` | `features/chat` | Typed results; generic outbox from `core`; files and pins events |
| `doc-room.ts` | `features/docs` | Search projection, versions to R2, comment anchors |
| `user-hub.ts`, `presence.ts`, `fanout.ts` | `features/realtime` | Generic fan-out API; tab leader election on the client |
| `huddle-room.ts`, `sfu.ts`, `fake-sfu.ts` | `features/calls` | Typed results instead of thrown denials; keep the fake SFU for tests |
| `client/screen-share.ts`, `client/probe.ts` | `apps/web/src/features/calls` | UI around it; keep the media run as a CI job |
| `test/*` helpers | `apps/worker/test` | Unique-ID fixtures (storage isn't isolated between tests) |

When a module has been promoted and its tests pass in the new structure, its spike counterpart is deleted.

## 7. Documentation updates this plan implies

The feature and cross-cutting specs change several PRD and TDD statements. These include: calendar scope, passkeys and magic links at launch, chat attachments, document defaults, the union permission rule, notifications and DND, retention and export of new objects, schema value lists, the socket budget, and timers. Both documents are being brought in line with the specs (see each spec's notes and platform §14). The assistant spec moves personal memory into the first AI release and maps PRD Phase 3 to M9; its §17 lists every PRD, TDD and spec change it made.

## 8. Decisions

Resolved:
1. **Feature names:** generic names ("Chat", "Calls", "Calendar", "Documents") for now. Marketing names come later.
2. **Calendar scope:** time off is declare-only; ICS in and out at launch; two-way Google and Microsoft sync later.
3. **Holiday regions:** all countries, from a bundled dataset. UK & Ireland, US & Canada and EU are verified first.
4. **Stack:** Hono, Zod, TanStack Router and Query, and Tailwind without Radix.
5. **Milestone order:** auth → chat → calls → calendar → documents. Event and document calls ship with their features.
6. **Authentication (15 Nov 2026):** passwordless (passkeys and magic links only) on the better-auth library; M1 slices revised to match (§4 M1, Identity §2).

Open:
7. **Upgrades.** Confirm the release-sync upgrade work stays deferred until just before the first external install (M7).

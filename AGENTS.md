# AGENTS.md — How we build Officebox

These are the working rules for everyone writing code or docs in this repository, people and coding agents alike. Read this file first, then the documents it points to.

## 1. What Officebox is

A self-owned, Cloudflare-native workspace for small teams: chat, calls, calendar, documents and files in one deployment. It runs in the customer's own Cloudflare account and is open source under AGPL-3.0. There are no per-seat fees.

## 2. Source documents

| Document | Answers | Owner of truth for |
|---|---|---|
| [`PRD.md`](PRD.md) | **Why and what**: product promise, principles, scope, phases | Product direction and decisions (Appendix A) |
| [`specs/*.md`](specs/) | **Exactly how a feature behaves**: decisions, rules, data, API, acceptance criteria | Feature behaviour |
| [`TDD.md`](TDD.md) | **How it's built**: architecture, schemas, protocols, security, operations | Technical design |
| [`PLAN.md`](PLAN.md) | **In what order**: milestones, slices, definition of done | Delivery sequence |
| [`spikes/`](spikes/) | **What we proved**: throwaway prototypes and findings | Reference only, never imported |

**Feature specs:**
- [Identity & Access](specs/identity.md)
- [Chat](specs/chat.md)
- [Calls](specs/calls.md)
- [Calendar](specs/calendar.md)
- [Documents, Whiteboards & Files](specs/documents.md)

**When documents disagree:** a spec overrides the PRD on feature detail, and the TDD governs implementation. Don't silently pick one. Flag the conflict in your PR and fix the losing document in the same PR.

## 3. Workflow

### 3.1 Specifying a feature

1. **Grill first.** Before writing a spec, interview the product owner in short rounds of focused, multiple-choice questions. Cover scope, rules, permissions, edge cases, notifications and what's deferred. Recommend an option when there's a sensible default.
2. **Write `specs/<feature>.md`** with this structure: Summary · Decisions (table) · behaviour sections · Data model · API · Acceptance criteria · Later · Open questions.
3. **Mark assumptions.** Anything not explicitly decided is tagged **(default)** so a reviewer can change it.
4. **Status:** `Draft for review` → `Approved` (product owner signs off) → `Implemented` (all acceptance criteria pass). Update the status line as it changes.
5. **Changing an approved spec** needs a PR that updates the Decisions table and says why. If the change alters direction, the PRD and TDD are updated too.

### 3.2 Building a slice

1. **Pick the next slice** from `PLAN.md` (for example M3a). One slice per branch and PR, kept small enough to review in one sitting.
2. **Read** the slice's spec sections and the TDD sections it references. Check `spikes/` for proven patterns and the findings listed in the spike README.
3. **Write a short plan** in the PR description before coding: the spec items covered, the files and modules touched, schema changes, and the tests you'll add.
4. **Build vertically:** migration → Durable Object or service → API → UI → tests → docs, all in the same PR.
5. **Verify** every item in the definition of done (§6). Run the checks locally before opening the PR.
6. **Open the PR** with the template headings: Summary, Spec coverage (with links), Screenshots (UI), Tests, Migrations, Follow-ups. Wait for green CI and review before merging (squash merge).

### 3.3 Branches and commits

- `main` is always deployable through the Deploy to Cloudflare button.
- Branch names: `<type>/<milestone>-<short-name>`, for example `feat/m3a-channels` or `fix/m1-invite-expiry`.
- Commit messages are imperative and describe the change ("Add channel archive"), with a body explaining *why* when it isn't obvious.
- Never force-push a branch someone else is using. Never commit secrets, `.dev.vars` or generated reports.

## 4. Codebase conventions

The structure is set out in `PLAN.md` §2: `apps/worker`, `apps/web`, `packages/shared`, `e2e`.

### 4.1 General

- **TypeScript strict** everywhere. No `any` without a comment explaining why.
- **Validation:** every API body and every WebSocket message is validated with a **Zod schema from `packages/shared`**. Clients and the Worker share the same types.
- **IDs** are ULIDs. **Timestamps** are UTC epoch milliseconds. **Calendar dates** are ISO `YYYY-MM-DD` together with an IANA time zone.
- **Errors:** expected outcomes (not found, forbidden, conflict, validation) are **typed results** (`Result<T, E>`), not exceptions. Only real failures throw. **Never throw expected denials across Durable Object RPC**: the runtime logs them as uncaught exceptions (spike finding).
- **Durable Object RPC types** must be concrete. No `unknown` or `any` fields in return values (spike finding).
- **Permissions:** every read and write of user content goes through the **permission engine**. No ad-hoc access checks in routes.
- **Audit:** administrative and destructive actions write to `audit_log`.

### 4.2 Worker and data

- **HTTP:** Hono routes per feature in `apps/worker/src/features/<feature>/`, with shared middleware from `core/`.
- **Durable Objects:**
  - extend the core DO base class (schema version plus lazy migration, alarm multiplexer, attachment helpers, auto-response keepalive)
  - one alarm per object, shared through named timers
  - follow the hibernation rules in TDD §3.2: no heavy constructor work, and no timers that keep the object awake.
- **D1 migrations** follow **expand/contract** (TDD §6.5). Each file holds one logical change and is safe to re-run, named `NNNN_<feature>_<change>.sql`. Never edit a migration that has been merged.
- **Messages and other derived data:** the Durable Object is the source of truth, and the D1 copy goes through the **outbox** helper (TDD §3.3).
- **Secrets** stay in Worker secrets, never in D1, client code or logs.

### 4.3 Web app

- React, TanStack Router and TanStack Query, styled with **Tailwind only**. No component library until the design system exists; build small accessible components ourselves.
- **Accessibility is not optional:** keyboard operable, labelled controls, visible focus, sufficient contrast, reduced-motion support. axe runs in end-to-end tests.
- The realtime client lives in `apps/web/src/lib/realtime`. Features subscribe through it, never by opening raw WebSockets.

### 4.4 Dependencies

Before adding a dependency, check all of these and note them in the PR:
- **Licence** is compatible with AGPL-3.0 (MIT, BSD, Apache-2.0 and ISC are fine; copyleft or "source-available" licences need product-owner approval).
- It is actively maintained.
- It works in the Workers runtime (for server code).
- It has a reasonable bundle size.
- The version is pinned.

Prefer the platform (WebCrypto, Workers APIs) over a library when the code is small.

## 5. Testing

| Layer | Tool | Expectation |
|---|---|---|
| Unit | Vitest | Pure logic: permissions, recurrence, parsers, reducers |
| Worker integration | Vitest + `@cloudflare/vitest-plugin` (Workers runtime, Miniflare) | Every route and Durable Object behaviour, including denied cases |
| End-to-end | Playwright | At least one test per user-facing flow; axe checks |
| Media | `npm run test:media` (real Realtime SFU) | Before merging changes that affect calls |

Known testing behaviour, learned in the spike:
- **Storage is shared between tests in a file.** Create unique IDs per test (users, channels, documents) instead of fixed fixtures.
- Use `evictDurableObject()` to test hibernation and cold starts, and `runDurableObjectAlarm()` for alarms.
- Install with `npm install --legacy-peer-deps`. npm 10.9 crashes resolving this project's peer dependencies.
- Headless Chromium can capture a fake screen (`--use-fake-ui-for-media-stream`, `--auto-select-desktop-capture-source`), so screen-sharing flows are testable.
- Tests that depend on timing must be stable across three consecutive runs before merging.

## 6. Definition of done (every PR)

- [ ] Behaviour matches the spec. Each acceptance criterion covered by the PR is ticked in the PR description.
- [ ] Permission checks go through the engine, with tests for both allowed and denied cases.
- [ ] Unit, integration and end-to-end tests are added. CI is green.
- [ ] Migrations follow expand/contract; Durable Object schemas are versioned.
- [ ] Accessibility checks pass for new UI.
- [ ] Audit entries exist for admin and destructive actions.
- [ ] No secrets in client code or logs; expected failures are typed results.
- [ ] Docs are updated: the spec status and decisions if behaviour changed, the TDD if design changed, and user-facing help or admin notes.
- [ ] `main` still deploys from the Deploy button.

## 7. Commands

Available once M0 lands; until then, run commands inside `spikes/realtime/`.

```sh
npm install --legacy-peer-deps   # install
npm run dev                      # Worker + web app locally (wrangler dev + Vite)
npm run typecheck                # all workspaces
npm run lint
npm test                         # unit + Worker integration
npm run e2e                      # Playwright end-to-end
npm run test:media               # real-media run (needs Realtime credentials)
```

## 8. Working with the product owner

- **Ask, don't assume, on product decisions.** If something isn't in the spec, ask, or mark your choice **(default)** and call it out in the PR.
- **Recommend.** When asking, propose the option you'd choose and say why.
- **Report honestly.** Say what you verified and how, and what you didn't. A failing test or a skipped step is stated plainly.
- **Feature names are generic for now** ("Chat", "Calls", "Calendar", "Documents"). Marketing names come later; don't invent them in code or UI copy.

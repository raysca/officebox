# Spec: Identity & Access

**Status:** Approved (product owner, 15 Nov 2026). **Revised 15 Nov 2026: passwordless sign-in on better-auth** (product-owner decision; §2 rows marked "changed 15 Nov 2026"). The product owner answered that revision's open questions and two rounds of review findings the same day (§2 rows marked "decided 15 Nov 2026"). **The spec stays Approved; the new rows and items marked (default) await the product owner's review.**
**Revision:** Revised after independent review (14 Nov 2026); updated for the [Assistant](assistant.md) spec (15 Nov 2026: reserved `assistant` handles, reserved non-user senders); updated for the [Admin](admin.md) spec (15 Nov 2026: exports become an owner and admin power, not owner-only; step-up re-authentication for sensitive downloads, now the passkey step-up in §4.5; bulk member tools and member CSV; admin screens defined in Admin §3); revised for passwordless sign-in with better-auth (15 Nov 2026: passwords, password reset and peppers removed); **clarified** during M1p (no decision change): the step-up prose in §2, §4.5, §5 and §9 now matches §5's `fresh_auth_method` column (a magic-link sign-in records `magic_link`; only `passkey` satisfies step-up); **M1a (15 Nov 2026)**: setup with a passkey, passkey sign-in, sessions, My devices, step-up, passkey management and the banner list implemented on better-auth 1.7.15 (no decision change); §5 `passkeys` follows the generated SQL (no `verified_sign_count`); §6 records `POST /setup/resume`'s answers and that rename and remove run as our own conditional SQL (default); acknowledging the banner is the permission engine's `security_notice.ack` step-up action
**Feature name:** Identity & Access (marketing name to be decided later)
**Milestone:** M1 ([PLAN](../PLAN.md)) · **Related:** PRD §6, §10.1; TDD §3.1, §6.8, §8.1; [Permissions](permissions.md), [Platform](platform.md), [Notifications](notifications.md)

Decisions marked **(default)** were not discussed; change them on review.

**Cross-cutting rules:** permissions follow [Permissions](permissions.md); notifications follow [Notifications & Attention](notifications.md); lifecycle, cascades, retention, export, admin settings, limits and timers follow [Platform Rules](platform.md). Those specs win on cross-cutting rules.

## 1. Summary

Identity & Access covers:
- setting up a workspace
- getting people in (invitations and onboarding)
- signing in (passkey or magic link; there are no passwords)
- keeping sessions safe
- describing people (profiles, handles, directory)
- organising them (roles and groups).

The permission engine that every feature relies on is specified in [Permissions](permissions.md). This spec covers people, sign-in and the admin actions on them.

## 2. Decisions

| Topic | Decision |
|---|---|
| Sign-in methods at launch | **Passkeys** for everyone, and **magic links by email for members only**. **No passwords**: no password sign-in, reset or change. **Changed 15 Nov 2026** (product owner) from "email + password, magic link, passkeys": passwords were the main thing to guess, store, pepper, rotate and throttle, and passkeys plus magic links cover every flow without them. |
| Magic links for members only | **Decided 15 Nov 2026** (product owner). **Owners and admins sign in with passkeys only**; no magic link is ever sent to them (the request page answers the same). They recover through another owner's recovery link or `RECOVERY_TOKEN` (§4.6). **Why:** an inbox compromise must not be enough to take over an account that can act on others. |
| Passkey user verification | **Required, for everyone, on every passkey sign-in and every registration, enforced server-side** (`userVerification: "required"` in the options and `requireUserVerification: true` when verifying). *Spike finding (M1a-0, 15 Nov 2026)*: better-auth's passkey plugin can't be configured to require UV; our `afterVerification` hooks refuse an assertion or attestation without it, and an after hook sets `"required"` in the authentication options (TDD §8.1). **Decided 15 Nov 2026** (product owner), replacing "preferred (default)". |
| Security notices for sign-in | A `security_notice` goes to the person on **every passkey addition** (except the first passkey at setup or acceptance) and on **a magic-link sign-in from a new device** (notifications §3). **Decided 15 Nov 2026** (product owner). |
| Security-notice banner | **Every security notice also appears as a banner after sign-in, and stays until it's acknowledged on a fresh passkey sign-in**, so a stolen session can't hide it. Email goes out too when email is configured; the inbox record arrives with M2 (notifications §9). `users.pending_security_notice` is a **list** covering passkey added, new-device magic link, recovery link, email change, owner recovery, domain move and an admin export of the member's data ([Admin](admin.md) §12) (§4.6a). **Decided 15 Nov 2026** (product owner). |
| Step-up for sensitive actions | **A fresh passkey assertion within the last 10 minutes** is required to add or remove a passkey, move the domain, change a role (including promoting someone to admin or owner), issue a recovery link, or change an email address. The session stores a fresh-auth timestamp; without a fresh one the API returns the typed error `reauth_required` and the UI asks for a passkey (§4.5). **Decided 15 Nov 2026** (product owner). |
| Domain move | **Two steps.** (1) An owner starts the move, with step-up, and enters the new origin. (2) The owner opens the new origin and registers a passkey there; **only that registration commits the switch**. Until then the old origin keeps working; a pending move expires after 24 hours **(default)**. Afterwards the old host redirects (302/307, keeping path and fragment, never a cached 301, never echoing a request-supplied host), tokens issued for the old origin are revoked, the other owners get a `security_notice`, and the move is audited. Owner-only (§4.4; permissions §6). **Decided 15 Nov 2026** (product owner). |
| Promotion | **Promoting to admin requires at least one passkey; promoting to owner requires two passkeys, or a `RECOVERY_TOKEN` that is set and not yet consumed.** Both need step-up. A demoted admin regains magic links and keeps their passkeys. **Added 15 Nov 2026** (review). |
| Authentication library | **better-auth** (MIT) for sessions, magic links (`magicLink` plugin) and passkeys (`@better-auth/passkey`, built on SimpleWebAuthn), on D1 through its built-in Kysely adapter ([better-auth docs](https://www.better-auth.com/docs)). It replaces the hand-built sign-in and session design of the M1a slice. Pinned to an exact version, with the advisory policy in TDD §8.1. **Added 15 Nov 2026** (product owner): a maintained library instead of our own session, token and WebAuthn plumbing. |
| Google/Microsoft sign-in | Later. SSO comes through Cloudflare Access in Phase 2 (PRD §6). |
| Two-factor (TOTP) | **After launch** (Phase 2) |
| Passkey-only accounts | **All accounts are passkey-only** (plus magic links for members when email is configured). **Changed 15 Nov 2026** from "allowed for members; owners must keep a password", because there are no passwords. |
| Owners' second passkey | **A reminder, plus one gate.** Setup and the owner's settings ask for a second passkey (for example a phone), and an owner with one sees a reminder. **Before an owner can invite anyone, they need a second passkey or a `RECOVERY_TOKEN` that is set and not yet consumed**, checked on every owner invite; setup itself isn't blocked. **Admins may still invite members when no owner meets the gate** (intended, **default**: the gate protects the owner's own account, not the workspace). **Decided 15 Nov 2026** (product owner). |
| Removing the last passkey | **A member may remove their last passkey if magic links work for them** (email configured and `magic_link_enabled` on). **An owner never can.** An admin can't either, because magic links aren't available to admins. **Decided 15 Nov 2026** (product owner). |
| better-auth admin plugin | **Not used.** No impersonation. Admins act through our permission-checked routes, which call better-auth on the server. **Decided 15 Nov 2026** (product owner). |
| Passkeys in exports | **Exports include passkey public keys**, so a restore onto the **same canonical origin** keeps them working; on another origin they're dropped (platform §6). **Decided 15 Nov 2026** (product owner), replacing "excluded". |
| Passkeys and domains | Passkeys are bound to the workspace's domain (WebAuthn relying-party ID). A domain change or restore elsewhere leaves them unusable; §4.4 covers the warning and recovery. |
| Password hashing | **None: there are no passwords.** No PBKDF2, no pepper secrets, no hash format. **Changed 15 Nov 2026** from "PBKDF2-SHA256, 100k iterations, plus an HMAC pepper". The M0 spike result (100k cap in production) is kept for the record in TDD §10. |
| Who can invite | **Admins invite members. Only owners invite or promote admins.** |
| Admin actions on people | Admins act on **members only**. Recovery links, email changes, disable and delete on **admins or owners need an owner**. Every recovery link or email change **notifies the person** and **revokes their pending magic links and recovery tokens** (permissions §6 Admin powers). Changed 15 Nov 2026: there are no reset tokens. |
| Magic link and email-link consumption | Links open a **confirmation page**; the token is used only by a POST from that page, so mail scanners can't use it up (platform §10 Email links) |
| Magic-link confirmation with better-auth | **The email links to our confirmation page, never to better-auth's verify URL.** better-auth verifies magic links with a GET (`/magic-link/verify`) and doesn't address mail-scanner prefetch, which conflicts with platform §10. So `sendMagicLink({ email, token, url })` ignores `url` and emails a link to our page; the page's POST consumes the token with our compare-and-set and then calls better-auth's verification on the server (`auth.api`). better-auth's GET verify route isn't reachable from outside (§4.4). **Added 15 Nov 2026.** |
| Tokens in links | **Every emailed or copied link carries its token in the URL fragment**, never the path or query: `/sign-in/link#t=…`, `/auth/recover#t=…`, `/invitations/accept#t=…`, `/me/email/confirm#t=…`. The page's script POSTs the token and strips the fragment with `history.replaceState`; these pages send `Referrer-Policy: no-referrer` and `Cache-Control: no-store`. **Added 15 Nov 2026** (review): fragments never reach server logs, proxies or `Referer`. |
| Canonical origin | **At the setup claim, `installation` records the canonical origin and an allowed-hosts list.** This is state written by the workspace, not configuration, so it complies with AGENTS §4.1. The relying-party ID comes from it; auth routes refuse other hosts; every emailed link is built from it, never from the request's `Host`. **A domain change is the owner's two-step move** (below). `allowed_hosts` entries come only from the setup claim's host and from the previous canonical host of each committed move; nothing is fetched server-side to verify a host, so there's no SSRF path. **Added 15 Nov 2026** (review), replacing "derived from the request host". |
| Passkey labels | Each passkey records **how it was created** (setup, invitation, recovery link, magic link, or added while signed in), shown in the passkey list and named in the `security_notice` for that addition. **Added 15 Nov 2026** (review). |
| Default channels | **Public channels only** **(default)** |
| Mentions | **Unique @handles** alongside display names |
| Session length | **30 days, sliding** |
| Session handling | **better-auth database sessions:** one session token in an `HttpOnly`, `Secure`, `SameSite=Lax` cookie (`__Host-` prefixed where better-auth allows); no session token is ever readable by JavaScript or present in a response body; `expiresIn` 30 days, `updateAge` 1 day (sliding); **`cookieCache` off**, so a revoked session stops working on its next request. **No refresh tokens**, so no rotation, reuse detection, grace window or `session_epoch`. "My devices" and "sign out everywhere" use better-auth's list and revoke; revoking also closes live sockets (§4.5). **Changed 15 Nov 2026** from "15-minute access token, rotating refresh token with reuse detection, `session_epoch`": better-auth has no refresh rotation, and with the cookie cache off every request already checks the session row. |
| Member self-service | **See and sign out own devices.** Email change and account deletion are admin actions. |
| Profile fields | Name, @handle, avatar, time zone, working hours, region, **job title, team, pronouns, phone, location/office** |
| Copy-link invites | **The admin enters the invitee's email**, and the link is bound to it |
| After accepting an invite | **Profile setup step → auto-join default channels → welcome post in #general → short welcome tour** |
| Magic link | **Single-use, 15 minutes, works on any device, members only.** better-auth's default lifetime (300 s) is overridden to 15 minutes; `disableSignUp` is on, so a magic link never creates an account. A sign-in from a device not seen before raises a `security_notice`. Needs email: Cloudflare Email Service by default, or another driver (TDD §7.6); without email the option is hidden. **Changed 15 Nov 2026:** now the only email-based sign-in, built on better-auth's `magicLink` plugin. |
| Passkey counter checks | **The M0 spike's rule stays: a counter at or below the stored value, unless both are 0, is refused as `clone_detected`.** better-auth doesn't document it, and SimpleWebAuthn may already reject regressions. The **M1a-0 spike decides** between relying on the library (and alerting on its error path) or keeping our own after-hook check, proven to see regressions (§4.4). **Added 15 Nov 2026**; revised after review. |
| Invite-only sign-up with better-auth | better-auth has no invite-only mode, so **`databaseHooks.user.create.before` refuses any new user unless a server-set marker is present** (the setup claim or our accept context), not merely because a pending invitation exists for that email. Magic links use `disableSignUp`. Tests cover every creation path (§9). **Added 15 Nov 2026**; tightened after review. |
| Passkey relying-party ID | **The canonical origin's host**, read from the installation record (above), never hardcoded, configured or taken from the request. One better-auth instance per installation origin (§4.4). **Changed 15 Nov 2026** (review) from "derived from the request host". |
| First-run setup with a passkey **(default)** | The setup token and atomic claim stay (TDD §6.8). Setup **checks WebAuthn support before the claim**, then creates the owner, records the canonical origin and **registers a passkey immediately**; it's complete only once that passkey exists. The same token resumes registration, on any device, while the owner has no passkey and has never had a session; an incomplete claim expires 24 hours after the claim, in one conditional batch, and the repair job completes setup if the passkey exists but completion didn't run. Setup recommends a second passkey and warns on `*.workers.dev` (§4.1). **Added 15 Nov 2026**; revised after review. |
| A second setup claim while one is open **(default)** | `POST /setup` while a claim is open answers **409**: the same token resumes it (`POST /setup/resume`) instead. A claim whose owner row was never written (a crash mid-claim) is released, so setup can start again, rather than blocking it until the 24-hour expiry. **Added 15 Nov 2026 (M1a).** |
| Workspaces without email **(default)** | Copy-link invitations; accepting registers a passkey. A lost passkey: an admin issues a recovery link (copy link) for members; owners use another owner's recovery link or `RECOVERY_TOKEN`. A domain change is an explicit owner action; afterwards members use a magic link (with email) or a recovery link, and admins and owners a recovery link (§4.4, §4.6). **Added 15 Nov 2026.** |
| Sign-in rate limits **(default)** | **Enforced in our middleware before `auth.handler`**, on atomic D1 `rate_counters` or the Rate Limiting binding; better-auth's own limiter is only a backstop. Magic-link requests limited **per email and per IP**, without letting anyone lock a victim out (§4.4). Emails are normalised (trim, lowercase, NFKC) for lookup, uniqueness and limiter keys. The password throttle, its progressive delays and the M1a "slow mode" are removed: there are no passwords to guess (platform §8). **Changed 15 Nov 2026.** |
| Kept from M1a, unchanged | CSRF (`X-Officebox-Request` plus a same-origin check, alongside better-auth's own origin check), the permission engine, audit entries, the `/not-configured` page, typed results, and the deploy step that creates missing secrets, which now creates `BETTER_AUTH_SECRET` and `TOKEN_HASH_KEY` (no longer `PEPPER_1` or `SESSION_SIGNING_KEY`; platform §16). **Recorded 15 Nov 2026.** |
| Groups | **Admins create groups and appoint group managers**, who manage membership |
| @group mentions | **Yes.** Notifies group members who can see the conversation. |
| Directory | **Everyone sees everyone's contact details**, plus region and working hours |
| Guests | **Phase 2** (the role value is reserved in the schema) |
| What M1 creates | **Only identity objects**: users, handles, groups, invitations, sessions, better-auth's accounts and verifications, passkeys, auth tokens and settings. `channels` and `channel_members` are **not** created in M1. `#general`, default channels and the welcome post arrive in **M3a**; personal, workspace and group calendars in **M5a**; My files, group drives, the Channels drive and channel folders in **M6a**. Each milestone provisions its own objects for existing people and groups with an idempotent backfill job (platform §13 Provisioning and backfill). |
| Admins giving themselves access | An admin **adding themselves** to a group, or **granting themselves** access to a group drive or folder, **needs an owner**. It's audited (permissions §6 Admin powers). |
| Exports | **Owners and admins** run workspace and per-member exports; members can't export their own data. Changed from owner-only by [Admin §2](admin.md), which makes exporting an admin power. |
| Step-up re-authentication | Sensitive downloads (exports, member and audit CSVs) need authentication within the last **10 minutes (default)** ([Admin §11.3](admin.md)). Added by the Admin spec; **merged 15 Nov 2026 into the passwordless step-up** (row "Step-up for sensitive actions" above): one session field, `sessions.fresh_auth_at`, which satisfies step-up only after a passkey assertion (`fresh_auth_method = 'passkey'`, §4.5), and one route, `POST /me/reauth`, replacing Admin's `authenticated_at` and `POST /auth/reauth`. |
| Recovery links without email | Admins may issue them for members, **loudly flagged**: the member sees a notice on the **sign-in page** ("An admin reset your account on …"), and **every owner sees it flagged** on the member list until an owner acknowledges it. |

## 3. Users and roles

| Role | Can |
|---|---|
| **Owner** | Everything an admin can, plus: invite and promote admins; change email, issue recovery links, disable, delete and sign out **admins and owners**; transfer ownership; installation settings (upgrades, email, policies). At least one active owner must exist. |
| **Admin** | Invite **members**; for **members only**: disable, re-enable, delete, change email, issue recovery links, sign out all sessions. Manage groups and group managers (but **adding themselves** to a group needs an owner); set default channels; workspace settings except owner-only ones (platform §7 Admin settings); view the audit log; run and download **workspace and per-member exports** ([Admin §11, §12](admin.md); a per-member export of an admin or owner needs an owner). |
| **Member** | Use the workspace, edit their own profile, manage their own sign-in methods and devices. |
| **Group manager** | A member (or admin) who manages one group's membership. This is a property of group membership, not a workspace role. |
| *Guest* | Phase 2 |

Admins can't read private content they haven't been given access to in the app, and can't add themselves to private channels (permissions §6 Admin powers). Workspace exports, which owners and admins run, do include private content; the privacy statement says so ([Admin §2](admin.md)). The full matrix of who can do what to people and groups is permissions §4.6.

## 4. Functional requirements

### 4.1 First-run setup

- Protected by the setup token: the deploy secret, or a one-time token generated into Workers Logs (TDD §6.8). The claim is atomic, and `/setup` returns 404 afterwards.
- Setup collects the workspace name and the owner's name, **@handle** and email, then **registers a passkey immediately**. There is no password.
  - **WebAuthn preflight before the claim.** The page checks for WebAuthn (`PublicKeyCredential` feature detection) before it submits anything. Without it, setup stops and says "This browser can't create a passkey. Use another device or a security key." **Roaming authenticators** (security keys, a phone over hybrid) are allowed.
  - **The claim** creates the owner and records the workspace's **canonical origin** (the origin setup runs on) and its allowed-hosts list in `installation` (§2, §4.4). The passkey is registered straight after it with a short-lived enrolment ticket (§4.4). Setup is **complete only once the owner has a passkey**.
  - **Resume (default):** while the claimed owner has **zero passkeys and has never had a session**, presenting the same setup token again, **on any device**, resumes registration for that owner; nobody else can claim the workspace. Once the owner has a passkey or a session, resume answers **410 Gone**. In generated-token mode, a token used for the claim stays valid for resume until the claim expires, even past its own 24-hour expiry.
  - **One clock:** the 24-hour window runs from the **claim** (`setup_claimed_at`).
  - **Expiry (default):** an incomplete claim expires **24 hours after the claim**, in **one conditional batch**: the owner row is deleted only if it still has no passkeys, `first_signed_in_at` is NULL and setup isn't complete, and the claim and canonical origin are cleared **only if that delete matched**. So expiry can never remove an owner who registered a passkey or signed in, and can't leave a half-cleared claim. Setup then reopens: with a `SETUP_TOKEN` secret the same secret works again; with a generated token, the next visit generates and logs a new one (TDD §6.8).
  - **Completion** checks that the claim nonce is still the current one, so a late registration can't complete a claim that expired and was re-claimed. The hourly **repair job** completes setup when the owner has a passkey but `setup_completed_at` is still NULL (a completion hook that failed).
  - Setup then **recommends a second passkey** (for example a phone), because an owner with one passkey has only the recovery token to fall back on (§2, §4.6). **Before an owner can invite anyone, they need a second passkey or a set `RECOVERY_TOKEN`** (§2); setup itself isn't blocked.
  - Registering on a `*.workers.dev` host shows the domain warning (§4.4), and the setup checklist adds: **"`workers.dev` usually means no email"**, because the default email driver needs a custom domain on Cloudflare DNS (TDD §7.6). Without email there are no magic links, so a second passkey or `RECOVERY_TOKEN` is the owner's only fallback.
  - Owners never use magic links (§2), with or without email. The owner's ways in are their passkeys, another owner's recovery link and the `RECOVERY_TOKEN` owner-recovery secret.
- **In M1, setup creates only identity objects:** the installation row, the owner's user and handle, and default settings.
- Objects owned by later features are created when those features ship, together with a backfill for workspaces set up earlier (platform §13 Provisioning and backfill):
  - **M3a:** `#general` (the default channel), with the owner as channel admin
  - **M5a:** the workspace calendar and the owner's personal calendar
  - **M6a:** the Channels drive, `#general`'s channel folder and the owner's My files drive.
- **Restore from export** is offered as an alternative path (PRD §13, TDD §7.5).

### 4.2 Invitations

- **Admins invite members; only owners invite admins.** An owner needs a **second passkey, or a `RECOVERY_TOKEN` that is set and not yet consumed**, checked on **every** owner invite (§2); the invite screen says why and links to adding a passkey. Admins may invite members even when no owner meets the gate **(default)**. Each invitation has an **email** (always required), a **role** (member, or admin when sent by an owner) and optional **groups** to join.
- **Delivery:**
  - by email, if email is configured
  - always as a **copy link** that works without email.
- The link is bound to the invitation's email; the invitee can't change it. This also covers PRD §6's "configurable email verification": an account's email is the one an admin invited, and later email changes need confirmation once email is configured (§4.11).
- Invitations are **single-use** and **expire after 7 days** **(default)**. Admins can **resend**, **copy again** (same link while it's valid) and **revoke**.
- Links are built from the **canonical origin**, never the request's host, and carry the token in the fragment (`/invitations/accept#t=…`, §2).
- **One pending invitation per normalised email**, enforced by a unique index (§5).
- Inviting an email that already belongs to an active member is refused. A disabled member is offered "re-enable" instead.
- An optional **allowed email domains** setting restricts who can be invited **(default: off)**.
- The pending invitations list shows email, role, inviter, sent and expiry, and status.

### 4.3 Accepting an invitation and onboarding

The flow runs in this order:

1. **Create the account.** The email is shown and fixed. The invitee enters a display name and **@handle**, suggested from their name, and then **registers a passkey**. This is the same with or without email, so copy-link invites need nothing else.
   - **Reopening (default):** if they leave before registering, they can open the invitation again while it's valid, **only while the account has zero passkeys and has never had a session**. Otherwise the link answers **410 Gone**, so an accepted invitation is never a standing way into the account. When email is configured, a member can also sign in with a magic link and add a passkey later.
   - **The confirm page shows the invited email prominently**, so nobody accepts an invitation meant for someone else.
   - **Order (D1 isn't transactional through the adapter):** the accept POST first **consumes the invitation with a compare-and-set** that records a fresh `accepted_attempt_id`, then creates the user through better-auth (in our accept context, the server-set marker the create hook requires) carrying that attempt ID, then claims the handle with the same attempt ID, and finally records `accepted_by` (the accepted user).
   - **The hourly repair job never resurrects a consumed invitation.** It **releases** one (back to pending) only when **all** of these hold: it was consumed more than 10 minutes ago; it isn't expired or revoked; **no `users` row (deleted users included) and no `handles` row carries that attempt ID**; and the release is a compare-and-set on `accepted_attempt_id`. In every other case it **rolls forward**: it finishes the user, handle and `accepted_by` for that attempt. The member's personal calendar (M5a) and My files drive (M6a) are created by those milestones, at account creation once they exist, and by their backfill for earlier members (platform §13 Provisioning and backfill).
2. **Profile setup.**
   - avatar (optional)
   - **time zone**, pre-filled from the browser
   - **working hours**, default Mon–Fri 09:00–17:00 local
   - **region** for public holidays, pre-filled from the time zone
   - job title, team, pronouns, phone and location (all optional).
3. **Auto-join default channels** (from M3a). Admins choose these from **public channels only** **(default)**; `#general` is always included. Members who joined before chat existed are added by the M3a backfill.
4. **Welcome post** (from M3a, if `welcome_post_enabled`). A system message in `#general`: "*Sam Lee* joined the workspace". The M3a backfill doesn't post welcome messages for earlier members **(default)**.
5. **Welcome tour.** Four or five dismissible tips covering chat, calls, calendar and documents. They can be replayed from Help, and dismissal is stored per member.

An invite opened by someone already signed in as another member shows "You're signed in as X. Sign out to accept."

### 4.4 Sign-in

- **One sign-in page** offering:
  - **Sign in with a passkey.** WebAuthn with discoverable credentials, so no email needs typing. This is the main button.
  - **Email me a sign-in link.** Shown only when email is configured and `magic_link_enabled` is on. Works for **members only** (§2).
- **There are no passwords** (§2). No password field, reset, change or policy exists.
- **Built on better-auth** (§2; TDD §8.1): its `magicLink` and passkey plugins, its database sessions, and its D1 adapter. Only the better-auth endpoints listed in §6 are reachable from outside, matched by **default-deny on the exact normalised method and path**; every other better-auth route, including get-session, email-and-password sign-up and sign-in (disabled in any case), user updates, email change and account deletion, answers 404. Our own routes call better-auth on the server through `auth.api`.
- **Canonical origin** (§2). The setup claim records the canonical origin and allowed hosts in `installation`. Sign-in, registration and every other auth route **answer only on the canonical origin**; other allowed hosts redirect to it, and unknown hosts are refused. The relying-party ID is the canonical host, `rpName` is the workspace name, and every emailed or copied link is built from the canonical origin, never the request's `Host`. There is one better-auth instance per installation origin (TDD §8.1).
- **CORS is never enabled on auth routes** (or any `/api` route): no `Access-Control-Allow-*` headers are sent, so no other origin can read a response.
- **Who may sign in:** active members only. `status = 'system'` rows, disabled and deleted members can't sign in, and see a generic "can't sign in" message. A **`databaseHooks.session.create.before`** refuses to create a session unless the user's status is `active`, so no better-auth path can sign in a disabled member.
- **New accounts only through setup or an invitation.** `databaseHooks.user.create.before` refuses to create a user **unless a server-set marker is present**: the setup claim or our invitation-accept context. A pending invitation for the email isn't enough on its own. Magic links set `disableSignUp`. So no better-auth path, present or added by an upgrade, can create an account on its own (§9 tests every path).
- **Emails are normalised** (trim, lowercase, Unicode NFKC) for lookup, uniqueness and rate-limit keys, with a unique index on the normalised address (§5).
- **Magic links** (better-auth `magicLink` plugin), **members only**:
  - single-use, valid for **15 minutes** (`expiresIn: 900`, overriding better-auth's 300 s), open on **any device**
  - sent only to **active members whose role is `member`**: the `sendMagicLink({ email, token, url })` callback looks the address up and sends nothing to owners, admins, unknown, disabled or `system` addresses
  - **no enumeration:** the request route answers identically for every email, does the **same work** for each (the lookup and a token write run either way; *Spike finding (M1a-0, 15 Nov 2026)*: better-auth does no email lookup on the request, so both are ours, in `sendMagicLink`), and sends mail in `waitUntil`, so the response and its timing don't reveal which emails have accounts
  - **scanner-safe:** the callback doesn't send better-auth's `url` (a GET that signs in). It emails a link to **our confirmation page** with the token in the fragment (`/sign-in/link#t=…`): "Sign in to *Workspace* as **_email_**" → Continue, with the email shown prominently so a link someone else shared (login CSRF) is obvious. Opening it does nothing. The page's script POSTs the token and strips the fragment. better-auth's own GET verify route isn't reachable from outside, so mail scanners and link prefetchers can't sign in or use the token up (platform §10 Email links). The same rule applies to recovery, invitation and email-change confirmation links.
  - **re-checked at consume time:** the confirm POST checks again that the user's role is `member` and status is `active` before consuming, so a member promoted, or disabled, after the link was sent can't use it. A demoted admin becomes a member, so magic links work for them again, and they keep their passkeys.
  - **consumed by our compare-and-set:** the callback also records the token's hash, the normalised email and the user in `magic_link_issues`. The confirm POST marks that row consumed with a compare-and-set (`… WHERE token_hash = ? AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > ?`) and only the winner calls better-auth's verification (`auth.api`). Two concurrent POSTs with one token sign in at most once. Revoking a member's pending links (email change, recovery link) marks their rows revoked by email.
  - **new device:** a magic-link sign-in from a browser without a known-device cookie for that member sends them a `security_notice` (§2) **(default)**. The device cookie is a random ID in an `HttpOnly`, `Secure`, `__Host-` cookie (`Path=/`), **set on every successful sign-in, by passkey or magic link**, and recorded hashed per member in `user_devices`; rows unused for **400 days** are deleted **(default)**.
  - limited per email and per IP in our middleware (below; platform §8).
- **Passkeys** (`@better-auth/passkey`, SimpleWebAuthn underneath):
  - members can register several, each with a name, **how it was created** (setup, invitation, recovery link, magic link, or added while signed in) and a "last used" time; they can rename and remove them (through our routes, which apply the rules below)
  - **every addition sends a `security_notice`** to the person, naming the passkey and how it was created (§2), **except the first passkey at setup or invitation acceptance**, which the person has just made themselves
  - **adding or removing a passkey while signed in needs step-up** (§4.5). Removing a passkey doesn't sign out other sessions, which is why it needs a fresh passkey assertion.
  - **user verification is required** on every sign-in and every registration, for everyone, and **enforced on the server** (`userVerification: "required"` in the options, and verification refuses an assertion or attestation without the UV flag). A security key without a PIN or biometric can't be used.
  - **removing the last passkey:** a **member** may, if magic links work for them (email configured and `magic_link_enabled` on); an **owner** never can; an admin can't either, since magic links don't work for admins (§2)
  - **owners are asked for a second passkey** at setup, on promotion and in their settings, with a reminder while they have one. **An owner can't invite anyone until they have a second passkey or a `RECOVERY_TOKEN` that is set and not yet consumed** (§2).
  - **first passkey without a session.** Setup, invitation acceptance and recovery register a passkey before the person has a session. The plugin's `registration.requireSession: false` and `resolveUser` allow this; `resolveUser` accepts only a valid **enrolment ticket** **(default)**:
    - a single-use, 15-minute token issued by the setup, accept or recovery POST, bound to one user (`auth_tokens.kind = 'passkey_enrol'`)
    - **carried only in an `HttpOnly`, `Secure`, `SameSite=Strict` cookie with the `__Host-` prefix and `Path=/`** (the prefix requires it), never in a JSON body; the passkey registration routes are the only ones that read it
    - **bound to the registration challenge** when the options are generated, and **consumed at registration verify** (not at options) with our compare-and-set; a challenge from another ticket or session is refused
    - using a recovery link (or owner recovery) **invalidates that user's other outstanding tickets**
    - without a session or a valid ticket, registration is refused. Completing registration signs the person in.
  - **clone detection:** the M0 spike's rule applies: a counter **less than or equal to** the stored value (unless both are 0, as with most synced passkeys) is refused as `clone_detected`, no session is left behind, and the member and owners get a `security_notice` (notifications §3). SimpleWebAuthn may already refuse regressions, so **the M1a-0 spike decides** between relying on the library (and raising the notice from its error path) or keeping our own after hook on `verified_sign_count` with a compare-and-set, proven to see regressions (TDD §10). *Spike finding (M1a-0, 15 Nov 2026)*: decided: the library refuses regressions, and our after hook **re-verifies on `AUTHENTICATION_FAILED` to detect clones**; `verified_sign_count` is dropped (TDD §8.1). Either way, **losing a compare-and-set race between two legitimate concurrent sign-ins doesn't raise an owner alert**: that request is refused and retried, and only a real counter regression is `clone_detected`.
  - **origin and relying party:** the expected origin is the canonical origin, and the relying-party ID is its host (above). Tests check that an assertion for another origin or relying-party ID is refused, because a published advisory found origin and user verification unenforced in some versions (TDD §8.1).
- **Passkeys and the domain (relying-party ID):**
  - Passkeys are bound to the canonical origin's host when they're registered.
  - **Changing the workspace's domain** (for example from `*.workers.dev` to a custom domain, PRD §13) or **restoring onto another origin** leaves existing passkeys unusable. A restore onto the **same** canonical origin keeps them, because exports include passkey public keys (§2; platform §6).
  - **Registering a passkey on a `*.workers.dev` domain shows a warning:** "If this workspace moves to a custom domain, you'll need to add this passkey again."
  - **A domain move takes two steps** (§2; owner-only, audited):
    1. **Start.** An owner, with step-up, enters the new origin ("Move workspace to a new address"). It's stored as a **pending move** with a single-use move link for the new origin (`/admin/domain/complete#t=…`), shown to that owner. The old origin keeps working.
    2. **Commit.** The owner opens the move link on the new origin. Its POST sets an enrolment ticket there, and the owner **registers a passkey with the new origin as relying party**. That successful registration is the proof the new origin reaches this Worker and the owner controls it; **only it commits the switch**. Nothing is fetched server-side to verify the host, so there's no SSRF path.
    - A pending move **expires after 24 hours** **(default)**, and the owner can cancel it.
    - **At commit:** the canonical origin becomes the new one; the old host is added to `allowed_hosts`; every session is revoked; magic links, invitations and enrolment tickets issued for the old origin are revoked (admins resend invitations, which the list flags); the other owners get a `security_notice`.
    - **Afterwards,** requests to the old host get a **302 (GET) or 307** redirect to the same path on the canonical origin, with `Cache-Control: no-store`, built from the installation record, **never a 301 and never from a host supplied in the request**; browsers keep the fragment. Auth routes don't answer there.
    - **Recovery:** the committing owner already has a passkey on the new origin. Members sign in there with a **magic link** (when email is configured) or a **recovery link**; admins and other owners get recovery links from an owner. The admin guide for domain changes and restores says so, and the restore flow lists who will need a recovery link (platform §6 Export coverage).
- **Rate limits** are **enforced in our middleware before `auth.handler`**, on atomic D1 `rate_counters` or the Rate Limiting binding; better-auth's own limiter (custom storage on the same counters) is only a backstop. The client IP is `cf-connecting-ip` (IPv6 by /64). Magic-link requests are limited **per normalised email and per IP**; passkey options and verification per IP.
  - **No lockout of a victim:** once an email reaches its limit, further requests inside the window **send no more mail but don't extend the window**, and the response stays identical, so nobody can keep a member from signing in by requesting links for their address.
  - There is no password guessing to slow down, so the password sign-in throttle and its progressive delays (and the "slow mode" drafted in the M1a branch) are gone. Values are in platform §8 Rate limits and quotas.

### 4.5 Sessions

- **better-auth database sessions** (TDD §3.1, §8.1): one session token in an `HttpOnly`, `Secure`, `SameSite=Lax`, host-only cookie with path `/`, using the **`__Host-` prefix** where better-auth's cookie configuration allows (otherwise an Officebox prefix; the M1a-0 spike checks). There are **no access or refresh tokens**, so there is no rotation, reuse detection or grace window.
- **No session token is ever reachable by JavaScript.** better-auth's get-session route isn't exposed; the web app uses `GET /me`. A response filter on the better-auth mount **strips any `token` or session token from every JSON body**, and a required test checks that no response body or log line contains a session token. *Spike finding (M1a-0, 15 Nov 2026)*: a session read can refresh the session and emit a `Set-Cookie` (once a day); every caller of `getSession` forwards it.
- **30-day sliding expiry:** `expiresIn` 30 days, `updateAge` 1 day, so a session used at least once in 30 days stays signed in.
- **`cookieCache` is off.** Every authenticated request reads the session row **from the D1 primary** (or with a Sessions API bookmark, never a stale replica) and checks the user's status, so a revoked session or a disabled member is refused on the **next request**, not after a cache bound. (A published advisory found revoked sessions surviving through the cookie cache; TDD §8.1.)
- **`session_epoch` is removed.** Revoking deletes the session rows themselves, and socket revocation doesn't need an epoch: every socket's attachment carries its session ID, so `closeConnections` targets one session or all of a user's (TDD §3.5).
- **My devices** (this is PRD §6's "login activity visibility"), on better-auth's list and revoke:
  - a list of active sessions showing browser and OS, approximate location if available, created and last-seen times (last seen to within a day, since better-auth refreshes it with the sliding expiry), and which one is the current device. Our route returns these fields and the session ID, never session tokens.
  - **sign out** any session, **sign out all other devices**, or **sign out everywhere** (this device too: better-auth's revoke-all)
  - the device label and approximate location are stored with the session and deleted with it.
- **Revoking closes live sockets.** Every revocation (signing out, a device signed out from My devices, sign out everywhere, an admin signing someone out, disabling a member, using a recovery link) calls `closeConnections` through the UserHub room registry, so sockets close within seconds (TDD §3.5). better-auth's after hooks trigger it for its own sign-out route; our routes trigger it directly.
- **Sessions that expire on their own** also lose their sockets: the UserHub **periodically rechecks** each connected session's row (alarm) and closes sockets whose session is gone **or whose `expires_at` is in the past**. This is also the fallback where better-auth has no session-delete hook (TDD §3.5).
- **Removing a passkey doesn't sign out other sessions** (default), so removal needs step-up (below).
- **Step-up for sensitive actions** (§2). The session stores **`fresh_auth_at`** with **`fresh_auth_method`** (§5). A passkey assertion, at sign-in or by re-authenticating with a passkey while signed in, sets them with method `passkey`; a magic-link sign-in sets them with method `magic_link`. These actions need `fresh_auth_at` within the **last 10 minutes** with method `passkey`:
  - adding or removing a passkey
  - moving the domain (starting the move)
  - changing a role, including promoting someone to admin or owner
  - issuing a recovery link
  - changing someone's email address
  - **sensitive downloads** ([Admin §11.3](admin.md)): an export archive, a per-member export, the member CSV or the audit CSV.

  Without a fresh assertion the API returns the typed error **`reauth_required`**, and the UI asks for a passkey and retries. Re-authentication uses better-auth's passkey authentication through our route, which checks that the assertion belongs to the signed-in user and updates the current session's `fresh_auth_at` (M1a-0 checks how to do this without creating a second session). A magic-link sign-in (`magic_link`) never satisfies step-up, with one exception **(default)**: a member with **no passkeys** may add their first one within 10 minutes of a magic-link sign-in, or they'd have no way back to passkeys. Registering through an enrolment ticket (setup, acceptance, recovery, domain move) needs no step-up, because the ticket is the proof.
- **Re-authentication limits:** `POST /me/reauth` is limited to **5 attempts per 10 minutes per session (default)** (platform §8). Failures are audited (`auth.reauth_failed`, Admin §11.3) and count toward the per-IP passkey sign-in limit; there is no per-account password throttle any more. Admin §11.3's download tokens build on `fresh_auth_at`.
- **Disabling a member** revokes all their sessions and closes all their open connections within seconds (TDD §3.5).
- **CSRF** is unchanged from M1a: state-changing requests, including better-auth's routes, need the `X-Officebox-Request` header and an `Origin` equal to the canonical origin, on top of better-auth's own origin check (TDD §8.2).

### 4.6 Account recovery

There are no passwords to reset, so recovery always means **registering a new passkey**.

- **Members, with email configured:** a member who has lost their passkeys signs in with a **magic link** and adds a new passkey. No admin is involved.
- **Owners and admins never use magic links** (§2). They recover through **another owner's recovery link** or, if every owner is locked out, `RECOVERY_TOKEN`.
- **Recovery links** (members without email, or anyone who can't receive it; always for admins and owners): an **admin or owner issues a one-time recovery link** to copy and share privately.
  - **Admins can issue them for members only. For admins and owners, an owner must issue them** (permissions §6 Admin powers).
  - It is valid for 24 hours **(default)**, built from the canonical origin, with the token in the fragment (`/auth/recover#t=…`).
  - **Issuing one needs step-up** (§4.5).
  - **The confirm page shows the account's email prominently.** It can be **resumed until a passkey is registered**, with the same guards as setup: while the link is valid and no passkey has been registered with it, opening it again issues a new enrolment ticket; afterwards it answers 410.
  - It lets the person **register a new passkey** (through an enrolment ticket, §4.4), **signs out all their existing sessions** and **invalidates their other outstanding enrolment tickets**. Their old passkeys stay listed so they can remove the lost ones **(default)**. The new passkey is **labelled "added with a recovery link"**, and the `security_notice` for it names the passkey.
  - Issuing one **revokes the person's other pending magic links and recovery tokens**.
  - **The person is notified:** an email to their current address (if email is configured), "*Admin Name* issued a recovery link for your account on *date*", and a `security_notice` on the banner list (§4.6a; the inbox record from M2).
  - **Loudly flagged, because without email the member can't be told in advance:**
    - The **sign-in page** shows the notice to that member on their next sign-in attempt, before and after signing in: "An admin reset your account on *date*. If this wasn't expected, contact an owner." This uses `users.pending_security_notice`, so it shows even after the link holder has registered a passkey.
    - **Every owner sees the member flagged** on the member list ("Recovery link issued by *Admin* on *date*") until an owner acknowledges it.
  - Issuing one is audited.
- **All owners locked out:** owner recovery through the `RECOVERY_TOKEN` secret (TDD §8.1). Someone with access to the Cloudflare account sets the secret (**at least 32 characters**); `/recover` then lets them **register a new passkey for one owner** (named by email), once.
  - The secret is compared in constant time and the route is rate-limited per IP.
  - Using it **records the secret's hash as a consumed row** (`recovery_token_uses`, one row per value used), so the same value never works twice; using it again needs a fresh value. "`RECOVERY_TOKEN` set" in the invite and promotion gates means **set and not yet consumed**.
  - It signs out that owner's existing sessions and invalidates their other enrolment tickets, is audited, sends the **other owners** a `security_notice` (notifications §3), and shows a banner to owners until the secret is deleted. This is why owners need a second passkey or a set `RECOVERY_TOKEN` before inviting (§2).
- **Domain change or restore:** as §4.4: the owner's two-step move starts recovery; members use magic links where email is configured; everyone else gets a recovery link; `RECOVERY_TOKEN` if no owner can get in.

### 4.6a Security notices and the banner

- **Kinds:** passkey added (not the first passkey at setup or acceptance), magic-link sign-in from a new device, recovery link issued or used, email changed, owner recovery used (to the other owners), domain moved (to the other owners), and passkey clone detected (notifications §3).
- **Delivery:** each notice is appended to the person's **`users.pending_security_notice` list** and shown as a **banner after sign-in** (and on the sign-in page for the recovery-link notice, §4.6). Email goes out too **when email is configured**. The `security_notice` inbox record arrives with M2 (notifications §9).
- **Acknowledgement:** the banner stays until the person acknowledges it **on a fresh passkey sign-in** (`fresh_auth_at` from a passkey assertion within 10 minutes), so someone holding a stolen session can't dismiss it. A member with no passkeys acknowledges after a fresh magic-link sign-in **(default)**.
- **Interim (M1a):** notices raised in M1a (passkeys added while signed in) are written to the banner list; email delivery starts with M1b (PLAN §4).

### 4.7 Profiles

| Field | Required | Notes |
|---|---|---|
| Display name | Yes | 1–64 characters |
| @handle | Yes | Unique; rules in §4.8 |
| Email | Yes | Changed by admins (members) or owners (admins and owners) only. See §4.11 for notification and token revocation. |
| Avatar | No | PNG, JPEG or WebP only; cropped to a square on the client **(default)**; stored in R2. Initials are shown otherwise. |
| Time zone | Yes | IANA name, pre-filled from the browser |
| Working hours | Yes (defaulted) | Per weekday, start and end times, in the member's time zone |
| Region | Yes (defaulted) | Country and optional subdivision, for public holidays |
| Job title | No | |
| Team | No | Free text **(default)**; see open questions |
| Pronouns | No | Free text, shown next to the name |
| Phone | No | |
| Location / office | No | Free text |
| Status | No | Emoji, text and an optional expiry ("In a meeting until 3 pm"). Time off from the calendar sets an automatic status. |

- **Profile card:** a popover from any avatar or name showing name, handle, pronouns, title, team, local time and working hours, status, and buttons to message and call.

### 4.8 @Handles

- 2–32 characters: lowercase letters, digits, `.`, `_` and `-`. Must start with a letter or digit. Unique ignoring case.
- **One namespace for people and groups.** `@design` can't be both a person and a group.
- Reserved words: `channel`, `here`, `everyone`, `all`, `admin`, `admins`, `owner`, `system`, `officebox`, `assistant`.
- **The assistant's handles** ([Assistant §2, §6](assistant.md)): besides `assistant`, the handle derived from the current assistant display name (`assistant_display_name`, default "Butler", so `butler`) is reserved, as `owner_type = 'reserved'`. The assistant is mentioned by ID, so `@assistant` always works and old mentions follow a rename. **On rename** **(default)**: the new derived handle is reserved if it's free; if a member already holds it, only `@assistant` and the display name in autocomplete are used, and the member keeps their handle. The old derived handle is released after the usual 30-day hold (§4.8).
- **Reserved non-user senders:** `system` and `assistant` appear as message senders (Chat §4.6) but aren't people: they can't sign in, aren't in the directory, aren't assignable roles and don't count as seats.
- Members can change their handle at any time **(default)**. Mentions are stored by user ID, so old messages show the new handle. A released handle can't be claimed by someone else for 30 days **(default)**.

### 4.9 Groups

- Admins create, rename and delete groups. Each group has a **name**, an **@handle**, a description and **managers**.
- **Group managers** add and remove members of their group. Admins can manage any group, but **an admin adding themselves** to a group needs an owner (audited), because it would give them everything shared with the group (permissions §6 Admin powers).
- **Uses:**
  - @group mentions (notify members who can see the conversation)
  - permission grants on **documents, whiteboards, folders, files, drives and calendars**. Groups have **no grants on channels**; "invite this group" to a channel adds its current members individually (permissions §3.3 Principals).
  - group calendars and group drives
  - "invite this group" shortcuts.
- **Group calendar and group drive:** created with each new group once calendar (M5a) and documents (M6a) exist, and backfilled for groups created earlier (platform §13 Provisioning and backfill). Renaming the group renames both.
- **Deleting a group** removes its grants (audited) and handles its calendar and drive as set out in platform §4 Deletion cascades.
- Group managers' membership changes are audited, because they can widen access to everything shared with the group (permissions §5 Containers and inheritance).

### 4.10 Member directory

- **Visible to every member:** name, handle, avatar, title, team, pronouns, email, phone, location, **region**, local time, **working hours**, status and groups.
- Search by name, handle, email, title, team or group, and filter by group.
- Disabled members appear under a **Deactivated** filter. Deleted members appear only as "Former member" in content.

### 4.11 Administration

- **Members:**
  - invite (admins invite members; owners also invite admins)
  - change role (owners only promote or demote admins and owners), **with step-up** (§4.5). **Promoting to admin requires the person to have at least one passkey; promoting to owner requires two passkeys, or a `RECOVERY_TOKEN` that is set and not yet consumed** (§2). Promoting a member revokes their pending magic links, since magic links are for members only; demoting an admin to member gives magic links back and keeps their passkeys.
  - disable and re-enable; delete (anonymise, PRD §10.2); change email; issue a recovery link; sign out all sessions (better-auth's revoke-all for that user, called by our permission-checked route; better-auth's admin plugin isn't used, decided 15 Nov 2026, §2).

  **Admins can do these for members only; for admins and owners, an owner must act** (permissions §6 Admin powers). What disabling and deleting do in each feature is set out in platform §3 Member lifecycle.
- **Bulk tools** ([Admin §5](admin.md)), following the same per-member rules:
  - **CSV invite** with a preview of every row before anything is sent ([Admin §5.1](admin.md))
  - **bulk group changes**: add to or remove from a group ([Admin §5.2](admin.md))
  - **bulk disable**, confirmed by typing the count, never including the actor or the last owner ([Admin §5.3](admin.md)). There is no bulk delete **(default)**.
- **Member CSV download** of the filtered member list, with step-up re-authentication (§4.5) and audited ([Admin §5.4](admin.md)).
- **Email change:**
  - **Needs step-up** (§4.5).
  - When email is configured, the new address must be confirmed before it takes effect. The pending address (normalised) is held in an `email_change` token's payload. The link (`/me/email/confirm#t=…`, built from the canonical origin) opens a confirmation page, and only its POST applies the change (platform §10 Email links).
  - The **old address is notified**: "Your Officebox email was changed to *new* by *Admin Name* on *date*". The person also gets a `security_notice` on the banner list (`pending_security_notice`, §4.6a; the inbox record from M2).
  - **All pending magic links and recovery tokens are revoked:** `magic_link_issues` rows for the old normalised email and `auth_tokens` rows for the user are marked revoked, so the matching better-auth verifications can never be consumed (§4.4). Email changes go through our route, never better-auth's change-email endpoint, which isn't exposed.
  - It's audited.
- **Ownership:** transfer it, or add more owners. The last owner can't be demoted, disabled or deleted.
- **Default channels:** choose which **public** channels new members join **(default)**.
- **Policies:**
  - allowed invite domains
  - whether magic-link sign-in is enabled (default on when email is configured).

  The minimum password length setting is removed, because there are no passwords.
- **Domain move:** owners only, in two steps with step-up (§4.4).
- **Audit log** entries for:
  - setup (claim, completion, expiry), invitations, role changes (including promotions), disable and delete
  - email changes, recovery links, ownership changes
  - **passkey added and removed**, **domain move** (start, commit, cancel, expiry), **owner recovery**
  - group changes and policy changes.

  The full list of admin settings and who may change each one is in platform §7 Admin settings.

## 5. Data model (additions to TDD §2.1)

These columns and tables are part of the **baseline migrations for M1**, not later `ALTER`s (platform §14 Schema reconciliation). They're written as `ALTER`s here only to show what changes from TDD §2.1.

**Baseline constraint changes:**
- `users.role` value list: `owner`, `admin`, `member`, `guest` (guest reserved, not assignable until Phase 2; permissions §9 Data model)
- `invitations.email` is **NOT NULL** in the baseline table (TDD §2.1 marks it optional)
- `invitations.role` allows `admin` only when the inviter is an owner (enforced by the API).
- **Reserved sender rows:** `messages.sender_id` references `users(id)`, so `system` and `assistant` exist as reserved `users` rows with `status = 'system'` (a new value in the `users.status` list), excluded from the directory, seats and sign-in **(default)** (TDD §2.1; [Assistant §17](assistant.md)).

**better-auth tables, mapped onto ours** (changed 15 Nov 2026; platform §14). better-auth needs `user`, `session`, `account`, `verification` and `passkey` tables (and optionally `rateLimit`, which we don't use: our limiter storage is `rate_counters`). They are mapped with better-auth's `modelName` and `fields` options, so our names, snake_case columns and conventions stay:

| better-auth model | Our table | Mapping |
|---|---|---|
| `user` | `users` (core, TDD §2.1) | `name` → `display_name`, `emailVerified` → `email_verified`, `image` → `avatar_key` (written only by our profile API). `role`, `status` (including `system`), `handle`, `email_normalised`, `first_signed_in_at` and the profile columns are `additionalFields` with **`input: false`**, so no better-auth endpoint can set them. |
| `session` | `sessions` (core, TDD §2.1) | `userId` → `user_id`, `expiresAt` → `expires_at`, `ipAddress` → `ip_address`, `userAgent` → `user_agent`; `device_label` and `approx_location` are `additionalFields`, set in `databaseHooks.session.create.before`. |
| `account` | `auth_accounts` (new) | Required by better-auth. Passkey and magic-link sign-in keep no secrets here; the `password` column stays NULL and is never written. |
| `verification` | `auth_verifications` (new) | better-auth's short-lived values: magic-link tokens and WebAuthn challenges. |
| `passkey` | `passkeys` | `credentialID` → `credential_id`, `publicKey` → `public_key`, `counter` → `sign_count`, `userId` → `user_id`; our `created_via` (with a DB default, set by our after hook) and `last_used_at` are added fields. (`verified_sign_count` was dropped after the M1a-0 spike: the library refuses counter regressions and our after hook re-verifies refused assertions, §4.4.) |

- **IDs are ULIDs** (`advanced.database.generateId`). Timestamps are epoch milliseconds where the adapter allows; whether better-auth's D1 adapter can store its dates as epoch milliseconds is checked in the M1a-0 spike, and any exception is recorded in platform §14 (§11). *Spike finding (M1a-0, 15 Nov 2026)*: the adapter stores ISO text by default; an **epoch-ms Kysely plugin** (our own Kysely instance passed to better-auth) is required, so no exception is needed (TDD §8.1).
- **Migrations** are SQL generated with `npx auth generate` from the same configuration, edited to these names, and checked in as expand-only feature migrations (`NNNN_identity_<change>.sql`, safe to re-run). better-auth's runtime `getMigrations` is never used, so every schema change goes through our migration discipline (TDD §6.5) **(default)**. A better-auth upgrade that changes its schema gets a new generated, reviewed migration.

**Handles:** the `handles` table is **authoritative**. `users.handle` and `groups.handle` are denormalised copies, updated in the **same transaction** as the `handles` row on create, rename and release.

```sql
-- users: extend
ALTER TABLE users ADD COLUMN handle TEXT;                  -- copy of the authoritative handles row (lowercase)
ALTER TABLE users ADD COLUMN avatar_key TEXT;              -- R2 key
ALTER TABLE users ADD COLUMN timezone TEXT NOT NULL DEFAULT 'UTC';
ALTER TABLE users ADD COLUMN working_hours TEXT;           -- JSON: { mon: [["09:00","17:00"]], ... }
ALTER TABLE users ADD COLUMN region TEXT;                  -- ISO 3166-1/-2, e.g. "GB-ENG", "US-CA"
ALTER TABLE users ADD COLUMN job_title TEXT;
ALTER TABLE users ADD COLUMN team TEXT;
ALTER TABLE users ADD COLUMN pronouns TEXT;
ALTER TABLE users ADD COLUMN phone TEXT;
ALTER TABLE users ADD COLUMN location TEXT;
ALTER TABLE users ADD COLUMN status_emoji TEXT;
ALTER TABLE users ADD COLUMN status_text TEXT;
ALTER TABLE users ADD COLUMN status_expires_at INTEGER;
ALTER TABLE users ADD COLUMN onboarded_at INTEGER;
ALTER TABLE users ADD COLUMN tour_dismissed_at INTEGER;

CREATE TABLE handles (                                     -- one namespace for people and groups
  handle TEXT PRIMARY KEY,                                 -- lowercase
  owner_type TEXT NOT NULL CHECK (owner_type IN ('user', 'group', 'reserved')),
  owner_id TEXT,
  released_at INTEGER,                                     -- held for 30 days after a change
  created_attempt_id TEXT                                  -- the invitation accept attempt that claimed it (repair job, §4.3)
);

CREATE TABLE passkeys (                                    -- better-auth `passkey` model, mapped
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE,                      -- base64url
  public_key TEXT NOT NULL,                                -- COSE key, base64url
  sign_count INTEGER NOT NULL DEFAULT 0,                   -- better-auth's counter
  created_via TEXT NOT NULL DEFAULT 'signed_in',           -- setup | invitation | recovery_link | owner_recovery | magic_link | signed_in (Zod); spike finding (M1a-0, 15 Nov 2026): needs a DB default, since better-auth inserts the row; our after hook sets the real value
  device_type TEXT NOT NULL,                               -- better-auth requires it
  backed_up INTEGER NOT NULL,
  transports TEXT,                                         -- comma-separated, as better-auth stores them
  aaguid TEXT,
  name TEXT,
  created_at INTEGER,                                      -- better-auth leaves it nullable
  last_used_at INTEGER
);
-- Columns follow the better-auth version pinned in M1a; the generated SQL is the source
-- (apps/worker/migrations/0013_identity_passkeys.sql).

CREATE TABLE auth_accounts (                               -- better-auth `account` model; no secrets stored
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  password TEXT,                                           -- always NULL: email and password is disabled
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
  -- plus better-auth's OAuth token columns, unused until SSO (Phase 2)
);

CREATE TABLE auth_verifications (                          -- better-auth `verification` model
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,                                -- magic-link token or challenge key
  value TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE auth_tokens (                                 -- our own tokens: recovery links, email changes, enrolment tickets
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                                      -- recovery | email_change | passkey_enrol (Zod-validated)
  issued_by TEXT REFERENCES users(id),                     -- admin or owner, for recovery links and email changes
  payload TEXT,                                            -- JSON; email_change: { "newEmail": "..." }; passkey_enrol: { "via": "...", "challengeId": "..." }
  expires_at INTEGER NOT NULL,
  used_at INTEGER,                                         -- set by compare-and-set: UPDATE … WHERE token_hash = ? AND used_at IS NULL
  revoked_at INTEGER,                                      -- e.g. other enrolment tickets after a recovery link is used
  created_at INTEGER NOT NULL
);

CREATE TABLE magic_link_issues (                           -- ours, beside better-auth's verification row (§4.4)
  token_hash TEXT PRIMARY KEY,                             -- HMAC(TOKEN_HASH_KEY, token)
  email_normalised TEXT NOT NULL,                          -- for revocation on email change or recovery
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,                                     -- compare-and-set by the confirm POST
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX magic_link_issues_email ON magic_link_issues(email_normalised);

CREATE TABLE user_devices (                                -- known browsers, for "magic-link sign-in from a new device" (default)
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_hash TEXT NOT NULL,                               -- HMAC(TOKEN_HASH_KEY, device cookie value)
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, device_hash)
);

-- invitations: (email NOT NULL is in the baseline table); add groups
ALTER TABLE invitations ADD COLUMN group_ids TEXT;         -- JSON array

-- security notices for admin-initiated actions (one mechanism: this banner + the security_notice inbox item)
ALTER TABLE users ADD COLUMN pending_security_notice TEXT; -- JSON array of notices (kind, at, details); banner until acknowledged on a fresh passkey sign-in (§4.6a)
ALTER TABLE users ADD COLUMN admin_reset_at INTEGER;        -- recovery link issued without email: flagged to owners
ALTER TABLE users ADD COLUMN admin_reset_by TEXT;
ALTER TABLE users ADD COLUMN admin_reset_acknowledged_by TEXT;

-- groups: add handle and managers
ALTER TABLE groups ADD COLUMN handle TEXT;               -- copy of the authoritative handles row
ALTER TABLE group_members ADD COLUMN role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('manager', 'member'));

-- users: better-auth's emailVerified (no password_hash, no session_epoch: TDD §2.1)
ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN email_normalised TEXT;        -- trim, lowercase, NFKC; NULL only once deleted
CREATE UNIQUE INDEX users_email_normalised ON users(email_normalised) WHERE email_normalised IS NOT NULL;
ALTER TABLE users ADD COLUMN first_signed_in_at INTEGER;   -- set by the first session; gates setup resume and invitation reopening (§4.1, §4.3)
ALTER TABLE users ADD COLUMN created_attempt_id TEXT;    -- the invitation accept attempt that created the user (repair job, §4.3)
ALTER TABLE invitations ADD COLUMN email_normalised TEXT NOT NULL;
ALTER TABLE invitations ADD COLUMN accepted_attempt_id TEXT; -- set by the accept compare-and-set; accepted_by holds the accepted user
CREATE UNIQUE INDEX invitations_pending_email ON invitations(email_normalised)
  WHERE accepted_at IS NULL AND accepted_attempt_id IS NULL AND revoked_at IS NULL;  -- one pending invitation per email (expired ones are revoked on re-invite)
-- handles carry the same attempt ID while an accept is in flight: handles.created_attempt_id

CREATE TABLE recovery_token_uses (                         -- RECOVERY_TOKEN values already used (§4.6)
  token_hash TEXT PRIMARY KEY,                             -- HMAC(TOKEN_HASH_KEY, secret)
  owner_id TEXT REFERENCES users(id),
  used_at INTEGER NOT NULL
);

-- sessions: device info for "My devices" (better-auth additionalFields)
ALTER TABLE sessions ADD COLUMN device_label TEXT;         -- e.g. "Chrome on macOS"
ALTER TABLE sessions ADD COLUMN approx_location TEXT;      -- from request.cf (city/country), if available; deleted with the session
ALTER TABLE sessions ADD COLUMN fresh_auth_at INTEGER;      -- last fresh authentication on this session; step-up needs method 'passkey' (§4.5)
ALTER TABLE sessions ADD COLUMN fresh_auth_method TEXT;     -- passkey | magic_link (only a passkey satisfies step-up, §4.5)
```

`sessions.fresh_auth_at` is the step-up field that [Admin §16](admin.md) calls `sessions.authenticated_at`: one column, which satisfies step-up only when `fresh_auth_method` is `passkey` (§4.5). It's in M1's baseline.

The canonical origin and allowed hosts are core columns of `installation` (TDD §2.1), written at the setup claim and by the owner's domain move.

Settings keys (defined in platform §7 Admin settings): `default_channels`, `welcome_post_enabled`, `allowed_invite_domains`, `magic_link_enabled`. (`min_password_length` is removed.)

## 6. API (summary)

Paths are relative to the Worker's `/api` prefix (for example `POST /api/setup`). Changed 15 Nov 2026: password routes are removed, and sign-in, sessions and passkeys run on better-auth.

**better-auth routes, mounted at `/auth/*`** (Hono passes them to `auth.handler(c.req.raw)`). Only these are reachable from outside, on the canonical origin only; the allowlist is **default-deny on the exact normalised method and path** (tests cover `//`, a trailing slash, case, `%2e` and other encoded segments, and `HEAD`/`OPTIONS`). Every other better-auth route answers 404. CORS is never enabled. Exact paths follow the pinned better-auth version. Each one passes our CSRF and rate-limit middleware first, and a response filter strips any session token from JSON bodies (§4.5).

| Method and path | Who | Purpose |
|---|---|---|
| `POST /auth/sign-out` | Session | Sign out this session; an after hook closes its sockets |
| `POST /auth/sign-in/magic-link` | Public | Request a magic link. Same response and work for every email; sends only to active members with role `member` (`disableSignUp`) |
| `GET /auth/passkey/generate-authenticate-options` · `POST /auth/passkey/verify-authentication` | Public | WebAuthn sign-in, user verification required (§4.4) |
| `GET /auth/passkey/generate-register-options` · `POST /auth/passkey/verify-registration` | Session, or enrolment ticket cookie | Register a passkey (user verification required): a signed-in member adding one, or the first passkey after setup, accepting an invitation or recovery (`resolveUser` accepts only an enrolment ticket bound to the challenge, consumed at verify) |

*Spike finding (M1a-0, 15 Nov 2026)*: the passkey route names and methods above are better-auth 1.7.15's. The two options routes are **GETs with side effects** (a challenge cookie and a verification row), so they need our `X-Officebox-Request` header too. The registration verify body's `createSession` flag is forced on for enrolment-ticket registrations and stripped when a session exists.

**Not exposed**, called only on the server through `auth.api` by our routes: **get-session** (the web app uses `GET /me`), magic-link verify (better-auth's GET), list sessions, revoke a session, revoke other sessions, revoke all sessions, list, rename and delete passkeys. **Blocked:** email-and-password sign-up and sign-in (also disabled), update user, change email, delete user, and any route a plugin or upgrade adds until it's reviewed.

**Link pages** (web app routes, not API): `/sign-in/link#t=…`, `/auth/recover#t=…`, `/invitations/accept#t=…`, `/me/email/confirm#t=…`, `/admin/domain/complete#t=…`. The token is only ever in the fragment; the page's script POSTs it to the route below and strips the fragment with `history.replaceState`. These pages are served with `Referrer-Policy: no-referrer` and `Cache-Control: no-store`, and a GET of them changes nothing (platform §10).

**Our routes.** The two under `/auth/` (`ws-ticket` and `recover`) are registered ahead of the better-auth mount, so better-auth never sees them. Tokens travel in JSON bodies, never in paths or query strings.

| Method and path | Who | Purpose |
|---|---|---|
| `POST /setup` | Setup token | Claim the workspace, record the canonical origin and create the owner (workspace name, owner's name, @handle, email); sets an enrolment ticket cookie for the first passkey. The page checks WebAuthn support first (§4.1). |
| `POST /setup/resume` | Setup token | A new enrolment ticket for the claimed owner, only while they have **zero passkeys and have never had a session**; otherwise **410**. With no open claim it answers 410 too; after setup completes, 404 like `/setup`. A second `POST /setup` while a claim is open answers **409** (resume instead) **(default, M1a)**. |
| `GET /me` | Member | Current user: profile, role, preferences summary, pending security notice, passkey count. Never includes a session token. |
| `POST /sign-in/link` `{ token }` | Public (magic-link token) | The confirmation page's POST: consumes the token with our compare-and-set, then calls better-auth's magic-link verification through `auth.api` and returns its session cookie |
| `POST /auth/ws-ticket` | Member | One-time WebSocket ticket for non-browser clients (realtime API, TDD §3.1; listed here for completeness) |
| `GET /me/sessions` · `DELETE /me/sessions/:id` · `POST /me/sessions/sign-out-others` · `POST /me/sessions/sign-out-everywhere` | Member | My devices, on better-auth's list and revoke; never returns session tokens; each revocation closes the matching sockets |
| `GET /me/passkeys` · `PATCH /me/passkeys/:id` · `DELETE /me/passkeys/:id` | Member; removal needs **step-up** | List (with how each was created), rename and remove **own** passkeys; removal applies the last-passkey rules (§4.4) and checks ownership itself. Adding one while signed in uses better-auth's registration routes, also behind step-up. Rename and remove run as **our own SQL** after the permission engine allows them, not better-auth's update and delete endpoints **(default, M1a)**: the remove is one conditional `DELETE … WHERE (SELECT count(*) …) > 1`, so two concurrent removals can never take the last passkey, which better-auth's unconditional delete can't guarantee. Another member's passkey answers 404. |
| `GET/PATCH /me/profile` · `PUT /me/avatar` · `PUT /me/status` | Member | Profile and status |
| `POST /auth/recover/lookup` `{ token }` · `POST /auth/recover` `{ token }` | Recovery link | Show the account email, then use the link: signs out existing sessions, invalidates other enrolment tickets and sets a new one. Resumable until a passkey is registered with it; then **410**. |
| `POST /recover` | `RECOVERY_TOKEN` secret | Owner recovery: an enrolment ticket for one owner; the secret's hash is then recorded as consumed (§4.6) |
| `POST /me/email/confirm` `{ token }` | Public | Confirm an email change |
| `POST /invitations/lookup` `{ token }` · `POST /invitations/accept` `{ token, name, handle }` | Public | Show and accept an invitation. Accepting consumes it by compare-and-set, creates the account through better-auth in our accept context (so its hooks run) and sets an enrolment ticket cookie. Reopening an accepted invitation works only while the account has zero passkeys and has never had a session; otherwise **410**. |
| `GET/POST /admin/invitations` · `POST …/:id/resend` · `DELETE …/:id` | Admin; an owner must meet the gate (second passkey, or `RECOVERY_TOKEN` set and unconsumed) on every invite | Manage invitations |
| `GET /members` · `GET /members/:id` | Member | Directory |
| `PATCH /admin/members/:id` (role, email, status) · `POST …/:id/recovery-link` · `POST …/:id/sign-out` · `DELETE …/:id` | Admin (members only); owner (admins and owners); role changes, email changes and recovery links need **step-up** | Administer members; promotion checks the passkey rules (§4.11); sign-out revokes all their sessions and closes their sockets |
| `POST /admin/members/:id/acknowledge-reset` | Owner | Clear the owners' "recovery link issued" flag |
| `POST /admin/domain` `{ origin }` · `DELETE /admin/domain/pending` | Owner, **step-up** | Start a domain move (stores the pending move and returns the move link for the new origin), or cancel it (§4.4) |
| `POST /admin/domain/complete` `{ token }` | Move link (on the new origin) | Sets an enrolment ticket for the new origin; the passkey registration that follows **commits** the move (§4.4). The page is `/admin/domain/complete#t=…`. |
| `POST /me/reauth/options` · `POST /me/reauth` | Member | Step-up: a passkey assertion for the signed-in user that sets the current session's `fresh_auth_at` (§4.5) |
| `GET /me/security-notices` · `POST /me/security-notices/ack` | Member; ack needs a fresh passkey sign-in | The banner list, and acknowledging it (§4.6a) |
| `GET/POST /groups` · `PATCH/DELETE /groups/:id` · `PUT/DELETE /groups/:id/members/:userId` | Admin / manager (an admin adding themselves needs an owner) | Groups |
| `GET /handles/:handle/available` | Member | Handle check |
| Bulk tools, member CSV, exports | Admin (as [Admin §17](admin.md)) | Defined in [Admin §17](admin.md) |

Shared error codes gain **`reauth_required`**, returned by sensitive actions and downloads that need step-up re-authentication (§4.5; [Admin §11.3, §16](admin.md)).

**Removed 15 Nov 2026:** `POST /auth/password`, `POST /auth/refresh`, `POST /auth/forgot`, `GET/POST /auth/reset/:token`, `PUT /me/password`, our own `POST /auth/passkey/options` and `/verify`, and `POST /me/passkeys/options` · `POST /me/passkeys` (now better-auth's passkey routes). Token-in-path routes (`/auth/recover/:token`, `/invitations/:token`, `/me/email/confirm/:token`) became fragment pages plus body POSTs after review.

## 7. Screens

1. Setup (WebAuthn check, token, then owner and workspace, then register a passkey, then "add a second passkey"; the checklist notes "`workers.dev` usually means no email")
2. Sign in (passkey button first; "email me a sign-in link" for members when email is configured)
3. Magic link "check your email" page and the "Sign in as *email*" confirmation page
4. Accept invitation, then register a passkey, then profile setup, then the tour
5. Recovery link and owner recovery (register a new passkey)
6. Profile settings: profile, status, passkeys (how each was created, the `*.workers.dev` warning and the owners' second-passkey reminder), my devices
7. Member directory and profile card
8. Admin: the admin area's pages are defined in [Admin §3](admin.md); this spec adds the owners' second-passkey gate on Invitations and "Move workspace to a new address" (owners)

## 8. Edge cases

- **An invitation accepted twice.** Only the first succeeds, enforced with a compare-and-set.
- **An invited email that becomes a member another way.** The pending invitation is revoked automatically.
- **Last sign-in method.** Removing the last passkey is blocked with an explanation, unless the person is a member and magic links work for them; owners and admins always keep one (§4.4).
- **Invitee leaves before registering a passkey.** The account exists with no passkey and no session. Reopening the invitation link while it's valid issues a new enrolment ticket for the same account; once the account has a passkey or has had a session, the link answers 410. A member can also use a magic link when email is configured, or get a recovery link.
- **A partial accept** (invitation consumed, user or handle not written). The idempotent repair job completes it or releases the invitation (§4.3).
- **A sensitive action without a fresh passkey assertion.** The API returns `reauth_required`; the UI asks for a passkey and retries (§4.5).
- **A stolen session tries to hide a security notice.** It can't: acknowledging needs a fresh passkey sign-in (§4.6a).
- **An owner promoting someone who has too few passkeys.** Refused with the rule (§4.11).
- **A claim expiring while the owner registers.** The expiry batch deletes nothing once a passkey exists, and completion checks the claim nonce, so the owner is never deleted mid-registration and a stale registration can't complete a newer claim (§4.1).
- **A consumed invitation whose user was later deleted.** The repair job sees the attempt ID on the deleted user and rolls forward; it never releases the invitation (§4.3).
- **A domain move that's never committed.** The old origin keeps working, and the pending move expires after 24 hours (§4.4).
- **Owner leaves setup before registering a passkey.** The same setup token resumes registration for the same owner, on any device, until they have a passkey or a session; an incomplete claim expires after 24 hours and setup reopens (§4.1).
- **A browser without WebAuthn at setup.** Setup stops before the claim and suggests another device or a security key (§4.1).
- **Lost device with an active session.** The member signs it out from another device, or an admin signs out all their sessions. The sockets close within seconds.
- **Lost all passkeys.** Members: a magic link when email is configured, otherwise a recovery link. Admins and owners: another owner's recovery link, or `RECOVERY_TOKEN` (§4.6).
- **Owner or admin requests a magic link.** The response is the same as for anyone; no email is sent (§2).
- **Someone floods magic-link requests for a member's address.** After the per-email limit no more mail is sent, but the window isn't extended, so the member's own request works once it passes (§4.4).
- **A shared magic link** (login CSRF). The confirmation page shows the email prominently, so signing in as someone else is obvious; the sign-in also raises a new-device `security_notice` for that account.
- **A request on a non-canonical host.** Auth routes refuse it; other allowed hosts redirect to the canonical origin (§4.4).
- **Handle collision during onboarding** (two people choosing the same handle at once). A unique constraint resolves it, and the loser is asked to pick another.
- **Two emails differing only in case or Unicode form.** They normalise to one address, so the second invitation or account is refused (§5).
- **Email not configured.** The magic-link option is hidden; invitations are copy-link only; recovery is done with recovery links and `RECOVERY_TOKEN`.
- **Time zone changes** (someone travels). The browser offers "Update your time zone to Europe/Berlin?" **(default)**.
- **Domain change.** Only through the owner's two-step move; at commit, passkeys and tokens for the old origin stop working, the old host redirects, and recovery starts (§4.4).
- **Restore.** Onto the same canonical origin, exported passkeys keep working. Onto another origin they're dropped, and members use magic links while everyone else gets recovery links.
- **A magic link opened by a mail scanner.** The GET shows the confirmation page and changes nothing; the token stays usable for the member's own click.
- **Two confirm POSTs with one magic-link or enrolment token.** Our compare-and-set lets exactly one through.
- **A better-auth route that would create a user** (for example a magic-link verify for an unknown email, or a route added by an upgrade). `databaseHooks.user.create.before` refuses it without the setup or accept marker.
- **A session for a disabled member** (any better-auth path). `databaseHooks.session.create.before` refuses it.
- **A cloned passkey.** The counter rule refuses the sign-in as `clone_detected`, leaves no session, and sends a `security_notice` (§4.4). Two legitimate concurrent sign-ins that race don't raise it.
- **A session that expires while sockets are open.** The UserHub's periodic recheck closes them (§4.5).
- **`RECOVERY_TOKEN` used twice.** The second use is refused; a fresh value is needed (§4.6).
- **Admin acting on an admin or owner.** The action is refused with "An owner must do this."
- **Email changed while a magic link is outstanding.** The old link no longer works (pending magic links revoked).
- **Recovery link issued with no email configured.** The member sees the notice on the sign-in page; owners see the flag on the member list until acknowledged.

## 9. Acceptance criteria

- **Setup (M1):** a fresh deploy can't be claimed without the token. Setup creates the owner (with handle) and default settings, and nothing that belongs to later milestones. The owner registers a passkey during setup and is then signed in; setup isn't complete until they have one. The same token resumes registration for the same owner only, on another device too, and answers 410 once the owner has a passkey or a session; an incomplete claim expires after 24 hours. A browser without WebAuthn is stopped before the claim. The claim records the canonical origin. Setup asks for a second passkey.
- **Provisioning (later milestones):** M3a, M5a and M6a each have a test that a workspace set up before them gets its `#general` and default-channel memberships, calendars, and drives and folders from the backfill, and that running the backfill twice changes nothing.
- **Invitations:**
  - link and email invitations both work end to end, including when email isn't configured
  - expired, revoked and used invitations are refused
  - members can't invite; admins can invite members but **not** admins; owners can invite admins
  - an owner with one passkey and no unconsumed `RECOVERY_TOKEN` can't invite (checked on every invite, including after the secret is consumed); with a second passkey or an unconsumed secret, they can; an admin can invite members either way
  - a second pending invitation for the same normalised email is refused
  - reopening an accepted invitation after the account has a passkey or a session answers 410
  - invitation links carry the token only in the fragment and are built from the canonical origin, whatever host the admin used.
- **Sign-in:**
  - sign in with a passkey, and magic link sign-in through the confirmation page, each work end to end (Playwright: a Chromium virtual authenticator, and a test email sink)
  - opening a magic, recovery, invitation or email-change link with GET doesn't use the token; only the confirmation POST does. better-auth's GET magic-link verify route answers 404 from outside.
  - link pages carry the token only in the fragment, strip it after reading, and are served with `Referrer-Policy: no-referrer` and `Cache-Control: no-store`
  - a magic link expires after 15 minutes and can't be used twice; **two concurrent confirm POSTs with one token sign in at most once**
  - the magic-link request response and its work are identical for members, owners, admins, unknown, disabled and `system` emails, and only active members with role `member` receive an email
  - a magic-link sign-in from a new device sends a `security_notice`; one from a known device doesn't; the device cookie is set on passkey sign-ins too
  - a confirm POST for a member who was promoted or disabled after the link was sent is refused
  - no auth route sends CORS headers
  - better-auth's get-session, email-and-password routes, update-user, change-email and delete-user answer 404; the allowlist holds against `//`, a trailing slash, case changes, `%2e` and other encoded segments, and `HEAD` and `OPTIONS`
  - **no response body or log line contains a session token** (required test)
  - registering a passkey on a `*.workers.dev` host shows the domain warning
  - an assertion or registration **without user verification is refused**
  - a passkey assertion whose counter is lower than, or equal to, a non-zero stored value is rejected as `clone_detected` and leaves no session; an authenticator that always reports 0 still signs in; two legitimate concurrent sign-ins don't raise a clone alert
  - an assertion made for another origin or relying-party ID is refused
  - auth routes on a host other than the canonical origin are refused; the relying-party ID and emailed links come from the canonical origin even when the request's `Host` differs
  - a session can't be created for a disabled member through any better-auth path.
- **Account creation paths** (each tested): setup and invitation acceptance create accounts; a magic-link verify for an unknown email, a passkey registration without a session or enrolment ticket, and a direct call of any better-auth user-creating API **without the setup or accept marker** (even with a pending invitation for that email) are all refused by `databaseHooks.user.create.before`. Partial accepts are repaired by the repair job.
- **Passkeys:**
  - a member can add, rename and remove passkeys; the list shows how each was created; every addition sends a `security_notice` naming it
  - removing the last passkey is refused unless the person is a member and magic links work for them; an owner's or admin's last passkey can't be removed
  - an owner with one passkey sees the second-passkey reminder
  - a member can't remove or rename another member's passkey, through our routes or better-auth's (which aren't exposed).
- **Enrolment tickets:** a ticket travels only in its cookie, is bound to the registration challenge, registers one passkey for its own user only, is consumed at verify (not at options), once, within 15 minutes; two concurrent verifies with one ticket register at most one passkey; using a recovery link invalidates the user's other tickets; registration without a session or a ticket is refused.
- **Sessions** (tested with an injected clock):
  - a session unused for 30 days is rejected; one used on day 29 is extended
  - the session cookie is `HttpOnly`, `Secure` and `SameSite=Lax` (and `__Host-` prefixed if the M1a-0 spike confirms better-auth allows it)
  - "sign out" for a single session, for all other devices and everywhere works, and the revoked session's next request fails at once (no cookie cache, primary reads)
  - each revocation closes that session's open sockets within 5 seconds; a session whose `expires_at` has passed loses its sockets at the UserHub's next recheck, even if its row still exists (socket checks run from M2, when sockets exist; PLAN M2 exit criteria)
  - "My devices" never returns a session token
  - step-up is satisfied only by a passkey assertion (sign-in or `POST /me/reauth`, recorded as `fresh_auth_method = 'passkey'`); a magic-link sign-in records `magic_link`, which counts only for a passkeyless member's first passkey (§4.5) and banner acknowledgement (§4.6a); the sliding expiry changes neither; failed step-ups are audited and count toward the per-IP passkey limit (the download step-up criteria are in [Admin §18](admin.md))
  - disabling a member closes their open connections within 5 seconds (from M2), and their next REST request fails.
- **CSRF:** a state-changing request to our routes or to better-auth's without `X-Officebox-Request`, or with an `Origin` other than the canonical origin, is refused.
- **Rate limits:** the limits in platform §8 for magic-link requests (per email and per IP), passkey sign-in, setup, recovery and invitation acceptance are enforced by our middleware before better-auth and return `rate_limited` at the threshold; unknown emails count the same as real ones; repeated requests for one email inside the window send no more mail and **don't extend the window**; emails differing only in case or Unicode form share one key.
- **Admin powers:**
  - an admin can disable, delete, change the email of and issue a recovery link for a **member**
  - the same actions on an **admin or owner** return 403 for an admin and succeed for an owner
  - the last owner can't be demoted, disabled or deleted.
- **Notifications of admin actions:**
  - issuing a recovery link or changing an email sends an email to the person's **old** address (when email is configured)
  - it adds a `security_notice` to the banner list (and, from M2, an inbox item)
  - with email **not** configured, the recovery notice appears on the sign-in page for that member, and the member is flagged to every owner until acknowledged
  - it revokes their pending magic links and recovery tokens, which then fail.
- **Recovery link flow:** issuing needs step-up; the link shows the account email, lets the member register a new passkey, signs out all their existing sessions (closing their sockets), can be reopened until a passkey is registered with it, and then answers 410.
- **Owner recovery:** with `RECOVERY_TOKEN` set (at least 32 characters), `/recover` registers a new passkey for one owner once; the same value is refused afterwards (its hash is recorded as consumed) and a fresh value works; without the secret it answers 404; the comparison is constant-time and the route is rate-limited per IP; the other owners get a `security_notice`; it's audited and shows a banner until the secret is deleted.
- **Domain move:** only owners with step-up can start one; the old origin keeps working until the owner registers a passkey on the new origin, which commits it; a pending move expires after 24 hours; after commit the old host answers 302/307 to the same path on the canonical origin (never 301, never a request-supplied host, `no-store`), old-origin magic links, invitations and enrolment tickets fail, every session is revoked, the other owners get a `security_notice`, and each step is audited.
- **Step-up:** adding or removing a passkey, starting a domain move, changing a role, promoting, issuing a recovery link and changing an email each return `reauth_required` when the session's last passkey assertion is older than 10 minutes, and succeed after re-authenticating; a magic-link sign-in doesn't satisfy it, except for a member with no passkeys adding their first.
- **Security-notice banner:** every notice kind in §4.6a is added to the banner list and, with email configured, emailed; the banner can't be acknowledged without a fresh passkey sign-in; the first passkey at setup or acceptance raises no notice.
- **Promotion:** promoting a user with no passkey to admin, or with one passkey and no unconsumed `RECOVERY_TOKEN` to owner, is refused; with the required passkeys (or the secret) it succeeds.
- **Setup expiry and repair:** an expired claim whose owner has a passkey or a session isn't deleted; an expired claim with neither is deleted and the claim cleared in one batch; a completion with a stale nonce is refused; the repair job completes setup when the owner has a passkey but completion didn't run.
- **Invitation repair:** the repair job releases a consumed invitation only after 10 minutes, when it's unexpired and unrevoked and no user (deleted included) or handle carries its attempt ID, by compare-and-set; otherwise it rolls forward; a deleted user's invitation is never released.
- **Directory:** search by name, handle, email, title, team and group returns the right members; the Deactivated filter lists disabled members only; region and working hours are shown.
- **Handles:** handles are unique across people and groups; reserved words (including `assistant` and the handle derived from the assistant display name) are refused; a released handle can't be claimed by someone else for 30 days.
- **Reserved senders:** the `system` and `assistant` rows never appear in the directory or member counts and can't sign in.
- **Groups:**
  - group managers can manage only their own groups
  - an admin adding themselves to a group gets 403; an owner adding an admin, or the admin with an owner's approval, succeeds and is audited
  - @group mentions notify only members who can see the message (from M3a).
- **Email change:** opening the confirmation link with GET doesn't change the email; the POST does, and only once; the old address's pending magic links then fail.
- **Export and restore:** exported passkeys keep working after a restore onto the same canonical origin, and are dropped onto another (platform §6).
- **`GET /me`** returns the signed-in member and any pending security notice.
- **Audit:** every admin action in §4.11 writes an audit entry with actor, target and time.

## 10. Later

TOTP two-factor (less needed with passkeys; revisit) · **WebAuthn related-origin requests**, so passkeys can survive a domain move · Google/Microsoft or SSO sign-in · guests · member self-service email change or account deletion · custom roles. (Member self-export is not planned: exports are an admin power, [Admin §2](admin.md).)

## 11. Open questions

1. **Team field.** Free text, or chosen from the member's groups (a "primary group")? The second keeps the directory consistent.
2. **Allowed invite domains.** Off by default, or on and set to the owner's domain at setup?
3. **Welcome post wording and channel.** Always `#general`, or configurable?
4. ~~**WebAuthn library and PBKDF2 limit.**~~ Answered by the M0 foundation spike ([foundation spike](../spikes/foundation/README.md)): `@simplewebauthn/server` runs in Workers (better-auth's passkey plugin uses it); the PBKDF2 result no longer applies, since there are no passwords.
Answered by the product owner on 15 Nov 2026 and recorded in §2: owners' second passkey (a reminder, plus the gate before inviting), removing the last passkey (members if magic links work; owners never), the admin plugin (not used), passkeys in exports (included), user verification (required) and magic links (members only, with security notices).

Also answered on 15 Nov 2026 (§2): step-up for sensitive actions, the two-step domain move, and the security-notice banner.

**Technical, to settle in the M1a-0 spike (TDD §10):** how step-up re-authentication uses better-auth's passkey authentication without creating a second session; the D1 adapter with our names and epoch-ms dates and no transactions; in-process magic-link verify returning cookie headers, `storeToken: "hashed"`, and the request route for unknown emails under `disableSignUp`; whether passkey verify with `requireSession: false` creates a session and how a hook reads the counter (and so whether we keep our own clone check); whether `user.create.before` covers every creation path and whether a session-delete hook exists; the `BETTER_AUTH_SECRETS` format; the `__Host-` cookie prefix; the origin check with our CSRF header and the token-stripping filter; the rate-limit storage interface; `trustedOrigins`, `baseURL` and `rpID` per installation.

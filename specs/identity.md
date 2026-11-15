# Spec: Identity & Access

**Status:** Approved (product owner, 15 Nov 2026). **Revised 15 Nov 2026: passwordless sign-in on better-auth** (product-owner decision; §2 rows marked "changed 15 Nov 2026"). The new **(default)** items in that revision await the product owner's review.
**Revision:** Revised after independent review (14 Nov 2026); updated for the [Assistant](assistant.md) spec (15 Nov 2026: reserved `assistant` handles, reserved non-user senders); revised for passwordless sign-in with better-auth (15 Nov 2026: passwords, password reset and peppers removed)
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
| Sign-in methods at launch | **Passkeys** and **magic links by email** only. **No passwords**: no password sign-in, reset or change. **Changed 15 Nov 2026** (product owner) from "email + password, magic link, passkeys": passwords were the main thing to guess, store, pepper, rotate and throttle, and passkeys plus magic links cover every flow without them. |
| Authentication library | **better-auth** (MIT) for sessions, magic links (`magicLink` plugin) and passkeys (`@better-auth/passkey`, built on SimpleWebAuthn), on D1 through its built-in Kysely adapter ([better-auth docs](https://www.better-auth.com/docs)). It replaces the hand-built sign-in and session design of the M1a slice. Pinned to an exact version, with the advisory policy in TDD §8.1. **Added 15 Nov 2026** (product owner): a maintained library instead of our own session, token and WebAuthn plumbing. |
| Google/Microsoft sign-in | Later. SSO comes through Cloudflare Access in Phase 2 (PRD §6). |
| Two-factor (TOTP) | **After launch** (Phase 2) |
| Passkey-only accounts | **All accounts are passkey-only** (plus magic links when email is configured). **Owners need two passkeys or the recovery token:** setup and the owner's settings ask for a second passkey (for example a phone), and an owner with only one sees a reminder until they add one **(default)**; the `RECOVERY_TOKEN` secret is the fallback (§4.6). **Changed 15 Nov 2026** from "allowed for members; owners must keep a password", because there are no passwords. |
| Passkeys and domains | Passkeys are bound to the workspace's domain (WebAuthn relying-party ID). A domain change or restore elsewhere leaves them unusable; §4.4 covers the warning and recovery. |
| Password hashing | **None: there are no passwords.** No PBKDF2, no pepper secrets, no hash format. **Changed 15 Nov 2026** from "PBKDF2-SHA256, 100k iterations, plus an HMAC pepper". The M0 spike result (100k cap in production) is kept for the record in TDD §10. |
| Who can invite | **Admins invite members. Only owners invite or promote admins.** |
| Admin actions on people | Admins act on **members only**. Recovery links, email changes, disable and delete on **admins or owners need an owner**. Every recovery link or email change **notifies the person** and **revokes their pending magic links and recovery tokens** (permissions §6 Admin powers). Changed 15 Nov 2026: there are no reset tokens. |
| Magic link and email-link consumption | Links open a **confirmation page**; the token is used only by a POST from that page, so mail scanners can't use it up (platform §10 Email links) |
| Magic-link confirmation with better-auth | **The email links to our confirmation page, never to better-auth's verify URL.** better-auth verifies magic links with a GET (`/magic-link/verify`) and doesn't address mail-scanner prefetch, which conflicts with platform §10. So `sendMagicLink({ email, token, url })` ignores `url` and emails a link to our page; the page's POST calls better-auth's verification on the server (`auth.api`), and better-auth's GET verify route isn't reachable from outside (§4.4). **Added 15 Nov 2026.** |
| Default channels | **Public channels only** **(default)** |
| Mentions | **Unique @handles** alongside display names |
| Session length | **30 days, sliding** |
| Session handling | **better-auth database sessions:** one session token in an `HttpOnly`, `Secure`, `SameSite=Lax` cookie; `expiresIn` 30 days, `updateAge` 1 day (sliding); **`cookieCache` off**, so a revoked session stops working on its next request. **No refresh tokens**, so no rotation, reuse detection, grace window or `session_epoch`. "My devices" and "sign out everywhere" use better-auth's list and revoke; revoking also closes live sockets (§4.5). **Changed 15 Nov 2026** from "15-minute access token, rotating refresh token with reuse detection, `session_epoch`": better-auth has no refresh rotation, and with the cookie cache off every request already checks the session row. |
| Member self-service | **See and sign out own devices.** Email change and account deletion are admin actions. |
| Profile fields | Name, @handle, avatar, time zone, working hours, region, **job title, team, pronouns, phone, location/office** |
| Copy-link invites | **The admin enters the invitee's email**, and the link is bound to it |
| After accepting an invite | **Profile setup step → auto-join default channels → welcome post in #general → short welcome tour** |
| Magic link | **Single-use, 15 minutes, works on any device.** better-auth's default lifetime (300 s) is overridden to 15 minutes; `disableSignUp` is on, so a magic link never creates an account. Needs email: Cloudflare Email Service by default, or another driver (TDD §7.6); without email the option is hidden. **Changed 15 Nov 2026:** now the only email-based sign-in, built on better-auth's `magicLink` plugin. |
| Passkey counter checks | **Our own check, on top of the library.** better-auth doesn't document counter-regression or clone detection, so after it verifies an assertion we compare the counter ourselves: a counter at or below the stored value, unless both are 0, is refused as `clone_detected` (the M0 spike's rule), and our stored value advances with compare-and-set (§4.4). **Added 15 Nov 2026.** |
| Invite-only sign-up with better-auth | better-auth has no invite-only mode, so **`databaseHooks.user.create.before` refuses any new user without a valid invitation** (or the setup claim), and magic links use `disableSignUp`. Tests cover every creation path (§9). **Added 15 Nov 2026.** |
| Passkey relying-party ID | **Derived from the request host** for each deployment, never hardcoded or configured (AGENTS §4.1): the better-auth instance is built per host (§4.4). **Added 15 Nov 2026.** |
| First-run setup with a passkey **(default)** | The setup token and atomic claim stay (TDD §6.8). Setup creates the owner and **registers a passkey immediately**; it's complete only once that passkey exists, and the same token resumes registration until then. Setup recommends a second passkey and warns on `*.workers.dev` (§4.1). **Added 15 Nov 2026.** |
| Workspaces without email **(default)** | Copy-link invitations; accepting registers a passkey. A lost passkey: an admin issues a recovery link (copy link) for members; owners use another owner's recovery link or `RECOVERY_TOKEN`. A domain change: everyone needs a recovery link or, with email, a magic link (§4.6). **Added 15 Nov 2026.** |
| Sign-in rate limits **(default)** | better-auth's limiter with custom storage on our counters (D1 `rate_counters` or the Rate Limiting binding). Magic-link requests limited **per email and per IP**. The password throttle, its progressive delays and the M1a "slow mode" are removed: there are no passwords to guess (platform §8). **Changed 15 Nov 2026.** |
| Kept from M1a, unchanged | CSRF (`X-Officebox-Request` plus a same-origin check, alongside better-auth's own origin check), the permission engine, audit entries, the `/not-configured` page, typed results, and the deploy step that creates missing secrets, which now creates `BETTER_AUTH_SECRET` and `TOKEN_HASH_KEY` (no longer `PEPPER_1` or `SESSION_SIGNING_KEY`; platform §16). **Recorded 15 Nov 2026.** |
| Groups | **Admins create groups and appoint group managers**, who manage membership |
| @group mentions | **Yes.** Notifies group members who can see the conversation. |
| Directory | **Everyone sees everyone's contact details**, plus region and working hours |
| Guests | **Phase 2** (the role value is reserved in the schema) |
| What M1 creates | **Only identity objects**: users, handles, groups, invitations, sessions, better-auth's accounts and verifications, passkeys, auth tokens and settings. `channels` and `channel_members` are **not** created in M1. `#general`, default channels and the welcome post arrive in **M3a**; personal, workspace and group calendars in **M5a**; My files, group drives, the Channels drive and channel folders in **M6a**. Each milestone provisions its own objects for existing people and groups with an idempotent backfill job (platform §13 Provisioning and backfill). |
| Admins giving themselves access | An admin **adding themselves** to a group, or **granting themselves** access to a group drive or folder, **needs an owner**. It's audited (permissions §6 Admin powers). |
| Recovery links without email | Admins may issue them for members, **loudly flagged**: the member sees a notice on the **sign-in page** ("An admin reset your account on …"), and **every owner sees it flagged** on the member list until an owner acknowledges it. |

## 3. Users and roles

| Role | Can |
|---|---|
| **Owner** | Everything an admin can, plus: invite and promote admins; change email, issue recovery links, disable, delete and sign out **admins and owners**; transfer ownership; installation settings (upgrades, export, email, policies). At least one active owner must exist. |
| **Admin** | Invite **members**; for **members only**: disable, re-enable, delete, change email, issue recovery links, sign out all sessions. Manage groups and group managers (but **adding themselves** to a group needs an owner); set default channels; workspace settings except owner-only ones (platform §7 Admin settings); view the audit log. |
| **Member** | Use the workspace, edit their own profile, manage their own sign-in methods and devices. |
| **Group manager** | A member (or admin) who manages one group's membership. This is a property of group membership, not a workspace role. |
| *Guest* | Phase 2 |

Admins can't read private content they haven't been given access to, and can't add themselves to private channels (permissions §6 Admin powers). The full matrix of who can do what to people and groups is permissions §4.6.

## 4. Functional requirements

### 4.1 First-run setup

- Protected by the setup token: the deploy secret, or a one-time token generated into Workers Logs (TDD §6.8). The claim is atomic, and `/setup` returns 404 afterwards.
- Setup collects the workspace name and the owner's name, **@handle** and email, then **registers a passkey immediately**. There is no password.
  - The claim creates the owner; the passkey is registered straight after it with a short-lived enrolment ticket (§4.4). Setup is **complete only once the owner has a passkey**. If the owner leaves before registering one, presenting the same setup token again resumes registration for the same owner; nobody else can claim the workspace **(default)**.
  - Setup then **recommends a second passkey** (for example a phone), because an owner with one passkey and no email has only the recovery token to fall back on (§2, §4.6).
  - Registering on a `*.workers.dev` host shows the domain warning (§4.4).
  - **If email is configured later**, the owner can also use magic links. Until then, the owner's only ways in are their passkeys and the `RECOVERY_TOKEN` owner-recovery secret.
- **In M1, setup creates only identity objects:** the installation row, the owner's user and handle, and default settings.
- Objects owned by later features are created when those features ship, together with a backfill for workspaces set up earlier (platform §13 Provisioning and backfill):
  - **M3a:** `#general` (the default channel), with the owner as channel admin
  - **M5a:** the workspace calendar and the owner's personal calendar
  - **M6a:** the Channels drive, `#general`'s channel folder and the owner's My files drive.
- **Restore from export** is offered as an alternative path (PRD §13, TDD §7.5).

### 4.2 Invitations

- **Admins invite members; only owners invite admins.** Each invitation has an **email** (always required), a **role** (member, or admin when sent by an owner) and optional **groups** to join.
- **Delivery:**
  - by email, if email is configured
  - always as a **copy link** that works without email.
- The link is bound to the invitation's email; the invitee can't change it. This also covers PRD §6's "configurable email verification": an account's email is the one an admin invited, and later email changes need confirmation once email is configured (§4.11).
- Invitations are **single-use** and **expire after 7 days** **(default)**. Admins can **resend**, **copy again** (same link while it's valid) and **revoke**.
- Inviting an email that already belongs to an active member is refused. A disabled member is offered "re-enable" instead.
- An optional **allowed email domains** setting restricts who can be invited **(default: off)**.
- The pending invitations list shows email, role, inviter, sent and expiry, and status.

### 4.3 Accepting an invitation and onboarding

The flow runs in this order:

1. **Create the account.** The email is shown and fixed. The invitee enters a display name and **@handle**, suggested from their name, and then **registers a passkey**. This is the same with or without email, so copy-link invites need nothing else. If they leave before registering, they can open the invitation again while it's valid, or, when email is configured, sign in with a magic link and add a passkey later **(default)**. The member's personal calendar (M5a) and My files drive (M6a) are created by those milestones, at account creation once they exist, and by their backfill for earlier members (platform §13 Provisioning and backfill).
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
  - **Email me a sign-in link.** Shown only when email is configured and `magic_link_enabled` is on.
- **There are no passwords** (§2). No password field, reset, change or policy exists.
- **Built on better-auth** (§2; TDD §8.1): its `magicLink` and passkey plugins, its database sessions, and its D1 adapter. Only the better-auth endpoints listed in §6 are reachable from outside; every other better-auth route, including email-and-password sign-up and sign-in (disabled in any case), user updates, email change and account deletion, answers 404. Our own routes call better-auth on the server through `auth.api`.
- **Who may sign in:** active members only. `status = 'system'` rows, disabled and deleted members can't sign in, and see a generic "can't sign in" message.
- **New accounts only through an invitation or setup.** `databaseHooks.user.create.before` refuses to create a user unless the email has a valid pending invitation or setup is being claimed. Magic links set `disableSignUp`. So no better-auth path, present or added by an upgrade, can create an account on its own (§9 tests every path).
- **Magic links** (better-auth `magicLink` plugin):
  - single-use, valid for **15 minutes** (`expiresIn: 900`, overriding better-auth's 300 s), open on **any device**
  - sent only to **active members**: the `sendMagicLink({ email, token, url })` callback looks the address up and sends nothing otherwise
  - the request page shows the same message whether or not the account exists, so it doesn't reveal which emails have accounts; the response and its timing are the same either way
  - **scanner-safe:** the callback doesn't send better-auth's `url` (a GET that signs in). It emails a link to **our confirmation page**, "Sign in to *Workspace* as *email*" → Continue. Opening it does nothing. Only the page's **POST** passes the token to better-auth's verification on the server (`auth.api`), which signs in and sets the session cookie. better-auth's own GET verify route isn't reachable from outside, so mail scanners and link prefetchers that open links with GET can't sign in or use the token up (platform §10 Email links). The same rule applies to recovery, invitation and email-change confirmation links.
  - limited per email and per IP (platform §8).
- **Passkeys** (`@better-auth/passkey`, SimpleWebAuthn underneath):
  - members can register several, each with a name and a "last used" time; they can rename and remove them (through our routes, which apply the rules below)
  - **the last sign-in method can't be removed:** a member can't remove their last passkey unless magic links are available to them (email configured and `magic_link_enabled` on) **(default)**; an **owner** can never remove their last passkey **(default)**, because email configuration can change
  - **owners are asked for a second passkey** at setup, on promotion and in their settings, with a reminder while they have only one **(default)** (§2)
  - **first passkey without a session.** Setup, invitation acceptance and recovery register a passkey before the person has a session. The plugin's `registration.requireSession: false` and `resolveUser` allow this; `resolveUser` accepts only a valid **enrolment ticket**: a single-use, 15-minute token in an `HttpOnly`, `Secure`, `SameSite=Strict` cookie, issued by the setup, accept or recovery POST and bound to one user (`auth_tokens.kind = 'passkey_enrol'`) **(default)**. Without a session or a ticket, registration is refused. Completing registration signs the person in.
  - user verification is **"preferred"** **(default)**.
  - **clone detection (our own check):** better-auth doesn't document counter-regression handling, so an **after hook** on passkey sign-in compares the verified assertion's counter with our stored `verified_sign_count`. A counter **less than or equal to** the stored value (unless both are 0, as with most synced passkeys) is refused as `clone_detected`: the session better-auth just created is revoked and the response is the typed error. The member and owners get a `security_notice` (notifications §3 Notification events).
  - our stored counter advances with a **compare-and-set** (`UPDATE … SET verified_sign_count = ? WHERE id = ? AND verified_sign_count = ?`), so two concurrent sign-ins with one passkey can't both pass against the same value; the loser is treated as `clone_detected`.
  - **origin and relying party:** the relying-party ID is the **request's host**, and the expected origin is the request's own origin (`trustedOrigins` as a function of the request). The better-auth instance is built per host (cached per isolate) rather than configured, so nothing deployment-specific is stored (AGENTS §4.1; TDD §8.1). Tests check that an assertion from another origin is refused, because a published advisory found origin and user verification unenforced in some versions (TDD §8.1).
- **Passkeys and the domain (relying-party ID):**
  - Passkeys are bound to the domain the workspace uses when they're registered.
  - **Changing the workspace's domain** (for example from `*.workers.dev` to a custom domain, PRD §13) or **restoring to another installation** leaves existing passkeys unusable.
  - **Registering a passkey on a `*.workers.dev` domain shows a warning:** "If this workspace moves to a custom domain, you'll need to add this passkey again."
  - **Recovery after a domain change:** everyone needs a **magic link** (when email is configured) or a **recovery link** (§4.6) on the new domain, and then registers a new passkey. Without email: an owner uses `RECOVERY_TOKEN`, then issues recovery links to everyone else. The admin guide for domain changes and restores says so, and the restore flow lists the members who will need a recovery link (platform §6 Export coverage).
- **Rate limits:** better-auth's limiter with custom storage on our counters, keyed by the client IP from `cf-connecting-ip` (IPv6 by /64). Magic-link requests are limited **per email and per IP**; passkey sign-in options and verification per IP. There is no password guessing to slow down, so the password sign-in throttle and its progressive delays (and the "slow mode" drafted in the M1a branch) are gone. Values are in platform §8 Rate limits and quotas.

### 4.5 Sessions

- **better-auth database sessions** (TDD §3.1, §8.1): one session token in an `HttpOnly`, `Secure`, `SameSite=Lax` cookie with an Officebox prefix. JavaScript can't read it and it never appears in a URL. There are **no access or refresh tokens**, so there is no rotation, reuse detection or grace window.
- **30-day sliding expiry:** `expiresIn` 30 days, `updateAge` 1 day, so a session used at least once in 30 days stays signed in.
- **`cookieCache` is off.** Every authenticated request reads the session row and checks the user's status, so a revoked session or a disabled member is refused on the **next request**, not after a cache bound. (A published advisory found revoked sessions surviving through the cookie cache; TDD §8.1.)
- **`session_epoch` is removed.** Revoking deletes the session rows themselves, and socket revocation doesn't need an epoch: every socket's attachment carries its session ID, so `closeConnections` targets one session or all of a user's (TDD §3.5).
- **My devices** (this is PRD §6's "login activity visibility"), on better-auth's list and revoke:
  - a list of active sessions showing browser and OS, approximate location if available, created and last-seen times (last seen to within a day, since better-auth refreshes it with the sliding expiry), and which one is the current device. Our route returns these fields and the session ID, never session tokens.
  - **sign out** any session, **sign out all other devices**, or **sign out everywhere** (this device too: better-auth's revoke-all)
  - the device label and approximate location are stored with the session and deleted with it.
- **Revoking closes live sockets.** Every revocation (signing out, a device signed out from My devices, sign out everywhere, an admin signing someone out, disabling a member, using a recovery link) calls `closeConnections` through the UserHub room registry, so sockets close within seconds (TDD §3.5). better-auth's after hooks trigger it for its own sign-out route; our routes trigger it directly.
- **Removing a passkey doesn't sign out other sessions** (default).
- **Disabling a member** revokes all their sessions and closes all their open connections within seconds (TDD §3.5).
- **CSRF** is unchanged from M1a: state-changing requests, including better-auth's routes, need the `X-Officebox-Request` header and a same-origin `Origin`, on top of better-auth's own origin check (TDD §8.2).

### 4.6 Account recovery

There are no passwords to reset, so recovery always means **registering a new passkey**.

- **With email configured:** a member who has lost their passkeys signs in with a **magic link** and adds a new passkey. No admin is involved.
- **Without email, or when the member can't receive email:** an **admin issues a one-time recovery link** to copy and share privately.
  - **Admins can issue them for members only. For admins and owners, an owner must issue them** (permissions §6 Admin powers).
  - It is valid for 24 hours **(default)**.
  - It lets the person **register a new passkey** (through an enrolment ticket, §4.4) and **signs out all their existing sessions**. Their old passkeys stay listed so they can remove the lost ones **(default)**.
  - Issuing one **revokes the person's other pending magic links and recovery tokens**.
  - **The person is notified:** an email to their current address (if email is configured), "*Admin Name* issued a recovery link for your account on *date*", and a `security_notice` inbox item.
  - **Loudly flagged, because without email the member can't be told in advance:**
    - The **sign-in page** shows the notice to that member on their next sign-in attempt, before and after signing in: "An admin reset your account on *date*. If this wasn't expected, contact an owner." This uses `users.pending_security_notice`, so it shows even after the link holder has registered a passkey.
    - **Every owner sees the member flagged** on the member list ("Recovery link issued by *Admin* on *date*") until an owner acknowledges it.
  - Issuing one is audited.
- **An owner who lost their passkeys:** another owner issues a recovery link, or the owner uses a magic link when email is configured.
- **All owners locked out:** owner recovery through the `RECOVERY_TOKEN` secret (TDD §8.1). Someone with access to the Cloudflare account sets the secret; `/recover` then lets them **register a new passkey for one owner** (named by email), once. It signs out that owner's existing sessions, is audited, and shows a banner to owners until the secret is deleted. This is why owners are asked for two passkeys (§2).
- **Domain change or restore:** as §4.4: magic links where email is configured, otherwise `RECOVERY_TOKEN` for an owner and recovery links for everyone else.

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
  - change role (owners only promote or demote admins and owners)
  - disable and re-enable; delete (anonymise, PRD §10.2); change email; issue a recovery link; sign out all sessions (better-auth's revoke-all for that user, called by our permission-checked route; better-auth's admin plugin isn't used **(default)**, §11).

  **Admins can do these for members only; for admins and owners, an owner must act** (permissions §6 Admin powers). What disabling and deleting do in each feature is set out in platform §3 Member lifecycle.
- **Email change:**
  - When email is configured, the new address must be confirmed before it takes effect. The pending address is held in an `email_change` token's payload. The link opens a confirmation page (GET), and only its POST applies the change (platform §10 Email links).
  - The **old address is notified**: "Your Officebox email was changed to *new* by *Admin Name* on *date*". The person also gets a `security_notice` inbox item and the sign-in banner (`pending_security_notice`).
  - **All pending magic links and recovery tokens are revoked.** Email changes go through our route, never better-auth's change-email endpoint, which isn't exposed.
  - It's audited.
- **Ownership:** transfer it, or add more owners. The last owner can't be demoted, disabled or deleted.
- **Default channels:** choose which **public** channels new members join **(default)**.
- **Policies:**
  - allowed invite domains
  - whether magic-link sign-in is enabled (default on when email is configured).

  The minimum password length setting is removed, because there are no passwords.
- **Audit log** entries for:
  - setup, invitations, role changes, disable and delete
  - email changes, recovery links, ownership changes
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
| `user` | `users` (core, TDD §2.1) | `name` → `display_name`, `emailVerified` → `email_verified`, `image` → `avatar_key` (written only by our profile API). `role`, `status` (including `system`), `handle` and the profile columns are `additionalFields` with **`input: false`**, so no better-auth endpoint can set them. |
| `session` | `sessions` (core, TDD §2.1) | `userId` → `user_id`, `expiresAt` → `expires_at`, `ipAddress` → `ip_address`, `userAgent` → `user_agent`; `device_label` and `approx_location` are `additionalFields`, set in `databaseHooks.session.create.before`. |
| `account` | `auth_accounts` (new) | Required by better-auth. Passkey and magic-link sign-in keep no secrets here; the `password` column stays NULL and is never written. |
| `verification` | `auth_verifications` (new) | better-auth's short-lived values: magic-link tokens and WebAuthn challenges. |
| `passkey` | `passkeys` | `credentialID` → `credential_id`, `publicKey` → `public_key`, `counter` → `sign_count`, `userId` → `user_id`; our `verified_sign_count` and `last_used_at` are added fields. |

- **IDs are ULIDs** (`advanced.database.generateId`). Timestamps are epoch milliseconds where the adapter allows; whether better-auth's D1 adapter can store its dates as epoch milliseconds is checked in M1a, and any exception is recorded in platform §14 (§11).
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
  released_at INTEGER                                      -- held for 30 days after a change
);

CREATE TABLE passkeys (                                    -- better-auth `passkey` model, mapped
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE,                      -- base64url
  public_key TEXT NOT NULL,                                -- COSE key, base64url
  sign_count INTEGER NOT NULL DEFAULT 0,                   -- better-auth's counter
  verified_sign_count INTEGER NOT NULL DEFAULT 0,          -- ours: clone detection with compare-and-set (§4.4)
  device_type TEXT,
  backed_up INTEGER,
  transports TEXT,                                         -- JSON
  aaguid TEXT,
  name TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
-- Columns follow the better-auth version pinned in M1a; the generated SQL is the source.

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
  payload TEXT,                                            -- JSON; email_change: { "newEmail": "..." }
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);

-- invitations: (email NOT NULL is in the baseline table); add groups
ALTER TABLE invitations ADD COLUMN group_ids TEXT;         -- JSON array

-- security notices for admin-initiated actions (one mechanism: this banner + the security_notice inbox item)
ALTER TABLE users ADD COLUMN pending_security_notice TEXT; -- JSON: shown on the sign-in page and after sign-in (recovery link issued, email changed, owner recovery)
ALTER TABLE users ADD COLUMN admin_reset_at INTEGER;        -- recovery link issued without email: flagged to owners
ALTER TABLE users ADD COLUMN admin_reset_by TEXT;
ALTER TABLE users ADD COLUMN admin_reset_acknowledged_by TEXT;

-- groups: add handle and managers
ALTER TABLE groups ADD COLUMN handle TEXT;               -- copy of the authoritative handles row
ALTER TABLE group_members ADD COLUMN role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('manager', 'member'));

-- users: better-auth's emailVerified (no password_hash, no session_epoch: TDD §2.1)
ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;

-- sessions: device info for "My devices" (better-auth additionalFields)
ALTER TABLE sessions ADD COLUMN device_label TEXT;         -- e.g. "Chrome on macOS"
ALTER TABLE sessions ADD COLUMN approx_location TEXT;      -- from request.cf (city/country), if available; deleted with the session
```

Settings keys (defined in platform §7 Admin settings): `default_channels`, `welcome_post_enabled`, `allowed_invite_domains`, `magic_link_enabled`. (`min_password_length` is removed.)

## 6. API (summary)

Paths are relative to the Worker's `/api` prefix (for example `POST /api/setup`). Changed 15 Nov 2026: password routes are removed, and sign-in, sessions and passkeys run on better-auth.

**better-auth routes, mounted at `/auth/*`** (Hono passes them to `auth.handler(c.req.raw)`). Only these are reachable from outside; every other better-auth route answers 404. Exact paths follow the pinned better-auth version. Each one still passes our CSRF middleware (§4.5).

| Method and path | Who | Purpose |
|---|---|---|
| `GET /auth/get-session` | Session | The current session (the web app uses `GET /me` for everything else) |
| `POST /auth/sign-out` | Session | Sign out this session; an after hook closes its sockets |
| `POST /auth/sign-in/magic-link` | Public | Request a magic link. Same response for every email; sends only to active members (`disableSignUp`) |
| Passkey authentication options · `POST /auth/sign-in/passkey` | Public | WebAuthn sign-in; the after hook runs our counter check (§4.4) |
| Passkey registration options · registration verify | Session, or enrolment ticket | Register a passkey: a signed-in member adding one, or the first passkey after setup, accepting an invitation or recovery (`resolveUser` accepts only an enrolment ticket) |

**Not exposed**, called only on the server through `auth.api` by our routes: magic-link verify (better-auth's GET), list sessions, revoke a session, revoke other sessions, revoke all sessions, list, rename and delete passkeys. **Blocked:** email-and-password sign-up and sign-in (also disabled), update user, change email, delete user, and any route a plugin or upgrade adds until it's reviewed.

**Our routes.** The two under `/auth/` (`ws-ticket` and `recover/:token`) are registered ahead of the better-auth mount, so better-auth never sees them.

| Method and path | Who | Purpose |
|---|---|---|
| `POST /setup` | Setup token | Claim the workspace and create the owner (workspace name, owner's name, @handle, email); returns an enrolment ticket for the first passkey |
| `POST /setup/resume` | Setup token | Issue a new enrolment ticket for the claimed owner, only while setup is incomplete (no owner passkey yet) |
| `GET /me` | Member | Current user: profile, role, preferences summary, pending security notice, passkey count |
| `POST /sign-in/link` | Public (magic-link token) | The confirmation page's POST: calls better-auth's magic-link verification through `auth.api` and returns its session cookie. The page itself (`/sign-in/link/:token` in the web app) does nothing on GET. |
| `POST /auth/ws-ticket` | Member | One-time WebSocket ticket for non-browser clients (realtime API, TDD §3.1; listed here for completeness) |
| `GET /me/sessions` · `DELETE /me/sessions/:id` · `POST /me/sessions/sign-out-others` · `POST /me/sessions/sign-out-everywhere` | Member | My devices, on better-auth's list and revoke; never returns session tokens; each revocation closes the matching sockets |
| `GET /me/passkeys` · `PATCH /me/passkeys/:id` · `DELETE /me/passkeys/:id` | Member | List, rename and remove **own** passkeys; removal applies the last-method and owner rules (§4.4) and checks ownership itself |
| `GET/PATCH /me/profile` · `PUT /me/avatar` · `PUT /me/status` | Member | Profile and status |
| `POST /auth/recover/:token` | Recovery link | Use an admin-issued recovery link: signs out existing sessions and returns an enrolment ticket. The page (`/auth/recover/:token` in the web app) does nothing on GET. |
| `POST /recover` | `RECOVERY_TOKEN` secret | Owner recovery: an enrolment ticket for one owner, once (§4.6) |
| `GET /me/email/confirm/:token` · `POST /me/email/confirm/:token` | Public | Confirm an email change (GET shows the confirmation page; POST applies it) |
| `GET /invitations/:token` · `POST /invitations/:token/accept` | Public | Show and accept an invitation; accepting creates the account through better-auth (so its database hooks run) and returns an enrolment ticket |
| `GET/POST /admin/invitations` · `POST …/:id/resend` · `DELETE …/:id` | Admin | Manage invitations |
| `GET /members` · `GET /members/:id` | Member | Directory |
| `PATCH /admin/members/:id` (role, email, status) · `POST …/:id/recovery-link` · `POST …/:id/sign-out` · `DELETE …/:id` | Admin (members only); owner (admins and owners) | Administer members; sign-out revokes all their sessions and closes their sockets |
| `POST /admin/members/:id/acknowledge-reset` | Owner | Clear the owners' "recovery link issued" flag |
| `GET/POST /groups` · `PATCH/DELETE /groups/:id` · `PUT/DELETE /groups/:id/members/:userId` | Admin / manager (an admin adding themselves needs an owner) | Groups |
| `GET /handles/:handle/available` | Member | Handle check |

**Removed 15 Nov 2026:** `POST /auth/password`, `POST /auth/refresh`, `POST /auth/forgot`, `GET/POST /auth/reset/:token`, `PUT /me/password`, our own `POST /auth/passkey/options` and `/verify`, and `POST /me/passkeys/options` · `POST /me/passkeys` (now better-auth's passkey routes).

## 7. Screens

1. Setup (token, then owner and workspace, then register a passkey, then "add a second passkey")
2. Sign in (passkey button first; "email me a sign-in link" when email is configured)
3. Magic link "check your email" page and the "Sign in as *email*" confirmation page
4. Accept invitation, then register a passkey, then profile setup, then the tour
5. Recovery link and owner recovery (register a new passkey)
6. Profile settings: profile, status, passkeys (with the `*.workers.dev` warning and the owners' second-passkey reminder), my devices
7. Member directory and profile card
8. Admin: members, invitations, groups, default channels, policies, audit log

## 8. Edge cases

- **An invitation accepted twice.** Only the first succeeds, enforced with an atomic update.
- **An invited email that becomes a member another way.** The pending invitation is revoked automatically.
- **Last sign-in method.** Removing the last passkey is blocked with an explanation, unless magic links are available to that member; an owner's last passkey can never be removed (§4.4).
- **Invitee leaves before registering a passkey.** The account exists with no passkey. They reopen the invitation link while it's valid (it then issues a new enrolment ticket for the same account instead of creating another), use a magic link when email is configured, or get an admin recovery link **(default)**.
- **Owner leaves setup before registering a passkey.** The same setup token resumes registration for the same owner; setup isn't complete until then (§4.1).
- **Lost device with an active session.** The member signs it out from another device, or an admin signs out all their sessions. The sockets close within seconds.
- **Lost all passkeys.** Magic link when email is configured; otherwise an admin recovery link (members) or another owner's recovery link or `RECOVERY_TOKEN` (owners) (§4.6).
- **Handle collision during onboarding** (two people choosing the same handle at once). A unique constraint resolves it, and the loser is asked to pick another.
- **Email not configured.** The magic-link option is hidden; invitations are copy-link only; recovery is done with admin recovery links and `RECOVERY_TOKEN`.
- **Time zone changes** (someone travels). The browser offers "Update your time zone to Europe/Berlin?" **(default)**.
- **Domain change or restore.** Passkeys stop working (§4.4). With email, everyone signs in with a magic link and registers a new passkey; without email, an owner uses `RECOVERY_TOKEN` and issues recovery links to everyone else.
- **A magic link opened by a mail scanner.** The GET shows the confirmation page and changes nothing; the token stays usable for the member's own click.
- **A better-auth route that would create a user** (for example a magic-link verify for an unknown email, or a route added by an upgrade). `databaseHooks.user.create.before` refuses it unless there's a valid invitation or setup claim.
- **A cloned passkey.** The counter check refuses the sign-in as `clone_detected`, revokes the session just created, and sends a `security_notice` (§4.4).
- **Admin acting on an admin or owner.** The action is refused with "An owner must do this."
- **Email changed while a magic link is outstanding.** The old link no longer works (pending magic links revoked).
- **Recovery link issued with no email configured.** The member sees the notice on the sign-in page; owners see the flag on the member list until acknowledged.

## 9. Acceptance criteria

- **Setup (M1):** a fresh deploy can't be claimed without the token. Setup creates the owner (with handle) and default settings, and nothing that belongs to later milestones. The owner registers a passkey during setup and is then signed in; setup isn't complete until they have one, and the same token resumes registration for the same owner only. Setup asks for a second passkey.
- **Provisioning (later milestones):** M3a, M5a and M6a each have a test that a workspace set up before them gets its `#general` and default-channel memberships, calendars, and drives and folders from the backfill, and that running the backfill twice changes nothing.
- **Invitations:**
  - link and email invitations both work end to end, including when email isn't configured
  - expired, revoked and used invitations are refused
  - members can't invite; admins can invite members but **not** admins; owners can invite admins.
- **Sign-in:**
  - sign in with a passkey, and magic link sign-in through the confirmation page, each work end to end
  - opening a magic, recovery or invitation link with GET doesn't use the token; only the confirmation POST does. better-auth's GET magic-link verify route answers 404 from outside.
  - a magic link expires after 15 minutes and can't be used twice
  - the magic-link request response is identical for existing, non-existing, disabled and `system` emails, and only active members receive an email
  - better-auth's email-and-password routes, update-user, change-email and delete-user answer 404
  - registering a passkey on a `*.workers.dev` host shows the domain warning
  - a passkey assertion whose counter is lower than, or equal to, a non-zero stored value is rejected as `clone_detected` and leaves no session; an authenticator that always reports 0 still signs in; of two concurrent sign-ins with the same counter, at most one succeeds
  - an assertion made for another origin or relying-party ID is refused
  - the relying-party ID follows the request host: the same build serves two hosts in tests, and a passkey registered on one doesn't work on the other.
- **Account creation paths** (each tested): setup and invitation acceptance create accounts; a magic-link verify for an unknown email, a passkey registration without a session or enrolment ticket, and a direct call of any better-auth user-creating API without an invitation are all refused by `databaseHooks.user.create.before`.
- **Passkeys:**
  - a member can add, rename and remove passkeys
  - removing the last passkey is refused unless magic links are available to that member; an owner's last passkey can't be removed
  - an owner with one passkey sees the second-passkey reminder
  - a member can't remove or rename another member's passkey, through our routes or better-auth's (which aren't exposed).
- **Enrolment tickets:** a ticket registers one passkey for its own user only, once, within 15 minutes; registration without a session or a ticket is refused.
- **Sessions** (tested with an injected clock):
  - a session unused for 30 days is rejected; one used on day 29 is extended
  - the session cookie is `HttpOnly`, `Secure` and `SameSite=Lax`
  - "sign out" for a single session, for all other devices and everywhere works, and the revoked session's next request fails at once (no cookie cache)
  - each revocation closes that session's open sockets within 5 seconds
  - "My devices" never returns a session token
  - disabling a member closes their open connections within 5 seconds, and their next REST request fails.
- **CSRF:** a state-changing request to our routes or to better-auth's without `X-Officebox-Request`, or from another origin, is refused.
- **Rate limits:** the limits in platform §8 for magic-link requests (per email and per IP), passkey sign-in and setup, recovery and invitation acceptance return `rate_limited` at the threshold; unknown emails count the same as real ones.
- **Admin powers:**
  - an admin can disable, delete, change the email of and issue a recovery link for a **member**
  - the same actions on an **admin or owner** return 403 for an admin and succeed for an owner
  - the last owner can't be demoted, disabled or deleted.
- **Notifications of admin actions:**
  - issuing a recovery link or changing an email sends an email to the person's **old** address (when email is configured)
  - it creates a `security_notice` inbox item and the sign-in banner
  - with email **not** configured, the recovery notice appears on the sign-in page for that member, and the member is flagged to every owner until acknowledged
  - it revokes their pending magic links and recovery tokens, which then fail.
- **Recovery link flow:** the link lets the member register a new passkey, signs out all their existing sessions (closing their sockets), and can't be used twice.
- **Owner recovery:** with `RECOVERY_TOKEN` set, `/recover` registers a new passkey for one owner once; without the secret it answers 404; it's audited and shows a banner until the secret is deleted.
- **Directory:** search by name, handle, email, title, team and group returns the right members; the Deactivated filter lists disabled members only; region and working hours are shown.
- **Handles:** handles are unique across people and groups; reserved words (including `assistant` and the handle derived from the assistant display name) are refused; a released handle can't be claimed by someone else for 30 days.
- **Reserved senders:** the `system` and `assistant` rows never appear in the directory or member counts and can't sign in.
- **Groups:**
  - group managers can manage only their own groups
  - an admin adding themselves to a group gets 403; an owner adding an admin, or the admin with an owner's approval, succeeds and is audited
  - @group mentions notify only members who can see the message (from M3a).
- **Email change:** opening the confirmation link with GET doesn't change the email; the POST does, and only once.
- **`GET /me`** returns the signed-in member and any pending security notice.
- **Audit:** every admin action in §4.11 writes an audit entry with actor, target and time.

## 10. Later

TOTP two-factor (less needed with passkeys; revisit) · Google/Microsoft or SSO sign-in · guests · member self-service email change, account deletion or data export · custom roles.

## 11. Open questions

1. **Team field.** Free text, or chosen from the member's groups (a "primary group")? The second keeps the directory consistent.
2. **Allowed invite domains.** Off by default, or on and set to the owner's domain at setup?
3. **Welcome post wording and channel.** Always `#general`, or configurable?
4. ~~**WebAuthn library and PBKDF2 limit.**~~ Answered by the M0 foundation spike ([foundation spike](../spikes/foundation/README.md)): `@simplewebauthn/server` runs in Workers (better-auth's passkey plugin uses it); the PBKDF2 result no longer applies, since there are no passwords.
5. **Owners' second passkey** (new, 15 Nov 2026). Recommend with a reminder (the default), or **require** a second passkey (or a set `RECOVERY_TOKEN`) before an owner can finish setup or be promoted? Recommendation: keep the reminder; requiring it blocks setup on a single device.
6. **Removing the last passkey when magic links work** (new). Allowed for members (the default), or always keep at least one passkey? Recommendation: allow it; the email account is then the sign-in method, as for a magic-link-only member.
7. **better-auth admin plugin** (new). Not used (the default): admins sign people out and manage members through our permission-checked routes, which call better-auth on the server. The plugin would add impersonation and its own role and ban fields, which conflict with permissions §6. Confirm.
8. **Passkeys in exports** (new). Public keys aren't secret, so exporting them would let a restore onto the **same domain** keep passkeys working; today they're excluded (platform §6), so after any restore everyone needs a magic link or recovery link. Recommendation: export them and drop them only when the restored domain differs.

**Technical, to settle in M1a (TDD §10):** whether better-auth's D1 adapter can store dates as epoch milliseconds (otherwise its date columns are an exception in platform §14); whether its magic-link plugin can store tokens hashed in `auth_verifications`; the exact routes, hooks and session-deletion hooks of the pinned version.

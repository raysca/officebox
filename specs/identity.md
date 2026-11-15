# Spec: Identity & Access

**Status:** Approved (product owner, 15 Nov 2026)
**Revision:** Revised after independent review (14 Nov 2026); updated for the [Assistant](assistant.md) spec (15 Nov 2026: reserved `assistant` handles, reserved non-user senders)
**Feature name:** Identity & Access (marketing name to be decided later)
**Milestone:** M1 ([PLAN](../PLAN.md)) · **Related:** PRD §6, §10.1; TDD §3.1, §6.8, §8.1; [Permissions](permissions.md), [Platform](platform.md), [Notifications](notifications.md)

Decisions marked **(default)** were not discussed; change them on review.

**Cross-cutting rules:** permissions follow [Permissions](permissions.md); notifications follow [Notifications & Attention](notifications.md); lifecycle, cascades, retention, export, admin settings, limits and timers follow [Platform Rules](platform.md). Those specs win on cross-cutting rules.

## 1. Summary

Identity & Access covers:
- setting up a workspace
- getting people in (invitations and onboarding)
- signing in (password, magic link, passkey)
- keeping sessions safe
- describing people (profiles, handles, directory)
- organising them (roles and groups).

The permission engine that every feature relies on is specified in [Permissions](permissions.md). This spec covers people, sign-in and the admin actions on them.

## 2. Decisions

| Topic | Decision |
|---|---|
| Sign-in methods at launch | **Email + password**, **magic link by email**, **passkeys** |
| Google/Microsoft sign-in | Later. SSO comes through Cloudflare Access in Phase 2 (PRD §6). |
| Two-factor (TOTP) | **After launch** (Phase 2) |
| Passkey-only accounts | **Allowed for members.** **Owners must keep a password** as well as any passkeys. |
| Passkeys and domains | Passkeys are bound to the workspace's domain (WebAuthn relying-party ID). A domain change or restore elsewhere leaves them unusable; §4.4 covers the warning and recovery. |
| Password hashing | **PBKDF2-SHA256, 100k iterations, plus an HMAC pepper** from Worker secrets (`pbkdf2-sha256-hmac$…`), because production Workers cap PBKDF2 at 100k (confirmed by the M0 foundation spike's production probe). Changed from "600k" after the spike (§4.4). |
| Who can invite | **Admins invite members. Only owners invite or promote admins.** |
| Admin actions on people | Admins act on **members only**. Recovery links, email changes, disable and delete on **admins or owners need an owner**. Every recovery link or email change **notifies the person** and **revokes their pending sign-in, reset and recovery tokens** (permissions §6 Admin powers). |
| Magic link and email-link consumption | Links open a **confirmation page**; the token is used only by a POST from that page, so mail scanners can't use it up (platform §10 Email links) |
| Default channels | **Public channels only** **(default)** |
| Mentions | **Unique @handles** alongside display names |
| Session length | **30 days, sliding** |
| Member self-service | **See and sign out own devices.** Email change and account deletion are admin actions. |
| Profile fields | Name, @handle, avatar, time zone, working hours, region, **job title, team, pronouns, phone, location/office** |
| Copy-link invites | **The admin enters the invitee's email**, and the link is bound to it |
| After accepting an invite | **Profile setup step → auto-join default channels → welcome post in #general → short welcome tour** |
| Magic link | **Single-use, 15 minutes, works on any device** |
| Groups | **Admins create groups and appoint group managers**, who manage membership |
| @group mentions | **Yes.** Notifies group members who can see the conversation. |
| Directory | **Everyone sees everyone's contact details**, plus region and working hours |
| Guests | **Phase 2** (the role value is reserved in the schema) |
| What M1 creates | **Only identity objects**: users, handles, groups, invitations, sessions, passkeys, auth tokens and settings. `channels` and `channel_members` are **not** created in M1. `#general`, default channels and the welcome post arrive in **M3a**; personal, workspace and group calendars in **M5a**; My files, group drives, the Channels drive and channel folders in **M6a**. Each milestone provisions its own objects for existing people and groups with an idempotent backfill job (platform §13 Provisioning and backfill). |
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
- Setup collects the workspace name and the owner's name, **@handle**, email and password. The owner can add a passkey straight away.
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

1. **Create the account.** The email is shown and fixed. The invitee enters a display name and **@handle**, suggested from their name. They then either set a **password**, **register a passkey**, or both. At least one is required (owners always need a password). The member's personal calendar (M5a) and My files drive (M6a) are created by those milestones, at account creation once they exist, and by their backfill for earlier members (platform §13 Provisioning and backfill).
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

- **One sign-in page**, with the email field first, offering:
  - **Password**
  - **Email me a sign-in link.** Shown only when email is configured.
  - **Use a passkey.** Uses WebAuthn with discoverable credentials, so a passkey can sign in without typing an email.
- **Passwords:**
  - at least 10 characters, checked against a bundled common-password list, no composition rules **(default)**
  - **PBKDF2-SHA256 at 100k iterations plus an HMAC pepper** held in Worker secrets (TDD §8.1), stored as `pbkdf2-sha256-hmac$<pepperId>$100000$<salt>$<hash>`, where the PBKDF2 input is `HMAC-SHA256(PEPPER_<pepperId>, password)`.
  - **Why not 600k:** production Workers cap PBKDF2 at 100k. The M0 foundation spike's production probe confirmed it: 100,001 and 600,000 are refused ([foundation spike](../spikes/foundation/README.md#production-results)). Argon2id in WASM (precompiled) also runs in production and remains a possible later upgrade.
  - **Pepper:** each `PEPPER_<n>` is at least **32 random bytes**, never stored in D1, exported or logged (platform §16).
  - **Pepper rotation:** add the new secret and write new hashes with it; re-hash each account at its next successful sign-in; after a published deadline, accounts still on a retired pepper must reset their password (or use a magic link or passkey). Old pepper secrets are kept until that deadline, then deleted.
  - **Restore:** restoring an export to another installation needs the same `PEPPER_*` secrets, otherwise every password must be reset (platform §6, §16).
  - **No account enumeration by timing:** sign-in for an unknown email or a passkey-only account runs the same derivation against a dummy salt. Stored iteration counts outside 100k–1M are refused before deriving.
- **Magic links:**
  - single-use, valid for **15 minutes**, open on **any device**
  - sent only to active members with an email
  - the request page shows the same message whether or not the account exists, so it doesn't reveal which emails have accounts
  - **opening the link shows a "Sign in as *email*" confirmation page**; only the POST from that page uses the token. Mail scanners and link prefetchers that open links with GET can't sign in or use it up (platform §10 Email links). The same applies to password-reset, recovery, invitation and email-change confirmation links.
- **Passkeys:**
  - members can register several, each with a name and a "last used" time; they can rename and remove them
  - removing the last sign-in method is blocked: a member always keeps a password or at least one passkey
  - **owners must keep a password**: an owner can't remove their password, and promoting a passkey-only member to owner requires them to set one first
  - user verification is **"preferred"** **(default)**. Verified with `@simplewebauthn/server` in the M0 foundation spike; it must be called with `requireUserVerification: false`, because its default is `true`.
  - **clone detection:** after the signature is verified, a `sign_count` that is **less than or equal to** the stored value (unless both are 0, as with most synced passkeys) rejects the sign-in as `clone_detected`. The service compares counters itself rather than relying on the library's error. The member and admins get a `security_notice` (notifications §3 Notification events).
  - the stored counter is updated with a **compare-and-set** (`UPDATE … SET sign_count = ? WHERE id = ? AND sign_count = ?`), so two concurrent sign-ins with one passkey can't both pass against the same value.
- **Passkeys and the domain (relying-party ID):**
  - Passkeys are bound to the domain the workspace uses when they're registered.
  - **Changing the workspace's domain** (for example from `*.workers.dev` to a custom domain, PRD §13) or **restoring to another installation** leaves existing passkeys unusable.
  - **Registering a passkey on a `*.workers.dev` domain shows a warning:** "If this workspace moves to a custom domain, you'll need to add this passkey again."
  - **Recovery:** members with a password sign in with it and add new passkeys. **Passkey-only members** need an admin recovery link (§4.6). The admin guide for domain changes and restores says so, and the restore flow lists passkey-only members who will need one (platform §6 Export coverage).
- **Rate limits:** progressive delays after **5 failed attempts per minute per IP** and **10 per hour per account** (TDD §8.1). There is no hard lockout.
  - **Delay schedule per account (default):** attempts 1–5 are immediate; then each further failed attempt waits 1 s, 2 s, 4 s, 8 s, 16 s, then 30 s (the cap). A successful sign-in resets it.
  - Further limits are in platform §8 Rate limits and quotas.
- **Disabled and deleted members** can't sign in. They see a generic "can't sign in" message.

### 4.5 Sessions

- `HttpOnly`, `Secure`, `SameSite=Lax` cookies: a 15-minute access token and a refresh token that rotates, with reuse detection (TDD §3.1).
- **Grace window (default 30 s):** if two tabs refresh with the same refresh token at once, both get the **same successor** token within 30 seconds of the rotation. Reuse of a token older than that still revokes the session.
- **Every authenticated request checks `session_epoch` and user status**, not only WebSocket upgrades. The check can be cached per isolate for at most **60 seconds** **(default)**, so a disabled member loses REST access within a minute and sockets within seconds.
- **30-day sliding expiry.** Each refresh extends the session.
- **My devices** (this is PRD §6's "login activity visibility"):
  - a list of active sessions showing browser and OS, approximate location if available, created and last-seen times, and which one is the current device
  - **sign out** any session, or **sign out all other devices**
  - the approximate location is stored with the session and deleted with it (sessions expire after 30 days without use).
- **Changing your password signs out your other sessions (default).** Removing a passkey does not.
- **Disabling a member** bumps `session_epoch` and closes all their open connections within seconds (TDD §3.5).

### 4.6 Account recovery

- **With email configured:** "Forgot password?" sends a single-use reset link valid for 1 hour. The member sets a new password and can add a passkey.
- **Without email, or when all passkeys are lost:** an **admin issues a one-time recovery link** to copy and share privately.
  - **Admins can issue them for members only. For admins and owners, an owner must issue them** (permissions §6 Admin powers).
  - It is valid for 24 hours **(default)**.
  - It lets the member set a password or register a new passkey, and signs out their existing sessions.
  - Issuing one **revokes the person's other pending magic-link, reset and recovery tokens**.
  - **The person is notified:** an email to their current address (if email is configured), "*Admin Name* issued a recovery link for your account on *date*", and a `security_notice` inbox item.
  - **Loudly flagged, because without email the member can't be told in advance:**
    - The **sign-in page** shows the notice to that member on their next sign-in attempt, before and after signing in: "An admin reset your account on *date*. If this wasn't expected, contact an owner." This uses `users.pending_security_notice`, so it shows even if the link holder changed the password.
    - **Every owner sees the member flagged** on the member list ("Recovery link issued by *Admin* on *date*") until an owner acknowledges it.
  - Issuing one is audited.
- **All owners locked out:** owner recovery through the `RECOVERY_TOKEN` secret (TDD §8.1).

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
  - disable and re-enable; delete (anonymise, PRD §10.2); change email; issue a recovery link; sign out all sessions.

  **Admins can do these for members only; for admins and owners, an owner must act** (permissions §6 Admin powers). What disabling and deleting do in each feature is set out in platform §3 Member lifecycle.
- **Email change:**
  - When email is configured, the new address must be confirmed before it takes effect. The pending address is held in an `email_change` token's payload. The link opens a confirmation page (GET), and only its POST applies the change (platform §10 Email links).
  - The **old address is notified**: "Your Officebox email was changed to *new* by *Admin Name* on *date*". The person also gets a `security_notice` inbox item and the sign-in banner (`pending_security_notice`).
  - **All pending magic-link, password-reset and recovery tokens are revoked.**
  - It's audited.
- **Ownership:** transfer it, or add more owners. The last owner can't be demoted, disabled or deleted.
- **Default channels:** choose which **public** channels new members join **(default)**.
- **Policies:**
  - allowed invite domains
  - whether magic-link sign-in is enabled (default on when email is configured)
  - the minimum password length (raise only; **owners only**, platform §7 Admin settings).
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

CREATE TABLE passkeys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE,                      -- base64url
  public_key TEXT NOT NULL,                                -- COSE key, base64url
  sign_count INTEGER NOT NULL DEFAULT 0,
  transports TEXT,                                         -- JSON
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);

CREATE TABLE auth_tokens (                                 -- magic links, password resets, recovery links
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                                      -- magic_link | password_reset | recovery | email_change (Zod-validated)
  issued_by TEXT REFERENCES users(id),                     -- admin or owner, for recovery links and email changes
  payload TEXT,                                            -- JSON; email_change: { "newEmail": "..." }
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);

-- invitations: (email NOT NULL is in the baseline table); add groups
ALTER TABLE invitations ADD COLUMN group_ids TEXT;         -- JSON array

-- security notices for admin-initiated actions (one mechanism: this banner + the security_notice inbox item)
ALTER TABLE users ADD COLUMN pending_security_notice TEXT; -- JSON: shown on the sign-in page and after sign-in (recovery link issued, email changed)
ALTER TABLE users ADD COLUMN admin_reset_at INTEGER;        -- recovery link issued without email: flagged to owners
ALTER TABLE users ADD COLUMN admin_reset_by TEXT;
ALTER TABLE users ADD COLUMN admin_reset_acknowledged_by TEXT;

-- groups: add handle and managers
ALTER TABLE groups ADD COLUMN handle TEXT;               -- copy of the authoritative handles row
ALTER TABLE group_members ADD COLUMN role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('manager', 'member'));

-- sessions: device info for "My devices"
ALTER TABLE sessions ADD COLUMN device_label TEXT;         -- e.g. "Chrome on macOS"
ALTER TABLE sessions ADD COLUMN approx_location TEXT;      -- from request.cf (city/country), if available; deleted with the session
ALTER TABLE sessions ADD COLUMN previous_refresh_hash TEXT; -- refresh grace window: the token just rotated away
ALTER TABLE sessions ADD COLUMN rotated_at INTEGER;         -- when it was rotated (grace window 30 s)
```

Settings keys (defined in platform §7 Admin settings): `default_channels`, `welcome_post_enabled`, `allowed_invite_domains`, `magic_link_enabled`, `min_password_length`.

## 6. API (summary)

| Method and path | Who | Purpose |
|---|---|---|
| `POST /setup` | Setup token | Create workspace and owner (name, @handle, email, password) |
| `GET /me` | Member | Current user: profile, role, preferences summary, pending security notice |
| `POST /auth/password` | Public | Sign in with password (replaces TDD §3.1's `POST /auth/session`) |
| `POST /auth/magic-link` | Public | Request a magic link |
| `GET /auth/magic-link/:token` · `POST /auth/magic-link/:token` | Public | GET shows the confirmation page (doesn't use the token); POST signs in |
| `POST /auth/passkey/options` · `POST /auth/passkey/verify` | Public | WebAuthn sign-in |
| `POST /auth/refresh` · `POST /auth/sign-out` | Session | Rotate (with the 30 s grace window), or sign out |
| `POST /auth/ws-ticket` | Member | One-time WebSocket ticket for non-browser clients (realtime API, TDD §3.1; listed here for completeness) |
| `GET /me/sessions` · `DELETE /me/sessions/:id` · `POST /me/sessions/sign-out-others` | Member | My devices |
| `POST /me/passkeys/options` · `POST /me/passkeys` · `PATCH/DELETE /me/passkeys/:id` | Member | Manage passkeys |
| `PUT /me/password` | Member | Set or change password |
| `GET/PATCH /me/profile` · `PUT /me/avatar` · `PUT /me/status` | Member | Profile and status |
| `POST /auth/forgot` · `GET /auth/reset/:token` · `POST /auth/reset/:token` | Public | Password reset by email (GET shows the form; POST uses the token) |
| `GET /auth/recover/:token` · `POST /auth/recover/:token` | Recovery link | Set a password or passkey (GET shows the form; POST uses the token) |
| `GET /me/email/confirm/:token` · `POST /me/email/confirm/:token` | Public | Confirm an email change (GET shows the confirmation page; POST applies it) |
| `GET /invitations/:token` · `POST /invitations/:token/accept` | Public | Accept an invitation |
| `GET/POST /admin/invitations` · `POST …/:id/resend` · `DELETE …/:id` | Admin | Manage invitations |
| `GET /members` · `GET /members/:id` | Member | Directory |
| `PATCH /admin/members/:id` (role, email, status) · `POST …/:id/recovery-link` · `DELETE …/:id` | Admin (members only); owner (admins and owners) | Administer members |
| `POST /admin/members/:id/acknowledge-reset` | Owner | Clear the owners' "recovery link issued" flag |
| `GET/POST /groups` · `PATCH/DELETE /groups/:id` · `PUT/DELETE /groups/:id/members/:userId` | Admin / manager (an admin adding themselves needs an owner) | Groups |
| `GET /handles/:handle/available` | Member | Handle check |

## 7. Screens

1. Setup (token, then owner and workspace)
2. Sign in (email, then password / link / passkey; passkey-first button)
3. Magic link "check your email" page and confirmation
4. Accept invitation, then profile setup, then the tour
5. Forgot password, reset password, recovery link
6. Profile settings: profile, status, sign-in methods (password, passkeys), my devices
7. Member directory and profile card
8. Admin: members, invitations, groups, default channels, policies, audit log

## 8. Edge cases

- **An invitation accepted twice.** Only the first succeeds, enforced with an atomic update.
- **An invited email that becomes a member another way.** The pending invitation is revoked automatically.
- **Last sign-in method.** Removing the last passkey when there's no password is blocked with an explanation.
- **Lost device with an active session.** The member can sign it out from another device, or an admin can sign out all sessions.
- **Handle collision during onboarding** (two people choosing the same handle at once). A unique constraint resolves it, and the loser is asked to pick another.
- **Email not configured.** Magic-link and "forgot password" options are hidden, and recovery is done with admin recovery links.
- **Time zone changes** (someone travels). The browser offers "Update your time zone to Europe/Berlin?" **(default)**.
- **Domain change or restore.** Passkeys stop working (§4.4). Members with a password sign in and re-register passkeys; passkey-only members need an admin recovery link.
- **Admin acting on an admin or owner.** The action is refused with "An owner must do this."
- **Email changed while a magic link is outstanding.** The old link no longer works (tokens revoked).
- **Two tabs refresh at once.** Both receive the same successor token within the 30-second grace window; neither is signed out.
- **Recovery link issued with no email configured.** The member sees the notice on the sign-in page; owners see the flag on the member list until acknowledged.

## 9. Acceptance criteria

- **Setup (M1):** a fresh deploy can't be claimed without the token. Setup creates the owner (with handle) and default settings, and nothing that belongs to later milestones.
- **Provisioning (later milestones):** M3a, M5a and M6a each have a test that a workspace set up before them gets its `#general` and default-channel memberships, calendars, and drives and folders from the backfill, and that running the backfill twice changes nothing.
- **Invitations:**
  - link and email invitations both work end to end, including when email isn't configured
  - expired, revoked and used invitations are refused
  - members can't invite; admins can invite members but **not** admins; owners can invite admins.
- **Sign-in:**
  - password, magic link and passkey sign-in each work end to end
  - opening a magic, reset or recovery link with GET doesn't use the token; only the confirmation POST does
  - the magic-link request response is identical for existing and non-existing emails
  - passkey-only members can sign in and can recover through an admin recovery link
  - registering a passkey on a `*.workers.dev` host shows the domain warning
  - a passkey assertion whose `sign_count` is lower than, or equal to, a non-zero stored value is rejected as `clone_detected`; an authenticator that always reports 0 still signs in.
- **Passkeys:**
  - a member can add, rename and remove passkeys
  - removing the last sign-in method is refused
  - an owner can't remove their password
  - promoting a passkey-only member to owner requires a password first.
- **Sessions** (tested with an injected clock):
  - a session unused for 30 days is rejected; one used on day 29 is extended
  - "sign out" for a single session and for all other devices works
  - changing the password signs out other sessions
  - two concurrent refreshes with the same token within 30 seconds both succeed with the same successor; reusing a token after the grace window revokes the session
  - disabling a member closes their open connections within 5 seconds, and their REST requests fail within 60 seconds.
- **Rate limits:** the 6th failed password attempt within a minute from one IP, and the 11th within an hour for one account, are delayed. The per-account delay follows the schedule in §4.4 (1 s, 2 s, 4 s … capped at 30 s), checked with an injected clock. The account isn't locked: a correct password after the delay succeeds.
- **Admin powers:**
  - an admin can disable, delete, change the email of and issue a recovery link for a **member**
  - the same actions on an **admin or owner** return 403 for an admin and succeed for an owner
  - the last owner can't be demoted, disabled or deleted.
- **Notifications of admin actions:**
  - issuing a recovery link or changing an email sends an email to the person's **old** address (when email is configured)
  - it creates a `security_notice` inbox item and the sign-in banner
  - with email **not** configured, the recovery notice appears on the sign-in page for that member, and the member is flagged to every owner until acknowledged
  - it revokes their pending magic-link, reset and recovery tokens, which then fail.
- **Recovery link flow:** the link lets the member set a password or add a passkey, signs out their other sessions, and can't be used twice.
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

TOTP two-factor · Google/Microsoft or SSO sign-in · guests · member self-service email change, account deletion or data export · custom roles.

## 11. Open questions

1. **Team field.** Free text, or chosen from the member's groups (a "primary group")? The second keeps the directory consistent.
2. **Allowed invite domains.** Off by default, or on and set to the owner's domain at setup?
3. **Welcome post wording and channel.** Always `#general`, or configurable?
4. ~~**WebAuthn library and PBKDF2 limit.**~~ Answered by the M0 foundation spike ([foundation spike](../spikes/foundation/README.md)): `@simplewebauthn/server` runs in Workers; PBKDF2 uses 100k plus an HMAC pepper (§4.4); the production probe confirmed the 100k cap.

**Still pending in other documents:** TDD §3.1 and §8.1 should add the refresh grace window, the per-request `session_epoch` check and the `email_change` token kind. (The PBKDF2 decision is now in TDD §8.1.)

# Spec: Identity & Access

**Status:** Draft for review
**Feature name:** Identity & Access (marketing name to be decided later)
**Milestone:** M1 ([PLAN](../PLAN.md)) · **Related:** PRD §6, §10.1; TDD §3.1, §6.8, §8.1

Decisions marked **(default)** were not discussed; change them on review.

## 1. Summary

Identity & Access covers:
- setting up a workspace
- getting people in (invitations and onboarding)
- signing in (password, magic link, passkey)
- keeping sessions safe
- describing people (profiles, handles, directory)
- organising them (roles and groups).

Every other feature relies on its permission engine.

## 2. Decisions

| Topic | Decision |
|---|---|
| Sign-in methods at launch | **Email + password**, **magic link by email**, **passkeys** |
| Google/Microsoft sign-in | Later. SSO comes through Cloudflare Access in Phase 2 (PRD §6). |
| Two-factor (TOTP) | **After launch** (Phase 2) |
| Passkey-only accounts | **Allowed.** Password is optional if the member has a passkey. |
| Who can invite | **Owners and admins only** |
| Mentions | **Unique @handles** alongside display names |
| Session length | **30 days, sliding** |
| Member self-service | **See and sign out own devices.** Email change and account deletion are admin actions. |
| Profile fields | Name, @handle, avatar, time zone, working hours, region, **job title, team, pronouns, phone, location/office** |
| Copy-link invites | **The admin enters the invitee's email**, and the link is bound to it |
| After accepting an invite | **Profile setup step → auto-join default channels → welcome post in #general → short welcome tour** |
| Magic link | **Single-use, 15 minutes, works on any device** |
| Groups | **Admins create groups and appoint group managers**, who manage membership |
| @group mentions | **Yes.** Notifies group members who can see the conversation. |
| Directory | **Everyone sees everyone's contact details** |
| Guests | **Phase 2** (the role value is reserved in the schema) |

## 3. Users and roles

| Role | Can |
|---|---|
| **Owner** | Everything an admin can, plus manage owners and admins, transfer ownership, installation settings (upgrades, export, email, policies). At least one active owner must exist. |
| **Admin** | Invite; disable and delete members; change members' email; issue recovery links; manage groups and group managers; set default channels; workspace settings except owner-only ones; view the audit log. |
| **Member** | Use the workspace, edit their own profile, manage their own sign-in methods and devices. |
| **Group manager** | A member (or admin) who manages one group's membership. This is a property of group membership, not a workspace role. |
| *Guest* | Phase 2 |

Admins can't read private content they haven't been given access to (PRD §10.1).

## 4. Functional requirements

### 4.1 First-run setup

- Protected by the setup token: the deploy secret, or a one-time token generated into Workers Logs (TDD §6.8). The claim is atomic, and `/setup` returns 404 afterwards.
- Setup collects the workspace name and the owner's name, @handle, email and password. The owner can add a passkey straight away.
- Setup creates `#general` (the default channel) and the owner's personal calendar (needed by calendar).
- **Restore from export** is offered as an alternative path (PRD §13, TDD §7.5).

### 4.2 Invitations

- Only owners and admins invite. Each invitation has an **email** (always required), a **role** (admin or member) and optional **groups** to join.
- **Delivery:**
  - by email, if email is configured
  - always as a **copy link** that works without email.
- The link is bound to the invitation's email; the invitee can't change it.
- Invitations are **single-use** and **expire after 7 days** **(default)**. Admins can **resend**, **copy again** (same link while it's valid) and **revoke**.
- Inviting an email that already belongs to an active member is refused. A disabled member is offered "re-enable" instead.
- An optional **allowed email domains** setting restricts who can be invited **(default: off)**.
- The pending invitations list shows email, role, inviter, sent and expiry, and status.

### 4.3 Accepting an invitation and onboarding

The flow runs in this order:

1. **Create the account.** The email is shown and fixed. The invitee enters a display name and **@handle**, suggested from their name. They then either set a **password**, **register a passkey**, or both. At least one is required.
2. **Profile setup.**
   - avatar (optional)
   - **time zone**, pre-filled from the browser
   - **working hours**, default Mon–Fri 09:00–17:00 local
   - **region** for public holidays, pre-filled from the time zone
   - job title, team, pronouns, phone and location (all optional).
3. **Auto-join default channels.** Admins choose these; `#general` is always included.
4. **Welcome post.** A system message in `#general`: "*Sam Lee* joined the workspace".
5. **Welcome tour.** Four or five dismissible tips covering chat, calls, calendar and documents. They can be replayed from Help, and dismissal is stored per member.

An invite opened by someone already signed in as another member shows "You're signed in as X. Sign out to accept."

### 4.4 Sign-in

- **One sign-in page**, with the email field first, offering:
  - **Password**
  - **Email me a sign-in link.** Shown only when email is configured.
  - **Use a passkey.** Uses WebAuthn with discoverable credentials, so a passkey can sign in without typing an email.
- **Passwords:**
  - at least 10 characters, checked against a bundled common-password list, no composition rules **(default)**
  - PBKDF2-SHA256 at 600k iterations in a versioned format (TDD §8.1).
- **Magic links:**
  - single-use, valid for **15 minutes**, open on **any device**
  - sent only to active members with an email
  - the page shows the same message whether or not the account exists, so it doesn't reveal which emails have accounts.
- **Passkeys:**
  - members can register several, each with a name and a "last used" time; they can rename and remove them
  - removing the last sign-in method is blocked: a member always keeps a password or at least one passkey.
- **Rate limits:** progressive delays per IP and per account (TDD §8.1). There is no hard lockout.
- **Disabled and deleted members** can't sign in. They see a generic "can't sign in" message.

### 4.5 Sessions

- `HttpOnly`, `Secure`, `SameSite=Lax` cookies: a 15-minute access token and a refresh token that rotates, with reuse detection (TDD §3.1).
- **30-day sliding expiry.** Each refresh extends the session.
- **My devices:**
  - a list of active sessions showing browser and OS, approximate location if available, created and last-seen times, and which one is the current device
  - **sign out** any session, or **sign out all other devices**.
- **Changing your password signs out your other sessions (default).** Removing a passkey does not.
- **Disabling a member** bumps `session_epoch` and closes all their open connections within seconds (TDD §3.5).

### 4.6 Account recovery

- **With email configured:** "Forgot password?" sends a single-use reset link valid for 1 hour. The member sets a new password and can add a passkey.
- **Without email, or when all passkeys are lost:** an **admin issues a one-time recovery link** to copy and share privately.
  - It is valid for 24 hours **(default)**.
  - It lets the member set a password or register a new passkey, and signs out their existing sessions.
  - Issuing one is audited.
- **All owners locked out:** owner recovery through the `RECOVERY_TOKEN` secret (TDD §8.1).

### 4.7 Profiles

| Field | Required | Notes |
|---|---|---|
| Display name | Yes | 1–64 characters |
| @handle | Yes | Unique; rules in §4.8 |
| Email | Yes | Changed by admins only |
| Avatar | No | Image upload, square-cropped and stored in R2; initials are shown otherwise |
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
- Reserved words: `channel`, `here`, `everyone`, `all`, `admin`, `admins`, `owner`, `system`, `officebox`.
- Members can change their handle at any time **(default)**. Mentions are stored by user ID, so old messages show the new handle. A released handle can't be claimed by someone else for 30 days **(default)**.

### 4.9 Groups

- Admins create, rename and delete groups. Each group has a **name**, an **@handle**, a description and **managers**.
- **Group managers** add and remove members of their group. Admins can manage any group.
- **Uses:**
  - @group mentions (notify members who can see the conversation)
  - permission grants on documents, channels and calendars
  - group calendars
  - "invite this group" shortcuts.
- Deleting a group removes its grants (audited) and archives its group calendar.

### 4.10 Member directory

- **Visible to every member:** name, handle, avatar, title, team, pronouns, email, phone, location, local time, status and groups.
- Search by name, handle, email, title, team or group, and filter by group.
- Disabled members appear under a **Deactivated** filter. Deleted members appear only as "Former member" in content.

### 4.11 Administration

- **Members:** invite; change role (owners manage admins and owners); disable and re-enable; delete (anonymise, PRD §10.2); change email; issue a recovery link; sign out all sessions.
- **Ownership:** transfer it, or add more owners. The last owner can't be demoted, disabled or deleted.
- **Default channels:** choose which channels new members join.
- **Policies:**
  - allowed invite domains
  - whether magic-link sign-in is enabled (default on when email is configured)
  - the minimum password length (raise only).
- **Audit log** entries for:
  - setup, invitations, role changes, disable and delete
  - email changes, recovery links, ownership changes
  - group changes and policy changes.

## 5. Data model (additions to TDD §2.1)

```sql
-- users: extend
ALTER TABLE users ADD COLUMN handle TEXT;                  -- unique, lowercase (with groups.handle, one namespace)
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
  kind TEXT NOT NULL CHECK (kind IN ('magic_link', 'password_reset', 'recovery')),
  issued_by TEXT REFERENCES users(id),                     -- admin, for recovery links
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);

-- invitations: email becomes NOT NULL; add groups
ALTER TABLE invitations ADD COLUMN group_ids TEXT;         -- JSON array

-- groups: add handle and managers
ALTER TABLE groups ADD COLUMN handle TEXT;
ALTER TABLE group_members ADD COLUMN role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('manager', 'member'));

-- sessions: device info for "My devices"
ALTER TABLE sessions ADD COLUMN device_label TEXT;         -- e.g. "Chrome on macOS"
ALTER TABLE sessions ADD COLUMN approx_location TEXT;      -- from request.cf (city/country), if available
```

Settings keys: `default_channels`, `allowed_invite_domains`, `magic_link_enabled`, `min_password_length`.

## 6. API (summary)

| Method and path | Who | Purpose |
|---|---|---|
| `POST /setup` | Setup token | Create workspace and owner |
| `POST /auth/password` | Public | Sign in with password |
| `POST /auth/magic-link` · `GET /auth/magic-link/:token` | Public | Request and consume a magic link |
| `POST /auth/passkey/options` · `POST /auth/passkey/verify` | Public | WebAuthn sign-in |
| `POST /auth/refresh` · `POST /auth/sign-out` | Session | Rotate, or sign out |
| `GET /me/sessions` · `DELETE /me/sessions/:id` · `POST /me/sessions/sign-out-others` | Member | My devices |
| `POST /me/passkeys/options` · `POST /me/passkeys` · `PATCH/DELETE /me/passkeys/:id` | Member | Manage passkeys |
| `PUT /me/password` | Member | Set or change password |
| `GET/PATCH /me/profile` · `PUT /me/avatar` · `PUT /me/status` | Member | Profile and status |
| `POST /auth/forgot` · `POST /auth/reset/:token` | Public | Password reset by email |
| `POST /auth/recover/:token` | Recovery link | Set a password or passkey |
| `GET /invitations/:token` · `POST /invitations/:token/accept` | Public | Accept an invitation |
| `GET/POST /admin/invitations` · `POST …/:id/resend` · `DELETE …/:id` | Admin | Manage invitations |
| `GET /members` · `GET /members/:id` | Member | Directory |
| `PATCH /admin/members/:id` (role, email, status) · `POST …/:id/recovery-link` · `DELETE …/:id` | Admin | Administer members |
| `GET/POST /groups` · `PATCH/DELETE /groups/:id` · `PUT/DELETE /groups/:id/members/:userId` | Admin / manager | Groups |
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

## 9. Acceptance criteria

- **Setup:** a fresh deploy can't be claimed without the token; setup creates the owner, `#general` and the owner's calendar.
- **Invitations:**
  - link and email invitations both work end to end, including when email isn't configured
  - expired, revoked and used invitations are refused
  - only admins can invite.
- **Sign-in:**
  - all three methods work end to end
  - passkey-only accounts can sign in and recover through an admin recovery link
  - the magic-link response doesn't reveal whether an account exists.
- **Sessions:**
  - expire after 30 days without use
  - "sign out" for a single session and for all other devices works
  - disabling a member closes their open connections within 5 seconds.
- **Handles:** handles are unique across people and groups; reserved words are refused.
- **Groups:** group managers can manage only their own groups; @group mentions notify only members who can see the message.
- **Audit and abuse protection:**
  - every admin action in §4.11 writes an audit entry
  - rate limits slow down repeated failed sign-ins without locking the account.

## 10. Out of scope (this milestone)

TOTP two-factor · Google/Microsoft or SSO sign-in · guests · member self-service email change, account deletion or data export · custom roles.

## 11. Open questions

1. **Team field.** Free text, or chosen from the member's groups (a "primary group")? The second keeps the directory consistent.
2. **Allowed invite domains.** Off by default, or on and set to the owner's domain at setup?
3. **Welcome post wording and channel.** Always `#general`, or configurable?
4. **WebAuthn library.** We need to confirm a maintained library (for example SimpleWebAuthn) runs in Workers. Otherwise we implement verification directly with WebCrypto.

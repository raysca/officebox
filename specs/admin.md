# Spec: Admin & Operations

**Status:** Draft for review
**Revision:**
- First draft written after four rounds of product-owner questions (15 Nov 2026).
- Revised after the independent review (15 Nov 2026):
  - private-only data in exports made explicit
  - the per-member export gate treated as a process control
  - maintenance state held in D1, with write exemptions and a consistency barrier
  - a step-up re-authentication design
  - export retention and erasure rules
  - external alerting kept for outages of the alert path
  - per-subject alerts with hysteresis
  - exports packed into one R2 object
  - wider changes to other documents.

**Feature name:** Admin (the admin area) and Operations (health, storage, usage, export, maintenance, updates)
**Milestone** ([PLAN](../PLAN.md)): M7, which grows alongside the features. Export and restore must ship before the first customer.

**Related specs:**
- [Identity & Access](identity.md) §4.4, §4.5, §4.11: sign-in, sessions, members, invitations, groups, policies
- [Permissions](permissions.md) §4.1, §6, §11: admin powers and the privacy statement
- [Notifications](notifications.md) §3, §5, §6
- [Platform](platform.md): lifecycle §3, retention §5, export §6, settings §7, limits §8, email links §10, timers §11, API §15
- [Assistant](assistant.md) §7.1, §10, §13

**Related PRD and TDD sections:** PRD §10, §13; TDD §2.1, §6.1, §6.3–§6.8, §7.1–§7.9

Decisions marked **(default)** were not discussed; change them on review.

**Cross-cutting rules:** permissions follow [Permissions](permissions.md); notifications follow [Notifications & Attention](notifications.md); lifecycle, retention, export, settings, limits and timers follow [Platform Rules](platform.md). Those specs win on cross-cutting rules. §19 lists the changes those documents need.

## 1. Summary

The admin area is where owners and admins run the workspace. It brings into one place things now spread across the PRD, the TDD and several specs:
- members, invitations and groups, with bulk tools
- every workspace setting
- the audit log
- health, alerts and the post-deploy checklist
- storage and protective mode
- usage and cost
- workspace exports, per-member data exports and restore
- maintenance mode
- updates.

Most mechanics already exist in the TDD (§6–§7). This spec decides **who** can do what, **how** they hear about problems, and the **policies** around exporting data.

Officebox is a workspace for an organisation, not a public service. Exporting data is therefore an **admin power**:
- Owners and admins can export the whole workspace, including private content.
- They can run a per-member export when someone makes a data-protection request.
- Members can't export data themselves.

Every export is audited and disclosed in the privacy statement.

## 2. Decisions

| Topic | Decision |
|---|---|
| Owner and admin split | **Split by risk.** Owners alone: upgrades and channel, usage and cost, the post-deploy checklist, telemetry and diagnostics, maintenance mode. Owners and admins: members, groups, invitations, workspace settings (per key, Platform §7), the audit log, health, storage, assistant oversight (Assistant §10–§11), and **exports**. |
| Who exports data | **Owners and admins only.** This is an organisation's workspace. Owners hold every admin power, so "admins" below includes owners. |
| Export contents | **Everything, including private content**, so a restore is complete. That covers DMs, group DMs, private channels, restricted documents, **time-off type and note, and personal reminders**. Exceptions: credentials (Platform §6), and assistant memory, which no admin can read. *Including time-off notes and reminders follows from "admins export everything" and changes Permissions §11 and Assistant §7.1 and §13. Flagged for the product owner.* |
| Disclosure | **Privacy statement and audit log** **(default)**. The privacy statement says admins can export everything, including private content. Every export is audited. Members see no history of **workspace** exports. |
| Member self-export | **None.** Members can't download their own data. This **removes** "Download my assistant data" from the approved Assistant spec (§19). |
| Data-protection requests | **Admin per-member export.** An admin runs an export scoped to one member and hands it over. The member gets a confirmation notice (§12). |
| Owner gate on per-member exports | **A process control, not a security boundary.** An export of an admin or owner needs an owner. But any admin can export the whole workspace, which includes the same content, so the gate is about procedure and the notice, not secrecy. |
| Assistant memory | **Not exportable by anyone.** It lives only in each member's private Assistant DO. Members can see it in "What Butler remembers". |
| Export retention | **On-demand exports are deleted after 30 days** **(default)**. Scheduled exports keep the latest 4. Per-member exports are deleted after 7 days **(default)**. |
| Exports and erasure | **Exports aren't rewritten** when a member is deleted. Expiry bounds how long a deleted member's data survives in an archive. The privacy statement says so. |
| Downloads | **Step-up re-authentication.** Downloading an export, or a CSV of members or audit entries, needs authentication within the last **10 minutes (default)** (§11.3). |
| Audit log | **Full viewer** for owners and admins: filter by person, action, target and date; download as CSV; kept **365 days** by default, changeable by owners. Entries never contain content or secrets. |
| Alerts | **Banner, inbox item and email.** A persistent admin banner and an inbox item for owners and admins. **Owners** also get email for serious alerts. Admins are in-app only. |
| Alerting when Officebox itself is down | **Cloudflare's own notifications** cover outages of the alert path (a D1 or Worker outage). Setting them up is a required checklist item (§15). |
| Scheduled exports | **Off by default, nudged.** When an owner or admin turns them on: weekly, files included, the latest 4 kept. |
| Auto-upgrade | **Off by default; owner opt-in** to `security` or `patch` auto-merge on the stable channel, in the repository's `.officebox/config.json` (TDD §6.3). Minor and major releases always need a manual merge. |
| Maintenance mode | **Owners schedule it or start it now**, with an optional message. Everyone sees a banner beforehand and during. Reading works; writes are refused, except the exemptions in §13. |
| Degraded services | **Small notice where the feature is used.** No workspace-wide alarm. Details stay on the admin health page. |
| Bulk member tools | **CSV invite, bulk group changes, bulk disable and member CSV download** at launch. |

## 3. The admin area

One **Admin** section in the app, shown only to owners and admins.

Each page shows only what the viewer may do. Controls they can't use are shown with `aria-disabled` and a visible, associated reason ("Only owners can change this"), so keyboard and screen-reader users can reach the explanation.

| Page | Owners | Admins | What it holds |
|---|---|---|---|
| **Overview** | ✓ | ✓ | Open alerts, health summary, installed version, setup progress (owners), last export, restore report (§11.4) |
| **Members** | ✓ | ✓ (members only, Permissions §6) | Member list, profiles, roles, status, recovery, bulk tools (§5) |
| **Invitations** | ✓ | ✓ | Pending invitations, copy links, CSV invite (§5.1) |
| **Groups** | ✓ | ✓ | Groups and their members (Identity §4.9) |
| **Settings** | ✓ | ✓ per key | Every Platform §7 setting, grouped (§6) |
| **Audit log** | ✓ | ✓ | Viewer and download (§7) |
| **Health** | ✓ | ✓ | Service checks (§8) |
| **Storage** | ✓ | ✓ (owners set budgets) | Store levels, protective mode, ways to free space (§9) |
| **Usage & cost** | ✓ | — | Usage against allowances, projected overage (§10) |
| **Assistant** | ✓ | ✓ (owners: models, budget, index deletion) | Assistant usage aggregates and the interaction metadata log (Assistant §10–§11) |
| **Data** | ✓ | ✓ | Workspace exports, schedule, per-member exports (§11, §12) |
| **Maintenance** | ✓ | view only | Schedule, start, reschedule or end maintenance (§13) |
| **Updates** | ✓ | view only | Version, channel, release notes, the upgrade pull request (§14) |
| **Setup checklist** | ✓ | — | Post-deploy steps and their status (§15) |
| **Telemetry & diagnostics** | ✓ | — | Telemetry opt-in with payload preview; support bundle (§8.3) |

**Accessibility.** Everything in the admin area is keyboard-operable, labelled and checked with axe (AGENTS §4.3).
- Statuses are shown as text, never colour alone.
- Progress for exports and bulk actions is announced in a polite live region.
- Tables have row and column headers.
- Banners never move focus.

## 4. Alerts

Alerts tell owners and admins about problems without them having to watch the health page. Each alert has a **kind** and a **subject**. One record is kept per `<kind>:<subject>`, for example `storage:d1` or `service_down:email`.

| Alert kind | Subject | Raised when | Severity | Who | Clears when |
|---|---|---|---|---|---|
| `storage` | `d1`, `r2`, or a DO ID | D1 at 70 % or 85 %; a DO over 5 GB; R2 over the soft budget (TDD §7.7) | Warning | Owners, admins | **5 points below** the threshold that raised it (hysteresis) |
| `protective_mode` | `d1` | D1 at 95 % | **Serious** | Owners, admins | Under 90 % |
| `d1_copy_paused` | `d1` | D1 at 98 % | **Serious** | Owners, admins | Under 95 % |
| `export_failed` | `workspace` or `member` | That kind of export fails | **Serious** | Owners, admins | An export of the **same kind** succeeds |
| `no_recent_export` | `workspace` | No complete workspace export in **30 days (default)**, whether or not scheduled exports are on | Warning | Owners, admins | A workspace export completes |
| `check_failing` | `do`, `r2`, `vectorize` | A required check fails on **two consecutive** runs | **Serious** | Owners, admins | Passes on two consecutive runs |
| `service_down` | `email`, `sfu`, `ai`, `link_previews` | An optional service fails on two consecutive runs | Warning | Owners, admins | Passes on two consecutive runs |
| `security_release` | the version | A security release isn't installed after 48 hours (TDD §6.7) | **Serious** | Owners | Installed |
| `release_sync_stuck` | — | The installation is behind the latest release on its channel for 7 days (TDD §6.4: the workflow may be disabled) | Warning | Owners | Installed |
| `schema_ahead` | — | Applied migrations are ahead of the running code (TDD §6.5): a deploy or rollback may have failed | **Serious** | Owners | Code catches up |
| `projection_backlog` | queue name | Outbox lag or a dead-letter queue over its threshold (TDD §7.1) | Warning | Owners, admins | Back under |
| `maintenance_overran` | window ID | Maintenance passed its planned end by **1 hour (default)** | Warning | Owners | Maintenance ends |
| `assistant_budget` | — | The assistant budget passes 80 % or 100 % (Assistant §10.2) | Warning | Owners, admins | The next month starts |

A D1 or Worker outage can't be recorded or raised by Officebox, because alerts live in D1 and run in the Worker. Those outages are caught by **Cloudflare's own notifications**, which the setup checklist requires (§15).

**Delivery:**
- **Banner:** every open warning or serious alert shows a persistent banner in the admin area. Serious ones also show at the top of the app for owners and admins.
- **Inbox:** each alert record is one inbox item of type `admin_alert`, keyed `admin_alert:<kind>:<subject>`, so repeats update the same item (Notifications §3).
- **Email:** serious alerts are emailed to **owners**.
  - One email when raised and one when cleared.
  - **Raise** emails are limited to one per alert record per 24 hours **(default)**; clear emails aren't limited.
  - Content names the alert and links to the admin area (with the origin from the request, Platform §10). It contains no member names or content.
- **Do not disturb:** follows Notifications §5. The inbox still records the item, while banners and email are held. `check_failing` and `protective_mode` emails break through DND **(default)**.
- **Dismissal:** info and warning alerts can be dismissed. A dismissed alert stays quiet while its condition holds, and is raised again if it clears and recurs. Serious alerts can't be dismissed.

**How checks run:**
- The cron dispatcher (TDD §7.8) runs the checks every **5 minutes (default)**, using cheap probes: no real email, model calls or SFU sessions.
- Only the dispatcher writes `health_checks` and `admin_alerts`, using compare-and-set on the stored state, so concurrent runs can't send duplicate emails.
- The health page reads the stored state; loading it never raises alerts.

## 5. Members

Member management follows Identity §4.11 and Permissions §6: admins act on members only, and actions on admins or owners need an owner. This spec adds bulk tools and list features.

- **Member list:** search, and filter by role, status (active, invited, disabled), group and last active.
  - Columns: name, handle, email, role, status, groups, last active, joined.
  - **Last active** is the date (day only) of the member's last session refresh **(default)**.
- **Flags:** members with a no-email recovery link or a pending security notice are flagged (Identity §4.6).

### 5.1 CSV invite

1. **Upload.** An admin uploads a CSV with these columns:
   - `email` (trimmed and lower-cased)
   - `role` (optional; `member` or `admin`, default `member`)
   - `groups` (optional; group handles separated by `;`).
2. **Preview.** Nothing is sent before the preview. Each row shows one of:
   - ready
   - already a member
   - already invited
   - duplicate in this file
   - invalid email
   - domain not allowed (`allowed_invite_domains`)
   - unknown group
   - role not allowed: admins can't invite admins, and `owner` or `guest` can't be invited by CSV.
3. **Send.** The admin removes or fixes rows, then sends. Only ready rows are invited.
4. **Limits:**
   - Up to **500 rows per upload (default)**.
   - Invitation sending is limited to **200 per workspace per day (default)**, a new Platform §8 row.
   - Rows beyond the limit, or beyond the email provider's daily quota (TDD §7.6), stay **pending**. They are sent the next day, or can be shared with copy links from the Invitations page one by one.
5. **Results.** Each row has its own result. Re-sending the same file skips rows already invited, so it's idempotent.
6. **Audit.** Each invitation is audited individually, plus one `members.invite_bulk` entry with the counts.

### 5.2 Bulk group changes

Select members (up to **500 per action (default)**), then **Add to group** or **Remove from group**.

The same rules as single changes apply:
- adding yourself to a group needs an owner (Permissions §6)
- group managers can change their own groups (Identity §4.9).

**Preview and results:**
- The preview lists anyone who can't be changed and why.
- Each member's change succeeds or fails on its own, with a per-member result. A partial failure leaves the successful changes in place.
- Each change is audited, plus one `members.group_bulk` summary.

### 5.3 Bulk disable

Select members (up to **500 per action (default)**), then **Disable**.

**Preview:**
- It lists everyone who will be disabled.
- It also lists anyone who can't be, and why. That includes an admin or owner when the actor isn't an owner, the **actor themselves**, and the last owner.

**Confirming:**
- The actor confirms by typing the number of people **(default)**, in a labelled field.

**Processing:**
- Members are disabled one at a time in a background job. The page shows progress.
- Each member is disabled exactly as a single disable would be (Platform §3), and audited individually, plus one `members.disable_bulk` summary.
- **Last owner:** the check runs in the same D1 transaction as each disable, so concurrent actions can never leave zero active owners.

There is no bulk delete **(default)**, because deletion is irreversible.

### 5.4 Member CSV download

Downloads the current filtered list: name, handle, email, role, status, groups, last active, joined.
- It holds personal data, so it needs step-up re-authentication (§11.3) and is audited (`members.exported`).
- Cells that start with `=`, `+`, `-` or `@` are prefixed with `'`, so spreadsheets don't run them as formulas. The same rule applies to every CSV in this spec.

## 6. Settings

- **Groups.** Every key in Platform §7 appears on the Settings page, grouped as:
  - Workspace
  - Sign-in & security
  - Chat
  - Calls
  - Calendar
  - Documents & files
  - Assistant
  - Email
  - Storage & data.
- **What each setting shows:** its value, its default, who can change it, and when and by whom it was last changed.
- **Owner-only settings** are `aria-disabled` for admins, with the reason.
- **Saving** writes the setting's audit event (Platform §7). Changes take effect within 30 seconds (the settings cache).
- **Missing setup steps.** A setting that depends on a missing step (for example email settings without a provider) links to the checklist item.

## 7. Audit log

- **Viewer:** owners and admins see every entry, newest first.
  - **Filters:** person (actor), action, target type, target, and date range.
  - **Each entry shows:** time, actor (name, or "Former member"), action, target, and readable details from `metadata`.
- **Never content:**
  - Entries never contain message, document or file content, passwords, tokens or secrets.
  - Personal values are redacted when a member is deleted (Platform §3.1).
  - DM and group-DM targets record only the object type, where Permissions §4.1 requires it.
- **Download:** the filtered entries as CSV, with step-up re-authentication (§11.3) and formula escaping (§5.4). The download is audited (`audit.exported`).
- **Retention:** `audit_retention_days`, **365** by default (PRD §10.2). Owners can set it from **90 to 3,650 days** **(default)**. A daily job purges older entries. `export.*` and `member_export.*` entries are kept for at least 365 days, whatever the setting.
- **No editing:** nobody can edit or delete entries through Officebox. Entries change only through retention purges and the erasure redaction above.

**Audit event names used in this spec:**
- **Members:** `members.invite_bulk`, `members.group_bulk`, `members.disable_bulk`, `members.exported`
- **Audit and alerts:** `audit.exported`, `alert.dismissed`
- **Workspace exports:** `export.started`, `export.completed`, `export.failed`, `export.cancelled`, `export.downloaded`, `export.deleted`, `export.expired`
- **Per-member exports:** `member_export.started`, `member_export.downloaded`, `member_export.expired`
- **Maintenance:** `maintenance.scheduled`, `maintenance.rescheduled`, `maintenance.started`, `maintenance.ended`, `maintenance.cancelled`
- **Setup and diagnostics:** `checklist.marked`, `diagnostics.downloaded`, `auth.reauth`
- **Settings:** the events for the new settings keys (§16).

## 8. Health

### 8.1 Health page

Shows each check from TDD §7.1 as **OK**, **Warning** or **Failing**, in text. Each check also shows when its status last changed, and what to do.

The checks:
- Worker and D1
- Durable Objects
- R2
- Vectorize
- AI Gateway and models (when configured)
- Realtime SFU and TURN (when configured)
- email provider (when configured)
- storage levels and protective mode
- outbox lag and dead-letter queues
- failed purge jobs
- installed version against the latest release
- applied migrations against running code.

Results come from the dispatcher runs (§4). The public `/health` endpoint stays minimal (Platform §15). The detailed view is open to owners and admins.

### 8.2 Notices for members

When an optional service is failing, members see a quiet notice **where the feature is used**, never a workspace-wide banner.

| Service | Where members see it |
|---|---|
| Email | The sign-in page, if magic links are affected ("Email sign-in links are unavailable — use your password or passkey"); admins see "Invitations can't be emailed right now — use copy links" on invitation screens |
| Calls | Call buttons are `aria-disabled` with "Calls are unavailable right now" |
| Assistant | The assistant DM says "*Display name* is unavailable right now", using `assistant_display_name` |
| Link previews | Nothing; previews are skipped |
| Search | "Search is catching up — recent messages may be missing" when the projection lags |

The app learns availability from `GET /status`. It returns per-feature flags and the maintenance state only, with no details, to any signed-in member. A socket message, `status.changed`, pushes changes.

### 8.3 Diagnostics bundle

- **Who:** owners download the support bundle described in TDD §7.2, after a **preview** of its full contents.
- **Contents:** it never contains message, document or file content, email addresses or secrets.
- **Audit:** downloading it is audited (`diagnostics.downloaded`). This replaces TDD §7.2's "the admin can download" (§19).

## 9. Storage

- **Store levels:** D1 size against its 10 GB limit (the size source is confirmed at implementation, TDD §7.7), the largest Durable Objects, and R2 usage against any budget, including exports.
- **Owner controls:** owners set `r2_budget_gb`, `r2_hard_budget_gb` and `search_copy_months` here (Platform §7).
- **Protective mode:** the TDD §7.7 list of refused creations applies unchanged. When it's on, the page leads with ways to free space:
  - shorten the search copy
  - empty Trash early
  - enable retention policies
  - delete old exports
  - export and delete archived channels.
- **What members see:** a refused creation fails with "The workspace is low on storage. Ask an admin." Messaging continues.
- **Priority writes:** audit, alert and export-status writes are small, and continue at 95 %. At 98 %, they are the only D1 writes besides the protected ones TDD §7.7 lists.

## 10. Usage & cost

Owners only. Shows the usage panel from TDD §7.9:
- month-to-date usage against the Workers Paid allowances, and projected overage
- Cloudflare's own figures when the optional analytics token is set, otherwise Officebox's counters.

Assistant usage has its own page (§3), shared with admins, as the Assistant spec requires.

A persistent prompt asks owners to set Cloudflare billing notifications until they mark it done, because Cloudflare has no hard spending cap.

## 11. Workspace exports and restore

### 11.1 Exporting

- **Who:** owners and admins. The permission engine checks a new action, `workspace.export`, both when an export starts and when it's downloaded (§19).
- **Contents:** the Officebox export format v1 (TDD §7.5), including all private content (§2). Exceptions follow Platform §6: credentials, assistant memory, and operational tables. Operational tables are `exports`, `maintenance_windows`, `admin_alerts` and `health_checks`, so a restore never starts read-only or with stale alerts.
- **Packing:**
  - The export Workflow writes the parts to `exports/<id>/`, then packs them into a single `export.tar` in R2 with a multipart upload. This keeps downloads within Worker limits.
  - The download streams that one object, and supports `Range` requests, so an interrupted download can resume.
  - The parts are deleted once packing succeeds.
- **One at a time:** only one workspace export runs at a time. Starting another returns `conflict`. A running export can be **cancelled**, and its partial objects are deleted.
- **Failure:** a failed export deletes its partial objects and raises `export_failed`.
- **Schema changes mid-run:** the export records the schema version at the start. If a deploy changes the schema during the run, the export fails with a clear message and can be retried.
- **Storage budgets:**
  - Exports count toward R2 usage.
  - Above `r2_hard_budget_gb`, new exports are refused with a message to delete old ones first.
  - Exports are allowed in protective mode, because they write mostly to R2.
- **On demand:**
  1. Choose whether to include files.
  2. Owners may choose **in maintenance mode** for a fully consistent snapshot (§13.4).
  3. Progress shows on the Data page.
- **Scheduled** (`scheduled_export`):
  - Off by default.
  - When on: weekly, on a chosen weekday, at a time in the **workspace time zone** (from setup), with files included, and the latest **4 complete** exports kept.
  - Older scheduled exports are deleted only after a new one completes.
- **Retention:** on-demand exports are deleted **30 days** after completion **(default)** (`export_retention_days`), which an owner can change. They can also be deleted earlier.
  - Deleting an export that is being downloaded ends the download with an error, never a silently truncated file.
- **Audit:** the `export.*` events, each with actor, export ID and whether files were included.

### 11.2 Exports and erasure

Exports are snapshots and **aren't rewritten** when a member is later deleted. A deleted member's data can therefore remain in an archive until it expires (30 days on demand; 4 weeks for scheduled exports).

- **Restoring an older export.** Restoring an export taken **before** a deletion brings that member's data back. The restore flow warns about this and lists the members who were deleted after the export's date, from the current installation's audit log where available, so an owner can delete them again.
- **Disclosure.** The privacy statement and Platform §3.1 say so.

### 11.3 Step-up re-authentication

Sensitive downloads need **recent authentication**: the export archive, the member CSV, the audit CSV, and per-member export archives.

- **Session field.** `sessions.authenticated_at` records when the member last proved who they are: a password, passkey or magic-link sign-in, or a step-up. A token refresh doesn't update it.
- **Recent window.** If `authenticated_at` is older than **10 minutes (default)**, the download returns `reauth_required`.
- **Re-authenticating.** The app then asks the member to authenticate again with `POST /auth/reauth`, using any method they have:
  - password
  - passkey
  - a one-time magic link to their own email, when email is configured
  - MFA, when it exists.

  Passwordless admins use their passkey or email.
- **Dialog.** Re-authentication is a labelled modal dialog, with focus trapped and Escape to cancel. Each success is audited (`auth.reauth`).

### 11.4 Restore

Restore follows TDD §7.5 and §6.8:
- it's offered on a fresh installation's first-run page and needs the setup token
- the command-line tool covers very large archives.

The Restore Workflow writes a **restore report**, which the Overview shows until an owner dismisses it. The report lists:
- members who must re-register passkeys or need a recovery link (passkey-only members, Identity §4.4)
- members who must re-enrol MFA
- that assistant memory was not restored and the assistant index is being rebuilt
- ICS subscriptions that need their URLs re-entered
- the erasure warning in §11.2.

## 12. Per-member data exports

For data-protection access requests. Members can't run these themselves.

- **Who:** owners and admins. The engine checks `member.export` when the export starts **and** when it's downloaded, including the subject's role at that moment. An export whose subject is, or has since become, an admin or owner needs an owner (a process control, §2).
- **Scope:** everything Platform §6 exports, **filtered to the subject**:
  - **Profile:** profile, preferences and notification preferences.
  - **Messages:** messages they wrote in every conversation, including DMs, with conversation names and their message-owned attachments.
  - **Reactions and saved items:** their reactions, saved items, stars and non-anonymous poll votes.
  - **Documents and files:** documents, whiteboards and files they own, with versions, including items in Trash.
  - **Calendar:** events they organise or attend, their time off (with type and note) and personal reminders.
  - **Comments** they wrote.
  - **Calls:** call-note transcript segments they spoke.
  - **Assistant:** their `assistant_interactions` metadata.
  - **Account:** group memberships, and their sessions list (devices and times, no tokens).
  - **Audit:** audit entries where they are the actor or target.
- **Not included:**
  - other people's messages and content
  - assistant conversations and memory (not readable by admins; the member can see these in "What Butler remembers")
  - credentials.
- **Running:** a Workflow, packed like §11.1. The archive expires **7 days (default)** after completion. Downloads check `expires_at` themselves, and the daily job deletes expired archives.
- **Download:** step-up re-authentication (§11.3); audited (`member_export.*`).
- **Notice to the subject:** a `security_notice` ("An admin exported your data on *date*") **(default)**, delivered as Notifications §3 defines (in-app and email, not held by DND). This is a confirmation of a request, unlike workspace exports, which members aren't told about (§2).
  - A **disabled** subject gets the notice when re-enabled.
  - A **deleted** subject gets none.

## 13. Maintenance mode

**Who:** owners. Admins can see it but not change it.

### 13.1 Windows

- **Starting:** start now, or schedule a start time with an optional planned end and an optional message up to **280 characters (default)**.
- **Validation:** only one window can be scheduled or active at a time. A start in the past means "now". A planned end must be after the start.
- **Changes:** a scheduled window can be **rescheduled** or **cancelled**.
- **Notice:**
  - A banner shows to everyone from **24 hours before (default)**.
  - Every member gets an inbox item (`maintenance_scheduled`, keyed `maintenance:<id>`). A window scheduled less than 24 hours ahead gets its notice immediately.
- **Ending:**
  - An owner ends maintenance, or it ends at its planned end.
  - An owner gets `maintenance_overran` an hour after the planned end.
  - Maintenance ends automatically **24 hours (default)** after it started.

### 13.2 State and timing

The `maintenance_windows` row in D1 is the **source of truth**. Whether maintenance is active is computed from the row and the current time on every read, so a missed timer can never leave the workspace stuck read-only or never starting.

- **Worker:** reads the state through the settings cache (30 seconds at most) and on every start and end action.
- **Durable Objects:** receive it through a config RPC, `setMaintenance(active)`, like `general_read_only`. The cron dispatcher's 5-minute run re-pushes the state as a reconciler.
- **Sockets:** move to read-only and back through `updateAccess` / `access.changed` (Permissions §8), so they don't reconnect. Clients also get `status.changed` (§8.2).
- **Triggers:** ReminderScheduler triggers aren't relied on. The dispatcher applies starts, ends, notices and the 24-hour cap from the row.

### 13.3 What works during maintenance

- **Reading** works everywhere.
- **Writes are refused** with a typed `maintenance` result, and the app shows "The workspace is read-only for maintenance". DOs refuse writes once they have the flag.
- **Exemptions:**
  - sign-in, sign-out and token refresh (`POST /auth/*`)
  - step-up re-authentication
  - ending, rescheduling or cancelling maintenance
  - internal system writes: audit, alerts, health, export status, outbox progress
  - the running export itself.

  Members can still sign in **(default)**.
- **Calls:** active calls continue, but no new calls start **(default)**.
- **Settings:** can't be changed.
- **Background jobs:** purges, retention sweeps and scheduled exports wait until maintenance ends **(default)**.
- **Reconnects:** when maintenance ends, sockets return to their normal roles through `access.changed`, with no mass reconnect.

### 13.4 Exporting in maintenance

An owner can tick **in maintenance mode** when starting a workspace export.

1. If no window is active, one starts now with the message "Exporting the workspace". If one is already active, the export uses it.
2. **Consistency barrier.** Before the snapshot, the export waits until:
   - the settings cache has expired (30 seconds)
   - every DO has acknowledged `setMaintenance(true)`
   - the projection outbox has drained.
3. When the export completes, fails or is cancelled, a window it started ends automatically. A window that was already active is left alone.

### 13.5 Audit

`maintenance.scheduled`, `.rescheduled`, `.started`, `.ended`, `.cancelled`.

## 14. Updates

Owners see the following (TDD §6.7); admins can view them:
- the installed version and channel
- the latest release on the channel, with release notes and a security flag
- a link to the open upgrade pull request in the repository
- migration status from the last deploy, as observable by the running app: schema against code, and being behind the latest release (§4).

**Auto-merge and channel.** These live in the customer's repository, in `.officebox/config.json` (TDD §6.3): `channel`, and `auto_merge`, which is one of `none`, `security` or `patch`.
- `auto_merge` defaults to **`none`**. Owners opt in by editing the file. Minor and major releases are never auto-merged.
- The running app holds no GitHub credentials (PRD §13). So the build embeds both values, and the Updates page shows them **as deployed**, with instructions for changing them.

## 15. Setup checklist

The post-deploy checklist (TDD §6.1) is an owner page.
- Status is detected automatically where possible. Owners mark manual items done (`checklist.marked`).
- The state lives in `installation.checklist`, not in settings.

**Items** (required items are marked **R** **(default)**):
- custom domain (**R** before inviting the team)
- email provider (not needed with Cloudflare Email Service)
- allowing GitHub Actions to open pull requests (**R**)
- making the repository private
- Cloudflare notifications for Worker errors and health (**R**), the external alert path (§4)
- Cloudflare billing notifications (**R**)
- the R2 lifecycle rule
- scheduled exports, or a first export (**R**)
- Realtime SFU and TURN credentials (when calls are used)
- AI Gateway and provider keys (when the assistant is used).

The Overview shows progress until every required item is done or dismissed.

## 16. Data model

These tables are created in M7's baseline migrations (Platform §14), so enum checks use Zod, not SQL `CHECK`.

```sql
-- NNNN_admin_alerts.sql
CREATE TABLE IF NOT EXISTS admin_alerts (
  kind TEXT NOT NULL,                  -- §4, Zod-validated
  subject TEXT NOT NULL DEFAULT '',
  severity TEXT NOT NULL,              -- 'info' | 'warning' | 'serious'
  state TEXT NOT NULL,                 -- 'open' | 'cleared' | 'dismissed'
  details TEXT,                        -- JSON; never content or personal data
  first_raised_at INTEGER NOT NULL,
  last_raised_at INTEGER NOT NULL,
  cleared_at INTEGER,
  last_raise_email_at INTEGER,
  version INTEGER NOT NULL DEFAULT 0,  -- compare-and-set by the dispatcher
  PRIMARY KEY (kind, subject)
);

-- NNNN_admin_health_checks.sql
CREATE TABLE IF NOT EXISTS health_checks (
  check_name TEXT PRIMARY KEY,         -- Zod-validated list (§8.1)
  status TEXT NOT NULL,                -- 'ok' | 'warning' | 'failing'
  consecutive INTEGER NOT NULL DEFAULT 0,  -- consecutive runs in this status
  status_since INTEGER NOT NULL,
  checked_at INTEGER NOT NULL,
  detail TEXT                          -- short, non-sensitive
);

-- NNNN_admin_maintenance_windows.sql
CREATE TABLE IF NOT EXISTS maintenance_windows (
  id TEXT PRIMARY KEY,                 -- ULID
  starts_at INTEGER NOT NULL,
  planned_end_at INTEGER,
  message TEXT,                        -- up to 280 characters
  state TEXT NOT NULL,                 -- 'scheduled' | 'active' | 'ended' | 'cancelled' (derived on read from times; stored for history)
  started_by_export TEXT,              -- export ID, when started by §13.4
  notice_sent_at INTEGER,
  created_by TEXT NOT NULL REFERENCES users(id),
  ended_by TEXT,
  cancelled_by TEXT,
  ended_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS one_open_window ON maintenance_windows((1)) WHERE state IN ('scheduled', 'active');
```

**`exports` (TDD §7.5).** Created in M7's baseline with these columns:
- `kind`: `export` | `member_export` | `restore`
- `state`: `running` | `packing` | `complete` | `failed` | `cancelled` | `expired` | `deleted`
- `include_files`, `in_maintenance`, `scheduled`
- `subject_user_id`, for member exports
- `schema_version`, `size_bytes`, `object_count`
- `archive_r2_key`
- `restore_report` (JSON, for restores)
- `requested_by`, `created_at`, `completed_at`, `expires_at`.

**Other changes:**
- `sessions` gains `authenticated_at INTEGER NOT NULL` (§11.3), in M1's baseline if M1 hasn't shipped, otherwise as an expand migration.
- `installation` gains `checklist` (JSON: manual items marked done).
- New settings keys (Platform §7):
  - `audit_retention_days` (owner, `settings.audit_retention`)
  - `export_retention_days` (owner, `settings.export_retention`)
  - `scheduled_export` `{ enabled, weekday, time, include_files, keep }` (admin, `settings.scheduled_export`).
- `inbox_items.event_type` gains `admin_alert` and `maintenance_scheduled`.
- Shared error codes gain `reauth_required` and `maintenance`.

**Timers:** all on the existing cron dispatcher (TDD §7.8).
- **Every 5 minutes:** health checks, alert raise and clear, and the maintenance reconciler (start, end, notice, 24-hour cap, re-push to DOs).
- **Daily:** audit retention purge, and export and member-export expiry.

No ReminderScheduler kinds are added.

## 17. API

All bodies are validated with Zod schemas from `packages/shared`. Expected failures are typed results: `forbidden`, `not_found`, `conflict`, `invalid`, `rate_limited`, `reauth_required`, `maintenance`.

| Method and path | Who | Purpose |
|---|---|---|
| `GET /admin/overview` | Owner, admin | Alerts, health summary, version, setup progress (owners), last export, restore report |
| `GET /admin/alerts` · `POST /admin/alerts/:kind/:subject/dismiss` | Owner, admin | List and dismiss (info and warning only) |
| `GET /admin/members?…` | Owner, admin | Filtered member list |
| `GET /admin/members.csv?…` | Owner, admin (step-up) | Member CSV (audited) |
| `POST /admin/invitations/csv/preview` · `POST /admin/invitations/csv` | Owner, admin | CSV invite preview and send (per-row results) |
| `POST /admin/members/bulk` | Owner, admin | `{ action: 'add_group' \| 'remove_group' \| 'disable', userIds (≤ 500), groupId?, preview? }` → per-member results; disable runs as a job |
| `GET /admin/audit.csv?…` | Owner, admin (step-up) | Audit CSV (audited); the viewer uses `GET /admin/audit` |
| `GET /admin/health` | Owner, admin | Detailed checks (stored state) |
| `GET /status` | Any signed-in member | Per-feature flags and maintenance state only |
| `GET /admin/diagnostics/preview` · `GET /admin/diagnostics` | Owner | Support bundle (audited) |
| `GET /admin/storage` | Owner, admin | Store levels |
| `GET /admin/usage` | Owner | Usage panel |
| `GET /admin/exports` · `POST /admin/exports` · `POST /admin/exports/:id/cancel` · `DELETE /admin/exports/:id` | Owner, admin (the maintenance option: owner) | List, start, cancel and delete workspace exports |
| `GET /admin/exports/:id/download` | Owner, admin (step-up) | Stream the archive; supports `Range` |
| `POST /admin/members/:id/export` · `GET /admin/member-exports/:id/download` | Owner, admin; an owner for admin or owner subjects | Per-member export (step-up to download) |
| `POST /auth/reauth` | Any signed-in member | Step-up re-authentication (§11.3) |
| `GET` / `POST /admin/maintenance` · `PATCH` / `DELETE /admin/maintenance/:id` · `POST /admin/maintenance/:id/end` | Owner (read: admin) | Schedule, start, reschedule, cancel and end |
| `GET /admin/updates` | Owner (read: admin) | Version, channel, release notes, PR link, the auto-merge value as deployed |
| `GET /admin/checklist` · `POST /admin/checklist/:item` | Owner | Checklist status and manual marks |

## 18. Acceptance criteria

Timing criteria use an injectable clock and drive the cron dispatcher directly.

**Access**
- [ ] **Role matrix:** each page and endpoint in §3 and §17 is allowed for exactly the listed roles, with a test for each allowed and denied case (added to the Permissions matrix test). Members get `forbidden` on every admin endpoint.
- [ ] **Owner-only actions:** admins get `forbidden` on maintenance changes, updates, usage, checklist, telemetry, diagnostics, and the maintenance option on exports.

**Alerts**
- [ ] **Raise and clear:** each alert kind in §4 is raised and cleared by its condition, per subject. Hysteresis stops flapping at a threshold.
- [ ] **Consecutive runs:** a single failing run raises nothing.
- [ ] **Concurrency:** concurrent dispatcher runs send no duplicate emails.
- [ ] **Email:** raise emails go to owners at most once per alert record per 24 hours, and clear emails are always sent. Admins receive no email. Emails contain no member names or content.
- [ ] **DND:** `check_failing` and `protective_mode` emails break through DND. Other alert emails are held, while the inbox item is still recorded.
- [ ] **Dismissal:** serious alerts can't be dismissed. A dismissed warning is raised again after it clears and recurs.

**Members**
- [ ] **CSV invite:**
  - The preview flags every row type in §5.1, including duplicates and `owner` or `guest` roles.
  - Re-sending a file is idempotent, and rows beyond the daily limit stay pending.
  - Admins can't invite admins.
- [ ] **Bulk changes:**
  - Bulk group changes and bulk disable give per-member results and survive partial failure.
  - Bulk disable excludes the actor, and concurrent bulk disables by two owners never leave zero owners.
- [ ] **CSV safety:** every CSV escapes formula-leading cells, and needs step-up re-authentication.

**Audit log**
- [ ] **Filters and download:** filters work, and the CSV matches the filtered view.
- [ ] **Retention:** entries older than `audit_retention_days` are purged, except export entries younger than 365 days.
- [ ] **No content:** no entry contains message or document content, tokens or secrets (asserted across a seeded run).

**Health and notices**
- [ ] **Health page:** it reflects stored check states, and loading it raises nothing.
- [ ] **Member notices:** `/status` returns flags and the maintenance state only. A failing SFU disables call buttons with the notice, and members see no workspace-wide banner.

**Exports**
- [ ] **Contents:** a workspace export run by an admin includes DMs, private channels, time-off notes and personal reminders. It excludes credentials, assistant memory and the operational tables.
- [ ] **Step-up re-authentication:**
  - A download with `authenticated_at` older than 10 minutes returns `reauth_required`. At 10 minutes exactly, it's allowed.
  - A refresh doesn't reset `authenticated_at`.
  - A passwordless admin can step up with a passkey or email.
- [ ] **Packing:** the archive is one R2 object, and a `Range` request resumes it. Deleting an export mid-download ends the stream with an error.
- [ ] **One at a time:** a second concurrent export returns `conflict`. Cancelling deletes the partial objects.
- [ ] **No member access:** members have no export endpoint, and `GET /assistant/export` no longer exists.
- [ ] **Scheduling and expiry:**
  - Scheduled exports keep the latest 4 complete ones.
  - On-demand exports expire after 30 days.
  - `no_recent_export` is raised after 30 days without a workspace export, even while scheduled exports are on.
- [ ] **Per-member export:**
  - It contains the subject's data per §12 and nothing written by others. A download after `expires_at` returns `not_found`.
  - The subject gets a `security_notice`, or gets it on re-enable if disabled.
  - An admin can't start or download an export whose subject is (or has become) an admin or owner.
- [ ] **Restore:** restoring an export taken during maintenance starts the new installation writable, with no stale alerts. The restore report lists the §11.4 items, including members deleted after the export date.

**Maintenance**
- [ ] **Read-only:**
  - During maintenance, writes return `maintenance`, except the §13.3 exemptions. Token refresh keeps members signed in.
  - Sockets switch to read-only without reconnecting. New calls are refused while active calls continue.
  - Purges and scheduled exports wait.
- [ ] **Timing:**
  - A scheduled window starts and ends even if the dispatcher missed runs (state derived from the row).
  - It ends after 24 hours at most.
  - A window scheduled 2 hours ahead sends its notice immediately.
  - A second open window is refused.
- [ ] **Consistent export:** an export in maintenance waits for the barrier, and ends the window it started on success, failure or cancel.

**Updates**
- [ ] **Updates page:** it shows version, channel, release notes, the PR link and the `auto_merge` value as deployed, plus the security alert after 48 hours.

**Accessibility**
- [ ] **Keyboard and axe:**
  - Every admin page passes axe and keyboard-only checks.
  - `aria-disabled` controls expose their reason.
  - Statuses are text, and progress is announced politely.
  - The re-authentication and bulk-confirm dialogs are labelled, trap focus and support Escape.
  - Banners don't move focus.

## 19. Changes to other documents

These edits are made in the PR that approves this spec.

| Document | Change |
|---|---|
| Assistant §2, §4.3, §4.4, §7.1, §11, §13, §15, §16, §17, §19 | **Remove "Download my assistant data"** and `GET /assistant/export` everywhere, including the export-filter text, the audit list, the acceptance criteria and open question 5. Personal reminders are now in admin-run exports (workspace and per-member). Assistant memory can't be exported by anyone; members view it in "What Butler remembers". Update the Decisions table with the reason. |
| Permissions §2, §4.1, §6, §8, §11, §12 | "Admins and private content" Decisions row and §11 criterion: admins can read private content, including DMs, time-off type and note, and personal reminders, **through exports**. The privacy statement says so plainly, along with export expiry and erasure (§11.2). New engine actions `workspace.export` and `member.export`, added to the matrix test. Per-member exports of admins or owners need an owner. Remove the break-glass item from §12 Later; exports cover it. |
| Identity §3, §4.4, §4.5, §4.11, §5, §6, §7 | Export is an owner and admin power, not owner-only. `sessions.authenticated_at`, `POST /auth/reauth`, and `reauth_required` in the shared codes. Bulk tools and member CSV. The admin screens follow §3. |
| Notifications §3, §5 | `admin_alert` (`admin_alert:<kind>:<subject>`; DND breakthrough for two kinds), `maintenance_scheduled` (`maintenance:<id>`), and `security_notice` for per-member exports (queued for disabled subjects until re-enabled). |
| Platform §3.1, §5, §6, §7, §8, §11, §14, §15 | §3.1: exports aren't rewritten on deletion (§11.2). §5: retention rows for on-demand, scheduled and per-member exports. §6: operational-table exclusions; time off and reminders included in admin-run exports (replacing "owner-only" and "personal export only"); per-member export scope. §7: the new keys (§16). §8: CSV invite (500 rows), bulk actions (500), invitation sending (200 a day). §11: the dispatcher jobs in §16. §14: the new tables and columns. §15: the new endpoints, with detailed health open to admins. |
| PRD §10.1, §10.2, §13, Appendix A | Admins (not only owners) export; exports include private content, disclosed; per-member exports; no member self-export; export retention; alerts; maintenance scheduling. |
| TDD §2.1, §6.1, §6.3, §6.4, §6.7, §7.1, §7.2, §7.3, §7.5, §7.7, §7.8 | `exports` columns and states, packing into one object, `sessions.authenticated_at`. The checklist items. `config.json` values embedded at build. Alert rules replace §7.3's external alerting as the in-app path, with Cloudflare notifications kept for outages. Diagnostics are owner-only. Maintenance as in §13. Priority writes in protective mode. New dispatcher jobs. |
| PLAN M7 | Points to this spec (done in this change). |

## 20. Later

- SSO and SCIM provisioning (PRD Phase 2)
- External alert delivery by webhook (for example to a chat or paging tool)
- Recurring maintenance windows
- EU data-residency option (PRD §13, Phase 2)
- Delegated admin roles (for example billing-only or audit-only)
- Exports encrypted with a customer-held key
- Re-applying erasures automatically when an older export is restored

## 21. Open questions

1. **Data-protection access to assistant memory.** Is the in-app "What Butler remembers" view enough to meet a member's right of access, now that the member download is removed?
2. **CSV invite and sending limits.** Are 500 rows per upload and 200 invitations a day right for the target team size?
3. **Email for admins.** Should admins be able to opt in to serious-alert email, or is owner-only right?
4. **Time-off notes and reminders in exports.** Confirm that admin-run exports should include them (§2). The alternative is to keep them member-only, and strip them from exports.

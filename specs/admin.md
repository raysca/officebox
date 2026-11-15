# Spec: Admin & Operations

**Status:** Draft for review
**Revision:** First draft, written after four rounds of product-owner questions (15 Nov 2026)
**Feature name:** Admin (the admin area) and Operations (health, storage, usage, export, maintenance, updates)
**Milestone** ([PLAN](../PLAN.md)): M7, which grows alongside the features. Export and restore must ship before the first customer.

**Related specs:**
- [Identity & Access](identity.md) §4.11: members, invitations, groups and policies
- [Permissions](permissions.md) §6: admin powers and the privacy statement
- [Notifications](notifications.md) §3, §6
- [Platform](platform.md): settings §7, limits §8, export §6, API §15
- [Assistant](assistant.md) §10, §13

**Related PRD and TDD sections:** PRD §13; TDD §6.1, §6.7, §7.1–§7.9

Decisions marked **(default)** were not discussed; change them on review.

**Cross-cutting rules:** permissions follow [Permissions](permissions.md); notifications follow [Notifications & Attention](notifications.md); lifecycle, retention, export, settings, limits and timers follow [Platform Rules](platform.md). Those specs win on cross-cutting rules. §19 lists the changes those documents need.

## 1. Summary

The admin area is where owners and admins run the workspace. It brings into one place things that are currently spread across the PRD, the TDD and several specs:
- members, invitations and groups, with bulk tools
- every workspace setting
- the audit log
- health, alerts and the post-deploy checklist
- storage and protective mode
- usage and cost
- workspace exports, per-member data exports and restore
- maintenance mode
- updates.

Most of the mechanics already exist in the TDD (§6–§7). This spec decides **who** can do what, **how** they hear about problems, and the **policies** around exporting data.

Officebox is a workspace for an organisation, not a public service. So exporting data is an **admin power**: owners and admins can export the whole workspace, including private content, and run a per-member export when someone makes a data-protection request. Members can't export data themselves. Every export is audited and disclosed in the privacy statement.

## 2. Decisions

| Topic | Decision |
|---|---|
| Owner and admin split | **Split by risk.** Owners alone: upgrades and channel, usage and budget, the post-deploy checklist, telemetry and diagnostics, maintenance mode. Owners and admins: members, groups, invitations, workspace settings (per key, Platform §7), the audit log, health, storage, and **exports**. |
| Who exports data | **Owners and admins only.** This is an organisation's workspace. Owners hold every admin power, so "admins" below includes owners. |
| Export contents | **Everything, including private content** (DMs, group DMs, private channels, restricted documents), so a restore is complete. Exceptions are credentials (Platform §6) and assistant memory, which no admin can read. |
| Disclosure | **Privacy statement and audit log** **(default)**. The privacy statement says admins can export everything, including private content. Every export is audited. Members see no export history or notifications. |
| Member self-export | **None.** Members can't download their own data. This **removes** "Download my assistant data" from the approved Assistant spec (§19). |
| Data-protection requests | **Admin per-member export.** An admin runs an export scoped to one member and hands it over. |
| Assistant memory | **Not exportable by anyone.** It lives only in each member's private Assistant DO. Members can see it in "What Butler remembers". |
| Audit log | **Full viewer** for owners and admins: filter by person, action, target and date; download as CSV; kept **365 days** by default, changeable by owners. Entries never contain content or secrets. |
| Alerts | **Banner, inbox item and email.** A persistent admin banner and an inbox item for owners and admins. **Owners** also get email for serious alerts. Admins are in-app only. |
| Scheduled exports | **Off by default, nudged.** When an owner or admin turns them on: weekly, files included, the latest 4 kept (TDD §7.5). |
| Auto-upgrade | **Off by default; owner opt-in** for patch and security releases on the stable channel. Minor and major releases always need a manual merge. |
| Maintenance mode | **Owners schedule it or start it now**, with an optional message. Everyone sees a banner beforehand and during. Reading works; writes are refused with a clear notice. |
| Degraded services | **Small notice where the feature is used** ("Calls are unavailable right now"). No workspace-wide alarm. Details stay on the admin health page. |
| Bulk member tools | **CSV invite, bulk group changes, bulk disable and member CSV download** at launch. |

## 3. The admin area

One **Admin** section in the app, shown only to owners and admins. Each page shows only what the viewer may do; controls they can't use are visible but disabled, with the reason ("Only owners can change this").

| Page | Owners | Admins | What it holds |
|---|---|---|---|
| **Overview** | ✓ | ✓ | Open alerts, health summary, installed version, setup checklist progress (owners), last export |
| **Members** | ✓ | ✓ (members only, Permissions §6) | Member list, profiles, roles, status, recovery, bulk tools (§5) |
| **Invitations** | ✓ | ✓ | Pending invitations, CSV invite (§5.1) |
| **Groups** | ✓ | ✓ | Groups and their members (Identity §4.9) |
| **Settings** | ✓ | ✓ per key | Every Platform §7 setting, grouped (§6) |
| **Audit log** | ✓ | ✓ | Viewer and download (§7) |
| **Health** | ✓ | ✓ | Service checks and diagnostics (§8) |
| **Storage** | ✓ | ✓ (owners set budgets) | Store levels, protective mode, ways to free space (§9) |
| **Usage & cost** | ✓ | — | Usage against allowances, projected overage, assistant cost (§10) |
| **Data** | ✓ | ✓ | Workspace exports, schedule, per-member exports (§11, §12) |
| **Maintenance** | ✓ | — (view only) | Schedule or start maintenance mode (§13) |
| **Updates** | ✓ | — (view only) | Version, channel, release notes, the upgrade pull request (§14) |
| **Setup checklist** | ✓ | — | Post-deploy steps and their status (§15) |
| **Telemetry & diagnostics** | ✓ | — | Telemetry opt-in with payload preview; support bundle (§8.3) |

Everything in the admin area is keyboard-operable, labelled and checked with axe, like the rest of the app (AGENTS §4.3).

## 4. Alerts

Alerts tell owners and admins about problems without them having to watch the health page.

| Alert | Raised when | Severity | Who | Clears when |
|---|---|---|---|---|
| Storage warning | D1 at 70 % or 85 %; any DO over 5 GB; R2 over the soft budget (TDD §7.7) | Warning | Owners, admins | Back under the threshold |
| Protective mode | D1 at 95 % (TDD §7.7) | **Serious** | Owners, admins | Under 95 % |
| D1 copy paused | D1 at 98 % | **Serious** | Owners, admins | Under 98 % |
| Export failed | A workspace or member export fails | **Serious** | Owners, admins | The next export succeeds, or dismissed |
| No recent export | Scheduled exports are off and no export in **30 days (default)** | Warning | Owners, admins | An export completes, or scheduled exports are turned on |
| Health check failing | A required check (D1, DO, R2) fails for **5 minutes (default)** | **Serious** | Owners, admins | Passing again |
| Optional service down | Email, Realtime SFU, AI or link previews failing for 5 minutes | Warning | Owners, admins | Passing again |
| Security release | A security release isn't installed after 48 hours (TDD §6.7) | **Serious** | Owners | Installed |
| Update available | A release is available on the channel | Info | Owners | Installed |
| Upgrade or migration failed | The deployed version is behind the merged release, or migrations report a failure (TDD §6.5) | **Serious** | Owners | Resolved |
| Projection backlog | Outbox lag or a dead-letter queue over its threshold (TDD §7.1) | Warning | Owners, admins | Back under |
| Maintenance overran | Maintenance mode passed its planned end by 1 hour | Warning | Owners | Maintenance ends |
| Checklist incomplete | A required post-deploy item is missing a week after setup | Info | Owners | Done or dismissed |

**Delivery:**
- **Banner:** every open warning or serious alert shows a persistent banner in the admin area, and serious ones also show at the top of the app for owners and admins.
- **Inbox:** each alert is one inbox item of type `admin_alert`, keyed `admin_alert:<kind>`, so repeats update the same item (Notifications §3).
- **Email:** serious alerts are emailed to **owners**, once when raised and once when cleared, and at most once per kind per 24 hours **(default)**. Admins get in-app delivery only. Email content names the alert and links to the admin area, with no member names or content.
- **Do not disturb** holds the inbox item and email for an owner in DND, except for "Health check failing" and "Protective mode", which break through **(default)**.
- Alerts clear automatically. Info and warning alerts can also be dismissed; serious ones can't.

## 5. Members

Member management follows Identity §4.11 and Permissions §6: admins act on members only, and actions on admins or owners need an owner. This spec adds bulk tools and a few list features.

- **Member list:** search and filter by role, status (active, invited, disabled), group and last active. Columns: name, handle, email, role, status, groups, last active, joined.
- **Flags:** members with a no-email recovery link or a pending security notice are flagged (Identity §4.6).

### 5.1 CSV invite

1. An admin uploads a CSV with the columns `email`, `role` (optional, default `member`) and `groups` (optional, separated by `;`).
2. **Preview** before anything is sent. Each row shows one of:
   - ready
   - already a member
   - already invited
   - invalid email
   - domain not allowed (`allowed_invite_domains`)
   - unknown group
   - role not allowed (admins can't invite admins).
3. The admin fixes or removes rows, then sends. Only ready rows are invited.
4. Limits: up to **500 rows per upload (default)**, and the normal invitation rate limits apply (Platform §8). Rows over the limit stay pending in the preview.
5. Each invitation is audited individually, plus one `members.bulk_invite` entry with the count.

### 5.2 Bulk group changes

Select members, then **Add to group** or **Remove from group**. The same rules as single changes apply:
- adding yourself to a group needs an owner (Permissions §6)
- group managers can change their own groups (Identity §4.9).

The preview lists any member who can't be changed and why. Each change is audited individually.

### 5.3 Bulk disable

Select members, then **Disable**.
- The preview lists everyone who will be disabled and anyone who can't be, for example an admin when the actor isn't an owner, or the last owner.
- The actor confirms by typing the number of people.
- Each member is disabled exactly as a single disable would (Platform §3), and each is audited individually.

There is no bulk delete **(default)**, because deletion is irreversible.

### 5.4 Member CSV download

Downloads the current filtered list: name, handle, email, role, status, groups, last active, joined. It holds personal data, so it's audited (`members.exported`).

## 6. Settings

- Every key in Platform §7 appears on the Settings page, grouped as:
  - Workspace
  - Sign-in & security
  - Chat
  - Calls
  - Calendar
  - Documents & files
  - Assistant
  - Email
  - Storage & data.
- Each setting shows its current value, its default, who can change it, and when and by whom it was last changed.
- Owner-only settings are disabled for admins, with the reason.
- Saving writes the setting's audit event (Platform §7). The change takes effect within 30 seconds (the settings cache).
- Settings that depend on a missing setup step (for example email settings without an email provider) link to the checklist item.

## 7. Audit log

- **Viewer:** owners and admins see every entry, newest first.
  - **Filters:** person (actor), action, target type, target and date range.
  - **Each entry shows:** time, actor (name, or "Former member"), action, target and readable details from `metadata`.
- **Never content:** entries never contain message, document or file content, passwords, tokens or secrets (TDD §2.1, Platform §3.1 for redaction on deletion). DM and group-DM targets record only the object type where Permissions §4.1 requires it.
- **Download:** the filtered entries as CSV. The download is itself audited (`audit.exported`).
- **Retention:** `audit_retention_days`, **365** by default (PRD §10.2). Owners can set it from **90 to 3,650 days (default)**. A daily job purges older entries.
- **Immutable:** nobody can edit or delete entries through Officebox.

## 8. Health

### 8.1 Health page

Shows each check from TDD §7.1 as **OK**, **Warning** or **Failing**, with when it last changed and what to do:
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
- installed version against the latest release, and applied migrations against running code.

Checks run every **5 minutes (default)** via the existing cron dispatcher (TDD §7.8) and on page load. The public `/health` endpoint stays minimal (Platform §15); the detailed view needs owner or admin.

### 8.2 Notices for members

When an optional service is failing, members see a quiet notice **where the feature is used**, never a workspace-wide banner:

| Service | Where members see it |
|---|---|
| Email | Invitation and email-change screens ("Email is unavailable — invitations can be sent as links") |
| Calls | Call buttons are disabled with "Calls are unavailable right now" |
| Assistant | The assistant DM says "Butler is unavailable right now" |
| Link previews | Nothing; previews are skipped |
| Search | "Search is catching up — recent messages may be missing" when the projection lags |

The app learns this from `GET /status`, which returns per-feature availability flags only (no details) to any signed-in member.

### 8.3 Diagnostics bundle

- Owners download the support bundle described in TDD §7.2, after a **preview** of its full contents.
- It never contains message, document or file content, email addresses or secrets.
- Downloading it is audited.

## 9. Storage

- **Store levels:** shows D1 size against its 10 GB limit, the largest Durable Objects, and R2 usage with any budget (TDD §7.7).
- **Owner controls:** owners set `r2_budget_gb`, `r2_hard_budget_gb` and `search_copy_months` here (Platform §7).
- **Protective mode:** a serious alert, and the page leads with ways to free space: shorten the search copy, empty Trash early, enable retention policies, export and delete archived channels.
- **What members see in protective mode:** creating a channel, document, file, event or invitation fails with "The workspace is low on storage. Ask an admin." Messaging continues.

## 10. Usage & cost

Owners only. Shows the usage panel from TDD §7.9:
- month-to-date usage against the Workers Paid allowances, and projected overage
- Cloudflare's own figures when the optional analytics token is set, otherwise Officebox's counters
- the Assistant section (Assistant §10.2).

A persistent prompt asks owners to set Cloudflare billing notifications until they mark it done, because Cloudflare has no hard spending cap.

## 11. Workspace exports and restore

### 11.1 Exporting

- **Who:** owners and admins.
- **Contents:** the Officebox export format v1 (TDD §7.5), including all private content. Exceptions follow Platform §6: credentials, and assistant memory, which lives in each member's private DO and is never exported.
- **On demand:**
  1. Choose whether to include files.
  2. Owners can also choose to run the export in maintenance mode (§13), for a fully consistent snapshot.
  3. The export runs as a Workflow, and the Data page shows its progress.
- **Scheduled:** set with `scheduled_export`.
  - Off by default.
  - When on: weekly on a chosen day, files included, the latest **4** kept (TDD §7.5).
  - The "No recent export" alert (§4) and the setup checklist nudge until scheduled exports are on, or a recent export exists.
- **Download:** a single `.tar` streamed by the Worker (TDD §7.5).
  - Starting a download needs the admin to have **signed in within the last 10 minutes (default)**, or to re-enter their password or passkey, because the archive holds private content.
  - Each download is audited.
- **Deleting exports:** admins can delete an export from R2 (audited). Scheduled exports beyond the keep count are deleted automatically.
- **Audit:** `export.started`, `export.completed`, `export.failed`, `export.downloaded` and `export.deleted`, with actor, export ID and whether files were included.
- **Disclosure:** the privacy statement (Permissions §6) says owners and admins can export all workspace content, including DMs and private channels. Members see nothing else about exports **(default)**.

### 11.2 Restore

Restore follows TDD §7.5 and §6.8 unchanged:
- it's offered on a fresh installation's first-run page and needs the setup token
- the command-line tool covers very large archives.

After a restore, the Overview lists:
- members who must re-register passkeys or need a recovery link (passkey-only members, Identity §4.4)
- members who must re-enrol MFA
- that assistant memory was not restored and the assistant index is being rebuilt
- ICS subscriptions that need their URLs re-entered.

## 12. Per-member data exports

For data-protection access requests. Members can't run these themselves.

- **Who:** owners and admins (Permissions §6 limits apply: an export of an admin or owner needs an owner).
- **Contents** (one archive):
  - profile, preferences and notification preferences
  - messages the member wrote, in every conversation including DMs, with conversation names
  - documents, whiteboards and files they own, with versions
  - calendar events they organise or attend, their time off and personal reminders
  - comments they wrote
  - group memberships, and their sessions list (devices and times, no tokens)
  - audit entries where they are the actor or target.
- **Not included:** other people's messages, assistant conversations and memory (not readable by admins; the member can see these in "What Butler remembers"), and credentials.
- **Running:** a Workflow, like workspace exports. The archive is kept for **7 days (default)**, then deleted.
- **Download:** has the same recent-sign-in rule as §11.1, and is audited (`member_export.created`, `member_export.downloaded`).
- **The member is told** with a `security_notice` inbox item: "An admin exported your data on *date*" **(default)**. Per-member exports are normally run at the member's request, so this is a confirmation, not a surprise.

## 13. Maintenance mode

**Who:** owners. Admins can see it but not start it.

1. **Start now or schedule:** a start time, an optional planned end, and an optional message up to 280 characters.
2. **Advance notice:** a scheduled window shows a banner to everyone from **24 hours before (default)**, and posts an inbox item to every member (`maintenance_scheduled`).
3. **During maintenance:**
   - **Read-only:** the Worker refuses writes with a typed `maintenance` result, and the app shows "The workspace is read-only for maintenance".
   - **Sockets:** they reconnect read-only through the UserHubs (TDD §7.5).
   - **Calls:** active calls continue, but no new calls start **(default)**.
   - **Owners and admins** can sign in, view everything and end maintenance. Settings can't be changed, except ending maintenance.
   - **Background jobs:** purges, retention sweeps and scheduled exports wait until maintenance ends **(default)**, so a consistent export isn't disturbed.
4. **Ending:**
   - An owner ends it, or it ends at its planned end.
   - If the planned end passes by an hour while maintenance is still on, owners get the "Maintenance overran" alert.
   - It ends automatically after **24 hours (default)** at most.
5. **Audit:** `maintenance.scheduled`, `maintenance.started`, `maintenance.ended` and `maintenance.cancelled`.

## 14. Updates

Owners see (TDD §6.7):
- the installed version and channel
- the latest release on the channel, with its release notes, and a security flag
- a link to the open upgrade pull request in the repository
- migration status from the last deploy.

**Auto-merge and channel.** These live in the customer's repository, not in the app, because the running app holds no GitHub credentials (PRD §13).
- **Auto-merge** is **off by default**. Owners can opt in to automatic merging of **patch and security releases on the stable channel**, by setting a repository variable that the release-sync workflow reads. Minor and major releases are never auto-merged.
- **Admin page.** The Updates page shows both settings as read from the build, and explains how to change them.

## 15. Setup checklist

The post-deploy checklist (TDD §6.1) is an owner page. Its status is detected automatically where possible; owners mark manual items done. Items:
- custom domain
- email provider (not needed with Cloudflare Email Service)
- allowing GitHub Actions to open pull requests
- making the repository private
- Realtime SFU and TURN credentials
- AI Gateway and provider keys
- Cloudflare billing notifications
- the R2 lifecycle rule
- **scheduled exports** (new).

Overview shows progress until every required item is done or dismissed.

## 16. Data model

```sql
-- NNNN_admin_alerts.sql
CREATE TABLE IF NOT EXISTS admin_alerts (
  kind TEXT PRIMARY KEY,               -- one row per alert kind (§4), Zod-validated
  severity TEXT NOT NULL,              -- 'info' | 'warning' | 'serious'
  state TEXT NOT NULL,                 -- 'open' | 'cleared' | 'dismissed'
  details TEXT,                        -- JSON; never content or personal data
  first_raised_at INTEGER NOT NULL,
  last_raised_at INTEGER NOT NULL,
  cleared_at INTEGER,
  last_emailed_at INTEGER
);

-- NNNN_admin_maintenance_windows.sql
CREATE TABLE IF NOT EXISTS maintenance_windows (
  id TEXT PRIMARY KEY,                 -- ULID
  starts_at INTEGER NOT NULL,
  planned_end_at INTEGER,
  message TEXT,                        -- up to 280 characters
  state TEXT NOT NULL,                 -- 'scheduled' | 'active' | 'ended' | 'cancelled'
  created_by TEXT NOT NULL REFERENCES users(id),
  ended_by TEXT,
  ended_at INTEGER
);

-- NNNN_admin_health_checks.sql
CREATE TABLE IF NOT EXISTS health_checks (
  check_name TEXT PRIMARY KEY,         -- Zod-validated list (§8.1)
  status TEXT NOT NULL,                -- 'ok' | 'warning' | 'failing'
  failing_since INTEGER,
  checked_at INTEGER NOT NULL,
  detail TEXT                          -- short, non-sensitive
);
```

**Changes to existing tables:**
- `exports` (TDD §7.5):
  - `kind` gains `member_export`
  - adds `subject_user_id` (for member exports), `in_maintenance`, `scheduled` and `expires_at`
  - `CHECK`s on enum columns move to Zod (Platform §14).
- `installation.settings` gains `audit_retention_days`, `scheduled_export` `{ enabled, weekday, include_files, keep }` and `checklist` (manual items marked done).
- `inbox_items.event_type` gains `admin_alert` and `maintenance_scheduled`.

**Timers:**
- The cron dispatcher (TDD §7.8) runs health checks every 5 minutes, raises and clears alerts, and runs the daily audit purge and member-export expiry.
- ReminderScheduler triggers `maintenance_notice` (24 hours before), `maintenance_start` and `maintenance_end` drive maintenance windows.

## 17. API

All bodies are validated with Zod schemas from `packages/shared`. Expected failures are typed results (`forbidden`, `not_found`, `conflict`, `invalid`, `rate_limited`, `reauth_required`, `maintenance`).

| Method and path | Who | Purpose |
|---|---|---|
| `GET /admin/overview` | Owner, admin | Alerts, health summary, version, checklist (owners), last export |
| `GET /admin/alerts` · `POST /admin/alerts/:kind/dismiss` | Owner, admin | List and dismiss alerts |
| `GET /admin/members?…` | Owner, admin | Filtered member list |
| `GET /admin/members.csv?…` | Owner, admin | Member CSV download (audited) |
| `POST /admin/invitations/csv/preview` · `POST /admin/invitations/csv` | Owner, admin | CSV invite preview and send |
| `POST /admin/members/bulk` | Owner, admin | `{ action: 'add_group' \| 'remove_group' \| 'disable', userIds, groupId? }` with preview mode |
| `GET /admin/audit.csv?…` | Owner, admin | Audit download (audited); the viewer uses the existing `GET /admin/audit` |
| `GET /admin/health` | Owner, admin | Detailed checks |
| `GET /status` | Any signed-in member | Per-feature availability flags only |
| `GET /admin/diagnostics/preview` · `GET /admin/diagnostics` | Owner | Support bundle preview and download (audited) |
| `GET /admin/storage` | Owner, admin | Store levels |
| `GET /admin/usage` | Owner | Usage panel (existing) |
| `GET /admin/exports` · `POST /admin/exports` · `DELETE /admin/exports/:id` | Owner, admin (maintenance option: owner) | List, start and delete workspace exports |
| `GET /admin/exports/:id/download` | Owner, admin | Stream the archive (recent sign-in required) |
| `POST /admin/members/:id/export` · `GET /admin/member-exports/:id/download` | Owner, admin (an owner for admin or owner subjects) | Per-member export |
| `GET /admin/maintenance` · `POST /admin/maintenance` · `POST /admin/maintenance/:id/end` · `DELETE /admin/maintenance/:id` | Owner (read: admin) | Schedule, start, end and cancel maintenance |
| `GET /admin/updates` | Owner (read: admin) | Version, channel, release notes, PR link, auto-merge setting as built |
| `GET /admin/checklist` · `POST /admin/checklist/:item` | Owner | Checklist status and marking manual items done |

## 18. Acceptance criteria

**Access**
- [ ] **Role matrix:** each page and endpoint in §3 and §17 is allowed for exactly the listed roles, with a test for each allowed and denied case. Members get `forbidden` on every admin endpoint.
- [ ] **Owner-only actions:** admins can view, but get `forbidden` on, owner-only actions: maintenance, updates, usage, checklist, diagnostics, and the maintenance option on exports.

**Alerts**
- [ ] **Raise and clear:** each alert in §4 is raised and cleared by its condition (tested with an injectable clock and the cron dispatcher).
- [ ] **Deduplication:** repeats update one inbox item.
- [ ] **Email:** serious alerts email owners once when raised and once when cleared, at most once per kind per 24 hours. Admins receive no email.
- [ ] **Dismissal:** serious alerts can't be dismissed.

**Members**
- [ ] **CSV invite:** the preview flags every invalid row type in §5.1. Only ready rows are invited, and admins can't invite admins.
- [ ] **Bulk changes:** bulk group changes and bulk disable apply the same rules as single actions, protect the last owner, and audit each member individually.
- [ ] **Member CSV:** downloading the member CSV writes `members.exported`.

**Audit log**
- [ ] **Filters and download:** filters work, and the CSV matches the filtered view. The download is audited.
- [ ] **Retention:** entries older than `audit_retention_days` are purged.
- [ ] **No content:** no entry contains message or document content, tokens or secrets (asserted across a seeded run).

**Health and notices**
- [ ] **Health page:** it reflects each check's state.
- [ ] **Member notices:** `/status` returns flags only. A failing SFU disables call buttons with the notice, and members see no workspace-wide banner.

**Exports**
- [ ] **Contents:** a workspace export run by an admin includes DMs and private channels, and excludes credentials and assistant memory.
- [ ] **Download protection:** downloads need recent sign-in (`reauth_required` otherwise) and are audited.
- [ ] **No member access:** members have no export endpoint at all, and `GET /assistant/export` no longer exists.
- [ ] **Scheduled exports:** they run weekly when on and keep the latest 4. "No recent export" is raised after 30 days without one.
- [ ] **Per-member export:** it contains the member's own content listed in §12 and nothing written by others. It expires after 7 days, and the member gets the `security_notice` item. An admin can't export an admin or owner.
- [ ] **Restore checklist:** after restore, the Overview lists passkey-only members, MFA re-enrolment, the assistant index rebuild and ICS URLs.

**Maintenance**
- [ ] **Read-only:** during maintenance, writes return `maintenance`, sockets are read-only, and new calls are refused while active calls continue. Purges and scheduled exports wait.
- [ ] **Notice and limits:** a scheduled window shows the banner and inbox item 24 hours ahead. It ends at its planned end, or after 24 hours at most.

**Updates**
- [ ] **Updates page:** it shows version, channel, release notes and the PR link, and the security banner after 48 hours.

**Accessibility**
- [ ] **Keyboard and axe:** every admin page passes axe and keyboard-only checks. Banners and alerts are announced without stealing focus, and disabled controls explain why.

## 19. Changes to other documents

These edits are made in the PR that approves this spec, as with the Assistant spec.

| Document | Change |
|---|---|
| Assistant §2, §4.3, §13, §15, §16 | **Remove "Download my assistant data"** and `GET /assistant/export`. Assistant memory can't be exported by anyone; members view it in "What Butler remembers". Personal reminders move into the per-member export (§12). Update Decisions with the reason. |
| PRD §13 | Exports are an owner and admin power and include private content (disclosed); per-member exports for data-protection requests; no member self-export; alerts; maintenance scheduling. |
| PRD §10.2 | Per-member export archives kept 7 days. |
| TDD §6.7, §7.1, §7.3, §7.5 | Health cadence and the `/status` endpoint; alerts as in §4 (in-app plus owner email, replacing external alerting as the primary path); exports run by owners or admins; per-member exports (`exports.kind` gains `member_export`); recent-sign-in rule for downloads; maintenance scheduling and job pausing. |
| Permissions §4.1, §6 | DMs: owners and admins can read their content through a workspace or per-member export. The privacy statement says so plainly. Per-member export of an admin or owner needs an owner. |
| Platform §6, §7, §8, §11, §15 | Export coverage for per-member exports; new settings (`audit_retention_days`, `scheduled_export`); CSV invite limit; health and alert timers; the new API endpoints (§17); detailed health open to admins as well as owners. |
| Identity §4.11, §7 | Bulk tools and member CSV download; the admin screens follow §3. |
| Notifications §3 | Event types `admin_alert` (`admin_alert:<kind>`), `maintenance_scheduled` (`maintenance:<id>`), and `security_notice` for per-member exports. |
| PLAN M7 | Points to this spec; export and restore before the first customer. |

## 20. Later

- SSO and SCIM provisioning (PRD Phase 2)
- External alert delivery by webhook (for example to a chat or paging tool)
- Recurring maintenance windows
- EU data-residency option (PRD §13, Phase 2)
- Delegated admin roles (for example a billing-only or audit-only role)
- Exports encrypted with a customer-held key

## 21. Open questions

1. **Data-protection access to assistant memory.** Is the in-app "What Butler remembers" view enough to meet a member's right of access, now that the member download is removed? If not, the per-member export would need a member-initiated path for assistant memory only.
2. **CSV invite limit.** Is 500 rows per upload right for the target team size, given the invitation rate limits?
3. **Email for admins.** Should admins be able to opt in to serious-alert email, or is owner-only right for every workspace?

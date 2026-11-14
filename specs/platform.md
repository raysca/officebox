# Spec: Platform Rules

**Status:** Draft for review
**Feature name:** Platform Rules (cross-cutting; not a user-facing feature)
**Milestone:** Applies from M0 onward ([PLAN](../PLAN.md)). Each rule ships with the milestone of the first feature that needs it. · **Related:** PRD §10.2, §13, §18; TDD §2.1, §2.3, §3.5, §6.5, §7.5, §7.8, §8; [Permissions](permissions.md), [Notifications & Attention](notifications.md), [Identity & Access](identity.md), [Chat](chat.md), [Calls](calls.md), [Calendar](calendar.md), [Documents](documents.md)

Decisions marked **(default)** were not discussed; change them on review. Where a feature spec and this spec disagree on a cross-cutting rule, **this spec wins** and the feature spec is fixed.

## 1. Summary

The rules every feature follows, so features behave consistently and no data is left behind. They cover:
- what happens when a member is disabled or deleted
- what happens when a container (channel, group, calendar, drive) is deleted
- retention, Trash and purge
- export
- admin settings, rate limits and quotas
- fetching outside URLs safely, and email links that resist mail scanners
- timers and schedulers
- the realtime connection budget
- provisioning and backfill
- the final shape of the shared schema.

## 2. Decisions

| Topic | Decision |
|---|---|
| Admin powers over owners and admins | Recovery links, email changes and disabling owners or admins require an **owner** ([Permissions](permissions.md) §6) |
| Chat attachments | **Message-owned.** They inherit the message's access and are deleted with it. "Save to folder" makes an independent copy. |
| DM / group-DM files | **Conversation only.** No folder in the Channels drive. |
| Channel deleted (after Trash) | Documents and saved copies in its folder **move to their creators' My files**, or to an admin's if the creator is gone. Explicit shares are kept. |
| New item access | **Follows the container** ([Permissions](permissions.md) §5) |
| In-call chat (document and event calls) | **Kept for the life of the context.** Not purged with huddle metadata. |
| Anonymous poll votes | **Hashed voter key per poll.** No member ID is stored, so voters can't be recovered from exports or logs. |
| External event invitations | **On by default**, capped at **50 external recipients per member per day**. Admins can turn them off. |
| ICS-in subscriptions | **Personal only.** URLs encrypted and masked. |
| Owners' sign-in | **Owners must keep a password** in addition to any passkeys |

## 3. Member lifecycle

*Disabled* means the member can't sign in and everything they own is kept. *Deleted* means personal data is erased, content they wrote stays as "Former member", and owned containers are transferred (PRD §10.2).

| Feature | Disabled | Deleted |
|---|---|---|
| **Identity** | Sign-in refused. `session_epoch` bumped. All sockets closed with `4401`, including chat, documents, hub **and calls** (room registry kind `huddle`, so the member drops out of calls immediately: the HuddleRoom socket closes and their SFU tracks are closed). The same applies to anyone who **loses access to a call's context** (removed from the channel, document or event). Shown under **Deactivated** in the directory. Handle kept. | Everything for *disabled*, then the [erase list](#31-personal-data-erase-list) runs. Handle released (held 30 days). Shown as "Former member". |
| **Chat** | DMs and group DMs are kept and marked **"deactivated"**. Sending to them is disabled **(default)**. Excluded from mention autocomplete and from `@here`. `@channel` and `@group` no longer notify them. Offline emails stop. If they were the **last channel admin**, the longest-standing remaining member is promoted (audited). | Messages stay, attributed to "Former member". Their `thread_follows`, `saved_items` and `sidebar_prefs` are erased. `@handle` text in plain-text copies and the search index is re-rendered as **"Former member"** **(default)**. |
| **Calls** | Removed from any active call (above). Rings to them are **refused** ("*Name* is deactivated"). They can't host. Moderation of a call they hosted passes as set out in [Calls](calls.md) §6.7 (a present moderator; otherwise any participant in DM calls; otherwise the earliest remaining participant). | As disabled. Huddle participant rows show "Former member". |
| **Calendar** | They **stay organiser** of their events **(default)**. Their reminders and emails stop. Invitations to them are refused. Hidden from find-a-time. **ICS-out feed tokens are revoked.** ICS-in refreshes pause. | Future events they organised: **organiser transferred** to the first remaining editor of the event's calendar, or else the calendar owner **(default)**. Standalone calendars they owned are **transferred to an admin**. ICS-in subscriptions and ICS-out feeds are **revoked**. `time_off` is **erased** (it holds sensitive types). `event_notes` and `event_reminders` are deleted. Attendee rows show "Former member". |
| **Documents and files** | They **keep ownership** (PRD §6). Shares stay. Pending access requests to them are re-routed to other editors or managers. | **My files** (documents, whiteboards, files, folders) is **transferred to an admin**. So is ownership of individual items elsewhere. Drives they managed get an admin as manager if none remains. `stars`, `recent_items` and `access_requests` are erased. Comments stay as "Former member". |
| **Notifications** | No new inbox items, emails or rings. Pending delayed emails are dropped when they fire. | `inbox_items`, `notification_preferences` and `user_preferences` are erased. |
| **Search** | Their content stays searchable. Hidden from people search **(default)**. | Content stays (attributed to "Former member"). Removed from people search. `@handle` occurrences re-rendered (Chat row). |
| **Presence** | Removed from WorkspacePresence immediately. | Same. |

### 3.1 Personal-data erase list

Deletion erases these in one idempotent purge job (TDD §2.3), audited:

| Store | What is erased |
|---|---|
| `users` | email, password_hash, avatar_key, phone, pronouns, job_title, team, location, status_emoji, status_text, status_expires_at, timezone (reset to `UTC`), working_hours, region. `display_name` becomes "Former member". `status` becomes `deleted`. |
| R2 | Avatar object |
| Auth | `passkeys`, `auth_tokens`, `sessions`, `ws_tickets`, `mfa_factors` |
| Identity | `handles` row released (held 30 days) |
| Preferences | `user_preferences`, `notification_preferences`, `sidebar_prefs` |
| Chat | `thread_follows`, `saved_items`; `@handle` text re-rendered in the D1 message copy and `search_index` |
| Calendar | `time_off`, `event_notes`, `event_reminders`, `ics_feeds`, `ics_subscriptions` (and their cached events) |
| Documents | `stars`, `recent_items`, `access_requests` (as requester) |
| Notifications | `inbox_items` |
| Membership | `group_members`, `channel_members` (channel history stays) |

`ON DELETE CASCADE` on `users` never fires, because user rows are anonymised, not deleted. The purge job must delete each table explicitly.

## 4. Deletion cascades

"Trash" means a 30-day soft delete (PRD §10.2). "Purge" is the permanent deletion run by the purge pipeline (TDD §2.3).

| Parent → action | Dependent | Behaviour |
|---|---|---|
| **Channel → archive** | Messages, pins, polls | Read-only. Open polls close. |
| | Channel folder | Read-only |
| | Channel calendar | Archived (read-only, hidden from "My calendars") |
| | Calls | No new calls. An active call ends. |
| | System messages | Still posted (e.g. "archived by …"). Nothing else can post. |
| | Thread follows, sidebar sections, saved items | Kept |
| **Channel → delete (Trash)** | Everything above | Hidden from everyone. Restorable by a workspace admin. |
| **Channel → purge** | Messages, polls and votes, pins, link previews (per-message mapping) | Deleted (channel DO `deleteAll()`) |
| | Message-owned files | Deleted (R2) |
| | Channel folder: documents, whiteboards, saved copies | **Moved to each creator's My files** (or an admin's if the creator is gone or deleted). Explicit grants kept. Channel-principal grants removed. Then the empty folder is deleted. |
| | Channel calendar | Purged with its events |
| | Huddle records | `context_id` kept as a tombstone reference. In-call chat was a thread, so it's purged with the messages. |
| | Saved items, thread follows, inbox items referencing it | Deleted |
| | Sidebar sections | The conversation ID is removed from `sidebar_prefs.sections` |
| | Grants where the channel is the principal | Deleted (audited) |
| **Group → delete** | Group drive | **To Trash with all contents.** Members are warned before confirming **(default)**. Restorable by an admin for 30 days. |
| | Group calendar | **Archived**, then purged after 30 days. Events stay on attendees' calendars as individual events. |
| | Grants where the group is the principal | Removed (audited) |
| | Event attendee rows | Already expanded to individuals when the invitation was sent, so they're unaffected |
| | `@handle` | Released (held 30 days) |
| **Calendar → delete** | Personal, workspace, group | **Can't be deleted directly.** Personal goes with its member, group with its group, workspace never. |
| | Standalone | To Trash with its events. Attendees see the events removed (cancellation notice). Restorable by the calendar owner or an admin. |
| | External (ICS in) | Deleted immediately with its cached events (no Trash) |
| **Event → delete** | Single event or whole series | To Trash. Cancellations sent to members and external attendees. Reminders and triggers removed. |
| | One occurrence / "this and following" | Exception (`cancelled`) or series split. No Trash for single occurrences. |
| | Event call | An active call continues until empty. In-call chat stays with the event while it's in Trash, then is purged with it. |
| **Drive → delete** | Folders and items | To Trash as one unit. Restorable by a drive manager or an admin. Items previously trashed individually keep their own purge date. |
| **Folder → delete** | Sub-folders and items | To Trash as one unit, restorable by an editor of the parent or the item owner |
| **Document / whiteboard → delete** | Comments, versions, recovery snapshots in R2 | To Trash with the item, then purged |
| | Embeds of it elsewhere | Show "This *whiteboard* was deleted" |
| | Search text and stars, recents and access requests | Removed from search immediately; the rest purged |
| **File → delete** | All versions | To Trash. Purge deletes every version's R2 object. |
| **Comment thread → delete** | Comments | Deleted immediately (no Trash) by the author (own comments) or the document owner, editors or admins (moderation, audited) |
| **User → delete** | See §3 | |

## 5. Retention, Trash and purge

This extends the PRD §10.2 table. Anything not listed follows the PRD.

| Data | Retention | Trash? | Who can restore |
|---|---|---|---|
| Calendars (standalone) | Until deleted | 30 days | Calendar owner, admin |
| Events | Until deleted | 30 days | Organiser, calendar editors, admin |
| Time off | Until deleted by the member; erased when the member is deleted | No | — |
| External attendee emails | **Purged 90 days after the event ends** (series: after the last occurrence) **(default)** | — | — |
| ICS-in cached events | Replaced on each refresh; deleted with the subscription | No | — |
| Drives | Until deleted | 30 days | Drive manager, admin |
| Folders | Until deleted | 30 days | Editor of the parent folder, admin |
| Comments | Life of the document | No (moderated deletes are immediate) | — |
| File versions | With their file. Purged when the file is purged, or when a version beyond the 100-version limit is dropped (oldest first) **(default)**. | With the file | As the file |
| Polls and votes | Life of the channel; votes stored as per-poll hashed keys | With the channel | Admin (via channel) |
| Saved items | Until removed, or until the member loses access or the message is deleted | No | — |
| Huddle metadata (`huddles`, `huddle_participants`) | 365 days | No | — |
| Call rings (`call_rings`) | 365 days, with huddle metadata | No | — |
| **In-call chat**, channel and DM calls | A thread in the conversation, so it follows the channel | With the channel | — |
| **In-call chat**, document and event calls | **Life of the context.** `huddle_messages` is **reparented** to the context (`context_type`, `context_id`) and **must not cascade** from `huddles`. | With the context | As the context |
| Link previews (`link_previews`) | Cache 24 hours. Rows unreferenced for 30 days are purged with their R2 image **(default)**. | No | — |
| Access requests | Decided requests 90 days after decision; pending ones expire after 30 days **(default)** | No | — |
| `ws_tickets` | Deleted daily after expiry | No | — |
| `auth_tokens` | Deleted 7 days after use or expiry | No | — |

**Who can restore from Trash, by container:**

| Container | Restorers |
|---|---|
| Item in My files | Owner, admin |
| Item in a shared or group drive | Item owner, drive manager, admin |
| Channel folder item | Item owner, channel admin, admin |
| Channel | Workspace admin |
| Group drive | Admin |
| Standalone calendar | Calendar owner, admin |
| Event | Organiser, calendar editor, admin |

## 6. Export coverage

This extends TDD §7.5.

| Included | Notes |
|---|---|
| Calendars, events, event exceptions, attendees, reminders | External attendee emails are included (personal data the organiser holds) |
| Time off | Including type and note (the export is owner-only) |
| Drives, folders, documents, whiteboards, files **with all versions** | `files/<file id>/<version>` |
| Comment threads and comments | |
| Polls and votes | Anonymous polls export **votes as hashed `voter_key`s only**, never member IDs; `poll_secret` is excluded. Non-anonymous polls export voter IDs. |
| Saved items, stars, sidebar prefs, user and notification preferences | |
| In-call chat | From `huddle_messages` (document and event calls) **and** from channel threads (channel and DM calls, part of channel export) |
| Huddle metadata, call rings | Within retention |

| Excluded | Reason |
|---|---|
| `sessions`, `auth_tokens`, `ws_tickets` | Credentials |
| `passkeys` | Bound to the domain (WebAuthn relying-party ID). Members **re-register** after restoring to a new domain. Owners can sign in with their required password (§2). |
| `mfa_factors` | Encrypted with an installation key |
| `ics_feeds` tokens | Credentials. Members create new feed URLs after a restore. |
| ICS-in URLs | Secrets. Subscriptions are exported **without URLs** and need re-entry after a restore **(default)**. |
| `search_index` | Rebuilt on restore (TDD §2.4) |
| Setup, recovery and Worker secrets | Never exported |

## 7. Admin settings

The single list of workspace settings. Feature specs reference this table instead of defining their own.

| Key | Default | Who can change | Audit event | Source |
|---|---|---|---|---|
| `allowed_invite_domains` | off (any domain) | Admin | `settings.invite_domains` | Identity §4.2 |
| `magic_link_enabled` | on when email is configured | Admin | `settings.magic_link` | Identity §4.11 |
| `min_password_length` | 10 (raise only) | Owner | `settings.password_policy` | Identity §4.11 |
| `default_channels` | `#general` (**public channels only**) | Admin | `settings.default_channels` | Identity §4.3 |
| `welcome_post_enabled` | on | Admin | `settings.welcome_post` | Identity §4.3 |
| `general_read_only` | off | **Owner** | `settings.general_read_only` | Chat §3.1 |
| `link_previews_enabled` | on | Admin | `settings.link_previews` | Chat §11 |
| `link_preview_blocked_domains` | empty | Admin | `settings.link_preview_domains` | Chat §11 |
| `screen_share` | `everyone` (`everyone` / `admins` / `off`) | **Owner** | `settings.screen_share` | PRD §5.8, Calls §6.6 |
| `screen_share_max_height` | 1080 (720 / 1080) | **Owner** | `settings.screen_share_cap` | PRD §5.8, Calls §6.6 |
| `holiday_regions` | regions of current members | Admin | `settings.holiday_regions` | Calendar §6 |
| `external_invites` | `on` (`on` / `admins` / `off`) | Admin | `settings.external_invites` | Calendar §8 |
| `external_invite_daily_cap` | 50 recipients per member per day | Admin | `settings.external_invite_cap` | Calendar §8, §8 here |
| `ics_subscription_limit` | 50 per workspace | Admin | `settings.ics_limit` | Calendar §10 |
| `offline_documents_enabled` | on (members can also turn it off for themselves in `user_preferences.offline_cache`) | Admin | `settings.offline_documents` | Documents §4.7 |
| `email_provider` | not configured | **Owner** | `settings.email` | TDD §7.6 |
| `telemetry` | off | **Owner** | `settings.telemetry` | TDD §7.9 |
| `storage_thresholds` | 70 / 85 / 95 / 98 % | **Owner** | `settings.storage` | TDD §7.7 |
| `r2_budget_gb`, `r2_hard_budget_gb` | none | **Owner** | `settings.r2_budget` | TDD §7.7 |
| `search_copy_months` | unlimited | **Owner** | `settings.search_copy` | TDD §7.7 |
| `upload_max_bytes` | 2 GB | Admin | `settings.upload_limit` | TDD §8.3 |
| `blocked_file_extensions` | empty | Admin | `settings.file_types` | TDD §8.3 |
| `retention_policies` | none (Phase 2) | **Owner** | `settings.retention` | PRD §10.2 |

Every change writes the audit event with old and new values. Settings are cached per Worker isolate for at most 30 seconds **(default)**.

## 8. Rate limits and quotas

Short-window limits use the Workers **Rate Limiting binding**. Daily quotas use **D1 counters** keyed by `(user, quota, day)` in the member's time zone. Exceeding a limit returns a typed `rate_limited` result with a retry-after value, never a thrown error (AGENTS §4.1).

| Action | Limit | Scope |
|---|---|---|
| Sign-in attempts | 5 per minute per IP; 10 per hour per account; progressive delay, no lockout | TDD §8.1 |
| Magic-link and password-reset requests | 3 per 15 minutes per account; 20 per hour per IP **(default)** | |
| Setup, recovery, invitation acceptance | 5 per minute per IP | TDD §8.1 |
| Message sends | 10 per 10 seconds per user per conversation **(default)** | |
| `@channel` / `@here` | 1 per 5 minutes per user per channel **(default)** | |
| "Notify anyway" (break through DND) | **Once per sender per recipient per 30 minutes** **(default)** | Notifications §5.2 |
| Group DM creation | 20 per hour per user **(default)** | |
| Poll creation | 10 per hour per user **(default)** | |
| Rings | 5 rings to the same person per 10 minutes **(default)** | |
| Handle changes | 3 per 30 days per user **(default)** | |
| Access requests | 1 pending request per object per requester; 20 per day per requester **(default)** | Permissions §7 |
| External event invitation emails | **50 external recipients per member per day** (setting) | Calendar §8 |
| Uploads | 2 GB per file (setting); 10 GB per user per day **(default)** | |
| Link-preview fetches | 60 per minute per workspace; 3 per message | §9 |
| ICS-in fetches | 1 per subscription per hour; 50 subscriptions per workspace | §9 |

**Structural limits:**

| Limit | Value |
|---|---|
| Folder depth | 20 |
| Items per folder | 10,000 |
| Versions per file | 100 |
| Comment length | 10,000 characters |
| Pins per channel | 100 |
| Link previews per message | 3 |
| Group DM size | 8 |
| Call participants | 25 |
| Drives per workspace | 500 **(default)** |
| Offline documents per device | 20 documents, 100 MB total |
| Message body | 40 KB |
| Poll options | 2–10 |

## 9. Outbound fetching

This applies to every server-side fetch of a user-supplied URL: link previews, preview images and ICS-in.

| Rule | Value |
|---|---|
| Schemes | `https` only, for previews, images and ICS **(default)** |
| Address filtering | Resolve DNS first and refuse **private, loopback, link-local, CGNAT and cloud-metadata ranges** (IPv4 and IPv6). Repeat the check on every redirect. |
| Redirects | At most 3, each re-validated |
| Timeouts | 5 s for previews and images; 10 s for ICS |
| Byte caps | Enforced while streaming: 1 MB HTML, 1 MB images, 5 MB ICS. Abort past the cap. |
| Content type | Must match the purpose (`text/html` for previews, `image/*` for images, `text/calendar` for ICS) |
| Request hygiene | No cookies, no credentials, fixed user agent `Officebox-Fetcher/1.0 (+workspace)` |
| Scheduling | Fetches go through a **queue**, with per-workspace and per-user rate limits (§8) |
| Caching | Preview metadata cached 24 hours per URL. Images stored once in R2 at original size up to 1 MB (no server-side resizing; the client scales) **(default)**. |
| ICS-in URLs | Stored **encrypted** with a Worker secret, **masked** in the UI (`https://calendar.example.com/…/basic.ics`), never shown to anyone but the subscriber, never exported |

Workers can't reach private networks directly. The address filtering still applies, to guard against misconfigured proxies and future network features.

## 10. Email links

**Rule:** every link that changes state opens a **confirmation page**, and the state changes only on a **POST** from that page. Mail scanners and link prefetchers (for example Outlook Safe Links) issue GETs, so they can't use up a token or answer an RSVP.

| Link | Token type | Valid for | Confirmation page |
|---|---|---|---|
| Magic link | Single-use | 15 minutes | "Sign in to *Workspace* as *email*" → Continue |
| Password reset | Single-use | 1 hour | Set new password |
| Recovery link (admin-issued) | Single-use | 24 hours | Set password or register passkey |
| Invitation | Single-use | 7 days | Accept form |
| Email change confirmation | Single-use | 24 hours | Confirm |
| **External RSVP** | **Per-attendee, reusable** | Until the event (or series) ends | Event summary with **Accept / Maybe / Decline** buttons. Response can be changed until the token expires. |
| External opt-out | Per-recipient, reusable | Indefinite | "Stop invitations from *Workspace*" → Confirm **(default)** |

Tokens are 32 random bytes, stored hashed (`auth_tokens`, `event_attendees.rsvp_token_hash`). Using a single-use token marks it used atomically.

**External invitation email template** (fixed; no free-form HTML):
- **From display name:** "*Name* via Officebox (*Workspace*)". The envelope sender is the workspace's configured email address.
- **Body:** title, time in the recipient's zone where known (otherwise the organiser's zone with a UTC offset), location, and description, all as **escaped plain text**. Links in the description are shown as text, not hyperlinks **(default)**.
- **Footer:** "You received this because *Name* invited you via Officebox. Respond using the buttons below — replies to this email aren't read." Plus the opt-out link.
- Opted-out addresses are refused with a typed result telling the organiser.

## 11. Timers and schedulers

| Timer | Owner | Mechanism |
|---|---|---|
| Event reminders | **ReminderScheduler DO** (singleton) | `scheduled_triggers` (below) |
| Event call starting (`call_starting` notification) | ReminderScheduler | Trigger kind `event_start` |
| Focus-time DND start and end | ReminderScheduler | Kinds `focus_start` / `focus_end` → user preference update + hub event |
| Time-off status start and end | ReminderScheduler | Kinds `timeoff_start` / `timeoff_end` → automatic status |
| Status expiry | ReminderScheduler | Kind `status_expire` |
| DND schedule (daily quiet hours) | ReminderScheduler | Kinds `dnd_start` / `dnd_end`, from the member's schedule, refilled daily |
| **10-minute unread email** | **Queues, delayed message** | One message per recipient per conversation, sent with `delaySeconds` = the member's delay. Deduplicated by key `(user, conversation, window)`. When it fires, the consumer checks the read cursor, activity, DND and time off, and sends only if still unread. **Paused during DND and time off:** if the member is in DND or on time off when it fires, it's re-enqueued for the end of that period. |
| DND-end held-notification summary | UserHub DO | When DND, focus or time off ends, the hub delivers "While you were away…" ([Notifications](notifications.md) §5.1) |
| RSVP-response batch | Hourly cron | Groups `rsvp_response` notifications per organiser ([Notifications](notifications.md) §3) |
| Poll auto-close | Channel DO | Alarm multiplexer timer `poll:<id>` |
| Huddle end (30 s after empty) | HuddleRoom DO | Alarm timer `end_at` |
| Screen hand-over deadline (5 s) | HuddleRoom DO | Alarm timer `handover_deadline` |
| Ring timeout (30 s) | UserHub DO (caller's) | Alarm timer `ring:<huddleId>` |
| ICS-in refresh | Hourly cron | Queue a fetch per due subscription |
| Snooze wake-ups | 5-minute cron | TDD §7.8 |
| Purge, retention, reconciliation, version thinning, release check | Daily cron | TDD §7.8 |
| Scheduled-trigger refill | Hourly cron | Below |

**Why a Queue for the unread email:** a UserHub alarm would wake the hub of every offline recipient just to check a cursor. The hub exists for connected users. A delayed queue message costs nothing until it fires, survives restarts, and is checked against D1 read state, which is the truth for unread counts (TDD §3.5). Queue delivery is at-least-once, so the consumer must be idempotent.

### 11.1 ReminderScheduler

```sql
CREATE TABLE scheduled_triggers (            -- in the ReminderScheduler DO's SQLite
  id TEXT PRIMARY KEY,                        -- idempotency key, e.g. "reminder:<event>:<occurrence>:<user>:<minutes>"
  fire_at INTEGER NOT NULL,                   -- UTC ms
  kind TEXT NOT NULL,                         -- reminder | event_start | focus_start | focus_end | timeoff_start | timeoff_end | status_expire | dnd_start | dnd_end
  target TEXT NOT NULL,                       -- JSON: { eventId, occurrence, userId, ... }
  fired_at INTEGER
);
CREATE INDEX scheduled_triggers_due ON scheduled_triggers(fire_at) WHERE fired_at IS NULL;
```

- **Filling:** a rolling **48-hour** expansion of recurring events, exceptions and per-attendee time zones (the all-day "09:00 the day before" uses each attendee's zone).
- **Refreshing:**
  - The calendar service upserts or deletes the affected triggers whenever an event is created, edited or deleted, an RSVP changes (decliners lose reminders), attendees change, or reminder settings change.
  - An **hourly refill** job extends the window and repairs drift.
- **Alarm:** one alarm, always set to the earliest unfired `fire_at`.
- **Firing:** the trigger is marked `fired_at` in the same transaction as enqueueing its effect, so a retry never fires it twice.
- **Catch-up after downtime:** overdue triggers **less than 1 hour late** fire immediately. Older ones are dropped (marked fired, with a log entry) **(default)**.
- **Load:** a 100-member workspace stays in the low thousands of rows for 48 hours. If one object becomes hot, shard by `hash(userId) % N` **(default N = 1)**.

## 12. Realtime connection budget

This replaces TDD §3.5's "at most three WebSockets per tab".

| Socket | When open |
|---|---|
| Hub (UserHub) | Always (one per browser, shared across tabs by leader election) |
| Channel (ChatChannel) | The conversation on screen |
| Document or whiteboard (DocRoom / BoardRoom) | The item on screen |
| Call (HuddleRoom) | While in a call |
| Embedded whiteboard | **Only while "edit in place" is active** |

- **Other embeds** (messages, events, document previews, link previews) **don't open sockets**. They refresh through hub `activity` events for objects the viewer has open.
- **Hard cap: 6 sockets per tab** **(default)**. Opening another closes the least recently used embedded-board socket first.

**Access-change propagation:**
- When a member's role is **downgraded**, or their **inherited access changes** (item moved, folder or drive grant changed, channel made private), the Worker computes the affected users and sends `access.changed { userId, object, newRole }` to the affected Durable Objects.
- Each DO then **switches the socket to read-only** (for viewer or commenter) or **closes it with `4403`** (no access). This complements `closeConnections` for full revocation (TDD §3.5).
- **Offline edits after losing access:** on reconnect the server rejects updates from a connection without edit rights. The client keeps the unsynced changes in a local copy the user can **export as Markdown**, and shows "You no longer have edit access — your offline changes were not saved" **(default)**.

## 13. Provisioning and backfill

**Created automatically:**

| Event | Created |
|---|---|
| Setup | `#general`, workspace calendar, Channels drive, owner's personal calendar and My files drive, `#general`'s channel folder |
| Account created (invitation accepted) | Personal calendar, My files drive, memberships of default channels |
| Group created | Group calendar, group drive, `@handle` |
| Channel created (not DMs) | Channel folder in the Channels drive. A channel calendar is optional. |
| Drive created | Root folder |
| Rename (group, channel) | Its calendar, drive or folder renamed with it |

**Backfill:** installations that already have data from earlier milestones need the objects later milestones assume. For example, users, groups and channels exist before calendar (M5) and documents (M6) ship.
- Each milestone ships an **idempotent backfill job**. It's enqueued by the migration's deploy step and also runs in the daily cron until complete. It creates any missing personal calendars, group calendars, My files drives, group drives, channel folders, the workspace calendar and the Channels drive.
- Backfill is safe to re-run (`INSERT … ON CONFLICT DO NOTHING`, keyed on owner).
- **M3b chat files need no migration**: chat attachments stay message-owned (§2).

**Default channels must be public.** Private channels can't be selected (Identity §4.11).

## 14. Schema reconciliation

**Rule:** all of these changes are **folded into the baseline migrations of the milestone that first creates the table**, so no table is rebuilt. After a release, changes follow **expand/contract** (TDD §6.5). Enums that may grow are validated with **Zod** in `packages/shared`, not with SQL `CHECK` constraints **(default)**. Existing `CHECK`s on such columns are dropped from the baseline.

| Table | Change | Final value | Source |
|---|---|---|---|
| `users.role` | Add value | `owner`, `admin`, `member`, `guest` (guest reserved; Phase 2) | Identity §2, PRD §10.1 |
| `users` | Add columns | handle (denormalised copy of `handles`), avatar_key, timezone, working_hours, region, job_title, team, pronouns, phone, location, status_*, onboarded_at, tour_dismissed_at, `pending_security_notice` | Identity §5 |
| `handles`, `passkeys`, `auth_tokens` | New tables | As Identity §5 (`handles` is authoritative) | Identity §5 |
| `invitations.email` | Nullability | **NOT NULL** (copy-link invites always carry the email) | Identity §4.2 |
| `invitations` | Add | `group_ids` | Identity §5 |
| `groups`, `group_members` | Add | `groups.handle`; `group_members.role` (`manager`, `member`) | Identity §5 |
| `sessions` | Add | `device_label`, `approx_location` | Identity §5 |
| `channels.type` | Add value | `public`, `private`, `dm`, **`group_dm`**. `dm_key` is required for `dm` and `group_dm`. Converting a group DM to a private channel clears `dm_key` and sets a name. | Chat §3.1 |
| `channels` | Add | `topic`, `description`, `posting_policy` | Chat §15 |
| `channel_members` | Add | `can_post`, `hidden`, `email_delay` | Chat §15 |
| `messages` (D1 copy) | Add | `kind` (`user` or a system kind), `format` (rich-text JSON; the existing `body` column holds the plain-text copy, `text`), `system_payload`, `reply_count`, `also_in_channel`, `forwarded_from`, `previews` | Chat §15 |
| `thread_follows` | New table | Thread follows and per-thread read state. The TDD `follows` table remains for other object types. | Chat §15 |
| `saved_items`, `sidebar_prefs`, `link_previews`, `message_previews` | New tables | As Chat §15 (`saved_items.state`: `in_progress`, `done`) | Chat §15 |
| `channel_members.notify_level` | Values | `default`, `all`, `mentions`, `mute`, `nothing` | Notifications §7 |
| ChatChannel DO `events.actor_id` | Exception | For `poll.voted` on **anonymous** polls, the actor is the per-poll `voter_key`, never a user ID (TDD §2.2 change) | Chat §9 |
| `resource_grants.resource_type` | Values | `document`, `whiteboard`, `folder`, `file`, `drive`, `calendar`, `project` | Permissions §9 |
| `resource_grants.role` | Values | `owner`, `manager`, `editor`, `commenter`, `viewer`, `freebusy` | Permissions §9 |
| `general_access` (documents, folders, files, drives, calendars) | Values | `restricted`, `workspace_freebusy` (calendars only), `workspace_view`, `workspace_comment`, `workspace_edit`. Personal calendars default to `workspace_freebusy`, group and workspace calendars to `workspace_view`. | Permissions §9 |
| `folders.general_access` | Default | **`restricted`** (new items follow the container) | Permissions §5 |
| `access_requests` | New table | Unique pending request per `(object_type, object_id, requester_id)`, with `expires_at` (30 days) | Permissions §9, Documents §9 |
| `item_activity` | New table | Details-panel activity | Documents §9 |
| `folders` | Add | `drive_id`, `channel_id` | Documents §9 |
| `files` | Rules | Either **message-owned** (`parent_type = 'message'`, no folder, no versions, deleted with the message) or a **drive file** (`folder_id` set, versioned). "Save to folder" copies a message-owned file into a new drive file. | §2; Documents §6 |
| `files` | Add | `drive_id`, `current_version`, `copied_from_file_id` (Save to folder provenance); new `file_versions` table | Documents §9 |
| `documents` | Add | `folder_id`, `drive_id`, `created_by` | Documents §9 |
| `drives`, `stars`, `recent_items`, `comment_threads`, `comments` | New tables | As Documents §9 | Documents §9 |
| `huddles.context_type` | Values | `channel` (including DMs), `document`, `event` (`project` reserved) | Calls §10 |
| `huddles` | Add | `started_message_id`, `purge_after`, **`context_key`** (e.g. `channel:<id>`, `document:<id>`, `event:<id>`, `event:<id>:<occurrenceStart>`). The active-call unique index moves to `context_key WHERE ended_at IS NULL`. The call kind is **derived**, not stored. | Calls §3, §10 |
| `huddle_messages` | New table | Keyed to the **context** (`context_type`, `context_id`, `context_key`), plus `huddle_id` as a nullable reference **without cascade**. Written through an outbox. | Calls §10, §5 here |
| `call_rings` | New table | Missed-call records (UserHub holds live ring state) | Calls §10 |
| `calendars.kind` | Values | `personal`, `group`, `channel`, `standalone`, `workspace`, `external` (holidays are generated, not stored) | Calendar §12 |
| Calendar tables | New tables | `calendars`, `events` (with `range_start`, `range_end` in UTC ms for every event, and `purge_after`), `event_exceptions`, `event_attendees`, `event_reminders`, `event_notes`, `time_off`, `ics_feeds`, `ics_subscriptions` | Calendar §12 |
| `time_off` | Add | `purge_after` (not needed if no Trash; see §5) | Calendar §12 |
| UserHub room registry | Add kind | `channel`, `doc`, **`huddle`** | §3 |
| `user_preferences`, `notify_anyway_log` | New tables | Defined in Notifications §7 (`user_preferences.reminder_defaults`, `offline_cache`, `dnd_until`, `dnd_schedule`, ...) | Notifications §7 |
| `scheduled_triggers` | New table (ReminderScheduler DO SQLite) | §11.1 | §11 |

## 15. Acceptance criteria

- **Lifecycle matrix test:** for each feature row in §3, disabling and deleting a member produces exactly the listed behaviour. After deletion, a scan of every table in §3.1 finds no personal data for that user, and their avatar object is gone from R2.
- **Calls revocation:** a disabled member in an active call is removed within 5 seconds. Ringing them is refused.
- **Cascades:**
  - purging a channel moves folder documents to their creators' My files with explicit shares intact, deletes message-owned files from R2, and removes the conversation from every `sidebar_prefs`
  - deleting a group trashes its drive and archives its calendar
  - deleting a standalone calendar sends cancellations
  - a deleted whiteboard's embeds show "deleted".
- **Retention:** document and event in-call chat survives the 365-day huddle purge. External attendee emails are gone 90 days after the event ends.
- **Export:** an export contains file versions, calendars, time off and hashed poll votes. It contains no sessions, auth tokens, passkeys, ICS feed tokens or ICS-in URLs. A restore into a new domain requires passkey re-registration and works with owner passwords.
- **Admin settings:** every key in §7 is enforced, changeable only by the listed role, and writes its audit event.
- **Rate limits:** each limit in §8 returns `rate_limited` with retry-after at the threshold. The 51st external recipient in a day is refused.
- **Outbound fetching:** preview and ICS fetches to `127.0.0.1`, `10.0.0.0/8`, `169.254.169.254`, `[::1]` and `fc00::/7`, and redirects to them, are refused. Responses over the byte cap are aborted. `http://` URLs are refused.
- **Email links:** a GET to any email link changes nothing (scanner-safe); only the confirmation POST does. An RSVP token works repeatedly until the event ends. Opted-out addresses can't be invited.
- **Timers:**
  - reminders fire within 1 minute of their time
  - after a simulated 30-minute outage, overdue triggers fire once; after a 2-hour outage, they're dropped and logged
  - a declined event removes its reminders
  - the 10-minute email isn't sent if the message is read within 10 minutes.
- **Connection budget:** a tab never exceeds 6 sockets. Downgrading an editor to viewer makes their open document socket read-only without a reconnect. Removing access closes it with `4403`.
- **Provisioning:** setup, account creation, group creation and channel creation create every object in §13. The backfill job is idempotent (running it twice changes nothing).

## 16. Later

Retention policies (Phase 2, PRD §10.2) · sharding the ReminderScheduler · server-side image resizing for previews · legal hold · per-member data export (self-service).

## 17. Open questions

1. **Disabled members' DMs:** should colleagues still be able to send to a deactivated DM (queued until re-enabled), or is sending disabled (the default above)?
2. **Organiser transfer on deletion:** transfer to the first remaining calendar editor, or always to an admin?
3. **External attendee email retention:** is 90 days after the event right, or should it follow the event's own retention?
4. **Catch-up window:** is "fire if less than 1 hour late, otherwise drop" right for reminders after downtime?
5. **ICS-in after restore:** require re-entering subscription URLs (the default above), or export them encrypted with a key the owner keeps?

# Spec: Platform Rules

**Status:** Approved (product owner, 15 Nov 2026)
**Revision:** Revised after second independent review (14 Nov 2026); updated for the approved [Assistant](assistant.md) spec (15 Nov 2026), whose §17 lists the changes; updated for passwordless sign-in on better-auth (15 Nov 2026, [Identity](identity.md) §2): §2, §3, §5–§8, §10, §14, §16 and §17, then for the product owner's answers and two reviews of that change (same day: step-up, the two-step domain move, the notice banner, setup and invitation repair, timers)
**Feature name:** Platform Rules (cross-cutting; not a user-facing feature)
**Milestone:** Applies from M0 onward ([PLAN](../PLAN.md)). Each rule ships with the milestone of the first feature that needs it. · **Related:** PRD §10.2, §13, §18; TDD §2.1, §2.3, §3.5, §6.5, §7.5, §7.8, §8; [Permissions](permissions.md), [Notifications & Attention](notifications.md), [Identity & Access](identity.md), [Chat](chat.md), [Calls](calls.md), [Calendar](calendar.md), [Documents](documents.md), [Assistant](assistant.md)

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
| Owners' sign-in | **Passkeys only** (passwordless, and no magic links: those are for members only). User verification is required. Owners are reminded to keep **two passkeys** and **can't invite anyone until they have a second passkey or a set `RECOVERY_TOKEN`**; they recover through another owner's recovery link or `RECOVERY_TOKEN` ([Identity](identity.md) §2, §4.6). Changed 15 Nov 2026 from "owners must keep a password". |
| Canonical origin | Recorded in `installation` at the setup claim (canonical origin and allowed hosts). Auth routes answer only there; the passkey relying-party ID and **every emailed or copied link** come from it, never the request's `Host`. Changed only by an owner's **two-step domain move**, committed by a passkey registration on the new origin; the old host then redirects (302/307, never 301) ([Identity](identity.md) §2, §4.4). `allowed_hosts` entries come only from the setup claim and committed moves. |
| Step-up | Sensitive actions (passkey add or remove, domain move, role changes and promotion, recovery links, email changes) need a passkey assertion within the last 10 minutes; otherwise `reauth_required` ([Identity](identity.md) §4.5) |
| Admin self-access | Admins need an **owner** to add themselves to a group or grant themselves drive or folder access; audited ([Permissions](permissions.md) §6) |
| Recovery links without email | Allowed for members, but **loudly flagged**: a notice on the member's sign-in page and a flag on the owners' member list |
| Group or channel calendar purged | Each event **moves to its organiser's personal calendar**, so attendees keep it. Events whose organiser is deleted are deleted, and attendees get `event_cancel`. |
| Orphaned private events | An **owner or admin** can delete a private event whose organiser is disabled or deleted, without seeing its details |
| Restore from Trash | The item's **owner**, the **person who deleted it**, **drive managers** of its drive, and **admins** |
| Access-change mechanism | RPC `updateAccess(userId, role \| null)`; WebSocket message `{ type: "access.changed", role }`; close code **4403** when the role is null |

## 3. Member lifecycle

*Disabled* means the member can't sign in and everything they own is kept. *Deleted* means personal data is erased, content they wrote stays as "Former member", and owned containers are transferred (PRD §10.2).

| Feature | Disabled | Deleted |
|---|---|---|
| **Identity** | Sign-in refused. All their sessions revoked (better-auth session rows deleted). All sockets closed with `4401`, including chat, documents, hub **and calls** (room registry kind `huddle`, so the member drops out of calls immediately: the HuddleRoom socket closes and their SFU tracks are closed). Anyone who **loses access to a call's context** (removed from the channel, document or event) is removed the same way, but with close code **`4403`**. Revocation uses the durable room registry plus the Worker-side fallback (§12). Shown under **Deactivated** in the directory. Handle kept. | Everything for *disabled*, then the [erase list](#31-personal-data-erase-list) runs. Handle released (held 30 days). Shown as "Former member". |
| **Chat** | DMs and group DMs are kept and marked **"deactivated"**. Sending to them is disabled **(default)**. Excluded from mention autocomplete and from `@here`. `@channel` and `@group` no longer notify them. Offline emails stop. If they were the **last channel admin**, the longest-standing remaining member is promoted (audited). | Messages stay, attributed to "Former member". Their `thread_follows`, `saved_items` and `sidebar_prefs` are erased. `@handle` text in plain-text copies and the search index is re-rendered as **"Former member"** **(default)**. |
| **Calls** | Removed from any active call (above). Rings to them are **refused** ("*Name* is deactivated"). They can't host. Moderation of a call they hosted passes as set out in [Calls](calls.md) §6.7 (a present moderator; otherwise any participant in DM calls; otherwise the earliest remaining participant). | As disabled. Huddle participant rows, `call_notes.started_by` and transcript speakers (`call_transcript_segments.speaker_id`) show "Former member", like messages. Call notes and mention replies they triggered stay. |
| **Calendar** | They **stay organiser** of their events **(default)**. An owner or admin can delete a **private** event they organised without seeing its details. Their reminders and emails stop. Invitations to them are refused. Hidden from find-a-time. **ICS-out feed tokens are revoked.** ICS-in refreshes pause. | **Events on their personal calendar:** an event with other attendees moves to the **first remaining attendee's** personal calendar (earliest to accept, otherwise earliest invited), and that attendee becomes organiser **(default)**. An event with no other attendees is deleted. **Events they organised on shared calendars:** the organiser becomes the first remaining editor of that calendar, or the calendar owner **(default)**. Private events among these can also be deleted by an owner or admin without seeing details. Standalone calendars they owned are **transferred to an admin**. ICS-in subscriptions and ICS-out feeds are **revoked**. `time_off` is **erased** (it holds sensitive types). `event_notes` and `event_reminders` are deleted. Attendee rows show "Former member". |
| **Documents and files** | They **keep ownership** (PRD §6). Shares stay. Pending access requests to them are re-routed to other editors or managers. | **My files** (documents, whiteboards, files, folders) is **transferred to an admin**, who can then read it. This is stated in the privacy statement ([Permissions](permissions.md) §6). So is ownership of individual items elsewhere. Drives they managed get an admin as manager if none remains. `stars`, `recent_items` and `access_requests` are erased. Comments stay as "Former member". |
| **Notifications** | No new inbox items, emails or rings. Pending delayed emails are dropped when they fire. | `inbox_items`, `notification_preferences`, `user_preferences`, `pending_emails` and `notify_anyway_log` rows are erased. |
| **Search** | Their content stays searchable. Hidden from people search **(default)**. | Content stays (attributed to "Former member"). Removed from people search. `@handle` occurrences re-rendered (Chat row). |
| **Presence** | Removed from WorkspacePresence immediately. | Same. |
| **Assistant** | Assistant DO kept but unreachable. `/ws/assistant` sockets close with `4401`. Proactive triggers, personal reminders and proactive opt-ins are suspended. Queued mention, nudge and proactive requests for them are **dropped** at their status check. **Purges (`assistant-purge`), vector deletes and the DO's `retention_sweep` keep running**, because they're housekeeping, not requests. Re-enabling runs the **reconcile pass** before the DO serves requests ([Assistant](assistant.md) §4.4, §13). | The member's **Assistant DO storage is deleted** (all tables), and their proactive triggers removed ([erase list](#31-personal-data-erase-list)). Every Worker path checks the member's status in D1 before addressing an Assistant DO, so queue consumers and alarms never recreate it. |

### 3.1 Personal-data erase list

Deletion erases these in one idempotent purge job (TDD §2.3), audited:

| Store | What is erased |
|---|---|
| `users` | email, email_verified, **handle** (cleared), avatar_key, phone, pronouns, job_title, team, location, status_emoji, status_text, status_expires_at, timezone (reset to `UTC`), working_hours, region, **`pending_security_notice`**. `display_name` becomes "Former member". `status` becomes `deleted`. |
| R2 | Avatar object |
| Auth | `passkeys`, `auth_tokens`, `sessions`, `auth_accounts`, `auth_verifications` and `magic_link_issues` (pending magic links for their email), `user_devices`, `ws_tickets`, `mfa_factors` |
| Identity | `handles` row released (held 30 days). **`invitations.email`** on invitations sent to that person is redacted (replaced by a hash). |
| Audit | **`audit_log.metadata`**: personal values (emails, names, handles) are replaced with the user ID and "Former member". Audit entries never store raw tokens or secrets in the first place. |
| Preferences | `user_preferences`, `notification_preferences`, `sidebar_prefs` |
| Chat | `thread_follows`, `saved_items`; `@handle` text re-rendered as "Former member" in the D1 message copy, `search_index`, **and the ChatChannel DO's plain-text body** (a DO-side erase task run per channel the member posted in) |
| Calendar | `time_off`, `event_notes`, `event_reminders`, `ics_feeds`, `ics_subscriptions` (and their cached events) |
| Documents | `stars`, `recent_items`, `access_requests` (as requester) |
| Notifications | `inbox_items`, `pending_emails`, `notify_anyway_log`, **`user_availability`** |
| Membership | `group_members`, `channel_members` (channel history stays) |
| Assistant | **Assistant DO storage** (all tables), `assistant_interactions`, `assistant_optins`, `assistant_source_refs`, `personal_reminders`, and their `assistant_brief`, `assistant_prep` and `personal_reminder` triggers ([Assistant](assistant.md) §13) |
| Calls | Nothing erased: `call_notes.started_by` and `call_transcript_segments.speaker_id` keep the user ID and show "Former member", like messages |

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
| **Channel → delete (Trash)** | Everything above | Hidden from everyone. Restorable by the person who deleted it or an admin. |
| **Channel → purge** | Messages, polls and votes, pins, link previews (per-message mapping) | Deleted (channel DO `deleteAll()`) |
| | Message-owned files | Deleted (R2), with their `file_derived_text` and vectors |
| | Channel folder: documents, whiteboards, saved copies | **Moved to each creator's My files** (or an admin's if the creator is gone or deleted). Explicit grants kept. Channel-principal grants removed. Then the empty folder is deleted. |
| | Channel calendar | Purged. Each event **moves to its organiser's personal calendar**; events whose organiser is deleted are deleted, with `event_cancel` to attendees. |
| | Huddle records | `context_id` kept as a tombstone reference. In-call chat was a thread, so it's purged with the messages. |
| | Call notes and transcripts (`call_notes`, `call_transcript_segments`) | Deleted, with their vectors ([Assistant](assistant.md) §12.3) |
| | Saved items, thread follows, inbox items referencing it | Deleted |
| | Sidebar sections | The conversation ID is removed from `sidebar_prefs.sections` |
| | Grants where the channel is the principal | Deleted (audited) |
| **Group → delete** | Group drive | **To Trash with all contents.** Members are warned before confirming **(default)**. Restorable by an admin for 30 days. |
| | Group calendar | **Archived**, then purged after 30 days. On purge each event **moves to its organiser's personal calendar**; events whose organiser is deleted are deleted, with `event_cancel` to attendees. |
| | Grants where the group is the principal | Removed (audited) |
| | Event attendee rows | Already expanded to individuals when the invitation was sent, so they're unaffected |
| | `@handle` | Released (held 30 days) |
| **Calendar → delete** | Personal, workspace, group | **Can't be deleted directly.** Personal goes with its member (events handled as in §3), group with its group, workspace never. Private events whose organiser is disabled or deleted can be deleted individually by an owner or admin. |
| | Standalone | To Trash with its events. Attendees see the events removed (cancellation notice). Restorable by the calendar owner, the person who deleted it, or an admin. |
| | External (ICS in) | Deleted immediately with its cached events (no Trash) |
| **Event → delete** | Single event or whole series | To Trash. Cancellations sent to members and external attendees. Reminders and triggers removed. |
| | One occurrence / "this and following" | Exception (`cancelled`) or series split. No Trash for single occurrences. |
| | Event call | An active call continues until empty. In-call chat stays with the event while it's in Trash, then is purged with it. |
| | Call notes and transcripts | Follow the event: they stay with it while it's in Trash, then are deleted, with their vectors, when it's purged (Assistant §12.3) |
| **Drive → delete** | Folders and items | To Trash as one unit. Restorable by a drive manager, the person who deleted it, or an admin. Items previously trashed individually keep their own purge date. |
| **Folder → delete** | Sub-folders and items | To Trash as one unit. Restorable per the canonical rule (§5). |
| **Document / whiteboard → delete** | Comments, versions, recovery snapshots in R2, **document-owned files** (pasted images, file cards), **call notes and transcripts** of its calls (with their vectors) | To Trash with the item, then purged |
| | Embeds of it elsewhere | Show "This *whiteboard* was deleted" |
| | Search text and stars, recents and access requests | Removed from search immediately; the rest purged |
| **File → delete** | All versions | To Trash, which removes the file's derived text from retrieval (restore re-indexes it). Purge deletes every version's R2 object, its `file_derived_text` rows and their vectors ([Assistant](assistant.md) §9). |
| **Comment thread → delete** | Comments | Deleted immediately (no Trash) by the author (own comments) or the document owner, editors or admins (moderation, audited) |
| **User → delete** | See §3 | |

**Assistant purge fan-out.** Every pipeline that deletes content also purges copies derived from it in members' assistant memory ([Assistant](assistant.md) §4.4):
- **Which pipelines:** a message deleted or a channel purged; a document or whiteboard purged; a file version dropped or purged; an event deleted; call notes or transcripts purged, by retention or by a context cascade. Editing a message doesn't purge **(default)**.
- **How:** the pipeline looks up `assistant_source_refs` and enqueues one **`assistant-purge`** job per affected member. The job skips only **deleted** members; it runs for disabled members, members without assistant access and while the assistant is off.
- **Vectors:** vector deletes and index invalidations always run, even while the assistant is off (Assistant §9).

## 5. Retention, Trash and purge

This extends the PRD §10.2 table. Anything not listed follows the PRD.

| Data | Retention | Trash? | Who can restore |
|---|---|---|---|
| Calendars (standalone) | Until deleted | 30 days | Calendar owner, person who deleted it, admin |
| Events | Until deleted | 30 days | Organiser, person who deleted it, admin |
| Time off | Until deleted by the member; erased when the member is deleted. **No Trash:** `deleted_at` is kept for audit only, and the row is hard-deleted after 30 days **(default)**. | No | — |
| External attendee emails | **Purged 90 days after the event ends** (series: after the last occurrence) **(default)** | — | — |
| ICS-in cached events | Replaced on each refresh; deleted with the subscription | No | — |
| Drives | Until deleted | 30 days | Canonical rule (below) |
| Folders | Until deleted | 30 days | Canonical rule (below) |
| Comments | Life of the document | No (moderated deletes are immediate) | — |
| File versions | With their file. Purged when the file is purged, or when a version beyond the 100-version limit is dropped (oldest first) **(default)**. A dropped version's `file_derived_text` and vectors go with it. | With the file | As the file |
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
| `auth_verifications` (better-auth: magic-link tokens, WebAuthn challenges) | Deleted on use; expired rows deleted daily | No | — |
| `magic_link_issues` | Deleted 7 days after use, revocation or expiry | No | — |
| `user_devices` | Deleted after 400 days unused **(default)**, and with the user | No | — |
| `recovery_token_uses` | Kept (so a used `RECOVERY_TOKEN` value never works again) | No | — |
| `pending_emails` | Deleted when sent or cancelled | No | — |
| **Assistant conversations and memory** (Assistant DO) | `assistant_memory_retention_days` (365 **(default)**), or shorter if the member chose; applied by the DO's daily `retention_sweep`, which keeps running while the assistant is off. **Incognito** conversations: deleted at End or 24 hours after last activity **(default)**. Content whose source the member lost access to: deleted after 7 days hidden **(default)**. Undecided pending items: 30 days **(default)**. Finished, cancelled and expired pending actions: 24 hours ([Assistant](assistant.md) §4, §5.1, §13). | No | — |
| `assistant_interactions` (metadata) | `assistant_interaction_retention_days` (30, PRD §10.2) | No | — |
| `assistant_source_refs` | Until the referencing memory is deleted | No | — |
| Personal reminders (`personal_reminders`) | Deleted 30 days after done or dismissed **(default)** | No | — |
| **Call notes** (`call_notes`) | **Life of the context.** Keyed to the context (`context_type`, `context_id`) and **must not cascade** from `huddles`. | With the context | As the context |
| **Call transcripts** (`call_transcript_segments`) and their vectors | `call_transcript_retention_days` (90 **(default)**), then purged by the daily purge job; earlier if the context is purged | With the context | As the context |
| `file_derived_text` and its vectors | Per file version, following the file: Trash removes it from retrieval, restore re-indexes it, purge deletes it. An owner can delete the whole assistant index (audited) **(default)**. | With the file | As the file |

**Who can restore from Trash (canonical rule):** the item's **owner**, the **person who deleted it**, **drive managers** of its drive, and **admins**. Feature specs use this rule unchanged.

| Container | How the rule applies |
|---|---|
| Item in My files | Owner (the My files member), person who deleted it, admin |
| Item in a shared or group drive | Item owner, person who deleted it, drive managers, admin |
| Channel folder item | Item owner, person who deleted it, admins (admins manage the Channels drive) |
| Folder or drive | Its owner or drive managers, person who deleted it, admin |
| Channel | Person who deleted it, admin |
| Standalone calendar | Calendar owner, person who deleted it, admin |
| Event | Organiser, person who deleted it, admin |

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
| `assistant_interactions` | Metadata only, within retention ([Assistant](assistant.md) §13) |
| Call notes and transcripts | Within retention |
| `passkeys` (public keys, credential IDs, counters, names, how each was created) | **Included** (product owner, 15 Nov 2026). Public keys aren't secret. A restore onto the **same canonical origin** keeps them working; onto another origin they're dropped, and members use a magic link (email configured) while everyone else gets a recovery link. The restore summary lists who needs one ([Identity](identity.md) §2). |

| Excluded | Reason |
|---|---|
| `sessions`, `auth_tokens`, `auth_accounts`, `auth_verifications`, `magic_link_issues`, `user_devices`, `ws_tickets` | Credentials (better-auth's session tokens, magic-link tokens and challenges, our own tokens and device markers) |
| `pending_emails`, `notify_anyway_log`, `scheduled_triggers` | Transient operational state, rebuilt after restore |
| `assistant_optins`, `assistant_source_refs` | Assistant operational state: opt-ins are re-chosen after a restore, and the source mirror is rebuilt from the members' Assistant DOs, which aren't restored either ([Assistant](assistant.md) §13) **(default)** |
| `mfa_factors` | Encrypted with an installation key |
| `ics_feeds` tokens | Credentials. Members create new feed URLs after a restore. |
| ICS-in URLs | Secrets. Subscriptions are exported **without URLs** and need re-entry after a restore **(default)**. |
| `search_index` | Rebuilt on restore (TDD §2.4) |
| `file_derived_text`, assistant vectors | Rebuilt by back-fill, like `search_index` ([Assistant](assistant.md) §9) |
| Assistant conversations and memory (Assistant DO) | Admins can't read them (Assistant §11). Members use the personal export ("Download my assistant data") **(default)**. Not part of a workspace restore. |
| `personal_reminders` | Often come from private conversations. Personal export only **(default)** (Assistant §7.1). |
| Setup, recovery and Worker secrets | Never exported, including `BETTER_AUTH_SECRET` (§16). There are no password hashes to export (changed 15 Nov 2026), so a restore needs no secret carried over; it sets up new secrets and all sessions are invalid. |

## 7. Admin settings

The single list of workspace settings. Feature specs reference this table instead of defining their own.

| Key | Default | Who can change | Audit event | Source |
|---|---|---|---|---|
| `allowed_invite_domains` | off (any domain) | Admin | `settings.invite_domains` | Identity §4.2 |
| `magic_link_enabled` | on when email is configured | Admin | `settings.magic_link` | Identity §4.11 |
| Canonical origin (domain move) | the setup claim's origin | **Owner**, with step-up, in two steps (start, then commit by registering a passkey on the new origin); not a `PATCH /admin/settings` key | `domain.move_started`, `domain.move_committed`, `domain.move_cancelled`, `domain.move_expired` | Identity §4.4 |
| `default_channels` | `#general` (**public channels only**) | Admin | `settings.default_channels` | Identity §4.3 |
| `welcome_post_enabled` | on | Admin | `settings.welcome_post` | Identity §4.3 |
| `general_read_only` | off | **Owner** | `settings.general_read_only` | Chat §3.1 |
| `link_previews_enabled` | on | Admin | `settings.link_previews` | Chat §11 |
| `link_preview_blocked_domains` | empty | Admin | `settings.link_preview_domains` | Chat §11 |
| `screen_share` | `everyone` (`everyone` / `admins` / `off`). **`admins`** means workspace owners and admins, plus channel admins for channel calls. | **Owner** | `settings.screen_share` | PRD §5.8, Calls §6.6 |
| `screen_share_max_height` | 1080 (720 / 1080) | **Owner** | `settings.screen_share_max_height` | PRD §5.8, Calls §6.6 |
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
| `assistant_enabled` | off **(default)** | Admin | `settings.assistant_enabled` | Assistant §10.1 |
| `assistant_access` | `everyone` **(default)** (`everyone` or a list of group IDs). Removing a member's access closes their `/ws/assistant` sockets (`4403`) and suspends their proactive triggers. | Admin | `settings.assistant_access` | Assistant §10.1 |
| `assistant_display_name` | `Butler` (1–32 characters) | Admin | `settings.assistant_name` | Assistant §10.1 |
| `assistant_avatar_key` | built-in icon | Admin | `settings.assistant_avatar` | Assistant §10.1 |
| `assistant_models` | Per role (`chat`, `summaries`, `stt`, `tts`, `vision`): `{ provider, model }`, Workers AI for every role **(default)**. Switching a role to BYOK requires the owner to acknowledge that content will go to that provider. | **Owner** | `settings.assistant_models` | Assistant §10.1 |
| `assistant_gateway_id` | none; set during post-deploy setup | **Owner** | `settings.assistant_gateway` | Assistant §10.1, §11 |
| `assistant_monthly_budget` | none (warn-only thresholds at 50/80/100 % once set) | **Owner** | `settings.assistant_budget` | Assistant §10.1, §10.2 |
| `assistant_daily_caps` | per member per day: 200 requests, 30 voice minutes, 20 image/audio file reads **(default)** | Admin | `settings.assistant_caps` | Assistant §10.1, §8 here |
| `assistant_call_notes_monthly_minutes` | 3,000 per workspace **(default)** | Admin | `settings.assistant_call_notes_cap` | Assistant §10.1, §8 here |
| `assistant_memory_retention_days` | 365 **(default)** (30–730 **(default)**); members can shorten it for themselves | **Owner** | `settings.assistant_retention` | Assistant §4.3, §10.1 |
| `assistant_interaction_retention_days` | 30 (PRD §10.2) (7–365 **(default)**) | **Owner** | `settings.assistant_interaction_retention` | Assistant §10.1 |
| `assistant_mentions` | on **(default)** | Admin | `settings.assistant_mentions` | Assistant §6, §10.1 |
| `assistant_proactive` | `{ brief: on, prep: on, nudges: on }` **(default)**; members still opt in | Admin | `settings.assistant_proactive` | Assistant §8, §10.1 |
| `assistant_call_notes` | on **(default)** | Admin | `settings.assistant_call_notes` | Assistant §12.3 |
| `call_captions` | on **(default)** | Admin | `settings.call_captions` | Assistant §12.4 |
| `call_transcript_retention_days` | 90 **(default)** | **Owner** | `settings.call_transcript_retention` | Assistant §12.3 |
| `assistant_live_voice` | on **(default)** | Admin | `settings.assistant_live_voice` | Assistant §12.2 |
| `assistant_file_media` | on **(default)** (image and audio reading) | Admin | `settings.assistant_file_media` | Assistant §9 |

Every change writes the audit event with old and new values (values that are personal data, such as email addresses, are stored hashed). Settings are read and written through `GET` / `PATCH /admin/settings` (§15). Settings are cached per Worker isolate for at most 30 seconds **(default)**. Durable Objects that enforce a setting (for example ChatChannel for `general_read_only`) receive it through their config RPC.

**Turning `assistant_enabled` off** hides every assistant surface, stops proactive timers and new indexing, and refuses requests. It **keeps** members' memory **(default)**, and leaves purges, vector invalidations and retention sweeps running. Turning it back on runs the reconcile pass (Assistant §4.4, §10.1).

## 8. Rate limits and quotas

Every limit names its **mechanism**:
- **binding:** the Workers Rate Limiting binding. Windows of **exactly 10 or 60 seconds** (no other period is supported); counted **per Cloudflare location**, **approximate and eventually consistent** (bursts can exceed the limit before counts converge). Good for abuse protection, not exact quotas. The wrapper treats a binding result as **advisory**: a refusal returns `rate_limited` with retry-after equal to the period. Local Miniflare is exact, so tests must not rely on production being exact (M0 foundation spike).
- **DO:** a counter inside the Durable Object that already owns the action (exact, per object). For example, per-conversation sends are counted in that channel's ChatChannel DO, and rings in the caller's UserHub.
- **D1 counter:** rows in a `rate_counters` table keyed `(scope, key, window_start)` for windows **longer than 60 seconds** and daily quotas. Daily windows use the member's time zone.

Exceeding a limit returns a typed `rate_limited` result with a retry-after value, never a thrown error (AGENTS §4.1).

**Client IP:** every per-IP limit uses `cf-connecting-ip`, with IPv6 addresses grouped by /64. better-auth must be configured the same way (`advanced.ipAddress.ipAddressHeaders: ["cf-connecting-ip"]` plus `ipv6Subnet`), because its default IP detection was the subject of an advisory (TDD §8.1).

**Sign-in limits are enforced in our middleware, before `auth.handler`**, on atomic D1 `rate_counters` or the binding. better-auth's own limiter (custom storage on the same counters, never memory) is only a backstop. Emails are **normalised** (trim, lowercase, NFKC) before they become limiter keys. **The per-email magic-link limit can't lock a victim out:** inside the window, further requests send no more mail but **don't extend the window**, and the response is identical to an accepted request.

**Removed 15 Nov 2026:** the password sign-in limits (5 attempts per minute per IP, 10 per hour per account with progressive delays) and the M1a draft's slow mode, with its `sign_in_throttle`, `sign_in_failure_buckets` and `sign_in_slots` tables. There are no passwords to guess ([Identity](identity.md) §2).

| Action | Limit | Mechanism | Source |
|---|---|---|---|
| Magic-link requests, per email | 3 emails per fixed 15-minute window per normalised address, counted the same for unknown emails (keyed by an HMAC of the address); later requests in the window send nothing and don't extend it **(default)** | D1 counter, in our middleware | Identity §4.4, TDD §8.1 |
| Magic-link requests, per IP | 20 per hour per IP **(default)** | D1 counter, in our middleware | Identity §4.4 |
| Magic-link confirmation POSTs, per IP | 10 per minute **(default)** | binding, in our middleware | Identity §4.4 |
| Passkey sign-in and registration (options and verification), per IP | 20 per minute **(default)** | binding, in our middleware | Identity §4.4 |
| Setup, setup resume, recovery links, owner recovery (`/recover`), invitation lookup and acceptance | 5 per minute per IP | binding, in our middleware | TDD §8.1 |
| Message sends | 10 per 10 seconds per user per conversation **(default)** | DO (ChatChannel) | Chat §20 |
| `@channel` / `@here` | 1 per 5 minutes per user per channel **(default)** | DO (ChatChannel) | Chat §20 |
| "Notify anyway" (break through DND) | Once per sender per recipient per 30 minutes **(default)** | D1 counter (`notify_anyway_log`) | Notifications §5.2 |
| Group DM creation | 20 per hour per user **(default)** | D1 counter | Chat §20 |
| Poll creation | 10 per hour per user **(default)** | D1 counter | Chat §20 |
| Rings | 5 rings to the same person per 10 minutes **(default)** | DO (caller's UserHub) | Calls §4 |
| In-call chat (`call_chat`) | 20 messages per 10 seconds per user per call **(default)**, separate from the per-conversation send limit | DO (ChatChannel, or HuddleRoom for document and event calls) | Chat §4.7 |
| Handle changes | 3 per 30 days per user **(default)** | D1 counter (from `handles` history) | Identity §4.8 |
| Access requests | 1 pending request per object per requester (unique index); 20 per day per requester **(default)** | D1 (unique index) + D1 counter | Permissions §7 |
| External event invitation emails | 50 external recipients per member per day (setting) | D1 counter | Calendar §8 |
| Uploads | 2 GB per file (setting); 10 GB per user per day **(default)** | Request check + D1 counter | Chat §10, Documents §6 |
| Link-preview fetches | 60 per minute per workspace; 3 per message | binding (workspace key) + request check | §9 |
| ICS-in fetches | 1 per subscription per hour; 50 subscriptions per workspace | Cron schedule + D1 count | §9 |
| General API requests | 300 per minute per session **(default)** | binding | — |
| Assistant requests (DM, talk, mentions, brief and prep) | `assistant_daily_caps.requests` per member per day (setting). Background work (summaries, extraction, indexing, nudge classification) doesn't count against member caps but is counted in usage **(default)**. | D1 counter (`assistant_requests`) | Assistant §10.2 |
| Assistant voice (push-to-talk, live) | `assistant_daily_caps.voice_minutes` per member per day, charged per second (setting) | D1 counter (`assistant_voice`) | Assistant §10.2 |
| Assistant image and audio file reads | `assistant_daily_caps.media_reads` per member per day (setting) | D1 counter (`assistant_media`) | Assistant §10.2 |
| Call notes and captions | `assistant_call_notes_monthly_minutes` per workspace (setting), in call minutes: wall-clock time while notes or anyone's captions are on, not per track **(default)** | D1 counter (`assistant_call_notes`) | Assistant §10.2 |
| Assistant burst | 10 requests per 60 seconds per member **(default)** | binding | Assistant §10.2 |
| Assistant mentions | 5 per 60 seconds per conversation **(default)** | DO (ChatChannel) | Assistant §10.2 |
| Live voice session | 30 minutes per session **(default)**; one at a time per member | DO (Assistant) | Assistant §10.2 |

**Structural limits** (enforced at write time, validated with Zod and checked in the service):

| Limit | Value |
|---|---|
| Folder depth | 20 **(default)** |
| Items per folder | 10,000 **(default)** |
| Versions per file | 100 **(default)** |
| Comment length | 10,000 characters **(default)** |
| Pins per channel | 100 **(default)** |
| Link previews per message | 3 **(default)** |
| Attachments per message | 20 **(default)** |
| Group DM size | 8 |
| Call participants | 25 |
| Drives per workspace | 500 **(default)** |
| Offline documents per device | 20 documents, 100 MB total **(default)** |
| Message body | 40 KB of text; rich-text JSON (`format`) at most 100 KB, so the serialised message state stays under 110 KB, inside the 128 KB queue message limit (Chat §4.1) **(default)** |
| Reactions per message | 50 distinct emoji **(default)** |
| Poll options | 2–10 **(default)** |
| Channel topic / description | 250 / 1,000 characters **(default)** |
| Call notetakers | 1 per call; not counted toward the 25 participants (Assistant §12.3) |
| Push-to-talk clip | 2 minutes **(default)** (Assistant §12.1) |
| Assistant file reading | Documents up to 50 MB or 500 pages; audio up to 2 hours; images up to 20 MB **(default)** (Assistant §9) |

## 9. Outbound fetching

This applies to every server-side fetch of a user-supplied URL: link previews, preview images and ICS-in.

| Rule | Value |
|---|---|
| Schemes and ports | `https` only, **port 443 only**, for previews, images and ICS **(default)** |
| Host checks | Refuse IP-literal hosts in private, loopback, link-local, CGNAT and cloud-metadata ranges (IPv4 and IPv6), including **IPv4-mapped IPv6, decimal and octal IPv4 forms**. Refuse `localhost` and single-label names. Repeat on every redirect. |
| DNS pre-resolution | Defence in depth only: where a DNS-over-HTTPS lookup is used, refuse names that resolve to the ranges above. `fetch` resolves names separately, so this can't fully stop DNS rebinding. |
| Redirects | At most 3, each re-validated |
| Timeouts | 5 s for previews and images; 10 s for ICS |
| Byte caps | Enforced while streaming: 1 MB HTML, 1 MB images, 5 MB ICS. Abort past the cap. |
| Content type | Must match the purpose (`text/html` for previews, `image/*` for images, `text/calendar` for ICS) |
| Request hygiene | No cookies, no credentials, fixed user agent `Officebox-Fetcher/1.0 (+workspace)` |
| Scheduling | Fetches go through a **queue**, with per-workspace and per-user rate limits (§8) |
| Caching | Preview metadata cached 24 hours per URL. Images stored once in R2 at original size up to 1 MB (no server-side resizing; the client scales) **(default)**. |
| ICS-in URLs | Stored **encrypted** with a Worker secret, **masked** in the UI (`https://calendar.example.com/…/basic.ics`), never shown to anyone but the subscriber, never exported |

Workers can't reach private networks directly, so these checks are **defence in depth**: they guard against misconfigured proxies, future network features (for example Workers VPC bindings) and abuse of Cloudflare-internal addresses.

## 10. Email links

**Rule:** every link that changes state opens a **confirmation page**, and the state changes only on a **POST** from that page. Mail scanners and link prefetchers (for example Outlook Safe Links) issue GETs, so they can't use up a token or answer an RSVP.

**Magic links and better-auth** (15 Nov 2026). better-auth's magic-link plugin verifies with a GET (`/magic-link/verify`) and doesn't handle scanner prefetch, so its link is never emailed. The `sendMagicLink` callback emails a link to **our confirmation page** instead; the page's POST consumes the token with our compare-and-set (`magic_link_issues`) and then calls better-auth's verification on the server (`auth.api`), which signs in. better-auth's GET verify route isn't reachable from outside. Magic links go to **members only**, never owners or admins ([Identity](identity.md) §2, §4.4, TDD §8.1).

**Identity links carry their token in the URL fragment** (15 Nov 2026, review): `/sign-in/link#t=…`, `/auth/recover#t=…`, `/invitations/accept#t=…`, `/me/email/confirm#t=…`. Fragments never reach the server, proxies, logs or `Referer`. The page's script POSTs the token in a JSON body and strips the fragment with `history.replaceState`. These pages send **`Referrer-Policy: no-referrer`** and **`Cache-Control: no-store`**. Every link is built from the **canonical origin** (§2), never the request's `Host`. RSVP and opt-out links keep their current form for now.

| Link | Token type | Valid for | Confirmation page |
|---|---|---|---|
| Magic link (members only) | Single-use (our compare-and-set, then better-auth verification) | 15 minutes (`expiresIn: 900`, not better-auth's 300 s default) | "Sign in to *Workspace* as **_email_**" → Continue, with the email prominent so a shared link is obvious; the POST runs better-auth's verification on the server |
| Recovery link (admin- or owner-issued) | Single-use | 24 hours | Register a new passkey |
| Invitation | Single-use | 7 days | Accept form |
| Email change confirmation | Single-use | 24 hours | Confirm |
| **External RSVP** | **Per-attendee, reusable** | Until the event (or series) ends | Event summary with **Accept / Maybe / Decline** buttons. Response can be changed until the token expires. |
| External opt-out | Per-recipient, reusable | Indefinite | "Stop invitations from *Workspace*" → Confirm **(default)** |

Our tokens are 32 random bytes, stored hashed (`auth_tokens`, `event_attendees.rsvp_token_hash`). Using a single-use token marks it used with a compare-and-set, so concurrent POSTs succeed at most once. Magic-link tokens are generated by better-auth and stored in `auth_verifications` (hashed if the M1a-0 spike confirms `storeToken: "hashed"`); we also record each token's hash and the normalised email in `magic_link_issues`, which is what we consume, and revoke by email on an email change or recovery link. Password-reset links are removed (15 Nov 2026).

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
| Focus-time DND start and end | ReminderScheduler | Kinds `focus_start` / `focus_end`, one pair per occurrence; write `user_availability.focus_until` and call UserHub `refreshAvailability()` (Notifications §5.7) |
| Time-off status start and end | ReminderScheduler | Kinds `time_off_start` / `time_off_end`; write `user_availability.away_until` and call UserHub `refreshAvailability()` |
| Status expiry | ReminderScheduler | Kind `status_expire` |
| Assistant daily brief | ReminderScheduler | Kind `assistant_brief`, per opted-in member at the start of their working hours on working days; enqueues to `assistant-proactive` ([Assistant](assistant.md) §8) |
| Assistant meeting prep | ReminderScheduler | Kind `assistant_prep`, 30 minutes **(default)** before a qualifying event the opted-in member attends; enqueues to `assistant-proactive` (Assistant §8) |
| Personal reminders | ReminderScheduler | Kind `personal_reminder`; raises the `personal_reminder` inbox item (Assistant §7.1) |
| DND schedule (weekly quiet hours) | ReminderScheduler | Kinds `dnd_start` / `dnd_end`, expanded from the member's schedule, refilled hourly; each calls UserHub `refreshAvailability()` |
| Manual DND expiry | ReminderScheduler | Kind **`dnd_until_end`**, created when a member sets DND "for 1 hour", "until tomorrow" and so on; calls UserHub `refreshAvailability()` |
| Holds longer than 24 hours (e.g. an email held for a long time off) | ReminderScheduler | Kind `email_release`, instead of a queue delay |
| **Offline unread email** | **Queues, delayed message** + D1 `pending_emails` | Below |
| Hourly and daily email digests | Hourly cron | For members whose email delay is "hourly" or "daily": send one digest of still-unread items; daily digests go at the start of the member's working hours ([Notifications](notifications.md) §6) |
| DND-end held-notification summary | UserHub DO | When DND, focus or time off ends, the hub delivers "While you were away…" ([Notifications](notifications.md) §5.1) |
| RSVP-response batch | Hourly cron | Groups `rsvp_response` notifications per organiser ([Notifications](notifications.md) §3) |
| Poll auto-close | Channel DO | Alarm multiplexer timer `poll:<id>` |
| Huddle end (30 s after empty) | HuddleRoom DO | Alarm timer `end_at` |
| Screen hand-over deadline (5 s) | HuddleRoom DO | Alarm timer `handover_deadline` |
| Ring timeout (30 s) | UserHub DO (caller's) | Alarm timer `ring:<huddleId>`; ring state stored in UserHub SQLite (§12) |
| Call notes idle stop | HuddleRoom DO | Alarm timer `notes_idle`: stops notes when no human participants remain (Assistant §12.3) |
| Call notes finalising | HuddleRoom DO | Alarm timer `notes_finalize`: writes the notes after the call ends or after a crash (Assistant §12.3) |
| Assistant memory housekeeping | Assistant DO (per member) | Alarm multiplexer timers `retention_sweep` (daily; also hidden refs after 7 days, pending items after 30 days, finished actions after 24 hours, and the D1 mirror reconcile), `conversation_close:<id>`, `incognito_expire:<id>`, `pending_expire` (Assistant §14.1) |
| ICS-in refresh | Hourly cron | Queue a fetch per due subscription |
| Snooze wake-ups | 5-minute cron | TDD §7.8 |
| Room-registry sweep | Daily cron | §12 |
| Purge, retention, reconciliation, version thinning, release check | Daily cron | TDD §7.8. The purge job also deletes expired `assistant_interactions`, `call_transcript_segments` past retention (and their vectors), `file_derived_text` for purged versions, and finished `personal_reminders` (Assistant §14.3). |
| Scheduled-trigger refill | Hourly cron | Below |
| Identity repair job | Hourly cron | Completes setup when the owner has a passkey but setup isn't complete; rolls forward or releases partial invitation accepts under the rules in [Identity](identity.md) §4.3; idempotent |
| Setup claim expiry | Hourly cron, and the next setup request | One conditional batch, 24 hours after the claim ([Identity](identity.md) §4.1) |
| Pending domain move expiry | Hourly cron | 24 hours after the start **(default)** |
| Identity token sweeps | Daily cron | Deletes expired `auth_verifications`, `magic_link_issues` 7 days after use or expiry, `auth_tokens` 7 days after use or expiry, and `user_devices` unused for 400 days (§5) |

**Offline unread email:**
1. When a qualifying notification (mention, DM, thread reply, …) is created for an offline or inactive member, the consumer inserts a row into **`pending_emails`** with a uniqueness key `(user_id, conversation_id, window)`. `window` is the time bucket of the member's delay, so repeated events in one conversation share one row. Queues don't deduplicate, so this table does.
2. If the row is new, a queue message is sent with `delaySeconds` = the member's delay. Queues allow at most **24 hours (86,400 s)** for `send`, `sendBatch` and retries (M0 foundation spike). Every delay is validated with Zod as an integer from 0 to 86,400 before sending; a value out of range becomes a typed result, never a thrown error.
3. When it fires, the consumer re-checks the member's **inbox records** for that conversation (Notifications §3.1: still unread, not retracted by message deletion), plus activity, DND and time off.
   - Read, or every message deleted: the row is deleted and nothing is sent.
   - **In DND or on time off:** the email is held. When DND or time off ends it's **re-evaluated: if still unread it's sent after the remaining delay, or immediately if the delay has passed** ([Notifications](notifications.md) §6). The release is a queue message if the remaining hold is 24 hours or less, otherwise an `email_release` trigger.
   - Otherwise it's sent, and the row is deleted.
4. Delivery is at-least-once, so the consumer is idempotent on the `pending_emails` row.

```sql
CREATE TABLE pending_emails (
  user_id TEXT NOT NULL REFERENCES users(id),
  conversation_id TEXT NOT NULL,               -- channel ID, or 'digest'
  window INTEGER NOT NULL,                     -- delay bucket start, UTC ms
  first_event_at INTEGER NOT NULL,
  state TEXT NOT NULL,                         -- queued | held | sent | cancelled (Zod-validated)
  PRIMARY KEY (user_id, conversation_id, window)
);
```

**Why a queue rather than a UserHub alarm:** a UserHub alarm would wake the hub of every offline recipient just to check a cursor. A delayed queue message costs nothing until it fires, survives restarts, and is checked against D1 read state, which is the truth for unread counts (TDD §3.5).

### 11.1 ReminderScheduler

```sql
CREATE TABLE scheduled_triggers (            -- in the ReminderScheduler DO's SQLite
  id TEXT PRIMARY KEY,                        -- idempotency key, e.g. "reminder:<event>:<occurrence>:<user>:<minutes>"
  fire_at INTEGER NOT NULL,                   -- UTC ms
  kind TEXT NOT NULL,                         -- reminder | event_start | focus_start | focus_end | time_off_start | time_off_end
                                              -- | status_expire | dnd_start | dnd_end | dnd_until_end | email_release
                                              -- | assistant_brief | assistant_prep | personal_reminder (Zod-validated)
  target TEXT NOT NULL,                       -- JSON: { eventId, occurrence, userId, ... }
  fired_at INTEGER
);
CREATE INDEX scheduled_triggers_due ON scheduled_triggers(fire_at) WHERE fired_at IS NULL;

CREATE TABLE trigger_outbox (                 -- effects waiting to be delivered (TDD §3.3 outbox pattern)
  trigger_id TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL
);
```

- **Filling:** a rolling **48-hour** expansion of recurring events, exceptions and per-attendee time zones (the all-day "09:00 the day before" uses each attendee's zone).
- **Refreshing:**
  - The calendar service upserts or deletes the affected triggers whenever an event is created, edited or deleted, an RSVP changes (decliners lose reminders), attendees change, or reminder settings change.
  - An **hourly refill** job extends the window and repairs drift.
- **Alarm:** one alarm, always set to the earliest of the next unfired `fire_at` and the next outbox retry.
- **Firing (outbox pattern):** in **one DO transaction**, the trigger is marked `fired_at` and a `trigger_outbox` row is written. The alarm then drains the outbox to the notification queue, deleting a row only after the send succeeds and retrying with backoff otherwise. The consumer is **idempotent on the trigger ID**, so a redelivered effect has no second result.
- **Assistant triggers** (`assistant_brief`, `assistant_prep`, `personal_reminder`) are suspended while the member is disabled; proactive triggers also while they lack assistant access, or the assistant or that proactive feature is off. They're deleted with the member (§3.1).
- **Catch-up after downtime:** overdue triggers **less than 1 hour late** fire immediately. Older ones are dropped (marked fired, with a log entry, no outbox row) **(default)**.
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
| Assistant (Assistant DO, `/ws/assistant`) | **Only while an assistant surface is on screen** ([Assistant](assistant.md) §3, §15) |

- **Other embeds** (messages, events, document previews, link previews) **don't open sockets**. They refresh through hub `activity` events for objects the viewer has open.
- **Hard cap: 6 sockets per tab** **(default)**. Opening another closes the least recently used embedded-board socket first.

**Access-change propagation:**
- When a member's role is **downgraded**, or their **inherited access changes** (item moved, folder or drive grant changed, channel made private), the Worker computes the affected users and calls **`updateAccess(userId, role | null)`** on each affected Durable Object.
- The DO sends **`{ type: "access.changed", role }`** on the member's sockets and **switches them to read-only** (viewer or commenter), or **closes them with `4403`** when the role is `null`. This complements `closeConnections` for full revocation (TDD §3.5).
- **Offline edits after losing access:** on reconnect the server rejects updates from a connection without edit rights. The client keeps the unsynced changes in a local copy the user can **export as Markdown**, and shows "You no longer have edit access — your offline changes were not saved" **(default)**.

**Durable room registry (revocation):**
- Each member's UserHub keeps a **room registry in its SQLite storage**, keyed by `(kind, room_id, connection_id)`, with kinds `channel`, `doc`, `board`, `huddle` and `assistant`. `assistant` sockets close with `4401` when the member is disabled and `4403` when they lose assistant access (Assistant §14.1).
- A room DO **registers** a connection when it accepts the socket and **unregisters** it when the socket closes (the DO calls the hub). Heartbeats refresh `last_seen_at`.
- Entries are **never pruned by age while the socket lives.** A **daily sweep** asks each room whether the connection still exists, and removes entries the room doesn't recognise.
- **Worker-side fallback:** revocation doesn't rely on the registry alone. The Worker also **recomputes the affected rooms from D1** (channel memberships, grants on documents and boards, active call contexts from `huddles`, and the member's own Assistant DO) and calls `closeConnections(userId)` on each directly. Revocation is complete when both paths have run.

**Durable UserHub state:** the hub stores **live ring state**, **`currentCall`** (one call at a time), the **held-notification flag and summary** (DND), the room registry and derived availability in its **SQLite storage**, never only in memory, so hibernation or eviction loses nothing.

## 13. Provisioning and backfill

Each object is created by the **milestone that builds it**. Earlier milestones don't create objects whose tables don't exist yet.

| Milestone | Creates automatically |
|---|---|
| **M1** (identity) | Users, `handles`, groups (with their `@handle`), invitations, installation settings. Nothing else. |
| **M3a** (chat) | `#general` (at setup, or backfilled), channels, default-channel auto-join on account creation, the welcome post. Backfill: existing members join the default channels. |
| **M5a** (calendar) | The workspace calendar, a personal calendar per member, a group calendar per group. Created on setup, account creation and group creation from M5a on, and backfilled. |
| **M6a** (documents) | The Channels drive, a channel folder per channel (not DMs), My files per member, a group drive per group, and a root folder per drive. Created on the matching events from M6a on, and backfilled. |

| Event (once the owning milestone has shipped) | Created |
|---|---|
| Setup | `#general` (M3a), workspace calendar (M5a), Channels drive and `#general`'s folder (M6a), owner's personal calendar (M5a) and My files (M6a) |
| Account created (invitation accepted) | Default-channel memberships (M3a), personal calendar (M5a), My files (M6a) |
| Group created | `@handle` (M1), group calendar (M5a), group drive (M6a) |
| Channel created (not DMs) | Channel folder in the Channels drive (M6a). A channel calendar is optional (M5a). |
| Drive created | Root folder |
| Rename (group, channel) | Its calendar, drive or folder renamed with it |

**Backfill:**
- Each of M3a, M5a and M6a ships an **idempotent backfill job**. It's enqueued by the migration's deploy step and also runs in the daily cron until complete.
- It creates every missing object in the tables above for existing members, groups and channels.
- It's safe to re-run (`INSERT … ON CONFLICT DO NOTHING`, keyed on owner).
- **M3b chat files need no migration:** chat attachments stay message-owned (§2).

**Default channels must be public.** Private channels can't be selected (Identity §4.11).

## 14. Schema reconciliation

**Rule:** all of these changes are **folded into the baseline migrations of the milestone that first creates the table**, so no table is rebuilt. After a release, changes follow **expand/contract** (TDD §6.5). Enums that may grow are validated with **Zod** in `packages/shared`, not with SQL `CHECK` constraints **(default)**. Existing `CHECK`s on such columns are dropped from the baseline.

| Table | Change | Final value | Source |
|---|---|---|---|
| `users.role` | Add value | `owner`, `admin`, `member`, `guest` (guest reserved; Phase 2) | Identity §2, PRD §10.1 |
| `users` | Add columns | handle (denormalised copy of `handles`), avatar_key, timezone, working_hours, region, job_title, team, pronouns, phone, location, status_*, onboarded_at, tour_dismissed_at, `pending_security_notice`, **`email_verified`** (better-auth) | Identity §5 |
| `users` | Remove (baseline, never created) | **`password_hash`** and **`session_epoch`** (15 Nov 2026: passwordless; revocation deletes sessions and closes sockets by session ID, TDD §3.5) | Identity §2, §4.5 |
| `users`, `sessions` | better-auth mapping | better-auth's `user` and `session` models map onto these core tables with `modelName` and `fields` (`name` → `display_name`, `emailVerified` → `email_verified`, `image` → `avatar_key`, `userId` → `user_id`, …). `role`, `status`, `handle` and the profile columns are `additionalFields` with `input: false`. IDs are ULIDs (`advanced.database.generateId`). | Identity §5, TDD §2.1 |
| `handles`, `passkeys`, `auth_tokens` | New tables | As Identity §5 (`handles` is authoritative). `passkeys` is better-auth's `passkey` model, mapped, plus our `verified_sign_count` and `last_used_at`. | Identity §5 |
| `auth_accounts`, `auth_verifications` | New tables (better-auth) | better-auth's `account` and `verification` models, mapped to these names. `auth_accounts.password` is always NULL. better-auth's optional `rateLimit` table isn't created (`rate_counters` is the limiter storage). | Identity §5 |
| better-auth tables | Migration rule | SQL from `npx auth generate`, edited to our names and checked in as expand-only feature migrations (`NNNN_identity_<change>.sql`, safe to re-run); runtime `getMigrations` is never used **(default)**. A better-auth upgrade that changes its schema gets a new reviewed migration, never an edit to a merged one. | Identity §5, TDD §6.5 |
| better-auth date columns | Possible exception | If better-auth's D1 adapter can't store dates as epoch milliseconds, its own date columns (`sessions.expires_at`, `auth_verifications.expires_at`, `created_at` and `updated_at` on its tables) hold what the adapter writes, and this row records the exception to AGENTS §4.1. Checked in the M1a-0 spike. | Identity §11 |
| `invitations.email` | Nullability | **NOT NULL** (copy-link invites always carry the email) | Identity §4.2 |
| `invitations` | Add | `group_ids` | Identity §5 |
| `groups`, `group_members` | Add | `groups.handle`; `group_members.role` (`manager`, `member`) | Identity §5 |
| `sessions` | Add | `device_label`, `approx_location` (better-auth `additionalFields`). **Not created:** `refresh_token_hash`, `session_epoch`, `previous_refresh_hash`, `rotated_at`, `revoked_at` and the M1a draft's `retired_refresh_hashes` (15 Nov 2026: no refresh tokens) | Identity §4.5, §5 |
| `users` | Add | `admin_reset_at`, `admin_reset_by`, `admin_reset_acknowledged_by` (no-email recovery flag) | Identity §4.6, §5 |
| `auth_tokens.kind` | Values | `recovery`, `email_change`, **`passkey_enrol`** (enrolment tickets, bound to a registration challenge in `payload`); plus `payload` and `revoked_at` columns. `magic_link` moves to better-auth's `auth_verifications` plus our `magic_link_issues`; `password_reset` is removed (15 Nov 2026). | Identity §4.4, §4.11, §5 |
| `installation` | Add columns | `canonical_origin`, `allowed_hosts` (JSON), written at the setup claim and by an owner's domain move; `setup_claimed_at` (incomplete claims expire 24 hours after the claim); `pending_origin`, `pending_origin_started_by`, `pending_origin_expires_at` (two-step domain move) | Identity §4.1, §4.4; TDD §2.1, §6.8 |
| `recovery_token_uses` | New table | One row per `RECOVERY_TOKEN` value used (hash, owner, time), replacing a single consumed-hash column | Identity §4.6, §5 |
| `sessions` | Add columns | `fresh_auth_at`, `fresh_auth_method` (step-up) | Identity §4.5, §5 |
| `invitations` | Add columns | `email_normalised` with a **unique index on pending invitations**; `accepted_attempt_id` (repair job; `accepted_by` holds the accepted user) | Identity §4.2, §4.3, §5 |
| `users`, `handles` | Add column | `created_attempt_id` (repair job) | Identity §4.3, §5 |
| `users.pending_security_notice` | Shape | A JSON **list** of notices (kind, time, details), not a single notice | Identity §4.6a |
| `users` | Add columns | `email_normalised` (trim, lowercase, NFKC) with a **unique index**; `first_signed_in_at` (gates setup resume and invitation reopening) | Identity §4.1, §4.3, §5 |
| `passkeys` | Add column | `created_via` (`setup`, `invitation`, `recovery_link`, `owner_recovery`, `magic_link`, `signed_in`; Zod) | Identity §4.4, §5 |
| `magic_link_issues`, `user_devices` | New tables | Our consumption and revocation record for magic links, and known devices for the new-device notice; excluded from export | Identity §4.4, §5 |
| `sign_in_throttle`, `sign_in_failure_buckets`, `sign_in_slots`, `users.password_version` | Dropped from the design (never on `main`) | Drafted in the M1a branch for password throttling and slow mode; not created, because there are no passwords (15 Nov 2026) | §8, Identity §2 |
| `channels.type` | Add value | `public`, `private`, `dm`, **`group_dm`**. `dm_key` is required for `dm` and `group_dm`. Converting a group DM to a private channel clears `dm_key` and sets a name. | Chat §3.1 |
| `channels` | Add | `topic`, `description`, `posting_policy`, **`config_version`** (`INTEGER NOT NULL DEFAULT 0`, bumped on every change pushed by `applyConfig`) | Chat §3.4, §15 |
| `channel_members` | Add | `can_post`, `hidden` (no per-conversation email delay; the delay lives only in `user_preferences.email_delay`, Notifications §7) | Chat §15 |
| `messages` (D1 copy) | Add | `kind` (`user`, **`call_chat`**, **`assistant`**, **`call_notes`**, or a system kind, Chat §4.6), `format` (rich-text JSON; the existing `body` column holds the plain-text copy, `text`), `system_payload`, `reply_count`, `also_in_channel`, `forwarded_from`, `previews` | Chat §15 |
| `messages.sender_id` and `users` | Reserved rows | `messages.sender_id` references `users(id)`, but `'system'` and `'assistant'` are not people. Reserved `users` rows with ids `'system'` and `'assistant'` and **`status = 'system'`** (a new `users.status` value), excluded from the directory, seats and sign-in **(default)**. Assistant messages use `sender_id = 'assistant'`, handled like `'system'`: a reserved sender that bypasses posting policy; `system_payload` holds `{ invoked_by, sources }`. | Assistant §14.2, §17 |
| `thread_follows` | New table | Thread follows and per-thread read state. The TDD `follows` table remains for other object types. | Chat §15 |
| `saved_items`, `sidebar_prefs`, `link_previews`, `message_previews` | New tables | As Chat §15 (`saved_items.state`: `in_progress`, `done`) | Chat §15 |
| `channel_members.notify_level` | Values | `default`, `all`, `mentions`, `mute`, `nothing` | Notifications §7 |
| ChatChannel DO `events.actor_id` | Exception | For `poll.voted` on **anonymous** polls, the actor is the per-poll `voter_key`, never a user ID (TDD §2.2 change) | Chat §9 |
| `resource_grants.resource_type` | Values | `document`, `whiteboard`, `folder`, `file`, `drive`, `calendar`, `project` | Permissions §9 |
| `resource_grants.role` | Values | `owner`, `manager`, `editor`, `commenter`, `viewer`, `freebusy` | Permissions §9 |
| `general_access` (documents, folders, files, drives, calendars) | Values | `restricted`, `workspace_freebusy` (calendars only), `workspace_view`, `workspace_comment`, `workspace_edit`. Personal calendars default to `workspace_freebusy`, group and workspace calendars to `workspace_view`. | Permissions §9 |
| `folders.general_access` | Default | **`restricted`** (new items follow the container) | Permissions §5 |
| `access_requests` | New table | Unique pending request per `(object_type, object_id, requester_id)`, with `expires_at` (30 days). `object_type` includes `event` (approver: the organiser, who adds the requester as an attendee) and `calendar` (approvers grant a calendar role). | Permissions §7, §9, Documents §9 |
| `item_activity` | New table | Details-panel activity | Documents §9 |
| `folders` | Add | `drive_id`, `channel_id` | Documents §9 |
| `files` | Rules | Three kinds: **message-owned** (`parent_type = 'message'`, no folder, no versions, deleted with the message); **document-owned** (`parent_type = 'document'`: images and file cards inside a document, no folder, no versions, inherit the document's access, deleted with it); or a **drive file** (`folder_id` set, versioned). "Save to folder" copies a message-owned file into a new drive file. | §2; Documents §6 |
| `files` | Add | `drive_id`, `current_version`, `copied_from_file_id` (Save to folder provenance); new `file_versions` table | Documents §9 |
| `documents` | Add | `folder_id`, `drive_id`, `created_by` | Documents §9 |
| `drives`, `stars`, `recent_items`, `comment_threads`, `comments` | New tables | As Documents §9. **`drives.general_access`** column (default `restricted`). | Documents §9 |
| `huddles.context_type` | Values | `channel` (including DMs), `document`, `event` (`project` reserved) | Calls §10 |
| `huddles` | Add | `started_message_id`, `purge_after`, **`context_key`** (e.g. `channel:<id>`, `document:<id>`, `event:<id>`, `event:<id>:<occurrenceStart>`). The active-call unique index moves to `context_key WHERE ended_at IS NULL`. The call kind is **derived**, not stored. | Calls §3, §10 |
| `huddle_messages` | New table | Keyed to the **context** (`context_type`, `context_id`, `context_key`), plus `huddle_id` as a nullable reference **without cascade**. Written through an outbox. | Calls §10, §5 here |
| `call_rings` | New table | Missed-call records (UserHub holds live ring state). `state`: `ringing`, `accepted`, `declined`, `missed`, `suppressed`, **`refused`** | Calls §10 |
| `calendars.kind` | Values | `personal`, `group`, `channel`, `standalone`, `workspace`, `external` (holidays are generated, not stored) | Calendar §12 |
| Calendar tables | New tables | `calendars`, `events` (with `range_start`, `range_end` in UTC ms for every event, and `purge_after`), `event_exceptions`, `event_attendees`, `event_reminders`, `event_notes`, `time_off`, `ics_feeds`, `ics_subscriptions` | Calendar §12 |
| `time_off` | Columns | `deleted_at` for audit only; **no `purge_after`** (no Trash; hard-deleted 30 days after `deleted_at`, §5) | Calendar §12 |
| UserHub room registry | Durable | SQLite table keyed `(kind, room_id, connection_id)`; kinds `channel`, `doc`, `board`, **`huddle`**, **`assistant`** (§12) | §3, §12, Assistant §14.1 |
| `user_preferences`, `notify_anyway_log`, **`user_availability`** | New tables | Defined in Notifications §7 (`user_preferences.reminder_defaults`, `offline_cache`, `dnd_until`, `dnd_schedule`, ...; `user_availability.focus_until`, `away_until`, `schedule_dnd_until`, ...) | Notifications §5.7, §7 |
| `inbox_items` | Replace | As Notifications §7: adds `count`, `preview` (redactable, up to 140 characters), `last_event_at` and a `message_id` index; `UNIQUE (user_id, dedupe_key)`, with resolved records reopened in place | Notifications §3.1, §7 |
| `inbox_items.event_type` | Add values | `assistant_brief`, `assistant_prep`, `assistant_nudge`, `assistant_reply`, `personal_reminder` | Notifications §3, Assistant §14.2 |
| `scheduled_triggers`, `trigger_outbox` | New tables (ReminderScheduler DO SQLite) | §11.1 | §11 |
| `scheduled_triggers.kind` | Add values | `assistant_brief`, `assistant_prep`, `personal_reminder` | §11.1, Assistant §14.2 |
| `pending_emails`, `rate_counters`, `ics_opt_outs` | New D1 tables | §11, §8, §15 | here |
| `cron_leases` | New D1 table (M0b) | One lease per cron schedule `(schedule, holder, expires_at)`; overlap guard for the dispatcher. `schedule` is Zod-validated (no `CHECK`). Excluded from export as a job table. | TDD §2.1, §7.8 |
| `rate_counters.scope` | Add values | `assistant_requests`, `assistant_voice`, `assistant_media`, `assistant_call_notes` | §8, Assistant §14.2 |
| `assistant_interactions`, `assistant_source_refs`, `assistant_optins`, `personal_reminders`, `file_derived_text`, `call_notes`, `call_transcript_segments` | New D1 tables | As Assistant §14.2. `call_notes` is keyed to the context and **must not cascade** from `huddles` (§5). | Assistant §14.2 |
| Assistant DO | New DO schema | Versioned with lazy migration through the core DO base class (Assistant §14.1) | Assistant §14.1 |
| `handles` | Reserved | `assistant` and the handle derived from the current `assistant_display_name` | Assistant §14.2, Identity |
| `audit_log.metadata` | Convention | `"via": "assistant"` on assistant-initiated writes (no new column). For writes into DMs and group DMs, only the object type is recorded (Permissions §4.1). | Assistant §5.1, §14.2 |
| Spec DDL `CHECK`s on growable enums | Rule | `calendars.kind`, `events.type`, `huddle_messages.context_type`, `auth_tokens.kind`, `drives.kind`, `item_activity.kind`, `pending_emails.state` and similar are **Zod-validated; the `CHECK` is omitted in migrations**, even where a spec's illustrative DDL shows one | here |

## 15. API

Cross-cutting endpoints not owned by a feature spec. All responses are typed results; errors use the shared error codes.

| Method and path | Who | Purpose |
|---|---|---|
| `GET /admin/settings` | Owner, admin | Read every §7 setting (values the caller may change are marked) |
| `PATCH /admin/settings` | Owner or admin, **per key** (§7) | Change settings; each change writes its audit event |
| `GET /admin/audit?actor=&action=&target=&from=&to=&cursor=` | Owner, admin | Audit log with filters and paging |
| `GET /admin/usage` | Owner | Usage and cost panel (TDD §7.9) |
| `GET /health` | Public (minimal) / owner (detailed) | Health checks (TDD §7.1) |
| `GET /ics/opt-out/:token` | External recipient | Confirmation page "Stop invitations from *Workspace*" (scanner-safe, §10) |
| `POST /ics/opt-out/:token` | External recipient | Record the opt-out |

```sql
CREATE TABLE ics_opt_outs (
  email_hash TEXT PRIMARY KEY,                 -- HMAC(TOKEN_HASH_KEY, lowercased email)
  created_at INTEGER NOT NULL
);
CREATE TABLE rate_counters (
  scope TEXT NOT NULL,                         -- e.g. 'external_invites', 'group_dm_create'
  key TEXT NOT NULL,                           -- user ID, IP, workspace
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (scope, key, window_start)
);
```

## 16. Secrets inventory

Every Worker secret. Secrets are never stored in D1, logged or exported (TDD §8.2).

| Secret | Purpose | Required | Rotation |
|---|---|---|---|
| `BETTER_AUTH_SECRET` | better-auth's secret: signs the session cookie and signs or encrypts its other values. At least **32 characters**, random. Created by the deploy step if missing (TDD §6.1). | Yes (from M1) | Rotate through `BETTER_AUTH_SECRETS` (below), never by replacing the value outright, which signs everyone out and invalidates outstanding magic links. |
| `BETTER_AUTH_SECRETS` | better-auth's rotation list: the new secret plus the previous ones, so values signed with an old secret still verify during the overlap (format per the pinned better-auth version) | No (rotation only) | Add the new secret, keep the old one for **30 days** (the session lifetime) **(default)**, then remove it and set `BETTER_AUTH_SECRET` to the new value |
| `TOKEN_HASH_KEY` | HMAC key for our stored token hashes (`auth_tokens`, invitations, RSVP and opt-out tokens, `ws_tickets`), email hashes in rate-limit keys and audit metadata. Still needed: better-auth doesn't hold these tokens. Created by the deploy step if missing. | Yes | Rotation invalidates outstanding recovery, invitation, email-change and RSVP links; schedule with care |
| `DATA_ENCRYPTION_KEY` | Encrypts ICS-in URLs (and MFA secrets later) | Yes (from M5c) | Re-encrypt on rotation (migration job) |
| `POLL_SECRET_KEY` | Derives per-poll secrets for anonymous voter keys (alternatively, per-poll secrets are generated and stored in the channel DO) **(default: derive)** | Yes (from M3b) | Never rotated for existing polls; rotating changes keys only for new polls |
| `SETUP_TOKEN` | First-run setup | Optional (generated if absent) | Ignored after setup; delete it |
| `RECOVERY_TOKEN` | Owner recovery: lets one owner register a new passkey, once ([Identity](identity.md) §4.6). **At least 32 characters**, compared in constant time, rate-limited per IP. Its hash is recorded as consumed after use, so the same value never works twice. While **set and not yet consumed**, it also satisfies the owners' gate before inviting and promotion to owner. Used values are kept as rows in `recovery_token_uses`. | Optional | Set a fresh value for each recovery, then delete |
| Email provider key(s), SMTP credentials | Outgoing email when not using the default Cloudflare Email Service binding, which needs no secret | Optional | Rotate at the provider |
| `REALTIME_APP_ID`, `REALTIME_APP_SECRET` | Realtime SFU for calls | Optional (calls) | Rotate in the Cloudflare dashboard |
| `TURN_KEY_ID`, `TURN_KEY_API_TOKEN` | TURN credentials | Optional | Rotate in the dashboard |
| `ANALYTICS_API_TOKEN` | Read-only usage panel | Optional | Rotate in the dashboard |
| AI Gateway authentication token | Sent as `cf-aig-authorization` when the configured AI Gateway requires authentication (TDD §5.1) | Optional (assistant, authenticated gateway only) **(default)** | Rotate in the dashboard |

**Removed 15 Nov 2026:** `SESSION_SIGNING_KEY` (and the M1a draft's `SESSION_SIGNING_KEY_PREVIOUS`), because better-auth signs the session cookie with `BETTER_AUTH_SECRET`; and `PEPPER_1`, `PEPPER_2`, …, because there are no passwords. The deploy step no longer creates either.

**The assistant adds no other secrets** ([Assistant](assistant.md) §10.1, §11). Workers AI and Vectorize are bindings. BYOK provider keys live only in AI Gateway's Secrets Store (TDD §5.1), never in Worker secrets, D1, logs or client code. `assistant_gateway_id` is a setting (§7), not a secret.

## 17. Acceptance criteria

- **Lifecycle matrix test:** for each feature row in §3, disabling and deleting a member produces exactly the listed behaviour. After deletion, a scan of every table in §3.1 finds no personal data for that user, and their avatar object is gone from R2.
- **Calls revocation:** a disabled member in an active call is removed within 5 seconds (close code `4401`); a member who loses access to the call's context is removed with `4403`. Ringing a disabled member is refused.
- **Durable registry:** after evicting a member's UserHub and keeping a document socket open for 48 hours (injected clock), disabling the member still closes that socket. With the registry entry deleted, the Worker-side fallback still closes it.
- **Cascades:**
  - purging a channel moves folder documents to their creators' My files with explicit shares intact, deletes message-owned files from R2, and removes the conversation from every `sidebar_prefs`
  - deleting a group trashes its drive and archives its calendar; purging that calendar moves each event to its organiser's personal calendar, and deletes events whose organiser is deleted with `event_cancel` to attendees
  - deleting a member moves their personal-calendar events that have other attendees to the first remaining attendee
  - deleting a standalone calendar sends cancellations
  - a deleted whiteboard's embeds show "deleted"
  - purging a channel, event or document deletes its call notes, transcripts and their vectors; purging a file deletes its `file_derived_text` and vectors; each deleting pipeline enqueues `assistant-purge` for members whose memory cites the object, including disabled members.
- **Retention:** document and event in-call chat survives the 365-day huddle purge. External attendee emails are gone 90 days after the event ends.
- **Export:** an export contains file versions, calendars, time off, hashed poll votes and passkey public keys. It contains no sessions, auth tokens, better-auth accounts or verifications, Worker secrets, ICS feed tokens or ICS-in URLs. After a restore onto the same canonical origin, passkeys still sign in; onto another origin they're dropped, the restoring owner registers a passkey during the restore's setup step, members use a magic link and everyone else a recovery link.
- **Admin settings:** every key in §7 is enforced, changeable only by the listed role, and writes its audit event.
- **Rate limits:** each limit in §8 returns `rate_limited` with retry-after at the threshold, using its stated mechanism. The 51st external recipient in a day is refused. The 4th magic-link request for one email within the 15-minute window sends no email, returns the same response, and doesn't extend the window, for unknown emails too; sign-in limits are enforced before better-auth runs. The client IP is read from `cf-connecting-ip`, so a forged `X-Forwarded-For` doesn't change the key.
- **Outbound fetching:** preview and ICS fetches to IP-literal hosts `127.0.0.1`, `10.0.0.0/8`, `169.254.169.254`, `[::1]`, `fc00::/7`, `[::ffff:127.0.0.1]`, `2130706433` and `0177.0.0.1`, and redirects to them, are refused. Non-443 ports and `http://` URLs are refused. Responses over the byte cap are aborted. (DNS-rebinding protection is best-effort and not part of the pass criteria.)
- **Email links:** a GET to any email link changes nothing (scanner-safe); only the confirmation POST does. Identity links carry the token only in the fragment, are built from the canonical origin, and their pages send `Referrer-Policy: no-referrer` and `Cache-Control: no-store`. An RSVP token works repeatedly until the event ends. Opted-out addresses can't be invited.
- **Timers:**
  - reminders fire within 1 minute of their time
  - each trigger has **at most one effect, retried until delivered**: killing the DO between firing and delivery still delivers exactly one notification after restart, and a redelivered queue message creates no duplicate
  - after a simulated 30-minute outage, overdue triggers fire; after a 2-hour outage, they're dropped and logged
  - manual DND "for 1 hour" ends after 1 hour (`dnd_until_end`)
  - a declined event removes its reminders
  - the 10-minute email isn't sent if the message is read within 10 minutes; two mentions in one conversation within the window produce one email (`pending_emails` uniqueness)
  - an email held by a 3-day time off is released through an `email_release` trigger.
- **Connection budget:** a tab never exceeds 6 sockets. Downgrading an editor to viewer makes their open document socket read-only without a reconnect. Removing access closes it with `4403`.
- **Provisioning:** after each of M1, M3a, M5a and M6a, setup, account creation, group creation and channel creation create exactly the objects §13 lists for the milestones shipped so far. Each backfill job is idempotent (running it twice changes nothing).

## 18. Later

Retention policies (Phase 2, PRD §10.2) · sharding the ReminderScheduler · PDF.js fallback for PDF preview, only if a browser fails the M6 check (the **M0 foundation spike** answered the sandbox question: Chromium's viewer renders under `Content-Security-Policy: sandbox` in an iframe without the `sandbox` attribute; TDD §8.3) · server-side image resizing for previews · legal hold · per-member data export (self-service).

## 19. Open questions

1. **Disabled members' DMs:** should colleagues still be able to send to a deactivated DM (queued until re-enabled), or is sending disabled (the default above)?
2. **Organiser transfer on deletion:** events on a deleted member's personal calendar go to the first remaining attendee (default above). Is that right, or should they go to an admin?
3. **External attendee email retention:** is 90 days after the event right, or should it follow the event's own retention?
4. **Catch-up window:** is "fire if less than 1 hour late, otherwise drop" right for reminders after downtime?
5. **ICS-in after restore:** require re-entering subscription URLs (the default above), or export them encrypted with a key the owner keeps?

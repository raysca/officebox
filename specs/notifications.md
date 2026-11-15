# Spec: Notifications & Attention

**Status:** Approved (product owner, 15 Nov 2026)
**Revision:** Created after independent review (14 Nov 2026); revised after the second review (inbox records, availability model, slices); updated for the approved [Assistant](assistant.md) spec (15 Nov 2026), whose §17 lists the changes
**Feature name:** Notifications (marketing name to be decided later)
**Milestone:** M2 core ([PLAN](../PLAN.md)), extended by each feature milestone (§9) · **Related:** PRD §8; TDD §3.5; [Chat](chat.md), [Calls](calls.md), [Calendar](calendar.md), [Documents](documents.md), [Identity & Access](identity.md), [Assistant](assistant.md), [Platform](platform.md)

Decisions marked **(default)** were not discussed; change them on review.

## 1. Summary

One model for how Officebox gets someone's attention, and when it holds back:
- a catalogue of notification events
- per-conversation notification levels
- do-not-disturb, focus time and time off, combined into one derived availability
- offline email
- the preferences that control all of them.

Every feature raises notifications through this model, never through its own rules.

## 2. Decisions

| Topic | Decision |
|---|---|
| Conversation levels | **All · Mentions · Mute · Nothing** for channels (default Mentions). **DMs and group DMs offer All or Nothing only** (default All) **(default)**. |
| Mute | **Only direct @you mentions get through.** No badges otherwise. |
| Nothing | **Complete silence**, including direct mentions; the inbox still records them **(default)** |
| Inbox records | **One record per dedupe key**, with a count, the latest preview and the time of the latest event. A new event on a resolved record **reopens the same record** **(default)**. |
| Message deletion | Clears matching inbox previews, recalculates counts, and cancels pending offline emails and toasts |
| What DND holds | **In-app banners and sounds, email notifications, call rings.** The inbox still records items. |
| What time off holds | **Call rings and email.** In-app banners and sounds still show **(default)**. |
| Breaking through DND | **"Notify anyway"** for DMs, rate-limited |
| Disclosure | **Shown:** presence and senders see "in do-not-disturb", "focusing until…" and "away until…" |
| Availability | **Derived in the UserHub** from time off, manual DND, focus time, DND schedule and presence (§5.7) |
| Offline email | After **10 minutes unread** (member-configurable, one setting per member), batched per conversation |
| Email content | **No message text for DMs, group DMs and private channels** unless the member opts in. Public channels include text **(default)**. |
| Working hours | **Don't imply DND (default)** |

## 3. Notification events

Every notification is an `inbox_items` record (§3.1, §7) with an `event_type`. The table below is the complete catalogue. A feature that needs a new type adds it here first.

| Event type | Source | Recipients | Default delivery | Dedupe / grouping key | Resolves when |
|---|---|---|---|---|---|
| `mention` | Chat message `@person`, including a mention added by editing a message (Chat §6) | The mentioned member, if they can read the conversation (or a public channel, Chat §6) | In-app; email after the delay | `mention:<channelId>:<seq>` (one record per message) | The member reads the conversation past that message |
| `group_mention` | `@group` | Group members who can read the conversation | In-app; email | `group_mention:<channelId>:<seq>` | As `mention` |
| `channel_mention` | `@channel` | All channel members | In-app; email | `channel_mention:<channelId>:<seq>` | As `mention` |
| `here_mention` | `@here` | Channel members online when it was sent | In-app only **(default)** | `here_mention:<channelId>:<seq>` | As `mention` |
| `dm` | DM or group DM message | Other participants | In-app; email | `dm:<channelId>` (**one record per conversation**, with a count) | The member reads the DM |
| `thread_reply` | Reply in a followed thread (not `call_chat` messages, Chat §4.7) | Thread followers, except the author and muted followers | In-app; email **(default)** | `thread:<rootMessageId>` (one record per thread, with a count) | The member reads the thread |
| `message_removed` | A channel admin or workspace admin removed the member's message (Chat §4.3) | The message's author | In-app only **(default)** | `message_removed:<channelId>:<messageId>` | Dismissed |
| `missed_call` | Unanswered, declined-by-timeout, suppressed or refused DM ring | The callee | In-app; email **(default)** | `missed_call:<huddleId>` | The member opens the DM or calls back |
| `call_starting` | Event call at start time | Attendees who accepted or haven't answered | In-app only | `call_starting:<eventId>:<occurrence>` | 15 minutes after start, or when they join |
| `event_invite` | Invited to an event | The attendee | In-app; email | `event_invite:<eventId>` | The member RSVPs |
| `event_update` | Time, location or call changed | Attendees who haven't declined | In-app; email if the time changed **(default)** | `event_update:<eventId>` (latest wins) | The member opens the event |
| `event_cancel` | Event or occurrence cancelled | Attendees who haven't declined | In-app; email | `event_cancel:<eventId>:<occurrence>` | The member opens it, or after the event's original end |
| `rsvp_response` | An attendee answers | The organiser | In-app, batched hourly **(default)** | `rsvp_response:<eventId>` (count) | The organiser opens the event |
| `reminder` | Event reminder due | The attendee who set it | In-app; email if chosen | `reminder:<eventId>:<occurrence>:<minutes>` | The event starts, or the member dismisses it |
| `doc_mention` | `@person` in a document or comment | The mentioned member, if they have access (otherwise the author is asked to share) | In-app; email | `doc_mention:<documentId>:<nodeOrCommentId>` | The member opens the document |
| `doc_comment` | New comment thread on a document | The document owner, plus followers of the document **(default)** | In-app; email | `doc_thread:<threadId>` | The member opens the thread |
| `comment_reply` | Reply in a comment thread | People who commented in the thread | In-app; email | `doc_thread:<threadId>` (count) | The member opens the thread |
| `access_request` | Request access to an object (permissions §7) | The object's owner and editors (or managers) | In-app; email | `access_request:<objectType>:<objectId>:<requesterId>` | Approved, declined, or expired |
| `access_request_decided` | A request was approved or declined | The requester | In-app; email | `access_request_decided:<objectType>:<objectId>` | The member opens the object (approved) or dismisses it (declined) |
| `share` | An object was shared with the member, or with a group or channel they belong to | Newly granted members (not whole-workspace general access) | In-app; email for direct shares only **(default)** | `share:<objectType>:<objectId>` | The member opens the object |
| `poll_closed` | A poll closes (manually or on time) | The poll creator **(default)** | In-app only | `poll_closed:<pollId>` | The member opens the conversation |
| `assistant_brief` | Daily brief ready (ReminderScheduler `assistant_brief`, [Assistant](assistant.md) §8) | The member, if opted in and with assistant access | In-app; email after the delay, **without content** (§6). `preview = NULL`. | `assistant_brief:<userId>:<date>` | The member opens the assistant DM |
| `assistant_prep` | Meeting prep ready, 30 minutes **(default)** before an event (ReminderScheduler `assistant_prep`, Assistant §8) | The attending member, if opted in and with assistant access | As `assistant_brief` | `assistant_prep:<eventId>:<occurrence>` | The member opens the assistant DM |
| `assistant_nudge` | Commitment nudge after the member's own message ("Want a reminder…?", Assistant §8) | The author, if opted in and with assistant access | As `assistant_brief` | `assistant_nudge:<messageId>` | The member opens the assistant DM |
| `assistant_reply` | A long assistant task finished (for example an audio file is ready, Assistant §9) | The member who asked | As `assistant_brief` | `assistant_reply:<turnId>` | The member opens the assistant DM |
| `personal_reminder` | A personal reminder is due (ReminderScheduler `personal_reminder`, Assistant §7.1) | The member who owns it | In-app; email after the delay | `personal_reminder:<reminderId>` | The member marks it done or dismisses it |
| `security_notice` | **Recovery link issued, email changed, role changed, passkey clone detected** (Identity §4.4, §4.6, §4.11) | The affected member (and, for passkey clone detection, owners) | In-app **and email (always; to the old address for an email change)**, not affected by levels or DND | `security_notice:<kind>:<id>` | Dismissed |

**Reserved for Phase 2** (projects and issues, PRD §5.6): `assignment`, `review_request`. They're not raised in the first release.

The `<userId>` is implicit: every record belongs to one recipient (`inbox_items.user_id`), so keys are unique per recipient.

**Rules:**
- **Never notify yourself.** The actor of an event isn't a recipient.
- **Access is checked at delivery.** A recipient who has lost access by then doesn't receive the item.
- **Grouping and reopening** follow §3.1.
- **Auto-resolution** follows the "Resolves when" column. A resolved item moves to "Read" (Personal Inbox, PRD §5.3).
- **Assistant mentions create no inbox item.** `@`-mentioning the assistant in a conversation notifies nobody (Assistant §6, Chat §6).
- **Assistant items carry no content.** `assistant_brief`, `assistant_prep`, `assistant_nudge` and `assistant_reply` always have `preview = NULL`, their email and push carry no content (§6), and their click target is the assistant DM (Assistant §11).
- **Assistant proactive items** (`assistant_brief`, `assistant_prep`, `assistant_nudge`) follow DND, focus time and time off (§5): they're held while any of these is active, including the in-app banner during time off, and then included in the summary (Assistant §8).

### 3.1 Inbox records

This section defines how `inbox_items` (§7) behaves. TDD §2.1 and §3.3 take this text as written.

- **One record per recipient and dedupe key.** `UNIQUE (user_id, dedupe_key)` holds for every record, open or resolved, because a resolved record is **reused**, not kept as separate history **(default)**.
- **Open and resolved:** a record is *open* when its state is `unread` or `snoozed`, and *resolved* when it's `read`, `done` or `dismissed`.
- **A new event with an existing key:**
  - On an **open** record: `count` goes up by 1, `preview`, `actor_id`, `source_seq`, `message_id` and `last_event_at` take the new event's values, and the record stays open.
  - On a **resolved** record: the record **reopens**. `state` returns to `unread`, `count` resets to 1, `resolved_at` is cleared, and the other fields take the new event's values **(default)**.
- **Per-message keys** (mentions) never repeat, so those records never reopen.
- **Preview:** a plain-text excerpt of the latest event, up to 140 characters, computed from the message's plain-text copy or the comment's text. Previews are for in-app display only; email content follows §6. A preview is **redactable** (set to NULL). Assistant event types never have one (§3).
- **Message deletion.** When the D1 copy applies a deletion (TDD §3.3), the projection consumer:
  - deletes per-message records (`mention`, `group_mention`, `channel_mention`, `here_mention`) for that message
  - for grouped records (`dm`, `thread_reply`), **recalculates `count`** from the D1 copy (messages after the recipient's read cursor that aren't deleted, aren't the recipient's own and aren't `call_chat`). It also sets `preview` to the latest remaining unread message's excerpt, or NULL. A record whose count reaches 0 is resolved.
  - sends `notification.retracted` through the hub, so clients remove toasts and banners for that message
  - **cancels the pending offline email:** the email timer re-checks the records when it fires (§6), so it sends nothing for a record that was deleted or now has a count of 0.
- **Edits** don't create notifications, except a newly added `@person`, `@group`, `@channel` or `@here`, which notifies only the newly mentioned people (Chat §6).

## 4. Levels and mute

Each conversation has one level per member:

| Level | In-app banner and sound | Badge | Email | Default for | Available in |
|---|---|---|---|---|---|
| **All** | Every message | Unread count | Every message (subject to §6) | DMs and group DMs | Channels, DMs, group DMs |
| **Mentions** | `@you`, `@group` you're in, `@channel`, `@here` | Bold for unread; count for mentions | Mentions only | Channels | Channels |
| **Mute** | **Only direct `@you`** | No badge, except a count for `@you` | Only direct `@you` | — | Channels |
| **Nothing** | None | None | None | — | Channels, DMs, group DMs |

- **DMs and group DMs offer All or Nothing only** **(default)**. A DM has no `@you` to tell apart from any other message, so Mentions and Mute don't apply.
- Muted and Nothing conversations are dimmed in the sidebar and can be hidden (Chat §3.3).
- Under **Nothing**, the inbox still records direct mentions so nothing is lost silently **(default)**. They don't badge or notify.
- **Threads:** members follow a thread automatically if they started it, replied, or were mentioned in it. They can follow, unfollow or mute a followed thread (Chat §5).
  - Following a thread in a Mute or Nothing conversation overrides the conversation level for that thread **(default)**.
  - A **muted follow** keeps the thread in the Threads view with its unread count, but sends no `thread_reply` notifications.
- `@channel` and `@here` count as mentions at the Mentions level and are ignored at Mute.

## 5. Do-not-disturb, focus time and time off

### 5.1 Do-not-disturb

- **Manual DND** from the status menu: 30 minutes, 1 hour, 2 hours, until tomorrow (next working-hours start), or a custom end time. It can be ended early.
  - It's stored as `user_preferences.dnd_until`.
  - Its end is a `dnd_until_end` trigger in the ReminderScheduler ([Platform §11](platform.md)), which clears it and releases held notifications even with no client open.
- **DND schedule:** a weekly schedule of quiet periods per weekday, in the member's time zone (for example "every day 19:00–08:00"). Off by default. Each period starts and ends through `dnd_start` / `dnd_end` triggers ([Platform §11](platform.md)).
- **Working hours don't imply DND (default).** They're shown to others, but notifications outside them still arrive unless a schedule is set.
- **While DND is active:**
  - **In-app banners and sounds are held**, and delivered as a summary when DND ends ("While you were in do-not-disturb: 3 mentions, 2 DMs").
  - **Email notifications are held.** When DND ends, each pending offline email is re-evaluated: if its records are still unread, it's sent after the remaining delay, or immediately if the delay has already passed **(default)**.
  - **Call rings are suppressed.** The caller sees the disclosure (§5.4), and a `missed_call` is recorded.
  - **The inbox still records every item**, and badges still update.
  - `security_notice` items are never held.

### 5.2 "Notify anyway"

- When someone sends a DM to a member in DND (or focus time), the composer shows "**Ana is in do-not-disturb until 15:00**" with a **Notify anyway** button.
- "Notify anyway" delivers that one message's notification immediately: banner and sound, but no email. It doesn't ring calls.
- Available in **DMs and group DMs only**. Not for `@mentions` in channels.
- **Rate limit:** once per sender per recipient per 30 minutes **(default)**; [Platform §8](platform.md).
- Not available while the recipient is on time off **(default)**.

### 5.3 Focus time and time off

- **Focus time** (a calendar event type, Calendar §5) **acts as DND** from its start to its end, including each occurrence of a recurring focus block. It's started and ended by `focus_start` / `focus_end` triggers ([Platform §11](platform.md)), which write `user_availability.focus_until` (§7).
- **Time off holds call rings and email** **(default)**.
  - In-app banners and sounds **still show**, because the member may glance at the app.
  - The inbox records everything.
  - Held emails are re-evaluated when time off ends, with the same rule as DND (§5.1): if still unread, they're sent after the remaining delay, or immediately if the delay has already passed.
  - It's started and ended by `time_off_start` / `time_off_end` triggers, which write `user_availability.away_until` (§7).

### 5.4 Disclosure

Others see the state, not the reason (except time off, which shows dates):

| State | Presence | Shown to senders and callers |
|---|---|---|
| DND (manual or scheduled) | Moon icon | "Ana is in do-not-disturb until 15:00" |
| Focus | Focus icon | "Ana is focusing until 11:30" |
| Time off | "Away" | "Ana is away until Mon 3 Dec" |

The time-off type and note are never shown to others (Calendar §7).

### 5.5 Status precedence

A member's displayed status and availability come from the highest-precedence active source:

1. **Time off** (automatic)
2. **Manual DND** (explicit, timed)
3. **Focus time** (automatic, from the calendar)
4. **DND schedule** (automatic)
5. **Online / idle / offline** (presence, §5.6)

- A **manual status message** (emoji and text, Identity §4.7) is shown alongside, unless time off or focus provides an automatic message, in which case the automatic message is shown first and the manual one second **(default)**.
- **Automatic statuses clear themselves** when their source ends (time off ends or is cancelled, focus block ends). The scheduler, not the client, clears them. A manual status clears at its own expiry or when the member clears it.
- **"Away until"** shows the **next working day after `end_date`**: the first day after `end_date` that is a working day in the member's working hours and isn't one of their public holidays. For example, time off Fri–Sun with Monday a bank holiday shows "away until Tue".

### 5.6 Active

A member is **active** when one of their tabs is visible **and** has had input (keyboard, pointer or scroll) in the last 2 minutes **(default)**. Active members don't get offline email, and banners appear in-app instead.

- Each hub socket reports `tab.state { visible, lastInputAt }` to the UserHub whenever visibility changes, and at most every 30 seconds while input continues **(default)**.
- The UserHub uses these reports, not the 5-minute presence heartbeat (TDD §3.5), for the 2-minute rule.
- Presence shows **online** (active), **idle** (connected but not active) or **offline** (no hub connection).

### 5.7 Availability model

The UserHub computes each member's **derived availability**: `{ state, until, source }`, where `state` is one of `away`, `dnd`, `focus`, `scheduled_dnd`, `online`, `idle` or `offline`. It applies the precedence in §5.5 to these sources:

| Source | Stored in | Written by |
|---|---|---|
| Time off | `user_availability.away_until`, `away_time_off_id` | `time_off_start` / `time_off_end` triggers (from Calendar `time_off`), and immediately when time off is created, edited or cancelled |
| Manual DND | `user_preferences.dnd_until` | `PUT /me/dnd`; cleared by the `dnd_until_end` trigger |
| Focus time | `user_availability.focus_until`, `focus_event_id` | `focus_start` / `focus_end` triggers |
| DND schedule | `user_preferences.dnd_schedule`; current period in `user_availability.schedule_dnd_until` | `dnd_start` / `dnd_end` triggers |
| Presence | UserHub memory (`tab.state` reports), published to WorkspacePresence | UserHub |

- Every writer calls the UserHub RPC `refreshAvailability()`. The UserHub re-reads the D1 rows, recomputes the state, and, if it changed, publishes it to WorkspacePresence and sends `status.changed` to online members (TDD §3.5).
- The UserHub keeps the last computed availability in its own storage, so it survives eviction.
- **Callers and senders** read the derived availability through WorkspacePresence (live) or `GET /members/:id/availability` (REST) for the disclosure in §5.4.
- Notification delivery (banners, email, rings) checks the derived availability at delivery time.

## 6. Email

- **When:**
  - a notification that is still unread after the member's **email delay** goes out by email
  - the member must also not be active, not in DND and not on time off (§5)
  - the delay is a **single per-member setting** (`user_preferences.email_delay`): **5, 10 (default) or 30 minutes**, an **hourly digest**, a **daily digest** (sent at the start of working hours), or **off**. There's no per-conversation delay **(default)**.
- **Timers:**
  - Per-recipient, per-conversation delayed messages (5, 10 or 30 minutes) are owned by [Platform §11](platform.md). The timer re-checks the inbox records when it fires and sends nothing if they're resolved, deleted or at a count of 0.
  - Holds for DND or time off can last longer than the queue's 24-hour maximum delay. The platform mechanism re-queues them in chunks, or hands the release to the ReminderScheduler's DND and time-off end triggers ([Platform §11](platform.md)).
  - **Hourly and daily digests are scheduled jobs**, not per-message timers ([Platform §11](platform.md)). They collect each member's unread records.
- **Batching:** one email per conversation (or per document or event) covering everything still unread there. Digests group all conversations.
- **Cancellation:** reading the conversation (or resolving the record) before the delay cancels the pending email. So does deleting the message (§3.1).
- **Content:**
  - **DMs, group DMs and private channels:** **no message text**, only "Ana sent you 2 messages" or "3 new mentions in a private channel", unless the member opts in to message text in their preferences.
  - **Public channels:** the text of the mentioning message **(default)**.
  - **Documents, comments and events:** title, plus the comment text for public-workspace documents only **(default)**.
  - **Personal reminders** (`personal_reminder`): "You have a reminder due" with a link, **without the reminder text** **(default)**, because it may come from a private assistant conversation. The in-app record shows the text to its owner.
  - **Assistant items** (`assistant_brief`, `assistant_prep`, `assistant_nudge`, `assistant_reply`): **no content**, only a fixed line with the assistant's display name ("Butler has your daily brief"), linking to the assistant DM. Push notifications follow the same rule when push exists ([Assistant](assistant.md) §11).
- **Template:**
  - a fixed Officebox template with the workspace name, a deep link and the reason ("You were mentioned in #design")
  - a footer link "**Change email notifications**" opening preferences (an unsubscribe-style link that signs in normally; [Platform §10](platform.md))
  - `security_notice` emails can't be turned off.
- **Email not configured:** email preferences are hidden. Notifications are in-app only, and admin-visible health says email is off.

## 7. Preferences data model

```sql
CREATE TABLE user_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email_delay TEXT NOT NULL DEFAULT '10m',                 -- '5m','10m','30m','hourly','daily','off' (Zod-validated)
  email_include_private_text INTEGER NOT NULL DEFAULT 0,   -- DMs, group DMs, private channels
  dnd_until INTEGER,                                       -- manual DND end (UTC ms), NULL = off
  dnd_schedule TEXT,                                       -- JSON: { mon: [["19:00","08:00"]], ... } in user's zone
  ring_sound INTEGER NOT NULL DEFAULT 1,
  notification_sound INTEGER NOT NULL DEFAULT 1,
  reminder_defaults TEXT NOT NULL DEFAULT '{"timed":[10],"allDay":["-1d@09:00"],"email":false}',
  shortcuts TEXT NOT NULL DEFAULT '{"singleKey":true}',     -- WCAG 2.1.4: single-key shortcuts can be turned off
  offline_cache INTEGER NOT NULL DEFAULT 1,                -- documents offline cache (Documents §4.7)
  updated_at INTEGER NOT NULL
);

CREATE TABLE user_availability (                           -- sources of derived availability (§5.7)
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  away_until TEXT,                                         -- time off: first working day back (YYYY-MM-DD); NULL = not away
  away_time_off_id TEXT,                                   -- the time_off row that set it
  focus_until INTEGER,                                     -- UTC ms; NULL = not focusing
  focus_event_id TEXT,
  schedule_dnd_until INTEGER,                              -- end of the current scheduled quiet period; NULL = outside one
  updated_at INTEGER NOT NULL
);

-- Inbox records (§3, §3.1). Replaces the TDD §2.1 definition.
CREATE TABLE inbox_items (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                       -- notification | action | schedule | follow (Personal Inbox, PRD §5.3)
  event_type TEXT NOT NULL,                 -- §3 catalogue (Zod-validated)
  source_type TEXT NOT NULL,                -- channel | thread | document | event | call | object | security | assistant | reminder
  source_id TEXT NOT NULL,
  source_seq INTEGER,                       -- latest channel seq contributing (chat)
  message_id TEXT,                          -- latest message contributing (chat)
  actor_id TEXT REFERENCES users(id),       -- latest actor
  dedupe_key TEXT NOT NULL,                 -- §3 key
  count INTEGER NOT NULL DEFAULT 1,
  preview TEXT,                             -- plain-text excerpt, up to 140 chars; NULL when redacted
  state TEXT NOT NULL DEFAULT 'unread',     -- unread | snoozed (open) · read | done | dismissed (resolved)
  priority INTEGER NOT NULL DEFAULT 0,
  snooze_until INTEGER,
  due_at INTEGER,
  created_at INTEGER NOT NULL,
  last_event_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  resolved_at INTEGER,
  purge_after INTEGER,                      -- resolved_at + 90 days (Platform §5)
  UNIQUE (user_id, dedupe_key)              -- one record per key; resolved records are reopened (§3.1)
);
CREATE INDEX inbox_items_user_state ON inbox_items(user_id, state, last_event_at);
CREATE INDEX inbox_items_message ON inbox_items(message_id) WHERE message_id IS NOT NULL;
CREATE INDEX inbox_items_source ON inbox_items(source_type, source_id);

-- per-conversation level (channel_members.notify_level): 'default','all','mentions','mute','nothing'
--   'default' = All for DMs and group DMs, Mentions for channels; DMs accept only 'default','all','nothing'
-- thread follow state: thread_follows (Chat §15), including muted follows

CREATE TABLE notification_preferences (                    -- per-event-type delivery overrides (TDD §2.1)
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  delivery TEXT NOT NULL,                                  -- 'in_app','email','push' (Zod-validated)
  enabled INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, event_type, delivery)
);

CREATE TABLE notify_anyway_log (                           -- rate limiting "Notify anyway"
  sender_id TEXT NOT NULL, recipient_id TEXT NOT NULL, sent_at INTEGER NOT NULL,
  PRIMARY KEY (sender_id, recipient_id, sent_at)
);
```

- Missing rows mean defaults. Per-device settings (for example, sounds off on this laptop) come later, with push.
- **Held notifications:** the UserHub keeps a held flag in its storage and delivers a summary when DND or focus ends. The inbox is the durable record, so nothing is lost if the hub is evicted.

## 8. In-app delivery

- **Notification panel:** the bell icon opens a list of recent notifications (the same records as the Personal Inbox), newest first by `last_event_at`, one entry per record with its count and preview. Selecting one opens the object and resolves it.
- **Toasts:** a short banner for new notifications while the app is open and the member isn't in DND (time off doesn't hold them, §5.3). Toasts don't show for the conversation already on screen. `notification.retracted` removes a toast for a deleted message.
- **Sounds:** one notification sound and one ring sound, each on or off (§7).
- **Badges:** sidebar counts (§4) and the browser tab title count ("(3) Officebox").
- **Accessibility:**
  - New notifications are announced through a **polite live region** ("New mention from Ana in #design").
  - Toasts can be reached by keyboard and stay visible while focused or hovered.
  - Nothing flashes, and motion respects reduced-motion settings.
  - The ring banner uses an assertive live region with a keyboard-reachable Accept/Decline.

## 9. Slices

What ships in each milestone. Later slices extend earlier ones; nothing ships before its source feature exists.

| Slice | Events | Levels and behaviour | Timers |
|---|---|---|---|
| **M1** | `security_notice` by **email and the sign-in-page banner** (Identity §4.6) | — | — |
| **M2** | `security_notice` as inbox records too | `inbox_items` with grouping and reopening (§3.1); notification panel, toasts, sounds, badges, live regions; `user_preferences`, `user_availability`; manual DND and DND schedule (holding banners and sounds); presence and the 2-minute active rule; derived availability (§5.7) and disclosure | ReminderScheduler kinds `dnd_until_end`, `dnd_start`, `dnd_end` (Platform §11); held-notification summary |
| **M3a** | `mention`, `group_mention`, `channel_mention`, `here_mention`, `dm` | Levels **All** and **Mentions** per conversation; never notify yourself; access checked at delivery; retraction on message deletion | — |
| **M3b** | `thread_reply`, `poll_closed` | Thread follows, unfollow and muted follows | Poll close (channel DO) |
| **M3c** | `message_removed` | Levels **Mute** and **Nothing**; DM levels All/Nothing; **Notify anyway**; **offline email** (delays, batching, cancellation, privacy, email held during DND) | Offline-email delayed messages; hourly and daily digests |
| **M4** | `missed_call` | Ring suppression during DND; call disclosure | Ring timeout (UserHub) |
| **M5a** | — | Time off in availability (`away_until`), "away until", time off holding rings and email | `time_off_start`, `time_off_end` |
| **M5b** | `event_invite`, `event_update`, `event_cancel`, `rsvp_response`, `reminder`, `call_starting` | Focus time acting as DND | `reminder`, `event_start`, `focus_start`, `focus_end`; hourly RSVP batch |
| **M6** | `doc_mention`, `doc_comment`, `comment_reply`, `access_request`, `access_request_decided`, `share` | — | — |
| **M9a** | `personal_reminder` | — | ReminderScheduler kind `personal_reminder` |
| **M9b** | `assistant_brief`, `assistant_prep`, `assistant_nudge` | Assistant mentions create no inbox item; proactive items held during DND, focus time and time off, then summarised | `assistant_brief`, `assistant_prep` |
| **M9c** | `assistant_reply` (audio files ready) | — | — |

## 10. API

| Method and path | Purpose |
|---|---|
| `GET /me/notifications?state=…&cursor=…` | List notifications (inbox records) |
| `POST /me/notifications/:id` (state: read, done, dismissed; or `snooze_until`) | Update one |
| `POST /me/notifications/read-all?source=…` | Mark all read, optionally for one conversation or object |
| `GET/PATCH /me/preferences` | `user_preferences` |
| `PUT /me/notification-preferences/:eventType` | Per-event-type delivery overrides |
| `PUT /me/dnd` (`until` or `null`) · `PUT /me/dnd/schedule` | Manual DND and schedule |
| `GET /members/:id/availability` | Derived availability for disclosure (§5.7) |
| `PUT /channels/:id/notify-level` | Conversation level (Chat API) |
| `PUT /threads/:rootId/follow` (`{ muted? }`) · `DELETE …` | Thread follow and muted follow |
| `POST /channels/:id/messages/:messageId/notify-anyway` | Break through DND for a DM message |

**Hub messages:**
- client → hub: `tab.state { visible, lastInputAt }`
- hub → client: `notification.new`, `notification.updated` (count or preview changed, or reopened), `notification.retracted`, `notification.resolved`, `notification.held-summary`, `status.changed` (derived availability).

## 11. Acceptance criteria

- **Levels:**
  - in a channel at **Mentions**, a plain message doesn't notify but `@you` does
  - at **Mute**, `@channel` doesn't notify and `@you` does
  - at **Nothing**, `@you` doesn't notify but appears in the inbox
  - DMs notify every message by default; setting a DM to Mute is refused (only All or Nothing are accepted).
- **Inbox records:**
  - five DMs from the same person create **one** record with a count of 5 and the fifth message as its preview
  - after the member reads the DM, a sixth message **reopens the same record** with a count of 1
  - deleting the latest of three unread DMs leaves the record with a count of 2 and the second message as its preview, and sends `notification.retracted`
  - deleting a mentioning message deletes its `mention` record.
- **DND:**
  - a DM during manual DND produces no banner, no email and no sound; the inbox records it
  - when DND ends (by the `dnd_until_end` trigger, with no client open), the member sees one summary
  - an email held by DND is sent immediately when DND ends if its delay had already passed, or after the remaining delay if not, provided the record is still unread.
- **Notify anyway:** it delivers a banner to a member in DND; a second use within 30 minutes is refused.
- **Rings:** a DM call to a member in DND doesn't ring. The caller sees "in do-not-disturb until…", and a `missed_call` is recorded.
- **Focus and time off:**
  - a recurring focus block applies DND at each occurrence's start and clears it at its end, without the client open
  - during time off, in-app banners still show, while rings and emails are held
  - time off Fri–Sun with Monday a public holiday shows "away until Tue"; cancelling the time off clears the status within one minute.
- **Availability:**
  - with time off and a manual DND both active, the status shows time off; after time off ends, the manual DND still applies until its end
  - a member with a visible tab and no input for 2 minutes shows as idle, and starts receiving offline email after the delay
  - the derived availability survives UserHub eviction (`evictDurableObject` test).
- **Offline email:**
  - an unread DM sends one email after 10 minutes; reading it at 9 minutes sends none
  - a DM email contains no message text unless the member opted in
  - a public-channel mention email contains the text.
- **Access and actors:** a member who lost access before delivery gets no notification; actors never notify themselves.
- **Security notices** are delivered during DND and with email notifications off.
- **Accessibility:** new notifications are announced in a polite live region; an axe check passes on the panel and toasts.

## 12. Later

Web push and native push (PRD §8) · per-device settings · keyword notifications · VIP senders who always break through · smart "catch up" summaries (Phase 3 AI) · `assignment` and `review_request` events (projects, Phase 2) · **reply by email** to mention and DM notification emails, received through Cloudflare Email Routing into a Worker `email()` handler and posted to the thread (product-owner decision, 15 Nov 2026: design it with chat, not at launch).

## 13. Open questions

1. **Nothing level:** should direct mentions still create inbox records (the default above), or be completely invisible?

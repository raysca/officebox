# Spec: Notifications & Attention

**Status:** Draft for review
**Revision:** Created after independent review (14 Nov 2026)
**Feature name:** Notifications (marketing name to be decided later)
**Milestone:** M2 core ([PLAN](../PLAN.md)), extended by each feature milestone · **Related:** PRD §8; TDD §3.5; [Chat](chat.md), [Calls](calls.md), [Calendar](calendar.md), [Documents](documents.md), [Identity & Access](identity.md), [Platform](platform.md)

Decisions marked **(default)** were not discussed; change them on review.

## 1. Summary

One model for how Officebox gets someone's attention, and when it holds back:
- a catalogue of notification events
- per-conversation notification levels
- do-not-disturb, focus time and time off
- offline email
- the preferences that control all of them.

Every feature raises notifications through this model, never through its own rules.

## 2. Decisions

| Topic | Decision |
|---|---|
| Conversation levels | **All · Mentions · Mute · Nothing**. Channels default to Mentions; DMs default to All. |
| Mute | **Only direct @you mentions get through.** No badges otherwise. |
| Nothing | **Complete silence**, including direct mentions; the inbox still records them **(default)** |
| What DND holds | **In-app banners and sounds, email notifications, call rings.** The inbox still records items. |
| Breaking through DND | **"Notify anyway"** for DMs, rate-limited |
| Disclosure | **Shown:** presence and senders see "in do-not-disturb", "focusing until…" and "away until…" |
| Offline email | After **10 minutes unread** (member-configurable), batched per conversation |
| Email content | **No message text for DMs, group DMs and private channels** unless the member opts in. Public channels include text **(default)**. |
| Working hours | **Don't imply DND (default)** |

## 3. Notification events

Every notification is an `inbox_items` row (TDD §2.1) with an `event_type`. The table below is the complete catalogue. A feature that needs a new type adds it here first.

| Event type | Source | Recipients | Default delivery | Dedupe / grouping key | Resolves when |
|---|---|---|---|---|---|
| `mention` | Chat message `@person` | The mentioned member, if they can read the conversation (or a public channel, Chat §6) | In-app; email after the delay | `channel:seq:mention:user` · grouped by conversation | The member reads the conversation past that message |
| `group_mention` | `@group` | Group members who can read the conversation | In-app; email | `channel:seq:group:user` · grouped by conversation | As `mention` |
| `channel_mention` | `@channel` | All channel members | In-app; email | `channel:seq:channel:user` | As `mention` |
| `here_mention` | `@here` | Channel members online when it was sent | In-app only **(default)** | `channel:seq:here:user` | As `mention` |
| `dm` | DM or group DM message | Other participants | In-app; email | `channel:dm:user` · **one item per conversation**, updated with a count | The member reads the DM |
| `thread_reply` | Reply in a followed thread | Thread followers, except the author | In-app; email **(default)** | `thread:root:user` · one item per thread with a count | The member reads the thread |
| `missed_call` | Unanswered or suppressed DM ring | The callee | In-app; email **(default)** | `huddle:user` | The member opens the DM or calls back |
| `call_starting` | Event call at start time | Attendees who accepted or haven't answered | In-app only | `event:occurrence:start:user` | 15 minutes after start, or when they join |
| `event_invite` | Invited to an event | The attendee | In-app; email | `event:invite:user` | The member RSVPs |
| `event_update` | Time, location or call changed | Attendees who haven't declined | In-app; email if the time changed **(default)** | `event:update:user` (latest wins) | The member opens the event |
| `event_cancel` | Event or occurrence cancelled | Attendees who haven't declined | In-app; email | `event:occurrence:cancel:user` | The member opens it, or after the event's original end |
| `rsvp_response` | An attendee answers | The organiser | In-app, batched hourly **(default)** | `event:rsvp:organiser` (count) | The organiser opens the event |
| `reminder` | Event reminder due | The attendee who set it | In-app; email if chosen | `event:occurrence:reminder:minutes:user` | The event starts, or the member dismisses it |
| `doc_mention` | `@person` in a document or comment | The mentioned member, if they have access (otherwise the author is asked to share) | In-app; email | `doc:node-or-comment:user` | The member opens the document |
| `comment` | New comment thread on a document | The document owner, plus followers of the document **(default)** | In-app; email | `doc:thread:user` | The member opens the thread |
| `comment_reply` | Reply in a comment thread | People who commented in the thread | In-app; email | `doc:thread:user` (count) | The member opens the thread |
| `access_request` | Request access to an object (permissions §7) | The object's owner and editors (or managers) | In-app; email | `object:requester` | Approved, declined, or expired |
| `access_granted` | A request was approved | The requester | In-app; email | `object:requester` | The member opens the object |
| `share` | An object was shared with the member, or with a group or channel they belong to | Newly granted members (not whole-workspace general access) | In-app; email for direct shares only **(default)** | `object:share:user` | The member opens the object |
| `poll_closed` | A poll closes (manually or on time) | The poll creator **(default)** | In-app only | `poll:closed` | The member opens the conversation |
| `security_notice` | Recovery link used, email changed, role changed, password changed, passkey added, new sign-in from a new device **(default)** | The affected member | In-app **and email (always, to the old address for an email change)**, not affected by levels or DND | `security:kind:id` | Dismissed |

**Rules:**
- **Never notify yourself.** The actor of an event isn't a recipient.
- **Access is checked at delivery.** A recipient who has lost access by then doesn't receive the item.
- **Grouping:** one inbox item per dedupe key. A repeat updates the count and the latest preview instead of creating a new item.
- **Auto-resolution** follows the "Resolves when" column; a resolved item moves to "Read" (Personal Inbox, PRD §5.3).

## 4. Levels and mute

Each conversation has one level per member:

| Level | In-app banner and sound | Badge | Email | Default for |
|---|---|---|---|---|
| **All** | Every message | Unread count | Every message (subject to §6) | DMs and group DMs |
| **Mentions** | `@you`, `@group` you're in, `@channel`, `@here` | Bold for unread; count for mentions | Mentions only | Channels |
| **Mute** | **Only direct `@you`** | No badge, except a count for `@you` | Only direct `@you` | — |
| **Nothing** | None | None | None | — |

- Muted and Nothing conversations are dimmed in the sidebar and can be hidden (Chat §3.3).
- Under **Nothing**, the inbox still records direct mentions so nothing is lost silently **(default)**. They don't badge or notify.
- **Threads:** members follow a thread automatically if they started it, replied, or were mentioned in it. They can follow or unfollow manually. Following a thread in a Mute or Nothing conversation overrides the conversation level for that thread **(default)**.
- `@channel` and `@here` count as mentions at the Mentions level and are ignored at Mute.

## 5. Do-not-disturb, focus time and time off

### 5.1 Do-not-disturb

- **Manual DND** from the status menu: 30 minutes, 1 hour, 2 hours, until tomorrow (next working-hours start), or a custom end time. It can be ended early.
- **DND schedule:** a weekly schedule of quiet periods per weekday, in the member's time zone (for example "every day 19:00–08:00"). Off by default.
- **Working hours don't imply DND (default).** They're shown to others, but notifications outside them still arrive unless a schedule is set.
- **While DND is active:**
  - **In-app banners and sounds are held**, and delivered as a summary when DND ends ("While you were in do-not-disturb: 3 mentions, 2 DMs").
  - **Email notifications are held.** The offline-email timer is paused and resumes when DND ends.
  - **Call rings are suppressed.** The caller sees the disclosure (§5.4), and a `missed_call` is recorded.
  - **The inbox still records every item**, and badges still update.
  - `security_notice` items are never held.

### 5.2 "Notify anyway"

- When someone sends a DM to a member in DND (or focus time), the composer shows "**Ana is in do-not-disturb until 15:00**" with a **Notify anyway** button.
- "Notify anyway" delivers that one message's notification immediately: banner and sound, but no email. It doesn't ring calls.
- Available in **DMs and group DMs only**. Not for `@mentions` in channels.
- **Rate limit:** once per sender per recipient per 30 minutes **(default)**; platform §8.
- Not available while the recipient is on time off **(default)**.

### 5.3 Focus time and time off

- **Focus time** (a calendar event type, Calendar §5) **acts as DND** from its start to its end, including each occurrence of a recurring focus block. It's started and ended by the scheduler (platform §11).
- **Time off** acts as **DND for rings and email** **(default)**. In-app notifications are held like DND. The inbox still records items, and nothing is delivered as an email during time off. When time off ends, the member gets one summary.

### 5.4 Disclosure

Others see the state, not the reason (except time off, which shows dates):

| State | Presence | Shown to senders and callers |
|---|---|---|
| DND | Moon icon | "Ana is in do-not-disturb until 15:00" |
| Focus | Focus icon | "Ana is focusing until 11:30" |
| Time off | "Away" | "Ana is away until Mon 3 Dec" |

The time-off type and note are never shown to others (Calendar §7).

### 5.5 Status precedence

A member's displayed status and availability come from the highest-precedence active source:

1. **Time off** (automatic)
2. **Manual DND** (explicit, timed)
3. **Focus time** (automatic, from the calendar)
4. **DND schedule** (automatic)
5. **Online / away** (presence)

- A **manual status message** (emoji and text, Identity §4.7) is shown alongside, unless time off or focus provides an automatic message, in which case the automatic message is shown first and the manual one second **(default)**.
- **Automatic statuses clear themselves** when their source ends (time off ends or is cancelled, focus block ends). The scheduler, not the client, clears them. A manual status clears at its own expiry or when the member clears it.
- **"Away until"** shows the **next working day after `end_date`**: the first day after the time-off range that is a working day in the member's working hours and isn't one of their public holidays. For example, time off Fri–Sun with Monday a bank holiday shows "away until Tue".

### 5.6 Active

A member is **active** when a tab has focus and has had input (keyboard, pointer or scroll) in the last 2 minutes, **or** their hub connection reports a visible tab **(default)**. Active members don't get offline email, and banners appear in-app instead.

## 6. Email

- **When:**
  - a notification that is still unread after the member's **email delay** goes out by email
  - the member must also not be active and not in DND or time off
  - the delay is **5, 10 (default) or 30 minutes**, an **hourly digest**, a **daily digest** (sent at the start of working hours), or **off**.
- **Batching:** one email per conversation (or per document or event) covering everything still unread there. Digests group all conversations.
- **Cancellation:** reading the conversation (or resolving the item) before the delay cancels the pending email. The timer is owned per recipient and conversation (platform §11).
- **Content:**
  - **DMs, group DMs and private channels:** **no message text**, only "Ana sent you 2 messages" or "3 new mentions in a private channel", unless the member opts in to message text in their preferences.
  - **Public channels:** the text of the mentioning message **(default)**.
  - **Documents, comments and events:** title, plus the comment text for public-workspace documents only **(default)**.
- **Template:**
  - a fixed Officebox template with the workspace name, a deep link and the reason ("You were mentioned in #design")
  - a footer link "**Change email notifications**" opening preferences (an unsubscribe-style link that signs in normally; platform §10).
  - `security_notice` emails can't be turned off.
- **Email not configured:** email preferences are hidden. Notifications are in-app only, and admin-visible health says email is off.

## 7. Preferences data model

```sql
CREATE TABLE user_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email_delay TEXT NOT NULL DEFAULT '10m' CHECK (email_delay IN ('5m', '10m', '30m', 'hourly', 'daily', 'off')),
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

-- per-conversation level (channel_members): replaces notify_level values
--   notify_level IN ('default','all','mentions','mute','nothing'); 'default' = All for DMs, Mentions for channels
-- thread follow state: thread_follows (Chat §15)

CREATE TABLE notification_preferences (                    -- per-event-type delivery overrides (TDD §2.1)
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  delivery TEXT NOT NULL CHECK (delivery IN ('in_app', 'email', 'push')),
  enabled INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, event_type, delivery)
);

CREATE TABLE notify_anyway_log (                           -- rate limiting "Notify anyway"
  sender_id TEXT NOT NULL, recipient_id TEXT NOT NULL, sent_at INTEGER NOT NULL,
  PRIMARY KEY (sender_id, recipient_id, sent_at)
);
```

- Missing rows mean defaults. Per-device settings (for example, sounds off on this laptop) come later, with push.
- **Held notifications:** UserHub keeps a held flag and delivers a summary when DND or focus ends. The inbox is the durable record, so nothing is lost if the hub restarts.

## 8. In-app delivery

- **Notification panel:** the bell icon opens a list of recent notifications (the same records as the Personal Inbox), newest first, grouped by dedupe key. Selecting one opens the object and resolves it.
- **Toasts:** a short banner for new notifications while the app is open and the member isn't in DND. Toasts don't show for the conversation already on screen.
- **Sounds:** one notification sound and one ring sound, each on or off (§7).
- **Badges:** sidebar counts (§4) and the browser tab title count ("(3) Officebox").
- **Accessibility:**
  - New notifications are announced through a **polite live region** ("New mention from Ana in #design").
  - Toasts can be reached by keyboard and stay visible while focused or hovered.
  - Nothing flashes, and motion respects reduced-motion settings.
  - The ring banner uses an assertive live region with a keyboard-reachable Accept/Decline.

## 9. API

| Method and path | Purpose |
|---|---|
| `GET /me/notifications?state=…&cursor=…` | List notifications (inbox records) |
| `POST /me/notifications/:id` (state: read, done, dismissed) | Update one |
| `POST /me/notifications/read-all?source=…` | Mark all read, optionally for one conversation or object |
| `GET/PATCH /me/preferences` | `user_preferences` |
| `PUT /me/notification-preferences/:eventType` | Per-event-type delivery overrides |
| `PUT /me/dnd` (`until` or `null`) · `PUT /me/dnd/schedule` | Manual DND and schedule |
| `PUT /channels/:id/notify-level` | Conversation level (Chat API) |
| `PUT /threads/:rootId/follow` · `DELETE …` | Thread follow |
| `POST /channels/:id/messages/:messageId/notify-anyway` | Break through DND for a DM message |

**Hub events:** `notification.new`, `notification.resolved`, `notification.held-summary`, `status.changed` (presence plus DND, focus or time off).

## 10. Acceptance criteria

- **Levels:**
  - in a channel at **Mentions**, a plain message doesn't notify but `@you` does
  - at **Mute**, `@channel` doesn't notify and `@you` does
  - at **Nothing**, `@you` doesn't notify but appears in the inbox
  - DMs notify every message by default.
- **Dedupe:** five DMs from the same person create **one** inbox item with a count of 5.
- **DND:**
  - a DM during manual DND produces no banner, no email and no sound; the inbox records it
  - when DND ends, the member sees one summary
  - the offline email is sent only once the delay has passed **after** DND ends, if still unread.
- **Notify anyway:** it delivers a banner to a member in DND; a second use within 30 minutes is refused.
- **Rings:** a DM call to a member in DND doesn't ring. The caller sees "in do-not-disturb until…", and a `missed_call` is recorded.
- **Focus and time off:**
  - a recurring focus block applies DND at each occurrence's start and clears it at its end, without the client open
  - time off Fri–Sun with Monday a public holiday shows "away until Tue"; cancelling the time off clears the status within one minute.
- **Precedence:** with time off and a manual DND both active, the status shows time off; after time off ends, the manual DND still applies until its end.
- **Offline email:**
  - an unread DM sends one email after 10 minutes; reading it at 9 minutes sends none
  - a DM email contains no message text unless the member opted in
  - a public-channel mention email contains the text.
- **Access and actors:** a member who lost access before delivery gets no notification; actors never notify themselves.
- **Security notices** are delivered during DND and with email notifications off.
- **Accessibility:** new notifications are announced in a polite live region; an axe check passes on the panel and toasts.

## 11. Later

Web push and native push (PRD §8) · per-device settings · keyword notifications · VIP senders who always break through · smart "catch up" summaries (Phase 3 AI).

## 12. Open questions

1. **Nothing level:** should direct mentions still create inbox items (the default above), or be completely invisible?
2. **Time off and in-app notifications:** hold them like DND (the default above), or deliver normally since the member isn't looking anyway?
3. **New-device sign-in notice:** send on every new device, or only for unusual locations?

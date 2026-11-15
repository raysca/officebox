# Spec: Calendar

**Status:** Draft for review
**Revision:** Revised after independent review, and again after the second review (14 Nov 2026); updated for the [Assistant](assistant.md) spec (15 Nov 2026: idempotency keys, `expectedVersion` on update, "Call notes" on events)
**Feature name:** Calendar (marketing name to be decided later)
**Milestone:** M5, in slices M5a–M5c (§15) ([PLAN](../PLAN.md))

**Related specs:**
- [Identity & Access](identity.md): time zone, working hours, region
- [Permissions](permissions.md) §4: permission matrix
- [Notifications](notifications.md) §5: do-not-disturb, focus time and time off
- [Platform](platform.md): lifecycle, retention, timers, outbound fetching, email links
- [Calls](calls.md): event calls
- [Chat](chat.md): status, create event from message
- [Assistant](assistant.md) §5, §7, §12.3: scheduling tools, personal reminders, call notes on events

**Related PRD section:** §5.3 (to be extended)

**Cross-cutting rules:** permissions follow [Permissions](permissions.md); notifications follow [Notifications & Attention](notifications.md); lifecycle, cascades, retention, export, admin settings, limits and timers follow [Platform Rules](platform.md). Those specs win on cross-cutting rules.

Decisions marked **(default)** were not discussed; change them on review. Calendar is **new scope** compared with PRD v1.3, which only planned an outbound ICS feed. The PRD and TDD will be updated to match this spec.

## 1. Summary

A team calendar built into the workspace:
- personal, group, channel, standalone and workspace calendars
- public holidays for every country
- time off, focus time and working location
- recurring events with RSVPs, including people outside the workspace by email
- reminders
- "find a time" across colleagues' working hours and time zones
- ICS feeds in and out.

## 2. Decisions

| Topic | Decision |
|---|---|
| Time off | **Declare only.** No approval workflow in the first release. |
| Time-off visibility | **Everyone sees the dates.** The **type and note are visible to the member only**. |
| External calendars | **ICS out** (private feed) **and ICS in** (read-only subscriptions, **personal only**). Two-way Google/Microsoft sync later. |
| Public holidays | **All countries**, from a bundled open dataset computed locally. UK & Ireland, US & Canada and EU are verified first. Choosing the dataset is a gate before M5 (§6). |
| Shared calendars | **Groups** (automatic) **+ channels** (optional) **+ standalone** shared calendars |
| Group calendar visibility | **Every member can view every group's calendar** |
| Who edits shared calendars | **Per-calendar roles** (owner, editor, viewer, free/busy), with sensible defaults per kind |
| Private events | **Editors see a busy block they can't open or edit.** Only the organiser and attendees see and edit details. |
| Event invitations | **Added straight away as tentative** ("not responded") until the attendee answers. Declined events are hidden, with a toggle to show them. |
| Personal calendar visibility | **Free/busy only** to others, unless shared with details or the event is marked public |
| External attendees | **On by default, with limits**: standard ICS invitations with RSVP links (needs email). Admins can turn them off or restrict them to admins. |
| Special event types | **Focus time, working location, deadlines and milestones** |
| Default reminders | **10 minutes before** timed events; **09:00 the day before** all-day events; in-app. Email is opt-in. |
| Daily agenda | **In-app Today view**. No agenda email. |

## 3. Calendars

| Kind | Created | Default access | Notes |
|---|---|---|---|
| **Personal** | Automatically for each member | Owner edits. `general_access = workspace_freebusy`: every member sees busy blocks. | Holds the member's own events, invitations they've received, time off, focus time and working location |
| **Group** | Automatically for each group | Group members **edit**. **Every member views** (`general_access = workspace_view`). | Shows the group's events plus an overlay of members' time off |
| **Channel** | Optional; added from channel settings | Channel members edit; follows channel visibility | Private channel calendars are visible to members only |
| **Project** | Automatically for each project (M10a, [Projects](projects.md) §3.1, §7) | Project Leads and Editors edit; Commenters and Viewers view (plus everyone for public projects) | Holds project milestones, releases, demos and project meetings, and overlays project contributors' declared time off, regional public holidays and working hours for capacity planning |
| **Standalone** | Any member creates one (e.g. "On-call rota") | Creator is owner; shared with users, groups and channels as editor / viewer / free/busy; general access restricted / free/busy / workspace view / workspace edit | |
| **Workspace** | One, at setup | Admins edit; everyone views | All-hands, company holidays, office closures |
| **Public holidays** | **Virtual**: generated, no rows stored **(default)** | Read-only; everyone | One overlay per region in use (§6) |
| **External (ICS in)** | A member subscribes to a URL | **Read-only and visible to the subscriber only.** Can't be shared. | Refreshed hourly (§10) |

- **Colours:** each calendar has a colour, and members can override it for themselves.
- **My calendars:** members choose which calendars to show in the sidebar. Personal, workspace and holidays are shown by default, plus their groups' calendars.
- **Roles:**
  - *owner*: share, delete
  - *editor*: create and edit events, except private events they don't organise or attend (§4.5)
  - *viewer*: see details
  - *freebusy*: busy blocks only.

  They're resolved by the permission engine as a resource type ([Permissions](permissions.md) §4). `freebusy` is a stored grant role; the matching calendar-wide general access value is `workspace_freebusy` (§12; [Permissions](permissions.md) §9).
- **Deletion:**
  - personal, workspace, group and project calendars can't be deleted directly; they follow their owner, group, project or workspace ([Platform](platform.md) §4)
  - channel calendars are removed with their channel
  - standalone and external calendars can be deleted by their owner (Trash for 30 days; restorable by the owner, the person who deleted it, or an admin; [Platform](platform.md) §5)
  - **when a group, channel or project calendar is purged** (decision), each event **moves to its organiser's personal calendar**, so attendees keep it. Events whose organiser has been deleted are deleted instead, and attendees get `event_cancel` ([Platform](platform.md) §4).
- **Deleted organiser:** events on a deleted member's personal calendar that have other attendees move to the **first remaining attendee's** personal calendar (earliest to accept, otherwise earliest invited), who becomes organiser **(default)**. Events with no other attendees are deleted. Events they organised on shared calendars get the calendar's first remaining editor (or owner) as organiser ([Platform](platform.md) §3).

## 4. Events

### 4.1 Fields

| Field | Notes |
|---|---|
| Title | Required |
| Calendar | Which calendar it belongs to; default is personal |
| Type | `event`, `focus`, `working_location`, `deadline`, `release`, `demo` (project calendars, [Projects](projects.md) §7.1), plus `holiday` for company holidays on the workspace calendar (§5, §6) |
| Start / end | Timed (with an **IANA time zone**) or **all-day** (date range, no zone) |
| Recurrence | RFC 5545 RRULE, plus exceptions (§4.3) |
| Attendees | Members, groups (expanded when the invitation is sent, **(default)**) and external emails (§8). Each can be marked **optional**. |
| Location | Free text |
| Call | "Add call": an Officebox call in the event's context ([Calls](calls.md) §3). The **organiser, attendees and anyone with details-level access** to the event can start or join it; free/busy-only viewers can't. |
| Description | Rich text, with links to documents, channels and messages |
| Visibility | `default` (follows the calendar), `private` (busy block for everyone except organiser and attendees), `public` (details visible even on free/busy calendars) |
| Show as | `busy` (default) or `free` |
| Reminders | Per attendee, defaulting from their settings (§9) |
| Organiser | The creator. Transferable to another editor of the calendar. |

### 4.2 Creating, editing and moving

- Create by clicking or dragging on the grid, with the "New event" button, from a chat message ("Create from message"), or from a document.
- **Quick create** popover (title, time, calendar), plus a **full editor**.
- **Move and resize:**
  - drag to move and drag the edge to resize, in the week and day views
  - **every drag action has a single-pointer and keyboard alternative**: the edit dialog's date and time fields, plus keyboard moves on a focused event (§11.1).
- **Who can edit:**
  - editors of the calendar can edit any non-private event on it
  - private events follow §4.5
  - attendees can't change event details; they can add **personal notes and reminders** **(default)**.
- **Moving an event to another calendar** requires editor access to **both** calendars. The organiser stays the same.
- Changes notify attendees (§9), with a "Notify guests?" choice for minor edits **(default)**.
- **Idempotency and versions** ([Assistant §5.1](assistant.md)):
  - Event create, update and RSVP accept an optional **idempotency key**. The key is stored with its result for **24 hours (default)**; a repeat with the same key returns the original result instead of writing again.
  - Update accepts an optional **`expectedVersion`**. The change is applied only if the event's current `version` still matches, as an atomic compare-and-set; otherwise the update returns a typed **`conflict`** result and changes nothing. Every change to an event increments `version`.

### 4.3 Recurrence

- **Patterns:** daily, weekdays, weekly on chosen days, monthly (by date, or "second Tuesday"), yearly, and custom (interval, end after N occurrences or on a date). Stored as an RRULE with the event's time zone.
- **Editing a recurring event:** "This event", "This and following" or "All events".
  - *This event* creates an exception.
  - *This and following* splits the series into two.
  - *All events* edits the series and keeps exceptions where they don't conflict **(default)**.
- **Deleting a recurring event** offers the same three choices.
- **Time zones and daylight saving:** occurrences keep their wall-clock time in the event's zone. A 09:00 London meeting stays at 09:00 London time across daylight-saving changes, and moves for viewers in other zones.

### 4.4 Invitations and RSVP

- **Inviting members:** the event is added straight away to each invitee's view of their **personal calendar** as tentative ("not responded"), even though it's stored on the organiser's chosen calendar (§12.1). An inbox notification is sent ([Notifications](notifications.md) §3).
- **RSVP:** Yes / No / Maybe, with an optional note, from the event, the notification or the inbox.
- Recurring events take a series RSVP, or a per-occurrence answer.
- An RSVP accepts an idempotency key (§4.2).
- Declined events are hidden from the attendee's views. A "Show declined" toggle brings them back.
- The organiser sees an attendee list with responses and counts, with optional attendees marked.
- **Group attendees:** inviting a group expands to its members when the invitation is sent **(default)**. People who join the group later aren't added.

### 4.5 Visibility matrix

What a person sees for an event depends on their role on its calendar, the event's visibility, and whether they organise or attend it ([Permissions](permissions.md) §4).

| Person | `default` event | `private` event | `public` event |
|---|---|---|---|
| **Organiser** | Full details, can edit | Full details, can edit | Full details, can edit |
| **Attendee** (any calendar role, including none) | Full details; RSVP, personal notes | Full details; RSVP, personal notes | Full details; RSVP, personal notes |
| **Calendar owner / editor** (not organiser or attendee) | Full details, can edit | **Busy block only; can't open, edit, move or delete** | Full details, can edit |
| **Calendar viewer** | Full details, read-only | Busy block only | Full details, read-only |
| **Free/busy access** (grant or `general_access = workspace_freebusy`) | Busy block only (if `show_as = busy`) | Busy block only | **Full details**, read-only |
| **No access to the calendar** | Not shown | Not shown | Not shown |

- **An attendee always sees full details of an event they're invited to**, even on a calendar they can't otherwise view.
- **Busy blocks** show only the time range, no title or location. `show_as = free` events don't appear as blocks.
- **Deletion of a private event** by a calendar editor isn't possible.
- **Call notes** (M9c) on an event follow its details: the organiser, attendees and anyone with details-level access see the event's "Call notes" section (§11); busy-block and free/busy-only viewers don't ([Assistant §12.3](assistant.md)).
- **The assistant** reads events only through these rules, per event and per occurrence, as the member it acts for. Events are **not in the vector index** ([Assistant §5, §9](assistant.md)).
- **Orphaned private events** (decision): when a private event's organiser is **disabled or deleted**, an **owner or admin** can delete it **without seeing its details** (the delete action is offered on the busy block, and audited). This is how such an event is removed from a group or personal calendar, which can't be deleted directly.

## 5. Special event types

| Type | Behaviour |
|---|---|
| **Focus time** | Shown as busy. **Turns on do-not-disturb** for its duration ([Notifications](notifications.md) §5): notifications are held and rings suppressed ([Calls](calls.md) §4). Status shows "Focusing until 11:30". DND is switched on and off by scheduled triggers for every occurrence, including recurring ones ([Platform](platform.md) §11). Personal calendar only. |
| **Working location** | All-day or partial-day markers: **Office** (with an optional office name), **Home**, **Elsewhere** (free text). Shown on profile cards ("In the London office today") and as a row on group calendars. Doesn't make you busy. Often recurring (e.g. office Tue/Thu). |
| **Deadline / milestone** | All-day marker with a flag style. Doesn't make you busy. Projects and issues will feed due dates here (Phase 2). |
| **Holiday** (workspace calendar only) | Company holiday: an all-day event that counts as time off for everyone (§6) |
| **Time off** | Its own record (§7), shown on calendars like an event |

## 6. Public holidays

- **Gate before M5 starts:** the holiday dataset library is chosen and checked for **licence** (AGPL-compatible, [AGENTS.md](../AGENTS.md) §4.4) and **Worker bundle size** before any M5 work begins. This is a milestone gate, not an open question.
- **Regions:**
  - Admins choose which regions the workspace shows. By default, the regions of current members' profiles, plus any added manually.
  - Each member's own region comes from their profile (Identity §4.7).
- **Data:**
  - Computed in the Worker from the bundled open dataset covering every country and subdivision. No external service.
  - Only the regions in use are loaded, which keeps memory down.
  - **No holiday rows are stored.** The holiday "calendar" is virtual, generated per request for the requested window **(default)**.
- **Quality bar:** **UK & Ireland** (including England, Scotland, Wales and Northern Ireland bank holidays), **US & Canada** (federal plus state and province), and **EU** countries are verified against reference lists in tests. Other countries rely on the dataset as-is.
- **Display:**
  - Each member sees **their own region's holidays highlighted**, and others' as a lighter overlay.
  - Group calendars mark "*Ana* (Ireland): St Patrick's Day — off".
  - "Find a time" treats a person's public holiday as unavailable.
- **Company holidays:** admins add these as all-day `holiday` events on the workspace calendar. They count as time off for everyone.
- **Substitute days** (a holiday that falls at the weekend is observed on Monday) follow the dataset's rules.

## 7. Time off

- **Declared** by the member: a date range, a type (**vacation**, **sick**, **personal**, **other**) and an optional note. No approval.
- **Half days:**
  - `start_half` / `end_half` take `am` or `pm`
  - am/pm split at the **midpoint of the member's working hours on that day** (09:00–17:00 splits at 13:00) **(default)**
  - a **single-day half day** sets both fields to the same value (e.g. both `pm` = afternoon off)
  - NULL means a full day.
- **Weekends and public holidays** inside the range don't change it. The range is stored as entered; no days are added or subtracted.
- **Effects:**
  - The member's personal calendar shows it.
  - **Group calendars** show it for all of the member's groups, as dates only.
  - Their status becomes **"Away until *next working day*"**: the first day after `end_date` that is a working day in the member's working hours and isn't one of their public holidays ([Notifications](notifications.md) §5.5 Status precedence). For example, time off ending Friday shows "Away until Mon 3 Dec".
  - Time off **acts as do-not-disturb for rings and email** ([Notifications](notifications.md) §5.3): calls don't ring them ([Calls](calls.md) §4), and no notification emails are sent during it.
  - Event invitations during time off warn the organiser.
  - "Find a time" treats them as unavailable.
- **Automatic status changes:** the status switches on and off at the start and end of the time off by scheduled triggers ([Platform](platform.md) §11). Cancelling time off clears the automatic status immediately.
- **Visibility:**
  - **everyone sees the dates** (shown as "Away")
  - the **type and note are visible to the member only**. Admins and group managers don't see them.
- Members can edit or cancel their own time off. Admins can edit or delete anyone's dates, and that is audited. Admins still never see type or note.

## 8. External attendees (by email)

- **On by default, with limits:**
  - an organiser can add **any email address** to an event; this needs email to be configured, otherwise the option is hidden
  - **50 external recipients per member per day** **(default)** ([Platform](platform.md) §8)
  - admins can turn external invitations **off** or **restrict them to admins** ([Platform](platform.md) §7).
- **Invitations:**
  - a standard **ICS invitation** (`METHOD:REQUEST`) that works in Gmail, Outlook and Apple Calendar
  - a **fixed template** headed **"*Name* invited you via Officebox (*Workspace*)"** ([Platform](platform.md) §10)
  - it includes the title, time, description, location and organiser; free text is rendered as plain text.
- **RSVP:**
  - Each external attendee gets a **reusable per-attendee token**, valid until the event ends (the last occurrence for a series).
  - Links open a **confirmation page**; the response is recorded only after a **POST** from that page. Mail scanners and link prefetchers that follow links don't change anything ([Platform](platform.md) §10).
  - Officebox has no mail server (PRD §7), so replies by email aren't read. The invitation says "Respond using the links below".
- **Updates and cancellations** send ICS updates (`SEQUENCE` incremented) and `METHOD:CANCEL`.
- **Editing one occurrence:** external attendees get an **updated full-series ICS** containing the series plus `RECURRENCE-ID` overrides for changed or cancelled occurrences **(default)**.
- **Calls:** external attendees can't join Officebox calls until guest access exists ([Calls](calls.md) §2, §13). The organiser can paste an external meeting link in the location field.
- **Opt-out:** every external invitation has an opt-out link. It opens a confirmation page, and only the POST from that page records the opt-out (`ics_opt_outs`, [Platform](platform.md) §10, §15). Inviting an opted-out address returns a typed result telling the organiser.
- External attendee emails are visible only to the organiser, the event's attendees, and editors who can see the event's details.

## 9. Reminders and notifications

- **Default reminders:** timed events **10 minutes before**; all-day events **09:00 the day before** (the attendee's time zone); delivered **in-app**. **Email reminders** are opt-in per member.
- Members change their defaults (stored in `user_preferences.reminder_defaults`, [Notifications](notifications.md) §7), and add or remove reminders per event.
- **Minute precision:**
  - The **ReminderScheduler** Durable Object, with its `scheduled_triggers` table, materialises upcoming reminder times for recurring events, exceptions and attendee time zones.
  - It keeps its alarm set to the next due trigger, catches up after downtime, and reschedules on edits, declines and attendee changes ([Platform](platform.md) §11).
  - Due reminders become inbox notifications, and emails if chosen.
- **The same scheduler drives:**
  - event calls' "starting now — join" ([Calls](calls.md) §5)
  - focus-time DND on and off (§5)
  - time-off status changes (§7)
  - from M9, the assistant's personal reminders, daily brief and meeting prep (trigger kinds `personal_reminder`, `assistant_brief`, `assistant_prep`; [Assistant §7.1, §8](assistant.md)). Personal reminders are separate from event reminders and aren't attached to events.
- **Notifications** ([Notifications](notifications.md) §3): invitation, update (time or location change), cancellation, RSVP responses (to the organiser, batched **(default)**), reminders, and event calls starting.
- **Today view:** today's events appear at the top of the Personal Inbox **Today** view (PRD §5.3). If calendar ships before the Personal Inbox (M8), the calendar gets its own **Today** panel. No agenda email.

## 10. ICS feeds

- **ICS out:**
  - Each member gets a **private, revocable feed URL** for their personal calendar (events they own or attend, time off as "Away", focus time). They can subscribe to it from Google, Outlook or Apple.
  - Details are included by default, since only the member has the URL **(default)**. Members can switch a feed to busy-only.
  - Members can create **extra feed URLs per shared calendar** they can view in detail **(default)**.
  - Revoking a URL invalidates it immediately.
  - Feed tokens are revoked when a member is disabled or deleted ([Platform](platform.md) §3).
- **ICS in (personal only):**
  - Members subscribe to an external `https://` ICS URL. The calendar is visible only to the subscriber and can't be shared.
  - Feed URLs often contain secrets, so they're **stored encrypted** and **masked** in the UI after saving ([Platform](platform.md) §9).
  - The Worker fetches the feed hourly under the outbound-fetch rules ([Platform](platform.md) §9): 10-second timeout and 5 MB limit **(default)**, no cookies, private addresses blocked. Events are stored read-only.
  - Failures show on the calendar ("Last updated 3 hours ago — couldn't refresh").
  - Recurring rules in the feed are expanded like native events.
  - At most **50 subscriptions per workspace** **(default)** ([Platform](platform.md) §8).

## 11. Views

- **Day, week, month, agenda.**
  - Week view shows the viewer's working hours shaded.
  - A **secondary time zone** column is optional.
- **Mobile:** **agenda view is the default** on small screens, with day view available **(default)**.
- **Overlay:** show several calendars at once, each in its colour, with a mini-month navigator and "Today".
- **Find a time:**
  - pick attendees, then see a grid of their busy blocks, working hours (each in their own zone, converted), time off and public holidays
  - suggested slots that fit everyone's working hours
  - free/busy-only calendars contribute busy blocks without details.
- **Group calendar view:** the group's events, plus rows per member for time off (dates only) and working location (a "who's in" strip).
- **Event detail:** time in the viewer's zone, with the organiser's zone shown if different; attendees and responses; call join button; description; links.
- **Call notes** (M9c): when notes were taken in the event's call, the event detail shows a **"Call notes"** section with the summary, decisions and action items, and a link to the transcript ([Assistant §12.3](assistant.md)). It is **separate from attendees' personal notes** (`event_notes`), and visible as §4.5 says.

### 11.1 Accessibility

- **Single-key shortcuts** (`t` today, `d` / `w` / `m` / `a` change view, `c` create, arrows move between periods) can be **turned off or remapped** in settings (WCAG 2.1.4).
- **Drag alternatives:** every drag action (move, resize, create by dragging) has a keyboard and single-pointer alternative (WCAG 2.5.7):
  - the edit dialog's date and time fields
  - on a focused event, keyboard shortcuts to move by a time slot and to change duration.
- **Screen readers:**
  - the grid is a structured table or grid (days as columns, time slots as rows) with labelled cells
  - events are announced with title (or "Busy"), time, calendar and response
  - changes made by others are announced through a polite live region.
- Colour is never the only way calendars are told apart: each has a name label and pattern option.

## 12. Data model

```sql
CREATE TABLE calendars (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
    -- 'personal' | 'group' | 'channel' | 'standalone' | 'workspace' | 'external'
    -- Zod-validated; CHECK omitted in migrations (platform §14). Holidays are virtual, so there is no 'holiday' kind.
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  owner_user_id TEXT REFERENCES users(id),       -- personal, standalone, external
  group_id TEXT REFERENCES groups(id),           -- group
  channel_id TEXT REFERENCES channels(id),       -- channel
  general_access TEXT NOT NULL DEFAULT 'restricted',
    -- values: 'restricted' | 'workspace_freebusy' | 'workspace_view' | 'workspace_edit' (validated with Zod; platform §14)
    -- personal: 'workspace_freebusy'; group/workspace: 'workspace_view'; standalone: chosen; external: 'restricted'
  created_at INTEGER NOT NULL,
  archived_at INTEGER,
  deleted_at INTEGER,
  purge_after INTEGER
);
-- Grants on calendars reuse resource_grants (resource_type = 'calendar'; roles owner/editor/viewer/freebusy).
-- The resource_type and role sets are part of the schema reconciliation (platform §14).

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  calendar_id TEXT NOT NULL REFERENCES calendars(id),
  type TEXT NOT NULL DEFAULT 'event',   -- 'event' | 'focus' | 'working_location' | 'deadline' | 'holiday' (company holiday); Zod-validated, CHECK omitted (platform §14)
  title TEXT NOT NULL,
  description TEXT,                              -- rich text JSON
  location TEXT,
  working_location TEXT,                         -- office | home | elsewhere (+ label in location)
  all_day INTEGER NOT NULL DEFAULT 0,
  start_at INTEGER,                              -- UTC ms (timed)
  end_at INTEGER,
  start_date TEXT,                               -- YYYY-MM-DD (all-day)
  end_date TEXT,                                 -- exclusive
  timezone TEXT,                                 -- IANA (timed)
  rrule TEXT,                                    -- RFC 5545, NULL if single
  range_start INTEGER NOT NULL,                  -- UTC ms: earliest instant any occurrence can touch (see §12.1)
  range_end INTEGER,                             -- UTC ms: latest instant; NULL only for unbounded recurring series
  visibility TEXT NOT NULL DEFAULT 'default' CHECK (visibility IN ('default', 'private', 'public')),
  show_as TEXT NOT NULL DEFAULT 'busy' CHECK (show_as IN ('busy', 'free')),
  has_call INTEGER NOT NULL DEFAULT 0,
  organizer_id TEXT REFERENCES users(id),
  sequence INTEGER NOT NULL DEFAULT 0,           -- ICS SEQUENCE for updates
  version INTEGER NOT NULL DEFAULT 0,            -- incremented on every change; compared with expectedVersion (§4.2) (default)
  source_uid TEXT,                               -- ICS UID (external feeds)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  purge_after INTEGER,
  CHECK (rrule IS NOT NULL OR range_end IS NOT NULL)   -- single events always have a range_end
);
CREATE INDEX events_calendar_range ON events(calendar_id, range_start, range_end);

CREATE TABLE event_exceptions (                  -- per-occurrence overrides and cancellations
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  original_start TEXT NOT NULL,                  -- occurrence id (ISO start in event zone, or date)
  status TEXT NOT NULL CHECK (status IN ('modified', 'cancelled')),
  override TEXT,                                 -- JSON of changed fields
  PRIMARY KEY (event_id, original_start)
);

CREATE TABLE event_attendees (
  id TEXT PRIMARY KEY,                           -- ULID
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id),             -- member attendee
  email TEXT,                                    -- external attendee, stored lowercased
  optional INTEGER NOT NULL DEFAULT 0,
  response TEXT NOT NULL DEFAULT 'needs_action' CHECK (response IN ('needs_action', 'accepted', 'declined', 'tentative')),
  note TEXT,
  occurrence TEXT,                               -- NULL = whole series, else per-occurrence answer
  rsvp_token_hash TEXT,                          -- external attendees: reusable token, valid until the event ends
  CHECK ((user_id IS NULL) != (email IS NULL)),
  CHECK (email IS NULL OR email = lower(email))
);
CREATE UNIQUE INDEX event_attendees_unique ON event_attendees(event_id, COALESCE(user_id, email), COALESCE(occurrence, ''));
CREATE INDEX event_attendees_user ON event_attendees(user_id, event_id);

CREATE TABLE event_reminders (event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id), minutes_before INTEGER NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('in_app', 'email')),
  PRIMARY KEY (event_id, user_id, minutes_before, channel));
CREATE TABLE event_notes (event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id), note TEXT, PRIMARY KEY (event_id, user_id));   -- attendee's private notes
-- Call notes for event calls live in call_notes (context_type = 'event'; Assistant §14.2), not in event_notes.
-- They're deleted with the event (platform §4).

CREATE TABLE calendar_idempotency (              -- §4.2 (default); rows older than 24 hours are purged (default)
  user_id TEXT NOT NULL REFERENCES users(id),
  key TEXT NOT NULL,                             -- client- or assistant-supplied idempotency key
  operation TEXT NOT NULL,                       -- 'event_create' | 'event_update' | 'rsvp' (Zod-validated)
  result TEXT NOT NULL,                          -- JSON of the original typed result
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, key)
);

CREATE TABLE time_off (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  start_date TEXT NOT NULL, end_date TEXT NOT NULL,      -- inclusive dates in the member's zone
  start_half TEXT CHECK (start_half IN ('am', 'pm')),    -- NULL = full day
  end_half TEXT CHECK (end_half IN ('am', 'pm')),        -- single-day half day: same value as start_half
  kind TEXT NOT NULL,                                    -- 'vacation' | 'sick' | 'personal' | 'other'; member-only; Zod-validated
  note TEXT,                                             -- member-only
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  deleted_at INTEGER                                     -- audit only: no Trash; hard-deleted 30 days later (platform §5)
);

CREATE TABLE ics_feeds (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  calendar_id TEXT REFERENCES calendars(id),             -- NULL = the member's personal calendar
  include_details INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE TABLE ics_subscriptions (
  calendar_id TEXT PRIMARY KEY REFERENCES calendars(id), -- kind = 'external'
  url_encrypted TEXT NOT NULL,                           -- encrypted with a Worker secret key (platform §9)
  url_hint TEXT NOT NULL,                                -- masked display, e.g. "calendar.google.com/…/basic.ics"
  etag TEXT,
  last_fetched_at INTEGER,
  last_error TEXT
);
-- huddles.context_type gains 'event' (calls spec §10; schema reconciliation in platform §14).
-- Reminder triggers live in the ReminderScheduler's scheduled_triggers table, with effects delivered through its outbox (platform §11.1).
-- External invitation opt-outs: ics_opt_outs (platform §15).
-- settings (platform §7): holiday_regions (JSON), external_invites ('on' | 'admins' | 'off'), external_invite_daily_cap, ics_subscription_limit;
-- reminder defaults live in user_preferences.reminder_defaults (notifications §7).
```

### 12.1 Range queries and the "My calendars" overlay

**Stored range.** Every event stores `range_start` and `range_end` in UTC milliseconds:
- **Timed single event:** `range_start = start_at`, `range_end = end_at`.
- **All-day single event:** the date range converted across the widest time zones, so the event is found from any viewer's zone:
  - `range_start` = start of `start_date` at UTC+14
  - `range_end` = end of the day before `end_date` at UTC−12.

  The result is filtered precisely afterwards in the viewer's zone.
- **Recurring series:**
  - `range_start` is the first occurrence's start (widened as above for all-day series)
  - `range_end` is the last occurrence's end when the rule has `UNTIL` or `COUNT`, and **NULL when unbounded**.
- Single events always have a non-null `range_end` (CHECK constraint). These values are recomputed whenever the time, rule or exceptions change.

**Query for a window** `[windowStart, windowEnd]`:

```sql
-- 1. Events on the calendars the viewer asked for (and can see)
SELECT e.* FROM events e
 WHERE e.calendar_id IN (:calendarIds)
   AND e.deleted_at IS NULL
   AND e.range_start <= :windowEnd
   AND (e.range_end IS NULL OR e.range_end >= :windowStart)
UNION
-- 2. Events the viewer is invited to, wherever they're stored (shown on the viewer's personal calendar)
SELECT e.* FROM events e
  JOIN event_attendees a ON a.event_id = e.id AND a.user_id = :viewerId
 WHERE e.deleted_at IS NULL
   AND e.range_start <= :windowEnd
   AND (e.range_end IS NULL OR e.range_end >= :windowStart);
```

- Recurring rows are then expanded in the Worker for the window (`rrule` + Temporal polyfill), exceptions are applied, and the visibility matrix (§4.5) is applied per occurrence.
- **In the "My calendars" overlay**, events from part 2 appear **in the colour of the viewer's personal calendar**:
  - with a **tentative style** while the response is `needs_action` or `tentative`
  - normally once `accepted`
  - hidden when `declined`, unless "Show declined" is on.

  If the same event is also on a calendar the viewer has switched on, it's shown once, in the personal-calendar style.

**Realtime:** calendar changes fan out to affected attendees and calendar viewers through UserHub `activity` (M2). No calendar Durable Object is needed except the **ReminderScheduler** ([Platform](platform.md) §11).

## 13. API (summary)

| Method and path | Purpose |
|---|---|
| `GET /calendars` · `POST /calendars` · `PATCH/DELETE /calendars/:id` · `PUT /calendars/:id/grants` | Calendars and sharing |
| `GET /events?calendars=…&from=…&to=…` | Expanded occurrences in a window: requested calendars plus the viewer's invitations (§12.1) |
| `POST /events` · `PATCH /events/:id?scope=this|following|all&occurrence=…` · `DELETE …` · `POST /events/:id/move` (target calendar) | Events, recurring edits and moving between calendars. Create and update accept `idempotencyKey`; update accepts `expectedVersion` and returns `conflict` on a mismatch (§4.2). |
| `POST /events/:id/rsvp` | Member RSVP; accepts `idempotencyKey` |
| `GET /rsvp/:token` (confirmation page) · `POST /rsvp/:token` (response) | External RSVP, safe against link scanners |
| `GET /freebusy?users=…&from=…&to=…` | Find a time |
| `GET/POST /time-off` · `PATCH/DELETE /time-off/:id` | Time off (type and note returned to the member only) |
| `GET /holidays?regions=…&from=…&to=…` | Public holidays (generated) |
| `POST /ics/feeds` · `DELETE /ics/feeds/:id` · `GET /ics/:token.ics` | ICS out |
| `POST /calendars/external` (URL) · `POST /calendars/:id/refresh` | ICS in |

## 14. Acceptance criteria

Criteria tagged **(manual)** need a real external client and are run before release; all others are automated.

- **Recurrence:**
  - a weekly recurring meeting with three members, edited for one occurrence and then "this and following", returns the expected occurrences from `GET /events` for each member
  - deleting "this event" leaves the rest of the series.
- **Range query:**
  - an all-day event is returned for viewers in UTC−10 and UTC+13 on its date
  - a past single event isn't returned for a later window
  - an unbounded weekly series is returned for a window five years ahead.
- **Time zones:** daylight-saving tests pass for Europe/London, America/New_York and Australia/Sydney. Wall-clock times are kept; all-day events never shift days across zones.
- **Invitations:**
  - an invited member sees the event as tentative in their personal-calendar colour at once, even when it's stored on a calendar they can't view
  - declining hides it
  - the organiser sees the responses, with optional attendees marked.
- **Visibility matrix:** for each row of §4.5, the API returns exactly the fields listed. A calendar editor gets a busy block for a private event, and their edit, move and delete requests are refused.
- **Group view:** any member can view any group's calendar; the "who's in" strip shows time off as dates only and working locations.
- **Calendar purge:** purging a group calendar moves each event to its organiser's personal calendar, and attendees still see it; an event whose organiser was deleted is deleted, and attendees receive `event_cancel`.
- **Deleted organiser:** deleting a member moves their personal-calendar events that have other attendees to the first remaining attendee, who becomes organiser.
- **Orphaned private events:** after a private event's organiser is disabled, an admin can delete it from the busy block without the API returning its title or details; a non-admin editor can't.
- **Event calls:** an attendee and a details-level viewer can start the event's call; a free/busy-only viewer gets 403.
- **Idempotency and versions:** repeating an event create, update or RSVP with the same idempotency key within 24 hours returns the original result and writes nothing new; an update whose `expectedVersion` no longer matches returns `conflict` and changes nothing, including when the event changes between the check and the write.
- **Call notes (M9c):** the event's "Call notes" section is returned to the organiser, attendees and details-level viewers, not to free/busy-only viewers or a removed attendee, and is separate from `event_notes` ([Assistant §16](assistant.md)).
- **External opt-out:** a GET on the opt-out link changes nothing; after the POST, inviting that address is refused with a typed result.
- **External attendees:**
  - automated ICS conformance tests check `METHOD:REQUEST`, `METHOD:CANCEL`, `SEQUENCE` increments and `RECURRENCE-ID` overrides against RFC 5545
  - the 51st external recipient in a day for one member is refused; external invitations disabled by an admin are refused
  - a GET on an RSVP link doesn't change the response; the POST from the confirmation page does
  - **(manual)** the invitation imports in Gmail and Outlook; a cancellation removes it there.
- **Holidays:** a member in GB-ENG sees England's bank holidays highlighted, and the group calendar shows a colleague's Irish holiday. Tests check UK, IE, US, CA and the EU against reference lists for the next three years.
- **Time off:**
  - it appears on the member's group calendars as dates only for everyone else, including admins and group managers; type and note are absent from their API responses
  - "Away until" shows the next working day (Friday end → Monday)
  - it suppresses call rings.
- **Focus time:** a recurring focus block turns DND on and off for each occurrence within one minute.
- **Find a time:** it proposes only slots within every attendee's working hours, outside their time off and holidays.
- **Reminders:** they fire within one minute of the due time, including after the scheduler restarts.
- **ICS:**
  - the out feed passes ICS conformance tests; revoking it returns 404
  - an ICS-in subscription refreshes hourly, shows errors, is visible only to its subscriber, and its URL is never returned unmasked
  - **(manual)** the out feed imports in Google Calendar.
- **Accessibility:** shortcuts can be turned off; every move and resize is possible without dragging; axe passes on day, week, month and agenda views.

## 15. Slices

| Slice | Contents |
|---|---|
| **M5a** | Calendars (all kinds), events, recurrence, views (including mobile agenda), public holidays, time off |
| **M5b** | Invitations and RSVP, external invitations, reminders (ReminderScheduler), find a time, focus time, working location |
| **M5c** | ICS in and out, group calendar view polish |

Event calls ([Calls](calls.md) §3) ship with M5b.

## 16. Later

Two-way Google and Microsoft sync · time-off approvals and balances · booking pages · room and resource booking · birthdays and work anniversaries · agenda email · sharing ICS-in subscriptions.

## 17. Open questions

1. **Half-day time off:** is the working-hours midpoint the right am/pm split, or should it be fixed at 12:00?

Resolved in this revision:
- Group calendar visibility: every member views.
- Private events and editors: busy block only.
- ICS-in sharing: personal only.
- Holiday dataset: now a gate before M5.

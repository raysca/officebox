# Spec: Calendar

**Status:** Draft for review
**Feature name:** Calendar (marketing name to be decided later)
**Milestone:** M5 ([PLAN](../PLAN.md)) · **Related:** PRD §5.3 (to be extended), [Identity & Access](identity.md) (time zone, working hours, region), [Calls](calls.md) (event calls), [Chat](chat.md) (status, create event from message)

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
| Time-off visibility | **Everyone sees the dates.** Type and note are visible only to the person, their group managers and admins. |
| External calendars | **ICS out** (private feed) **and ICS in** (read-only subscriptions). Two-way Google/Microsoft sync later. |
| Public holidays | **All countries**, from a bundled open dataset computed locally. UK & Ireland, US & Canada and EU are verified first. |
| Shared calendars | **Groups** (automatic) **+ channels** (optional) **+ standalone** shared calendars |
| Who edits shared calendars | **Per-calendar roles** (editor / viewer), with sensible defaults per kind |
| Event invitations | **Added straight away as tentative** ("not responded") until the attendee answers. Declined events are hidden, with a toggle to show them. |
| Personal calendar visibility | **Free/busy only** to others, unless shared with details or the event is marked public |
| External attendees | **Yes, by email**: standard ICS invitations with RSVP links (needs email) |
| Special event types | **Focus time, working location, deadlines and milestones** |
| Default reminders | **10 minutes before** timed events; **09:00 the day before** all-day events; in-app. Email is opt-in. |
| Daily agenda | **In-app Today view**. No agenda email. |

## 3. Calendars

| Kind | Created | Default roles | Notes |
|---|---|---|---|
| **Personal** | Automatically for each member | Owner edits. Others see **free/busy**. | Holds the member's own events, invitations they've received, time off, focus time and working location |
| **Group** | Automatically for each group | Group members **edit**; others **view** if the workspace can see the group **(default)** | Shows the group's events plus an overlay of members' time off |
| **Channel** | Optional; added from channel settings | Channel members edit; follows channel visibility | Private channel calendars are visible to members only |
| **Standalone** | Any member creates one (e.g. "On-call rota") | Creator is owner; shared like documents (users, groups, channels; editor / viewer); general access restricted / workspace view / workspace edit | |
| **Workspace** | One, at setup | Admins edit; everyone views | All-hands, company holidays, office closures |
| **Public holidays** | Generated | Read-only; everyone | One overlay per region in use (§6) |
| **External (ICS in)** | A member subscribes to a URL | Read-only. Visible to the subscriber; can be shared like a standalone calendar **(default)**. | Refreshed hourly (§10) |

- **Colours:** each calendar has a colour, and members can override it for themselves.
- **My calendars:** members choose which calendars to show in the sidebar. Personal, workspace and holidays are shown by default, plus their groups' calendars.
- **Roles:** *owner* (share, delete), *editor* (create and edit events), *viewer* (see details), *free/busy* (busy blocks only). They're resolved by the permission engine as a new resource type (Identity §4; TDD §2.1).

## 4. Events

### 4.1 Fields

| Field | Notes |
|---|---|
| Title | Required |
| Calendar | Which calendar it belongs to; default is personal |
| Type | `event`, `focus`, `working_location`, `deadline` (§5) |
| Start / end | Timed (with an **IANA time zone**) or **all-day** (date range, no zone) |
| Recurrence | RFC 5545 RRULE, plus exceptions (§4.3) |
| Attendees | Members, groups (expanded when the invitation is sent, **(default)**) and external emails (§8) |
| Location | Free text |
| Call | "Add call": an Officebox call in the event's context (Calls §3) |
| Description | Rich text, with links to documents, channels and messages |
| Visibility | `default` (follows the calendar), `private` (others see "busy"), `public` (details visible even on free/busy calendars) |
| Show as | `busy` (default) or `free` |
| Reminders | Per attendee, defaulting from their settings (§9) |
| Organiser | The creator. Transferable to another editor. |

### 4.2 Creating and editing

- Create by clicking or dragging on the grid, with the "New event" button, from a chat message ("Create from message"), or from a document.
- **Quick create** popover (title, time, calendar), plus a **full editor**.
- Drag to move and drag the edge to resize, in the week and day views.
- Editors of the calendar can edit any event on it. Attendees can't change event details; they can add **personal notes and reminders** **(default)**.
- Changes notify attendees (§9), with a "Notify guests?" choice for minor edits **(default)**.

### 4.3 Recurrence

- **Patterns:** daily, weekdays, weekly on chosen days, monthly (by date, or "second Tuesday"), yearly, and custom (interval, end after N occurrences or on a date). Stored as an RRULE with the event's time zone.
- **Editing a recurring event:** "This event", "This and following" or "All events".
  - *This event* creates an exception.
  - *This and following* splits the series into two.
  - *All events* edits the series and keeps exceptions where they don't conflict **(default)**.
- **Deleting a recurring event** offers the same three choices.
- **Time zones and daylight saving:** occurrences keep their wall-clock time in the event's zone. A 09:00 London meeting stays at 09:00 London time across daylight-saving changes, and moves for viewers in other zones.

### 4.4 Invitations and RSVP

- Inviting members **adds the event to their calendar straight away as tentative** ("not responded") and sends an inbox notification.
- **RSVP:** Yes / No / Maybe, with an optional note, from the event, the notification or the inbox.
- Recurring events take a series RSVP, or a per-occurrence answer.
- Declined events are hidden from the attendee's views. A "Show declined" toggle brings them back.
- The organiser sees an attendee list with responses and counts.
- **Group attendees:** inviting a group expands to its members when the invitation is sent **(default)**. People who join the group later aren't added.

## 5. Special event types

| Type | Behaviour |
|---|---|
| **Focus time** | Shown as busy. **Turns on do-not-disturb** in chat and calls for the duration: notifications are held, rings suppressed (Calls §4). Status shows "Focusing until 11:30". Personal calendar only. |
| **Working location** | All-day or partial-day markers: **Office** (with an optional office name), **Home**, **Elsewhere** (free text). Shown on profile cards ("In the London office today") and as a row on group calendars. Doesn't make you busy. Often recurring (e.g. office Tue/Thu). |
| **Deadline / milestone** | All-day marker with a flag style. Doesn't make you busy. Projects and issues will feed due dates here (Phase 2). |
| **Time off** | Its own record (§7), shown on calendars like an event |

## 6. Public holidays

- **Regions:**
  - Admins choose which regions the workspace shows. By default, the regions of current members' profiles, plus any added manually.
  - Each member's own region comes from their profile (Identity §4.7).
- **Data:**
  - Computed in the Worker from a **bundled open holiday dataset** covering every country and subdivision. No external service.
  - Only the regions in use are loaded, which keeps memory down.
  - The dataset's licence and bundle size are checked before choosing the library.
- **Quality bar:** **UK & Ireland** (including England, Scotland, Wales and Northern Ireland bank holidays), **US & Canada** (federal plus state and province), and **EU** countries are verified against official sources in tests. Other countries rely on the dataset as-is.
- **Display:**
  - Each member sees **their own region's holidays highlighted**, and others' as a lighter overlay.
  - Group calendars mark "*Ana* (Ireland): St Patrick's Day — off".
  - "Find a time" treats a person's public holiday as unavailable.
- **Company holidays:** admins add these as all-day events on the workspace calendar, marked **holiday** so they count as time off for everyone.
- **Substitute days** (a holiday that falls at the weekend is observed on Monday) follow the dataset's rules.

## 7. Time off

- **Declared** by the member: a date range (full days, or half-day morning or afternoon **(default)**), a type (**vacation**, **sick**, **personal**, **other**) and an optional note. No approval.
- **Effects:**
  - The member's personal calendar shows it.
  - **Group calendars** show it for all of the member's groups, as dates only.
  - Their chat status becomes "**Away until Mon 3 Dec**" (Chat §13), and calls don't ring them (Calls §4).
  - Event invitations during time off warn the organiser.
  - "Find a time" treats them as unavailable.
- **Visibility:** **everyone sees the dates**. **Type and note** are visible only to the member, their group managers and admins.
- Members can edit or cancel their own time off. Admins can edit anyone's, and that is audited.

## 8. External attendees (by email)

- An organiser can add **any email address** to an event. This needs email to be configured; otherwise the option is hidden.
- External attendees receive a standard **ICS invitation** (`METHOD:REQUEST`) that works in Gmail, Outlook and Apple Calendar. It includes the description, location and organiser.
- **RSVP:** each invitation has signed **Accept / Decline / Maybe links** (single-use per response change, valid until the event ends). Officebox has no mail server (PRD §7), so replies by email aren't read. The invitation says "Respond using the links below".
- **Updates and cancellations** send ICS updates (`SEQUENCE` incremented) and `METHOD:CANCEL`.
- **Calls:** external attendees can't join Officebox calls until guest access exists (Calls §11). The organiser can paste an external meeting link in the location field.
- External attendee emails are visible only to the event's editors and attendees.

## 9. Reminders and notifications

- **Default reminders:** timed events **10 minutes before**; all-day events **09:00 the day before** (the attendee's time zone); delivered **in-app**. **Email reminders** are opt-in per member.
- Members change their defaults, and add or remove reminders per event.
- **Minute precision:** a **ReminderScheduler** Durable Object keeps its alarm set to the next due reminder (PLAN M5 design notes). Due reminders become inbox notifications, and emails if chosen.
- **Notifications:** invitation, update (time or location change), cancellation, RSVP responses (to the organiser, batched **(default)**), and event calls "starting now — join" at start time (Calls §5).
- **Today view:** today's events appear at the top of the Personal Inbox **Today** view (PRD §5.3). If calendar ships before the Personal Inbox (M8), the calendar gets its own **Today** panel. No agenda email.

## 10. ICS feeds

- **ICS out:**
  - Each member gets a **private, revocable feed URL** for their personal calendar (events they own or attend, time off, focus time). They can subscribe to it from Google, Outlook or Apple.
  - It contains no private event details beyond "Busy" unless the member enables "include details" **(default: include details, since only the member has the URL)**.
  - Members can create **extra feed URLs per shared calendar** they can view **(default)**.
  - Revoking a URL invalidates it immediately.
- **ICS in:**
  - Members subscribe to an external `https://` ICS URL. The Worker fetches it hourly (10-second timeout, 5 MB limit, no cookies) and stores the events read-only in an **External** calendar.
  - Failures show on the calendar ("Last updated 3 hours ago — couldn't refresh").
  - Recurring rules in the feed are expanded like native events.
  - Fetch limits per workspace stop abuse: 50 subscriptions **(default)**.

## 11. Views

- **Day, week, month, agenda.**
  - Week view shows the viewer's working hours shaded.
  - A **secondary time zone** column is optional.
- **Overlay:** show several calendars at once, each in its colour, with a mini-month navigator and "Today".
- **Find a time:**
  - pick attendees, then see a grid of their busy blocks, working hours (each in their own zone, converted), time off and public holidays
  - suggested slots that fit everyone's working hours
  - free/busy-only calendars contribute busy blocks without details.
- **Group calendar view:** the group's events, plus rows per member for time off and working location (a "who's in" strip).
- **Event detail:** time in the viewer's zone, with the organiser's zone shown if different; attendees and responses; call join button; description; links.
- **Keyboard shortcuts:** `t` today, `d` / `w` / `m` / `a` change view, `c` create, arrows move between periods.

## 12. Data model

```sql
CREATE TABLE calendars (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('personal', 'group', 'channel', 'standalone', 'workspace', 'external')),
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  owner_user_id TEXT REFERENCES users(id),       -- personal, standalone, external
  group_id TEXT REFERENCES groups(id),           -- group
  channel_id TEXT REFERENCES channels(id),       -- channel
  general_access TEXT NOT NULL DEFAULT 'restricted',  -- standalone: restricted | workspace_view | workspace_edit
  created_at INTEGER NOT NULL,
  archived_at INTEGER,
  deleted_at INTEGER,
  purge_after INTEGER
);
-- Grants on calendars reuse resource_grants (resource_type = 'calendar'; roles owner/editor/viewer/freebusy).

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  calendar_id TEXT NOT NULL REFERENCES calendars(id),
  type TEXT NOT NULL DEFAULT 'event' CHECK (type IN ('event', 'focus', 'working_location', 'deadline', 'holiday')),
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
  recurrence_end_at INTEGER,                     -- for range queries; NULL = unbounded
  visibility TEXT NOT NULL DEFAULT 'default' CHECK (visibility IN ('default', 'private', 'public')),
  show_as TEXT NOT NULL DEFAULT 'busy' CHECK (show_as IN ('busy', 'free')),
  has_call INTEGER NOT NULL DEFAULT 0,
  organizer_id TEXT REFERENCES users(id),
  sequence INTEGER NOT NULL DEFAULT 0,           -- ICS SEQUENCE for updates
  source_uid TEXT,                               -- ICS UID (external feeds)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX events_calendar_range ON events(calendar_id, start_at, recurrence_end_at);

CREATE TABLE event_exceptions (                  -- per-occurrence overrides and cancellations
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  original_start TEXT NOT NULL,                  -- occurrence id (ISO start in event zone, or date)
  status TEXT NOT NULL CHECK (status IN ('modified', 'cancelled')),
  override TEXT,                                 -- JSON of changed fields
  PRIMARY KEY (event_id, original_start)
);

CREATE TABLE event_attendees (
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id),             -- member attendee
  email TEXT,                                    -- external attendee
  response TEXT NOT NULL DEFAULT 'needs_action' CHECK (response IN ('needs_action', 'accepted', 'declined', 'tentative')),
  note TEXT,
  occurrence TEXT,                               -- NULL = whole series, else per-occurrence answer
  rsvp_token_hash TEXT,                          -- external RSVP links
  CHECK ((user_id IS NULL) != (email IS NULL))
);
CREATE UNIQUE INDEX event_attendees_unique ON event_attendees(event_id, COALESCE(user_id, email), COALESCE(occurrence, ''));

CREATE TABLE event_reminders (event_id TEXT, user_id TEXT, minutes_before INTEGER, channel TEXT CHECK (channel IN ('in_app', 'email')),
  PRIMARY KEY (event_id, user_id, minutes_before, channel));
CREATE TABLE event_notes (event_id TEXT, user_id TEXT, note TEXT, PRIMARY KEY (event_id, user_id));   -- attendee's private notes

CREATE TABLE time_off (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  start_date TEXT NOT NULL, end_date TEXT NOT NULL,      -- inclusive dates in the member's zone
  start_half TEXT CHECK (start_half IN ('am', 'pm')), end_half TEXT CHECK (end_half IN ('am', 'pm')),
  kind TEXT NOT NULL CHECK (kind IN ('vacation', 'sick', 'personal', 'other')),
  note TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
);

CREATE TABLE ics_feeds (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, calendar_id TEXT, include_details INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, revoked_at INTEGER);
CREATE TABLE ics_subscriptions (calendar_id TEXT PRIMARY KEY REFERENCES calendars(id), url TEXT NOT NULL, etag TEXT,
  last_fetched_at INTEGER, last_error TEXT);
-- settings: holiday_regions (JSON), reminder defaults per user live in user preferences.
```

**Recurrence expansion:** the server expands occurrences for the requested window with `rrule` and the Temporal polyfill, applies exceptions, and caches the expanded windows per request. Range queries use `start_at <= windowEnd AND (recurrence_end_at IS NULL OR recurrence_end_at >= windowStart)`.

**Realtime:** calendar changes fan out to affected attendees and calendar viewers through UserHub `activity` (M2). No calendar Durable Object is needed except the **ReminderScheduler**.

## 13. API (summary)

| Method and path | Purpose |
|---|---|
| `GET /calendars` · `POST /calendars` · `PATCH/DELETE /calendars/:id` · `PUT /calendars/:id/grants` | Calendars and sharing |
| `GET /events?calendars=…&from=…&to=…` | Expanded occurrences in a window |
| `POST /events` · `PATCH /events/:id?scope=this|following|all&occurrence=…` · `DELETE …` | Events and recurring edits |
| `POST /events/:id/rsvp` · `GET /rsvp/:token?response=…` (external) | RSVP |
| `GET /freebusy?users=…&from=…&to=…` | Find a time |
| `GET/POST /time-off` · `PATCH/DELETE /time-off/:id` | Time off |
| `GET /holidays?regions=…&from=…&to=…` | Public holidays |
| `POST /ics/feeds` · `DELETE /ics/feeds/:id` · `GET /ics/:token.ics` | ICS out |
| `POST /calendars/external` (URL) · `POST /calendars/:id/refresh` | ICS in |

## 14. Acceptance criteria

- **Recurrence:**
  - a weekly recurring meeting with three members, edited for one occurrence and then "this and following", shows correctly for everyone
  - deleting "this event" leaves the rest of the series.
- **Time zones:** daylight-saving tests pass for Europe/London, America/New_York and Australia/Sydney. Wall-clock times are kept; all-day events never shift days across zones.
- **Invitations:** an invited member sees the event as tentative at once; declining hides it; the organiser sees the responses.
- **External attendees:** they receive an ICS invitation that imports in Gmail and Outlook; RSVP links update their response; a cancellation removes the event in their client.
- **Holidays:** a member in GB-ENG sees England's bank holidays highlighted, and the group calendar shows a colleague's Irish holiday. Tests check UK, IE, US, CA and the EU against reference lists for the next three years.
- **Time off:** it appears on the member's group calendars as dates only for colleagues, sets "Away until…" in chat, and suppresses call rings.
- **Focus time:** it turns on do-not-disturb for its duration.
- **Find a time:** it proposes only slots within every attendee's working hours, outside their time off and holidays.
- **Reminders:** they fire within one minute of the due time.
- **ICS:** the out feed imports in Google Calendar; revoking it stops access. An ICS-in subscription refreshes hourly and shows errors.
- **Permissions:**
  - free/busy-only viewers see no titles
  - private events show "busy" even to editors of the calendar, except the organiser and attendees **(default)**.

## 15. Later

Two-way Google and Microsoft sync · time-off approvals and balances · booking pages · room and resource booking · birthdays and work anniversaries · agenda email · per-occurrence attendee changes for external attendees.

## 16. Open questions

1. **Group calendar visibility:** can every member view every group's calendar, or only the group's own members?
2. **Half-day time off:** needed in the first release?
3. **ICS-in sharing:** can members share an external subscription with others, or is it personal only?
4. **Private events and calendar editors:** should editors of a shared calendar see private events' details? (The default above is no.)

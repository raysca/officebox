# Home & Glanceable Objects

**Status:** Draft for review

**Type:** Product journey map; not an implementation spec

**Related:** [PRD](../PRD.md); [Assistant](../specs/assistant.md); [Chat](../specs/chat.md); [Projects](../specs/projects.md); [Notifications](../specs/notifications.md); [Permissions](../specs/permissions.md); [Platform](../specs/platform.md)

## Summary

Home is a personal starting point that helps a member resume work, see what needs attention, and reach places they choose to keep close. It brings together compact, permission-checked views of existing workspace objects without replacing the apps that own those objects.

Where this draft says **Butler**, the UI uses the workspace's configured assistant display name (default **Butler**); technical identifiers use `assistant`.

This draft establishes a journey and interaction model for Home and glanceable objects. It does not define database schema, API routes, or implementation sequencing. Those belong in the feature specs and TDD after this product direction is approved.

## Decisions

| Topic | Decision |
|---|---|
| Home sections | Keep **Continue**, **What's next**, and **Pinned** distinct: resume, act, navigate. |
| Butler on Home | Use the member's existing private assistant conversation. Show it expanded and ready for a first conversation; show a compact continuation entry when conversation history exists **(default)**. |
| Continue | Show the five most recently opened unique objects from the last 30 days **(default)**. Intentional contextual peeks count as opens; passive link previews do not. Exclude objects already shown in Pinned or What's next so the sections stay distinct. |
| What's next | Show actionable or time-bound items, initially overdue/due-today work, direct messages, mentions, review requests, assigned work, personal tasks/reminders, and upcoming events. Existing feature and notification rules determine when each item resolves; reading a notification does not resolve an underlying action when its owning spec says otherwise. |
| What's next ordering | Follow the Personal Inbox's Today ordering where applicable: overdue/due-today work, direct messages and mentions, review requests, other action items, then followed activity. Upcoming schedule items follow due and waiting-on-you items **(default)**. |
| What's next size | Show up to five items on Home, followed by **View all** for the full list **(default)**. |
| What's next full view | **View all** opens the existing Personal Inbox, where Today, Upcoming, Inbox, and Assigned to me remain the authoritative full views. Home does not create a second work or notification list **(default)**. |
| What's next empty state | Keep **What's next** as the section title. When there are no items, show **All good for now** **(default)**. |
| Snoozing | Use existing Inbox and feature snooze behavior. Home does not add a separate snooze state or change an object's status or schedule. |
| Home and Inbox | Home's What's next is a short, ranked cross-app view of work to look at or act on now. Inbox remains the complete notification and follow-up list, with read, done, dismissed, and snoozed states governed by the Notifications spec. Viewing an item on Home does not silently change Inbox state or complete the underlying work. |
| Pinned | Start with one ordered, personal collection, without named groups **(default)**. The member can pin from an object or find objects through an Add to Home picker. |
| Pin candidates | Initial candidates: channels, projects, issues, calendar events, and documents. |
| Pin target | Pin the object itself, not an app-specific view or filter **(default)**. Project cards can link to the project's channel and calendar; pinning a specific project-calendar view can come later. |
| Pin data | A pin is a personal relationship to an object, not a copy of its content and not a permission grant **(default)**. Access is checked whenever the object is resolved. |
| Lost access to a pin | Keep the personal pin through temporary access loss, clear cached metadata, and use the canonical object-specific no-access state and request-access action where Permissions §7 allows it **(default)**. Private conversations/messages stay hidden with no request action. Hide trashed objects; restore their pins only when restored and accessible; remove pins on permanent purge. |
| Personal follow-ups | Support personal tasks linked to an object, using the existing My Work model. Defer freeform notes **(default)**. |
| Existing sources | Home composes existing recents, inbox/action items, My Work tasks, personal reminders, and upcoming events. It does not create a second inbox or task system **(default)**. Existing Chat stars and saved items remain separate; members can explicitly pin an object to Home. |
| Inbox alignment | Home's short What's next list is a projection of the existing Personal Inbox. Direct messages, read/done/dismiss/snooze/follow states, grouping, and auto-resolution follow PRD §5.3 and Notifications; Home actions never silently change those states. |
| Glanceable object views | Each supported object can have a compact reference and a reusable contextual peek, with a route to its full view in the owning app. The same object renderer can be used by Home, links, Search, Butler, and call surfaces where appropriate. |
| Card content | Use a shared card structure with type-specific summary fields, limited to the few details that help identify or act on the object **(default)**. Never show cached summary content after access is lost. |
| Object identity | Use typed object references and canonical in-app routes/resolution. Keep authoritative object data in existing feature models; a graph database is not required. |
| Calendar event identity | A reference to one occurrence includes its `occurrenceStart` anchor; a series-level reference remains distinct. A series card shows its next relevant occurrence **(default)**. |
| Contextual opening | Opening a linked object can show a peek while preserving the current app view. Deep work can continue in the object's owning app. |
| Responsive behavior | Desktop uses a side panel for peeks; tablet adapts to available space; mobile uses a full-screen sheet with a clear return path **(default)**. |
| Butler unavailable | If the member lacks assistant access or the assistant is off, omit the Home ask interface and let the rest of Home use the space. If Butler is enabled but temporarily unavailable, show a non-blocking status with retry; do not block navigation or other Home sections **(default)**. |
| Assistant display name | UI labels and mention affordances use the configured assistant display name (default **Butler**); code and stable reference use `assistant`. |

## Behaviour

### Returning member

1. The member opens Officebox and lands on Home.
2. Home shows a compact entry for the configured assistant when available, up to five recently opened objects in Continue, up to five unresolved or upcoming items in What's next with a **View all** link to the Personal Inbox, and the member's ordered Pinned collection.
3. The member can open a pinned item, continue a recent item, or peek at an item from What's next without losing Home.
4. The member can choose **Open in app** to move into the full view, or close the peek and return to the exact Home state.
5. Completing an item removes it from What's next according to the owning feature or notification rule. Pinned items remain until unpinned.

Home does not replace Inbox. The same underlying work can appear in both: Home surfaces it because it is relevant now; Inbox retains its notification record and state. Opening an item from Home does not mark the inbox record read or complete the work unless the owning feature's existing rules explicitly do so. Snoozing an inbox record does not change the underlying object's status or schedule.

### First-time member

1. The member opens Home with no recent items or personal pins.
2. Continue explains that recently opened work will appear there. Pinned offers **Add to Home** and a short explanation of pinning.
3. If the member has assistant access, the configured assistant is expanded and ready to ask; its actions follow the Assistant spec. Otherwise, Home opens without an assistant composer. UI copy and mention autocomplete use the configured display name (default Butler); `@assistant` remains the stable mention handle.
4. Home offers a searchable Add to Home path and relevant workspace destinations to help the member find initial channels, projects, issues, events, and documents.
5. As the member visits objects, Continue begins to populate. The member can pin useful objects from their full view or from the picker.

### Pinning an object

1. From a supported object, the member chooses **Pin to Home**. Alternatively, from Home they choose **Add to Home** and search for an object.
2. Home adds the object's typed reference to the member's ordered Pinned collection and renders its type-specific summary card.
3. The member can reorder or unpin the object using drag-and-drop, a **Move up / Move down** menu, or keyboard controls with announced position. Removing a pin does not delete or change the underlying object.
4. If the member loses access, Home clears cached metadata and follows that resource's canonical no-access flow. It offers **Request access** only where Permissions §7 allows it. For private conversations/messages, show the canonical generic private state and no request action. If the object is in Trash, hide it; if restored and accessible, show the card again. Permanent purge removes the pin.

### Opening a glanceable object

1. A link, card, search result, assistant citation, or call surface supplies a typed reference to an object. An event reference includes an `occurrenceStart` anchor when it targets one occurrence; a series reference remains series-level.
2. Officebox resolves the reference and checks access through the permission engine.
3. Where a peek is supported and the member has details access, Officebox shows a compact, type-specific summary and a small set of contextual actions. Busy-only calendar access shows only the permitted time block and cannot open event details or offer RSVP/Join actions.
4. If access is denied, Officebox shows the canonical object-specific no-access state and request flow from Permissions §7. Hidden resources reveal no protected metadata; private conversation/message references use the fixed private/no-access state without a request option.
5. The member can close the peek to return to the originating view or open the full object in its owning app.
6. Butler-generated writes continue to use the Assistant spec's preview and confirmation behavior. A card or object reference never authorizes a write.

### Butler unavailable

- Without member access or while the assistant is off, Home does not show an unusable ask interface; the other Home sections remain available.
- If an enabled Butler becomes temporarily unavailable, its area shows a non-blocking status and retry action. Home navigation and other content continue to work.

## Glanceable-object matrix

The following is the proposed first-pass contract for the five initial pin types. Card and peek content is resolved for the current member and respects each feature's access rules. **Open in app** is always available when the object can be opened.

| Object | Home card (compact reference) | Contextual peek | Quick actions **(default)** | Full view |
|---|---|---|---|---|
| **Channel** | Channel name, topic when set, unread indicator/count, and recent-activity time. No message excerpt on the Home card **(default)**. | Name, topic and description, membership/posting state, and a short recent-activity list with links to messages/threads. Never show channel content to a non-member of a private channel. | **Open in Chat**; **Jump to unread** when unread messages exist. | Channel conversation in Chat. |
| **Project** | Project name and key, status, lead, and latest Pulse time or next milestone **(default: show whichever is useful and available)**. | Project summary, lead, status/progress, active blockers or reassignment alerts, next milestone, and shortcuts to its channel and calendar. | **Open project**; **Open project channel**; **Open project calendar**. | Project Overview in Projects. View-specific calendar pins are deferred; the project card links to its calendar. |
| **Issue / personal task** | Key when present, title, status, priority, assignee, and due date, following the existing issue embed summary **(default)**. | Title, status, priority, assignee, due date, project/context, description excerpt, and recent activity/comments. Personal-task details are visible only to the task's authorised viewers. | **Open in Projects**; **Add comment** when the member can comment. Status changes remain in the full view **(default)**. | Issue or task detail in Projects / My Work. |
| **Calendar event** | Title and start time in the member's time zone, with calendar name and RSVP state when relevant **(default)**. For busy-only access, show only the permitted busy block with no title or location. | With details access: title, time, calendar, attendees and RSVP, location and call details as allowed. A busy-only block is not openable and offers no RSVP or Join action. Preserve the Calendar spec's private-event and free/busy rules. | With details access: **Open in Calendar**; RSVP inline when the member is an attendee; **Join call** when allowed. Busy-only: no actions. | Event detail or targeted occurrence in Calendar. |
| **Document** | Title, owner, file/document type, and modified time **(default)**. | Title, owner, location, and a short content preview where permitted, following the existing document embed pattern. Comments and collaboration controls remain in Docs. | **Open in Docs**. | Document in Docs. |

### Shared card and peek rules

- Keep the card's identity and summary consistent wherever it appears; adapt only the amount of detail to the surface (Home, Chat, Search, Butler, or calls).
- Use compact references in lists and messages; use a peek for meaningful inspection. All five initial types may use peeks when the member has detail access **(default)**. Busy-only event blocks are non-interactive and cannot open a detail peek.
- Do not place destructive or state-changing actions on the compact card. In the peek, keep quick actions low-risk and permission-checked; higher-impact edits use the owning app's flow. Butler writes still require the Assistant spec's confirmation preview.
- A reference, card or peek does not grant access. On access loss, clear cached metadata and use the resource-specific Permissions §7 state, including request-access actions only where permitted. Documents show a title only when their containing space is visible; private project issues, private personal tasks, and events keep titles hidden; private conversations/messages use the fixed private state with no request option. Personal tasks have no access-request action. Use `not_found` where existence is hidden. Never return protected metadata from a stale cache.
- The peek title identifies the owning app and offers **Open in app**. Closing it returns to the exact originating view and state.

## Cross-device journey map

| Stage | Desktop | iPad | Mobile |
|---|---|---|---|
| Open Home | Home sections and expanded/compact Butler state are visible within the workspace shell. | Home sections adapt to available width; avoid requiring persistent side-by-side panes. | Home is the landing view; sections remain reachable without a desktop-style sidebar. |
| Inspect an object | Open a right-side peek while preserving Home or the current app view. | Use an overlay or split view when space allows. | Open a full-screen sheet; Back returns to the originating view and state. |
| Continue deeper | Open the full object in its owning app. | Open the full object in its owning app. | Navigate to the full object; provide a clear back path. |

## Data model

This journey needs the following concepts; it does not prescribe table definitions:

- **Typed object reference:** object type plus stable object ID, with a typed variant/anchor when the target is a specific sub-object or occurrence. Human-readable metadata is resolved separately and is not embedded in the reference. Calendar occurrence references include `occurrenceStart`.
- **Canonical route/resolver:** maps a typed reference to the object's owning app and full view.
- **Personal pin:** a member-to-object relationship with an ordering value; it does not copy content or grant access.
- **Glanceable view contract:** type-specific summary data and supported contextual actions, resolved with current permissions.
- **Recent activity:** Continue uses a permission-checked recent-object list with a 30-day window and a five-item display cap **(default)**. Intentional contextual peeks count as opens; passive link previews do not. It excludes objects already represented in Pinned or What's next.
- **Home aggregation:** What's next composes existing inbox/action items, My Work, personal reminders, and upcoming calendar events. Duplicate signals for the same object are consolidated in Home, with the most urgent reason shown **(default)**; the underlying records and their separate lifecycles remain authoritative.
- **Existing personal organization:** Chat stars and saved items are not silently migrated or mirrored into Home pins. A member can explicitly add the same object to Home.

Existing feature tables remain authoritative for object data. Any persistent pin or recent-item schema must be reconciled with Platform §14 and the TDD before implementation.

## API

No endpoint or wire schema is defined in this journey draft. Before implementation, typed references, resolution responses, pin actions, and Butler card payloads must use shared Zod schemas from `packages/shared`; all request and response data must be permission-checked through the existing engine.

## Acceptance criteria

- A member can identify Home's three jobs: resume work, act on what's next, and navigate to pinned places.
- The first-time Home state and returning Home state are distinct and usable.
- Empty Continue and Pinned sections explain what will appear there and provide a clear next action.
- A member can pin a supported object from its view or through the Home picker, and can reorder or unpin it.
- Pin order can be changed by drag-and-drop, keyboard controls, and a single-pointer Move up/Move down alternative, with the new position announced.
- A pin does not grant access; access loss clears stale content and follows the canonical resource-specific no-access/request flow.
- The same supported object can render appropriately from Home, a contextual link, and Butler without duplicating its underlying identity or data.
- A peek preserves the originating view and provides a clear route to the full object in its owning app.
- What's next items leave according to their owning feature/notification lifecycle; marking an inbox item read does not incorrectly clear an unresolved action.
- What's next shows at most five items and **View all** opens the existing Personal Inbox; snoozing follows the existing Inbox and feature behavior.
- When What's next has no items, Home keeps the section in place and shows the agreed empty-state message.
- Home and Inbox can surface the same work without conflating Home visibility, inbox state, and the underlying object's completion state.
- Personal tasks can link back to a pinned object and remain managed through My Work.
- Desktop, iPad, and mobile users can inspect an object and return to their previous context using keyboard, touch, and assistive technology.
- Contextual peeks and sheets have an accessible name, move focus into the opened surface, close with Escape/system Back, and restore focus to the invoking control. Modal sheets make background content inert.
- Event references to a recurring occurrence reopen that same occurrence; series-level references remain distinct and show the next relevant occurrence.
- Butler cards respect the Assistant spec's audience, permission, and confirmed-write rules.

## Later

- Named pin groups and user-created dashboard layouts.
- Pins for specific app views or filters, such as a project-calendar view.
- Freeform personal notes attached to pins.
- Additional pin types beyond channels, projects, issues, events, and documents.
- Graph-oriented query/indexing if product journeys later require broad relationship traversal.
- User-configurable Home layouts and per-device layout preferences.

## Open questions

None for this journey draft. Deferred choices are listed under Later.

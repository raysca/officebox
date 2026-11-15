# Officebox App Shell & Cross-App Journeys

**Status:** Draft for review

**Type:** Product journey map; not an implementation spec

**Related:** [Home journey](home.md); [PRD](../PRD.md); [Chat](../specs/chat.md); [Projects](../specs/projects.md); [Calendar](../specs/calendar.md); [Documents](../specs/documents.md); [Assistant](../specs/assistant.md); [Notifications](../specs/notifications.md); [Permissions](../specs/permissions.md); [Platform](../specs/platform.md)

## Summary

The app shell gives members a stable way to move between Officebox apps while preserving each app's own navigation and work context. Top-level navigation answers **which app**; the app sidebar answers **which area or content within that app**; contextual peeks let related objects come into view without replacing the current work.

Where this draft says **Butler**, the UI uses the workspace's configured assistant display name (default **Butler**); technical identifiers use `assistant`.

This draft maps journeys across the shared shell. First-sign-in members complete Identity §4.3 onboarding (profile setup, default-channel join when available, welcome step/tour) before the returning-member Home journey begins. It builds on the [Home journey](home.md) and reusable glanceable-object model. It does not specify component implementation, route schemas, or app-specific detail flows.

## Decisions

| Topic | Decision |
|---|---|
| Shell navigation | Use a stable top-level app navigation rail on roomy screens, plus a persistent app-specific sidebar for the selected app **(default)**. |
| App navigation | Each app owns its second-level navigation and content organization. Examples include Chat conversations, project areas, calendar lists/overlays, and document drives/folders. |
| Chat landing | Selecting Chat opens the member's last active conversation **(default)**; unread and thread activity remain visible in Chat navigation. Home remains the cross-app attention view. |
| Main view | The selected app and its selected content occupy the main work area. App navigation changes the main view; contextual peeks do not. |
| Per-app return location | Returning to an app restores its last useful location and view state **(default)**. |
| Saved destination validity | Re-resolve a saved location on return and check current access. If it is inaccessible, show the canonical no-access flow without cached metadata; if deleted or purged, return to a safe landing in the owning app **(default)**. |
| Contextual objects | A link to a supported object can open a contextual peek over the current view, with an **Open in app** action for deeper work. |
| Peek stack | Show one contextual peek at a time **(default)**. Opening another object replaces the current peek; provide a clear close/back path to the originating view. |
| Full navigation | **Open in app** switches to the owning app and opens the object's full view. Preserve an in-app return path to the origin **(default)**. |
| Tabs | Tabs are not the primary app-shell navigation model. Pinned objects on Home provide a personal set of destinations; linked objects use peeks or their owning app. |
| Search and quick switcher | Keep search/quick switcher available across the shell as a fast path to apps, people, and objects; it complements the persistent navigation **(default)**. |
| Search result opening | A typed object result opens a contextual peek when a source view is active; a standalone global result opens the owning app's full view **(default)**. Message results open the source conversation at the target message and preserve the result list for Back. |
| Return path | Opening a full view from a peek adds an in-app return path to the source view and object. Browser Back returns to that source state; if the source is no longer valid, resolve it through the saved-destination fallback **(default)**. |
| Notifications | The notification panel is global. Opening a notification routes to its object under the existing Inbox and feature lifecycle rules; Home and Inbox remain distinct ([Home journey](home.md)). |
| Personal Inbox | Inbox is a first-class workspace area with Today, Upcoming, Inbox, Assigned to me, and Following views. The global notification panel is a compact entry to recent notification records, not a substitute for those views. |
| Butler | The configured assistant display name (default **Butler**) is reachable from Home and through contextual entry points where allowed. It uses the existing Assistant conversation and scope rules, not a separate shell-level conversation. |
| Responsive shell | Desktop uses app rail + app sidebar; iPad may collapse one layer as needed; mobile uses a compact top-level app switcher and a separate app navigation surface **(default)**. The current object and a clear back path stay visible. |

## Journeys

### 1. Open Home and orient

1. A member who has not completed first-sign-in onboarding completes Identity §4.3 before entering the workspace shell. A returning member opens Officebox and lands on Home.
2. Home presents **Continue**, **What's next**, **Pinned**, and Butler according to the [Home journey](home.md).
3. The member selects a pinned object or app destination. The shell makes the active app and current location clear.

### 2. Switch apps, keep each app's place

1. From any app, the member selects another app in the top-level navigation.
2. The selected app's own sidebar appears, showing its second-level navigation.
3. The app re-resolves its last useful location and opens it if the member still has access **(default)**, or at its standard landing view on first visit.
4. If access has changed, the app uses the canonical no-access flow without cached metadata; if the object was deleted or purged, it opens the app's safe landing view.
5. The member chooses a destination in that sidebar; the main view changes while the app navigation remains stable.
6. Switching back to the previous app returns to its saved location rather than resetting every app to its landing page.

### 3. Follow a related object without losing context

1. The member encounters an object reference in a message, document, project, calendar event, search result, or Butler response.
2. Selecting a supported reference opens its contextual peek over the current app view.
3. The peek shows a permission-checked summary and actions appropriate to the object type.
4. Closing the peek returns to the exact source view and state.
5. Selecting **Open in app** switches to the object's owning app and full view, retaining a back path to the source **(default)**.

### 4. Use a cross-app project journey

1. The member opens a project in Projects.
2. From the project area, the member opens the project channel or project calendar using the existing project links/shortcuts.
3. From the channel, the member peeks at a linked issue while keeping the conversation available.
4. The member opens the issue in Projects for deeper work.
5. The member returns to the project channel or project through the visible back path or preserved app location.

This journey validates the shell and object-peek model without requiring a browser-like tab strip.

### 5. Open from a global entry point

1. The member uses the quick switcher/search to find an app, person, or accessible object; or opens a notification from the global notification panel.
2. The shell resolves the destination and makes the owning app and object clear.
3. A typed object result opens a peek if the member has an active source view; a standalone global result opens the full object in its owning app. A message result opens the source conversation at that message and preserves the result list for Back **(default)**.
4. Notification opening follows its existing resolution rules and does not silently complete unrelated work.

### 6. Ask Butler in context

1. The member opens Butler from Home or chooses a contextual **Ask Butler** action from an object.
2. Contextual Ask opens the member's private assistant conversation with the selected object attached, as defined by the Assistant spec.
3. The response cites permission-checked object references that can open the shared glanceable view.
4. Writes retain the Assistant spec's server-rendered preview and Confirm/Cancel behavior.
5. Shared mentions using the configured assistant handle continue to use audience-safe rules and do not inherit private Home or personal assistant context.

### 7. Work from the Personal Inbox

1. The member opens Inbox from the app navigation to see Today, Upcoming, Inbox, Assigned to me, or Following. The bell's global notification panel remains a compact recent-notification list over the current app.
2. Today groups overdue/due-today work first, then direct messages and mentions, review requests, other action items, and followed activity. Upcoming combines future commitments such as events, reminders, and assigned work.
3. Events group only when their prescribed notification dedupe key and lifecycle match, showing the latest event and count. Distinct records for the same object stay separate when their actions/resolution differ (for example, an event invitation awaiting RSVP and an event update resolved by opening). Opening an item routes to its source with an in-app path back to the same Inbox view and position.
4. The member can mark a notification read, mark an action done, dismiss a notification, snooze it, or follow/unfollow an object. These actions have distinct effects; dismiss never deletes the source object, and snooze returns the item as unread.
5. Opening a DM marks its notification read. Opening an assignment or review request does not complete it; the item resolves only through the source workflow. Home's What's next card does not mutate Inbox state by being displayed.
6. DND holds banners, sounds, email, and call rings as specified, but durable Inbox records remain available. Time off holds rings and email; it does not hide Inbox items.

## Shell regions

| Region | Job | Behavior |
|---|---|---|
| **Top-level app navigation** | Move between Home, Inbox, Chat, Projects, Calendar, Documents, and other shipped apps. | Remains stable on desktop/tablet. The active app is visibly selected. |
| **App sidebar** | Navigate within the active app. | Content and hierarchy belong to that app; changing it does not change other apps' sidebar models. |
| **Main view** | Work with the selected app destination or full object. | One primary view at a time; the owning app provides its full workflows. |
| **Contextual peek** | Inspect and take a small number of relevant actions on a linked object. | Overlays the main view; one at a time **(default)**; never grants access. |
| **Global search/quick switcher** | Jump to accessible apps, people, and objects. | Available from every app; supports keyboard and touch entry points. |
| **Personal Inbox** | Review workday, upcoming commitments, notifications, assigned work, and followed activity. | First-class app area with the five views from PRD §5.3. |
| **Notification panel** | Review recent notification records without leaving current work. | Global bell entry; uses the same notification records as Inbox but is not the full Inbox. |
| **Butler entry points** | Ask for help privately or in an explicitly shared context. | Context and audience are explicit; follows Assistant spec. |

## Cross-device journey map

| Task | Desktop | iPad | Mobile |
|---|---|---|---|
| Switch app | Select from persistent app rail; app sidebar remains visible. | App rail or app switcher; sidebar may collapse to give the main view room. | Use compact app switcher/bottom navigation; avoid rendering every app as a tiny icon row. |
| Navigate within an app | Use the app's persistent second-level sidebar. | Sidebar can collapse or become an overlay; preserve selection. | Open the app's navigation surface, select a destination, then return to content. |
| Inspect linked object | Non-modal, labelled side region; focus moves to its heading/close control but can leave the region. | Split view is non-modal; overlay is modal. | Full-screen modal sheet with focus trap, inert background, and clear Back action. |
| Open full object | Switch to owning app and full view; preserve a return path. | Navigate to owning app; preserve a return path. | Navigate to owning app; Back returns to source. |
| Search/jump | Keyboard shortcut and visible search control. | Visible search control and supported keyboard shortcut. | Prominent search/switcher control; keyboard optional. |

## Shared behavior and guardrails

- A contextual peek is an inspection layer, not a second copy of the owning app.
- Object references use typed identity and a canonical resolver as described in the [Home journey](home.md); the route carries identity, while permission-checked resolution supplies display metadata.
- Every object read and action goes through the permission engine. A reference, search result, notification, embed, or Butler citation never grants access.
- Access loss or deletion invalidates cached summaries and follows the canonical Permissions §7 no-access/request flow and Platform lifecycle rules. A hidden private resource does not leak through a saved route.
- Do not clear inbox state or mark work complete just because an object is displayed in a peek.
- Provide visible focus, keyboard operation, touch targets, reduced-motion behavior, and accessible names for app switchers, sidebars, peeks, and back/close actions.
- A desktop side peek is a labelled complementary region, not a dialog: focus moves to its heading or close control, can leave the region, and Escape/Close dismisses it and restores focus to the invoking control. A mobile full-screen sheet is a modal dialog with focus trap and inert background; Escape/system Back closes it and restores focus. On iPad, semantics follow presentation: split view is non-modal; overlay is modal.
- A mobile layout may collapse navigation into a sheet, but must preserve a legible path back to the current work.

## Acceptance criteria

- A member can tell which app is active and which destination within that app is open.
- Switching apps preserves each app's last useful location **(default)**.
- Each app retains ownership of its second-level navigation and full object views.
- A related object can be inspected without losing the originating view, then opened fully in its owning app.
- Returning to a saved app location re-checks access; revoked, deleted, or purged destinations fall back safely without exposing stale metadata.
- Search and global-navigation results have a defined return path to the source view or result list.
- The peek, search, notification, and Butler paths use the same typed object identity and permission-checked display contract.
- Home, app navigation, quick switcher, notifications, and Butler remain distinct entry points with predictable behavior.
- The Personal Inbox is a first-class area distinct from the global notification panel; both use the same notification records and prescribed lifecycle.
- A non-member cannot learn private-channel content from a link or peek; event cards honor busy-only/private-event rules; all other object peeks honor their feature permissions.
- Desktop, iPad, and mobile users can navigate between apps, inspect an object, and return using keyboard, touch, or assistive technology.
- No workflow depends on an unbounded row of tabs to preserve context.

## Later

- User-arranged multi-pane workspaces or named layouts.
- Multiple simultaneous peeks or a persistent cross-app object tray.
- Per-app tab sets or browser-like tab restoration, if journeys demonstrate a need beyond app-location preservation.
- User-configurable app rail/sidebar arrangement.

## Open questions

- What exact apps appear in the top-level navigation at initial release, and in what order?
- Should the app sidebar remain expanded per app, or should the member's collapsed/expanded state be global?
- Which actions belong in each object peek versus its full app view? The [Home journey](home.md) contains the first-pass object matrix.
- Which Home, app-switching, and contextual-peek states should be remembered across sessions and devices?

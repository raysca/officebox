# Chat Journeys: Conversation & Context

**Status:** Draft for review

**Type:** Product journey map; not an implementation spec

**Related:** [App shell journey](app-shell.md); [Home journey](home.md); [Chat spec](../specs/chat.md); [Assistant](../specs/assistant.md); [Projects](../specs/projects.md); [Notifications](../specs/notifications.md); [Permissions](../specs/permissions.md); [Platform](../specs/platform.md)

## Summary

Chat is a place to follow conversations and move work forward. Its UX should help members find the right conversation, understand what has changed, and connect discussion to durable workspace objects—without turning Chat into a flat, endless channel list or a clone of another team's chat app.

Where this draft says **Butler**, the UI uses the workspace's configured assistant display name (default **Butler**); technical identifiers use `assistant`, and `@assistant` remains the stable mention handle.

The proposed interaction model keeps the conversation stream central, organizes navigation by conversation type and project context, and lets related issues, documents, and events open in context. Butler is available through explicit private and shared entry points, using the same object cards and permission rules as the rest of Officebox.

This journey draft proposes navigation changes and topic-marker interactions not yet specified in the current [Chat spec](../specs/chat.md), which remains the behavior source until the product owner approves changes. On approval, reconcile Chat §2, §3.3, message data/API, access and lifecycle rules, and acceptance criteria; update TDD/Platform if schema or cascade behavior changes. Do not implement topic markers from this journey alone.

## Decisions

| Topic | Decision |
|---|---|
| Chat landing | Open the member's last active conversation. Keep unread and thread activity visible in Chat navigation **(default)**. |
| Conversation groups | Separate **Projects**, **Channels**, **People** (1:1 DMs), and **Group conversations**. Project channels appear under their project; non-project channels appear under Channels. |
| Project channel placement | List a project channel only under its project in the grouped Chat navigation **(default)**. Starred and custom sections may also surface it as a personal shortcut; the channel is not duplicated under Channels. |
| Channel discoverability | Show the eight most recently active conversations across groups **(default)**. Surface unread, starred, and member-organized custom-section conversations even if that makes the list longer, except where Chat's Hide state suppresses them. A hidden conversation reappears only on new activity at its notification level; a hidden Nothing-level conversation stays hidden. Quieter conversations remain accessible through **Browse all** and search, rather than occupying the default active list. |
| Project channel ownership | A project channel is the same conversation whether opened from Chat or its project. It is grouped under its project in Chat and remains reachable from the project area. |
| Assistant DM placement | Show the member's private assistant conversation as a distinct entry pinned above human direct messages, using the configured assistant display name (default **Butler**). It is not a person or group DM, and appears only while the assistant is enabled and the member has access **(default; follows Chat §3.1)**. |
| Existing sidebar preferences | Preserve Starred, member-created custom sections, unreads-first, mute, and hide behavior **(default)**. Starred/custom sections can surface conversations from grouped navigation without changing conversation type or project ownership. |
| Conversation chronology | Preserve chronological messages and existing day dividers. Add fast date navigation and an optional subject-oriented outline for long conversations. |
| Subject outline | Build the outline from explicit topic markers, thread starts, and linked workspace objects **(default)**. Do not depend on AI to make the outline available. |
| Topic markers | Proposed behavior: topic markers are shared with everyone who can read the conversation and anchor to one source message. They add navigational metadata without changing that message. Requires Chat-spec approval before implementation. |
| Topic marker editing | Any conversation member can add a marker; its creator can edit or remove it, and channel admins retain their existing moderation powers **(default)**. |
| Topic marker creation | Add **Mark as topic** to the source message's action menu. The member provides a short shared label; selecting it in the outline jumps to that message **(default)**. |
| Topic marker lifecycle | Remove a marker when its source message is deleted; hide markers while the channel is in Trash; restore them with the channel; purge them when the channel is permanently purged. Re-check channel access before showing markers. Creator attribution follows Platform member-anonymization rules **(default)**. |
| Butler in private context | **Ask Butler** on a message, thread, or channel opens the member's private Assistant DM with that context attached, as specified in Assistant §3. |
| Butler in shared context | The composer mention uses the configured assistant display name (default **Butler**; stable handle `@assistant`) and remains an explicit shared action. Its reply uses audience-safe sources and stays in the conversation/thread according to Assistant §6; it does not use the asker's private memory. |
| Butler in Chat UI | The configured-name assistant mention is the primary integrated entry point for shared conversation help. Do not add a persistent assistant pane to the Chat view **(default)**. Keep contextual private Ask as a separate path to the Assistant DM where the Assistant spec provides it. |
| Butler unavailable in Chat | Offer the assistant mention only when the assistant, assistant mentions, and the member's access allow it, following Chat §4.1 and §6. If a mention request fails, follow Assistant §6 failure behavior; ordinary chat remains usable **(default)**. |
| Object references | Issues, docs, events, and other supported objects use the shared typed-reference/card/peek behavior in the [Home journey](home.md). |
| Create from message | Keep **Create from message** in the message action menu, not as a persistent control on every message **(default)**. |
| Search result return | Selecting a message search result opens its conversation at the target message and highlights it. Back returns to the same search query, filters, and result position **(default)**. |
| Conversation creation | A clear **New** action supports starting a 1:1 or group DM and creating a public/private channel. Existing DMs are reused; group membership and channel visibility follow Chat §3.1 and Permissions. |
| Saved conversation fallback | On returning to Chat, re-resolve the last active conversation. If the member lost access, use the canonical no-access state; if it is deleted or purged, return to the Chat landing view **(default)**. |
| Current Chat rules | Message, thread, mention, privacy, access, notification, and lifecycle rules stay as defined in Chat and cross-cutting specs unless a separate approved decision changes them. |

## Journeys

### 1. Open Chat and find the right conversation

1. The member selects Chat from the app navigation.
2. Chat opens the last active conversation; on first use, it opens the app's standard conversation landing view **(default)**.
3. The sidebar shows clear groups: project conversations, non-project channels, 1:1 people, and group conversations.
4. The active list shows the eight most recently active eligible conversations across groups, plus unread, starred, and custom-section conversations that are not currently hidden. New activity can unhide a conversation only when it meets its notification level; Nothing-level hidden conversations remain suppressed. This keeps high-signal items visible without merging channels and DMs into one undifferentiated list.
5. The member selects a conversation. The main view shows the conversation and its project/context identity where applicable.
6. To find a quieter conversation, the member opens **Browse all** or uses global search. Public-channel join and private-channel access rules remain unchanged.

### 2. Start or join a conversation

1. From Chat, the member chooses **New** and selects **Message** or **Channel**.
2. For a 1:1 DM, the member searches for a person; Officebox opens the existing DM or creates/returns the DM before the first message, as defined in Chat §3.1.
3. For a group DM, the member chooses 3–8 total members, including themselves; Officebox creates/returns the fixed-membership conversation before the first message. Adding people to an existing group DM starts a new conversation with the combined members; it does not expose old history. More than 8 people suggests creating a private channel.
4. For a public channel, the member can create it or find and join it through Browse all. For a private channel, the creator names it and adds members; it stays hidden from non-members.
5. The member composes and sends the first message. Chat keeps the chosen conversation in the main view and records it in recent activity.
6. If the channel is announcement-only or archived, the composer reflects the member's actual posting rights. Expected denials use the channel's existing typed outcome and preserve the draft **(default)**.

### 3. Catch up in a conversation

1. The member opens a conversation with unread activity.
2. Chat presents the existing **Jump to first unread** behavior and a clear date boundary.
3. The member scans top-level messages and can open a thread inline or in the existing thread panel behavior.
4. The member can use **Jump to date** or the subject outline to move to a known time/topic without scrolling through the full history.
5. Reading the conversation advances the read cursor according to the Chat and Notifications specs. This does not resolve unrelated assigned work or review actions.

### 4. Reply and keep the conversation moving

1. The member composes a message in the current conversation. Mention autocomplete shows only people and groups allowed by the conversation's access rules; the configured assistant mention appears only when Assistant and mentions are enabled for that member.
2. The member can attach a file or paste a supported Officebox link. The composer previews its destination without exposing content the recipient cannot access.
3. The member sends the message. Enter sends and Shift+Enter adds a line **(default)**; drafts stay available if the send is refused or temporarily fails.
4. To reply to a focused discussion, the member chooses **Reply in thread**. Short threads remain inline and longer threads open in the established thread panel, with a clear parent-message reference.
5. The member can use **Also send to channel** when the reply should also appear in the main conversation, with the notification and unread behavior defined by Chat and Notifications.

### 5. Browse a long conversation by subject or date

1. The member opens the conversation's outline or date navigator.
2. The outline lists chronological anchors: topic markers, thread starts, and linked objects; the date navigator offers day/time jumps.
3. Selecting an anchor scrolls the main conversation to the original message/thread and clearly marks its location.
4. From the message action menu, the member chooses **Mark as topic** and enters a short label. The shared marker appears in the chronological outline and jumps to its source message. Its creator can edit or remove it; channel admins retain moderation powers **(default)**.
5. If Butler is available, the member can ask it to summarize a selected period or thread in their private Assistant DM. The answer links to source messages and objects; it does not post into the channel unless the member explicitly uses `@Butler`.

### 6. Follow a project conversation into its work

1. The member opens a project channel from the Projects group in Chat or from the project itself.
2. The project identity is visible in the conversation header, with clear routes to the project overview and project calendar.
3. The member selects a linked issue, event, or document in a message; its contextual peek opens without replacing the conversation.
4. From the peek, the member can inspect its summary or choose **Open in app** for the full view.
5. Closing the peek returns to the same message and scroll position.
6. From the message action menu, the member can create an issue, document, or event using the existing **Create from message** behavior, which copies content by explicit choice and keeps a backlink.

### 7. Find an old message through Search

1. The member searches for a phrase, person, or object and selects a message result.
2. Chat opens the conversation at the matching message and highlights the result in context, including its thread when applicable.
3. The member can inspect nearby messages, a thread, a topic marker, or a linked object.
4. Back returns to the same search query, filters, and result position **(default)**.
5. Search results and opened content remain permission-filtered; a private conversation or message the member cannot access is not exposed.

### 8. Start or join a call from a conversation

1. From a channel or DM header, the member chooses **Start call**, or joins an active call from its visible banner. Archived channels do not offer call start.
2. Channel calls show a banner and system message; DM and group-DM calls ring the other participants, following the Calls spec.
3. Before joining, Officebox re-checks access to the conversation and applies the one-call-at-a-time rule.
4. If call notes are already on, the member sees the required notice and chooses **Join** or **Don't join** before connecting. The notice explains who can read the notes; captions-on state is visible.
5. In-call chat appears as a thread under the call-start message and does not create ordinary unread counts, thread-follow notifications, or offline email.
6. When the member leaves the call, they return to the same conversation and scroll position.

### 9. Ask Butler about a conversation

1. For help in the shared conversation, the member selects the configured assistant mention from composer autocomplete (default visible form `@Butler`; stable alias `@assistant`). For a private question about a message, thread, or channel range, the member chooses **Ask [configured name]** to open their private Assistant DM.
2. The interface makes the context clear before the question is sent: the mention response is shared with conversation readers; contextual Ask is private to the member.
3. A private Ask opens the member's Assistant DM with the selected context attached; it may use the member's own allowed sources and memory under the Assistant spec.
4. A shared `@Butler` answer uses only sources the whole audience can open and never the asker's private memory.
5. References in the answer render with the shared object-card pattern and open in context.
6. Shared mentions cannot perform general writes, with one Assistant-spec exception: an eligible Project Editor or Lead in a project channel may stage a `propose_project_memory` suggestion as `pending` (up to three per turn). It is not activated from Chat; a Project Lead or Editor confirms it on the Project Overview, or in a private DM confirmation flow where the Assistant spec allows. Other writes remain in private Assistant flow with a server-rendered Confirm/Cancel preview.

## Navigation model

| Group | Contains | Default behavior |
|---|---|---|
| **Projects** | Project channels the member can access, grouped by project. | Project groups can collapse. Selecting the channel opens the same conversation shown from Projects. |
| **Channels** | Non-project public/private/announcement channels available to the member. | The eight most recently active conversations are selected across all groups; unread, starred, and custom-section conversations are also surfaced. Browse all accessible non-project channels separately. |
| **People** | One-to-one direct messages. | Clearly distinct from channels and group conversations. |
| **Group conversations** | Group DMs. | Show group identity/members and preserve fixed membership rules. |
| **Assistant conversation** | The member's private Assistant DM, under its configured display name. | Distinct from human DMs; pinned above human direct messages while assistant access is enabled, following Chat §3.1. |
| **Starred / custom sections** | Conversations the member chose to surface or organize. | Personal shortcuts; they do not change conversation type or project ownership. |
| **Browse all** | Accessible channels and discoverable public channels. | Ordinary non-members, including non-member workspace admins, do not discover private channels here. Admins see existence metadata only in designated admin views per Permissions §4.1; never show content, previews, search snippets, cards, or Butler sources. |

The active conversation stays in the main view when navigation groups expand, collapse, or change. Selecting another conversation changes the main view. Contextual object peeks do not change the active conversation.

## Long-conversation navigation

| Navigation aid | Purpose | Source |
|---|---|---|
| Day dividers and unread marker | Show chronology and where new activity begins. | Existing Chat behavior. |
| Jump to first unread / latest | Catch up or return to the live conversation. | Existing Chat behavior. |
| Jump to date | Move directly to a day/time range. | Proposed enhancement **(default)**. |
| Thread outline | Find focused exchanges and replies. | Existing threads, surfaced as navigable anchors. |
| Topic markers | Give a meaningful subject label anchored to one source message. | Explicit shared member action; creator can edit/remove **(default)**. |
| Linked-object anchors | Find discussion around an issue, doc, or event. | Typed object references in conversation messages. |
| Butler summary | Catch up on a selected period/thread with source links. | Optional private Ask; follows Assistant rules. |

## Cross-device behavior

| Task | Desktop | iPad | Mobile |
|---|---|---|---|
| Find conversation | Persistent Chat sidebar with collapsible groups and search. | Sidebar can collapse while preserving the selected conversation. | A conversation-list surface with clear groups/search; selecting one opens the conversation. |
| Find assistant conversation | Configured-name entry above human DMs, only when available. | Same entry in the collapsed/expanded navigation. | Available from the conversation list when assistant access is enabled. |
| Browse old history | Main conversation plus optional date/topic outline panel. | Outline appears as an overlay or split view. | Date/topic navigator opens as a sheet; selecting an anchor returns to the conversation at that point. |
| Open an object | Right-side contextual peek; conversation remains visible. | Overlay or split view based on space. | Full-screen object sheet with a clear return to the source message. |
| Ask Butler | Contextual Ask and explicit `@Butler` mention; keyboard-supported. | Same distinctions, touch-accessible. | Same distinctions, with audience/context visible before send. |

## Shared behavior and guardrails

- Channel membership, private-channel concealment, posting rights, read cursors, unread counts, thread behavior, mention delivery, notification levels, and deletion follow the existing Chat and cross-cutting specs.
- The last active conversation is re-resolved on return. If the member lost access, use the canonical no-access state; if deleted or purged, return to the Chat landing view without stale content.
- The Assistant DM is a distinct entry above human direct messages; its label follows the configured assistant display name and it appears only when the assistant is enabled and the member has access.
- Grouping a project channel in Chat does not grant project or channel access. Ordinary non-members cannot discover a private channel; a non-member workspace admin may see only its existence metadata as Permissions §4.1 allows. No non-member, including an admin, receives messages, previews, search snippets, cards, or Butler sources from it.
- Project channel grouping is navigation metadata only; it does not create a second channel or copy messages.
- A date/topic outline navigates to source messages; it does not reorder or rewrite conversation history.
- Topic markers add metadata only and must not alter message text, permissions, or notification state.
- If a topic marker's source message is deleted, remove the marker; hide markers while their channel is in Trash; restore them with the channel; remove them permanently on purge. Re-check access before rendering markers.
- Calls follow the Calls spec for ringing, join permissions, the one-call rule, and mandatory call-notes acknowledgement; in-call chat remains exempt from ordinary notifications and unread counts.
- Butler's private Ask and shared mention remain visibly distinct. Shared answers follow the audience rule; private context never leaks into the channel.
- Object cards and peeks re-check current permissions. Access loss invalidates cached content.
- Keep the composer reachable in the conversation view. The optional Butler entry must not replace ordinary message composition or send on the member's behalf.
- All navigation, topic markers, thread panels, peeks, and composer actions are keyboard- and touch-operable with visible focus and accessible labels. Mobile date/topic navigator sheets use modal dialog focus behavior; desktop side outlines are non-modal regions.
- Restoring the last active conversation re-checks access; an inaccessible route follows the canonical no-access behavior, and a deleted/purged route returns to the Chat landing view without stale content.
- The Assistant DM is distinct from human 1:1 and group conversations, and uses the configured assistant display name in the UI.
- A topic marker is removed with its source message, hidden in channel Trash, restored with the channel, and permanently removed with channel purge; access loss hides it.

## Acceptance criteria

- A member can distinguish project channels, non-project channels, 1:1 DMs, group DMs, and the distinct configured-name Assistant DM at a glance.
- A quieter channel is still discoverable without permanently occupying the default active list.
- The active list shows the eight most recently active eligible conversations, while unread, starred, and custom-section conversations remain surfaced unless Chat's Hide state suppresses them.
- Selecting Chat restores the last active conversation **(default)**.
- A project channel reached through Chat and Projects is the same conversation, with the same messages, access, and unread state.
- A member can reach a point in a long conversation by unread position, date, thread, topic marker, or linked object without manually scrolling the full history.
- A member can create a shared topic marker from a message action menu and navigate to it from the outline, subject to the topic-marker behavior being approved and added to Chat spec first.
- Opening a message search result shows its context and returns to the same search state when the member goes back.
- Topic markers are shared with conversation readers, navigate to their source messages, and do not alter message content or notification state.
- A member can inspect a linked object and return to the same source message and scroll position.
- Butler Ask explains whether context is private or shared before the member sends the request.
- Private Ask uses member-allowed context; shared mentions use only audience-safe context and no personal memory.
- Butler writes use confirmation; shared mention replies cannot perform general writes, except the pending Project Memory suggestion explicitly allowed by Assistant §5–6 and Projects §8.2–8.3.
- **Create from message** is available in the message action menu and retains its explicit-copy and backlink behavior.
- A member can start or join a 1:1 DM, group DM, public channel, or private channel within existing membership and group-size rules.
- A member can compose a message, use allowed mentions, attach supported content, reply in a thread, and recover a draft after an expected send failure.
- A member can start/join a call from a conversation and use in-call chat without creating ordinary unread or notification noise.
- All existing Chat permission, notification, message lifecycle, and accessibility requirements continue to pass if this journey is implemented.

## Later

- Butler-generated topic clustering or automatic conversation chapters. Manual topic navigation must work without Butler enabled.
- A cross-channel project conversation view or project-wide activity feed.
- Custom channel taxonomy beyond Projects, Channels, People, and Group conversations.
- Saved conversation searches and user-defined topic collections.

## Open questions

None for this journey draft. Deferred capabilities are listed under Later.

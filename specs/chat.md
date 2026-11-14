# Spec: Chat

**Status:** Draft for review
**Revision:** Revised after independent review (14 Nov 2026)
**Feature name:** Chat (marketing name to be decided later)
**Milestone:** M3 ([PLAN](../PLAN.md)), in slices M3a–M3c (§18) · **Related:** PRD §5.4, §8; TDD §2.2, §3.3–3.5; [Identity & Access](identity.md), [Permissions](permissions.md), [Notifications](notifications.md), [Platform](platform.md)

Decisions marked **(default)** were not discussed; change them on review.

## 1. Summary

Real-time team conversation:
- public and private channels, announcement channels, DMs and group DMs
- threads that stay inline while short
- rich-text messages with mentions, reactions, message-owned files, polls, pins and saved items
- link previews and search
- notifications that follow the [Notifications](notifications.md) model.

## 2. Decisions

| Topic | Decision |
|---|---|
| Who creates channels | **Any member**, public or private. Admins can archive or delete any channel. |
| Threads | **Inline until 3 replies, then collapsed** into an "N replies" marker that opens a side panel. Threads are always clearly marked. |
| Composer | **Rich text with Markdown shortcuts** |
| Channel types | Public, private, **announcement**, plus an option to make **#general read-only** |
| Editing and deleting | **Anytime.** Edited messages show "(edited)". No public edit history. |
| Group DMs | **3 to 8 people, fixed membership.** Adding someone starts a new group DM. More than 8 suggests a private channel. |
| Read receipts | **None** |
| Extras in the first release | **Pins, saved items, polls, external link previews** |
| @channel / @here | **Anyone may use them.** A confirmation appears in channels with more than 20 members. |
| Notification levels and mute | Per [Notifications §4](notifications.md): All · Mentions · **Mute (direct @you only)** · Nothing |
| Offline email | Per [Notifications §6](notifications.md): after 10 minutes unread; **no message text for DMs, group DMs or private channels** unless the member opts in |
| Sidebar | **Starred section, custom sections, unreads-first view, mute and hide** |
| Public/private conversion | **Public → private only**, by channel admins |
| Private channel discovery | **Hidden** from non-members |
| Private channels and admins | **Workspace admins can't join or read private channels** unless a member adds them ([Permissions §6](permissions.md)) |
| Files | **Owned by the message.** The Files tab is read-only. "Save to folder" makes an independent drive copy. DM files stay in the conversation. |
| Forward | **Live reference**, no content copies |
| Create from message / reply privately | **Copies the text**, at the user's choice; later changes to the source don't affect the copy |
| Polls | **Multiple choice, anonymous option (truly anonymous), closing time** |

## 3. Conversations

### 3.1 Types

| Type | `channels.type` | Who sees it | Who posts | Notes |
|---|---|---|---|---|
| **Public channel** | `public` | Every member can find and read it | Members who join | Joining and leaving are free |
| **Private channel** | `private` | Members only; hidden from everyone else | Members | **Members add people; channel admins remove them** ([Permissions §3](permissions.md)) |
| **Announcement channel** | `public` or `private` with `posting_policy = 'posters'` | As above | **Channel admins, plus people they choose** ("posters") | Everyone can read, react and reply in threads |
| **DM** | `dm` | The two people | Both | Created on first message; `dm_key` (sorted IDs) keeps it unique |
| **Group DM** | `group_dm` | 3 to 8 people | All | **Fixed membership** (below) |

- `channels.type` gains the value `group_dm` in the baseline schema ([Platform §14](platform.md)). `dm_key` is set for both `dm` and `group_dm`, and is NULL otherwise.
- **Group DMs have fixed membership.** "Add people" creates a **new** group DM with the combined members, and the old one stays. Nobody joins later and sees history they weren't part of.
- **Convert to private channel:**
  - offered when a group DM would exceed 8 people, or at any time from the group DM's menu
  - asks for a channel name, then **re-types the conversation in place**: `type` becomes `private`, `dm_key` is cleared, the name is set, and the current participants become members. The first converter becomes channel admin.
  - history is kept, because the participants already had it
  - **(default):** re-type rather than copy, so links and threads keep working.
- **#general** is created at setup. Everyone is in it, and members can't leave it **(default)**. Owners can make it **read-only**, which works like an announcement channel with owners and admins as posters ([Platform §7](platform.md)).

### 3.2 Channel properties and management

- **Properties:** name (unique, lowercase, `a-z0-9-_`, up to 80 characters; DMs and group DMs have none), topic, description, type, **posting policy** (everyone, or admins and posters) and creator.
- **Channel roles:** the creator becomes channel admin. Channel admins can rename, edit the topic and description, set the posting policy, manage posters, remove members, archive, and convert public → private.
- **Workspace admins:**
  - **Public channels:** the same powers as channel admins.
  - **Private channels:** can **archive, delete and remove members**, but **can't join or read** them unless a member adds them. Message moderation applies only where they can read ([Permissions §6](permissions.md)).
- **No remaining channel admin** (the last one left or was removed): the **longest-standing member becomes channel admin automatically** **(default)**, with a system message.
- **Join and leave:**
  - Public channels: join from the channel browser, or by being added. A non-member mentioned in a public channel can open it without joining (§6).
  - Private channels: added by a member.
  - Leaving a private channel requires being re-added to return.
- **Archive:** the channel becomes read-only, stays searchable and is hidden from the sidebar; it can be unarchived. No new calls can start in an archived channel. **Delete** (workspace admins only) moves it to Trash for 30 days. What happens to the channel folder, calendar, pins, polls and huddle records is defined in [Platform §4](platform.md).
- **Convert public → private:** channel admin only. Current members stay; non-members lose access to the conversation, including in search. Private → public isn't possible. The channel folder follows (Documents §3.3).

### 3.3 Sidebar

- **Starred** at the top, then **custom sections** (named, collapsible, per member), then the default **Channels** and **Direct messages** sections.
- **Reordering sections and moving conversations:**
  - drag and drop, **or** a single-pointer alternative: a "Move to…" menu on each conversation and "Move up / Move down" on each section (WCAG 2.5.7)
  - keyboard reordering with Alt+Arrow keys **(default)**.
- **Unreads-first view:** a toggle that lists only conversations with unread messages, mentions first.
- **Levels:** each conversation's notification level follows [Notifications §4](notifications.md). **Mute** passes only direct `@you` mentions (no badge otherwise); **Nothing** is complete silence. Muted and Nothing conversations are dimmed.
- **Hide** removes a conversation from the sidebar until new activity at its level arrives, or for good for Nothing-level conversations.
- **Badges:** bold for unread, and a count for mentions and DMs ([Notifications §4](notifications.md)).
- **Quick switcher** (Cmd/Ctrl+K): jump to any conversation, person or recent item.
- When a conversation is deleted or the member loses access, it's removed from their sections ([Platform §4](platform.md)).

## 4. Messages

### 4.1 Composer

- **Rich text with Markdown shortcuts:** bold, italic, strikethrough, inline code, code blocks (syntax highlighting on render), bulleted and numbered lists, quotes and links. Typing `**`, `_`, `` ` ``, ```` ``` ```` or `>` formats as you type.
- **Content format:** stored as structured rich text (ProseMirror JSON) plus a plain-text copy for search and notifications. The server never renders HTML (TDD §8.2).
- **Mentions** with autocomplete:
  - `@person`, `@group`, `@channel` and `@here`
  - `#channel` references
  - pasted Officebox links become rich references.

  Mentions are stored by ID. The plain-text copy holds the handle at send time and is refreshed when a handle changes or a member is deleted ([Platform §3](platform.md)).
- **Emoji:** picker and `:shortcode:` autocomplete. Standard Unicode emoji only; custom emoji come later.
- **Attachments:** button, drag-and-drop or paste. Uploads show progress, and a message can be sent while they finish (§10).
- **Drafts** are saved per conversation (and per thread) on the device. Syncing across devices comes later.
- **Keys:** Enter sends and Shift+Enter adds a new line **(default)**. Up arrow edits your last message.
- **Limit:** 40 KB of text per message (TDD §3.3).

### 4.2 Display

- Consecutive messages from the same person within 5 minutes are grouped **(default)**.
- Day dividers; a **"New" marker** at the first unread message; **"Jump to first unread"** and **"Jump to latest"** buttons.
- **Times** are shown in the viewer's **profile time zone** **(default)**. Hovering shows the full date and time, plus the sender's local time if it differs.
- **System messages** have their own `kind` (§4.6) and are shown in a lighter style.

### 4.3 Editing and deleting

- Authors can **edit anytime**. Edited messages show "(edited)", and no history is visible.
- Authors can **delete anytime**. Channel admins, and workspace admins **in channels they can read**, can delete any message in their scope. That is audited, and the author is told an admin removed it **(default)**.
- Deleting leaves a "This message was deleted" placeholder if the message has thread replies; otherwise it disappears.
- The content is redacted from the replay log, the D1 copy and search (TDD §2.2). The message's **files are deleted with it** (§10).
- Live references to it (forwards, embeds) show "This message was deleted". Text copies made with Create from message or Reply privately are **not** affected (§4.5).

### 4.4 Reactions

Quick reactions (the last 6 used) and the full picker. Hover shows who reacted. Your own reactions are highlighted. Unlimited distinct emoji per message **(default)**.

### 4.5 Message actions

| Action | Who | Notes |
|---|---|---|
| Reply in thread | Anyone who can read | |
| React | Anyone who can read | In announcement channels too |
| Edit / delete | Author; admins can delete (§4.3) | |
| **Copy link** | Anyone who can read | Permalink that opens the conversation at the message (or the thread) |
| **Forward** | Anyone who can read | **A live reference, not a copy.** Shows the original as it is now: edits apply, and deletion shows "deleted". Recipients without access see "A message you don't have access to" ([Permissions §7](permissions.md)). Forwarding from a private conversation to people outside it shows a warning first: "Most recipients can't see this message". |
| **Create from message** | Anyone who can read | **Document** (title from the message, body **copied** from it, link back) or **calendar event** (title and description copied). **Task** arrives with projects (Phase 2). The person creating it chooses to copy the content; later edits or deletion of the source don't change the copy. |
| **Reply privately** | Anyone who can read | Opens a DM with the author with the message text **copied** as a quote (the user can edit or remove it before sending) |
| Pin / unpin | Channel members, or posters in announcement channels **(default)** | |
| Save for later | Anyone | Private to the member |
| Save file to folder | Anyone who can read | Copies an attached file into a folder (§10) |

### 4.6 System messages

System messages are messages with `sender_id = 'system'` and a `kind`:

| `kind` | Payload | Posted by |
|---|---|---|
| `member_joined` / `member_left` / `member_added` / `member_removed` | `{ userId, byUserId? }` | Channel membership changes |
| `welcome` | `{ userId }` | Onboarding (Identity §4.3), in #general |
| `channel_renamed` / `topic_changed` / `converted_private` / `archived` / `unarchived` / `admin_assigned` | `{ old?, new?, byUserId }` | Channel management |
| `call_started` / `call_ended` | `{ huddleId, startedBy }` / `{ huddleId, durationMs, participants[] }` | Calls |
| `missed_call` | `{ huddleId, callerId }` | Calls (DMs) |
| `poll_closed` | `{ pollId, results }` | Polls |
| `message_pinned` | `{ messageId, byUserId }` | Pins |

- System messages may be posted into announcement channels, read-only #general and archived channels; posting policy doesn't apply to them.
- `call_started` is the thread root for in-call chat (Calls §6.4). The HuddleRoom DO posts it through a typed ChatChannel RPC that returns a result, not a thrown denial (AGENTS §4.1).

## 5. Threads

Short exchanges stay in the flow of the conversation. Longer ones move aside.

- **Starting:** "Reply in thread" on any top-level message. Threads are one level deep.
- **Up to 3 replies: inline.** Replies appear **nested under the parent**: indented, with a connecting line and a small "Thread" label on the parent. New replies are added under the parent, not at the bottom of the channel.
- **From the 4th reply: collapsed.** The inline replies fold into a **thread marker** under the parent: "💬 4 replies · repliers' avatars · last reply 2m ago →". Selecting it opens the **side panel** with the full thread and its own composer.
- **Clearly marked:** a parent always shows its thread indicator, whether inline or collapsed. Replies never appear loose in the main flow.
- **Also send to channel:** a checkbox on thread replies that also posts the reply at the bottom of the channel, with "replied to a thread: *parent excerpt*".
- **Activity far up the conversation:** when a reply lands on a parent that's scrolled out of view, members following the thread see a small **"New reply in thread: *excerpt*"** chip at the bottom of the conversation **(default)**.
- **Following:** automatic for the thread's starter, repliers and anyone mentioned in it; manual follow and unfollow. A **Threads** view lists followed threads with unread replies. Following overrides a Mute or Nothing conversation level for that thread ([Notifications §4](notifications.md)).
- **Notifications:** `thread_reply` to followers ([Notifications §3](notifications.md)).

## 6. Mentions and notifications

Recipients, levels, DND and email follow [Notifications](notifications.md) §3–§6. Chat-specific rules:

| Mention | Who is notified |
|---|---|
| `@person` in a **public** channel | The person, **even if not a member**. They can open the channel without joining **(default)**. |
| `@person` in a **private** channel or DM | Only if they're a member. For a non-member, the composer offers "**Add Sam to the channel?**". If declined, they're not notified. |
| `@group` | Group members who can read the conversation (in public channels, all group members; in private channels, members only) |
| `@channel` | All channel members |
| `@here` | Channel members online when it's sent |

- **@channel / @here:** anyone may use them. In channels with more than 20 members the composer asks "This will notify *N* people. Send?". Rate-limited per [Platform §8](platform.md).
- **Time off and DND:** messaging someone on time off or in DND shows their status ([Notifications §5.4](notifications.md)). DMs offer **Notify anyway** ([Notifications §5.2](notifications.md)).

## 7. Unread state

- A per-member **read cursor** per conversation (`last_read_seq`), advanced when the conversation is visible and focused. **Unread counts** come from the D1 copy (TDD §3.5).
- Opening a conversation marks it read up to what was shown. Matching inbox items resolve automatically, and any pending offline email is cancelled ([Notifications §6](notifications.md)).
- **Thread read state** is tracked separately per followed thread (`thread_follows.last_read_seq`).
- Unread state syncs across a member's devices through the hub.

## 8. Pins and saved items

- **Pins:**
  - up to 100 per channel **(default)**
  - a **Pinned** tab in the channel header lists them newest first, with a link back to the message
  - pinning posts a `message_pinned` system message **(default)**
  - who can pin: channel members, or posters in announcement channels **(default)**.
- **Saved items:**
  - members save any message they can read
  - the **Saved** view has two tabs, **In progress** and **Done** (`saved_items.state`: `in_progress`, `done`)
  - saved items disappear if the member loses access or the message is deleted.

## 9. Polls

- **Creating:** from the composer's "+" menu. A poll has a question, 2–10 options, and these settings:
  - **multiple choice**
  - **anonymous**
  - **closing time** (optional).
- **Voting:** live results update in real time, and voters can change their vote until the poll closes.
- **Anonymous polls are truly anonymous:**
  - Each vote is stored under a **per-poll voter key** `HMAC(poll_secret, user_id)`. `poll_secret` is a random value generated when the poll is created and kept only inside the channel DO.
  - The key stops anyone voting twice. The **member ID is never stored** with an anonymous vote: not in the event log, the outbox, the D1 copy or exports.
  - The `poll.voted` event's actor is the voter key, not the user ID. This is an **exception to TDD §2.2 `events.actor_id`** (which normally holds a user ID), so the TDD must allow a non-user actor for this event type.
  - Exports include anonymous polls' counts and voter keys, never identities ([Platform §6](platform.md)). `poll_secret` is excluded from exports.
- **Non-anonymous polls** store the voter's user ID and show who voted for what.
- **Closing:** the creator can close a poll early. Closing (manual or automatic) posts a `poll_closed` system message with the final results and sends `poll_closed` to the creator ([Notifications §3](notifications.md)). The closing timer is owned by the channel DO ([Platform §11](platform.md)). Closed polls are read-only.
- Rate-limited per [Platform §8](platform.md).

## 10. Files in chat

- **Owned by the message:**
  - a file attached to a message belongs to that message
  - it **inherits the message's access** and is **deleted with it** (and purged with the channel)
  - files are stored in R2 with `files.parent_type = 'message'` (TDD §2.1).
- **Upload:** through the Worker into R2, multipart above 50 MB; default limit 2 GB, configurable (TDD §8.3; [Platform §8](platform.md)).
- **Previews:**
  - images show inline with a lightbox; multiple images display as a grid
  - PDF, video and audio play inline (allow-listed types)
  - everything else is a file card with a download.
- **Files tab:** each channel, DM and group DM has a **read-only Files tab** listing files attached to its messages (name, sharer, date, size, type filter). Files can't be renamed, moved or versioned there.
- **Save to folder:**
  - copies a file into the **channel folder** or any folder the member can edit, as an **independent drive file** (Documents §6) with its own access, versions and Trash
  - the copy is unaffected when the message is deleted.
- **Channel folders** (Documents §3.3) hold documents and saved copies only, not message attachments.
- **DM and group-DM files** are conversation-only: no folder in the Channels drive. "Save to folder" copies them into a drive.

## 11. Link previews

- **Internal Officebox links** (messages, documents, events, channels) always render a **permission-checked** preview. People without access see the no-access treatment in [Permissions §7](permissions.md).
- **External links** (first release):
  - Fetched server-side after sending under the **outbound-fetching controls in [Platform §9](platform.md)**:
    - `https` only, private and internal addresses blocked, limited redirects
    - streamed with a byte cap
    - queued and rate-limited
    - HTML parsed, not rendered.
  - Reads Open Graph / Twitter metadata (title, description, site name, image).
  - **Preview image:** fetched once and **stored in R2 as the original, capped at 1 MB**. The browser scales it, and no server-side resizing is done **(default)**. Larger images are skipped. Viewers never load third-party images.
  - Previews are cached per URL for 24 hours **(default)**, and each message records which previews it shows (`message_previews`).
  - Senders can remove a preview from their message. Admins can turn external previews off, or block domains ([Platform §7](platform.md)).
  - Up to 3 previews per message **(default)**.

## 12. Search

- FTS5 over messages and file names (TDD §2.4), permission-filtered.
- **Filters:**
  - `from:@handle`, `in:#channel`, `with:@handle` (DMs)
  - `has:file`, `has:link`, `is:thread`
  - `before:` / `after:` / `on:` dates.
- Results are grouped by conversation with highlighted snippets. Selecting one opens the conversation at that message.
- Deleted messages never appear. Archived channels are searchable unless filtered out. Members don't see results from conversations they can't read, including private channels for admins (§3.2).

## 13. Presence and typing

- Presence dots (online, away, DND, focus) and status next to people (M2; [Notifications §5.4](notifications.md)).
- **Typing indicators:** "Sam is typing…" or "Several people are typing…". Typing events are throttled and never stored (TDD §3.4).
- **Time off:** "Away until Mon 3 Dec" (the next working day; [Notifications §5.5](notifications.md)) on DMs and mentions, with a confirmation: "Sam is away until Monday — send anyway?" **(default)**.

## 14. Moderation and administration

- **Channel admins** remove messages, members and posters in their channel. **Workspace admins** can do the same in public channels and in private channels they belong to. In other private channels they can only archive, delete and remove members (§3.2).
- Every admin removal is audited. The author is told their message was removed by an admin **(default)**.
- Workspace settings, owned by [Platform §7](platform.md):
  - external link previews on or off, plus blocked domains
  - read-only #general (owners)
  - default channels (Identity §4.11; public channels only, **(default)**).

## 15. Data model (additions)

**ChatChannel DO** (TDD §2.2). New event types:
- `message.pinned` / `message.unpinned`
- `poll.created` / `poll.voted` / `poll.closed`
- `preview.attached` / `preview.removed`

Message state adds:
- `kind` (`user` or a system `kind`, §4.6), `format` (rich-text JSON) plus `text` (plain)
- `reply_count`, `last_reply_at`, `thread_participants`
- `also_in_channel`
- `forwarded_from` (message reference: `{ channelId, messageId }`)
- `previews` (JSON array of `url_hash`).

Polls: a `polls` table in the DO (`id`, `message_id`, `options`, `multiple`, `anonymous`, `closes_at`, `poll_secret`, `closed_at`) and `poll_votes` (`poll_id`, `voter_key`, `option_ids`). For non-anonymous polls `voter_key` is the user ID; for anonymous polls it's the HMAC key (§9).

**D1:**
```sql
-- channels (baseline per Platform §14): type IN ('public','private','dm','group_dm'); dm_key set for dm and group_dm
ALTER TABLE channels ADD COLUMN topic TEXT;
ALTER TABLE channels ADD COLUMN description TEXT;
ALTER TABLE channels ADD COLUMN posting_policy TEXT NOT NULL DEFAULT 'everyone' CHECK (posting_policy IN ('everyone', 'posters'));
ALTER TABLE channel_members ADD COLUMN can_post INTEGER NOT NULL DEFAULT 0;   -- poster in announcement channels
ALTER TABLE channel_members ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
-- channel_members.notify_level values: 'default','all','mentions','mute','nothing' (Notifications §7)

-- messages (D1 copy, TDD §2.1): add
ALTER TABLE messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'user';
ALTER TABLE messages ADD COLUMN format TEXT;            -- rich-text JSON; body becomes the plain-text copy ("text")
ALTER TABLE messages ADD COLUMN reply_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN previews TEXT;          -- JSON array of url_hash
ALTER TABLE messages ADD COLUMN forwarded_from TEXT;    -- JSON { channelId, messageId }
ALTER TABLE messages ADD COLUMN also_in_channel INTEGER NOT NULL DEFAULT 0;

-- thread follows: replaces the TDD `follows` table for threads (follows remains for other object types)
CREATE TABLE thread_follows (user_id TEXT NOT NULL, channel_id TEXT NOT NULL, root_message_id TEXT NOT NULL,
  last_read_seq INTEGER NOT NULL DEFAULT 0, muted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, root_message_id));
CREATE TABLE saved_items (user_id TEXT NOT NULL, message_id TEXT NOT NULL, channel_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'in_progress' CHECK (state IN ('in_progress', 'done')), created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, message_id));
CREATE TABLE sidebar_prefs (user_id TEXT PRIMARY KEY, sections TEXT NOT NULL DEFAULT '[]', unreads_first INTEGER NOT NULL DEFAULT 0);
  -- sections: [{id, name, collapsed, conversationIds[]}]; 'starred' is reserved. Conversation IDs are removed
  -- when a conversation is deleted or the member loses access (Platform §4).
CREATE TABLE link_previews (url_hash TEXT PRIMARY KEY, url TEXT NOT NULL, title TEXT, description TEXT, site_name TEXT,
  image_key TEXT, fetched_at INTEGER, status TEXT);
CREATE TABLE message_previews (channel_id TEXT NOT NULL, message_id TEXT NOT NULL, url_hash TEXT NOT NULL,
  PRIMARY KEY (message_id, url_hash));
```

## 16. Realtime protocol (additions)

- **Client → channel DO:**
  - `message.send` gains `format`, `mentions`, `alsoInChannel` and `forwardOf`
  - new: `message.pin`, `message.unpin`, `poll.create`, `poll.vote`, `poll.close`, `preview.remove`.
- **Channel DO → clients:** events as today, including the new types and system `kind`s.
- **Hub → client:** `activity` gains thread updates for followed threads (M2).

## 17. API

| Method and path | Purpose |
|---|---|
| `GET /channels?browse=1` · `POST /channels` · `GET/PATCH/DELETE /channels/:id` | Browse, create, read, update (name, topic, description, posting policy), delete |
| `POST /channels/:id/archive` · `POST /channels/:id/unarchive` · `POST /channels/:id/convert-private` | Lifecycle |
| `POST /channels/:id/join` · `POST /channels/:id/leave` · `PUT/DELETE /channels/:id/members/:userId` · `PUT /channels/:id/members/:userId/role` · `PUT /channels/:id/posters/:userId` | Membership and roles |
| `POST /dms` (`{ userIds }` → existing or new DM / group DM) · `POST /dms/:id/convert` (`{ name }`) | DMs and group DMs |
| `GET /channels/:id/messages?before=&after=&around=` | History (served by the DO via the Worker) |
| `GET /search/messages?q=` | Search with filters |
| `GET /channels/:id/pins` · `GET /me/saved` · `PUT/DELETE /me/saved/:messageId` · `PATCH /me/saved/:messageId` (state) | Pins and saved items |
| `GET/PUT /me/sidebar` | Sidebar sections, starred, unreads-first |
| `PUT /channels/:id/read` (`{ seq }`) · `PUT /threads/:rootId/read` | Read cursors |
| `PUT /channels/:id/notify-level` · `PUT/DELETE /threads/:rootId/follow` · `PUT /channels/:id/hidden` | Levels, follows, hide |
| `POST /uploads` (start multipart) · `PUT /uploads/:id/parts/:n` · `POST /uploads/:id/complete` | File uploads (message-owned) |
| `GET /files/:id` · `POST /files/:id/save-to-folder` (`{ folderId }`) | Download; Save to folder |
| `DELETE /channels/:id/messages/:messageId/previews/:urlHash` | Remove a preview |
| `POST /channels/:id/messages/:messageId/forward` (`{ toChannelIds }`) | Forward (live reference) |
| `POST /channels/:id/messages/:messageId/create-document` · `…/create-event` | Create from message (copies text) |
| `POST /channels/:id/messages/:messageId/notify-anyway` | Notify anyway (Notifications §5.2) |
| `GET /channels/:id/files` | Files tab (read-only) |

Message send, edit, delete, react, pin and poll actions go over the channel WebSocket (§16).

## 18. Slices

| Slice | Contents |
|---|---|
| **M3a: Messaging core** | Public and private channels; DMs **and group DMs** (including convert to private); channel browser, join and leave; channel admin basics; composer (rich text, mentions `@person`, `#channel`, emoji, drafts); history, unread markers and read cursors; typing and presence; system messages; edit and delete; quick switcher; default sidebar sections |
| **M3b: Rich conversation** | Threads (inline and collapsed, follows, Threads view); reactions; message-owned files, Files tab and Save to folder; **pins**; **saved items**; **announcement channels** and read-only #general; **`@group`, `@channel` and `@here`**; forward, create from message, reply privately; **polls**; **external link previews**; search |
| **M3c: Attention and polish** | Notification levels (Mute and Nothing) and Notify anyway; offline email; **starred and custom sidebar sections, unreads-first, hide**; moderation and admin settings; keyboard shortcuts; accessibility pass |

## 19. Accessibility

- New messages in the open conversation are announced through a **polite live region** (sender and excerpt), throttled in busy channels.
- The message list is a **`feed`** of `article` elements with author, time and content labelled. Virtualisation keeps the focused message mounted, and reading order is preserved.
- **Keyboard:**
  - F6 cycles between sidebar, conversation and thread panel **(default)**
  - a "Skip to composer" link
  - Escape closes the thread panel and returns focus to the parent message.
- Every drag interaction has a single-pointer alternative (§3.3). Single-key shortcuts can be turned off ([Notifications §7](notifications.md), WCAG 2.1.4).

## 20. Rate limits

Message send, `@channel`/`@here`, uploads, polls, link preview fetches and Notify anyway are rate-limited per [Platform §8](platform.md).

## 21. Acceptance criteria

- **Conversations:**
  - two members chat in a public channel, a private channel, a DM and a group DM
  - non-members can't see or search a private channel, and neither can workspace admins who aren't members.
- **Group DMs:**
  - creating a group DM with the same 3 people twice returns the same conversation
  - "Add people" creates a new group DM and leaves the old one unchanged
  - converting renames it, clears `dm_key`, and keeps history and links.
- **Threads:**
  - the first 3 replies render nested inline; the 4th collapses the thread into a marker that opens the side panel
  - "also send to channel" posts to both places
  - followers get `thread_reply`; unfollowing stops it.
- **Announcement channels:** only admins and posters can post; everyone can react and reply in threads; system messages still post.
- **Edits and deletes:**
  - an edit shows "(edited)"
  - a deleted message's text is absent from search, replay and the D1 copy
  - its attached files are no longer downloadable.
- **Mentions:**
  - @channel in a 25-member channel asks for confirmation
  - `@person` for a non-member in a public channel notifies them; in a private channel it offers "Add to channel?" and doesn't notify
  - at Mute, only `@you` notifies (Notifications acceptance criteria).
- **Files:**
  - the Files tab lists attachments read-only
  - "Save to folder" creates an independent file that survives deleting the message
  - DM files don't appear in any drive.
- **Forward:**
  - a forward shows later edits to the original, and "deleted" after deletion
  - a recipient without access sees "no access"
  - forwarding from a private channel to outsiders shows the warning.
- **Create from message:** the new document contains a copy of the text that stays after the original is deleted.
- **Pins and saved items:**
  - the Pinned tab lists pinned messages; the 101st pin is refused
  - saved items move between In progress and Done
  - saved items disappear when the member loses access.
- **Sidebar:**
  - custom sections can be created and reordered by drag **and** by the "Move to…" menu
  - hidden conversations reappear on new activity at their level.
- **Polls:**
  - multiple choice and auto-close work
  - for an anonymous poll, **no API response, export file, D1 row or DO event contains a voter's user ID**, checked by searching an export for the voter's ID
  - double voting is refused.
- **Link previews:** an external preview stores its image in R2 (at most 1 MB); viewers never request third-party hosts; private-address URLs are refused (Platform §9 tests).
- **Unread state:** unread counts and the "New" marker are correct after a reconnect and across two devices.
- **Search:** each filter (`from:`, `in:`, `with:`, `has:file`, `has:link`, `is:thread`, dates) returns only matching messages from conversations the searcher can read, as an automated test per filter.
- **Performance:**
  - p95 message round trip under 300 ms in-region (TDD §9.2)
  - a channel with 10,000 messages renders a 50-message page in under 100 ms and scrolls at 60 fps on a mid-range laptop, as a manual check with the browser's performance panel **(default)**.
- **Accessibility:** axe passes on the conversation, thread panel and sidebar; a new message is announced in the live region.

## 22. Later

Scheduled send and message reminders · mark unread · keyword notifications · custom emoji · slash commands · synced drafts · message edit history · Slack import (PRD §19) · bots and webhooks (PRD §19) · push notifications (Phase 2, PRD §8) · editable group-DM membership.

## 23. Open questions

1. **Pinning permission:** any member (the default above), or only channel admins and posters?
2. **Public-channel mentions of non-members:** notify them (the default above), or only offer "Add to channel?" as in private channels?
3. **Default channels:** public only (the default above), or allow private channels?

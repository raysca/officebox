# Spec: Chat

**Status:** Draft for review
**Feature name:** Chat (marketing name to be decided later)
**Milestone:** M3 ([PLAN](../PLAN.md)), in slices M3a–M3c · **Related:** PRD §5.4, §8; TDD §2.2, §3.3–3.5; [Identity & Access](identity.md)

Decisions marked **(default)** were not discussed; change them on review.

## 1. Summary

Real-time team conversation:
- public and private channels, announcement channels, DMs and group DMs
- threads that stay inline while short
- rich-text messages with mentions, reactions, files, polls, pins and saved items
- link previews and search
- notifications that respect people's attention.

## 2. Decisions

| Topic | Decision |
|---|---|
| Who creates channels | **Any member**, public or private. Admins can archive or delete any channel. |
| Threads | **Inline until 3 replies, then collapsed** into an "N replies" marker that opens a side panel. Threads are always clearly marked. |
| Composer | **Rich text with Markdown shortcuts** |
| Channel types | Public, private, **announcement**, plus an option to make **#general read-only** |
| Editing and deleting | **Anytime.** Edited messages show "(edited)". No public edit history. |
| Group DMs | **Up to 8 people**. Beyond that, suggest converting to a private channel. |
| Read receipts | **None** |
| Extras in the first release | **Pins, saved items, polls, external link previews** |
| @channel / @here | **Anyone may use them.** A confirmation appears in channels with more than 20 members. |
| Offline email | **After 10 minutes unread**, batched per conversation; members can change or turn it off |
| Sidebar | **Starred section, custom sections, unreads-first view, mute and hide** |
| Public/private conversion | **Public → private only**, by channel admins |
| Private channel discovery | **Hidden** from non-members |
| Polls | **Multiple choice, anonymous option, closing time** |
| Message actions | **Copy link, forward, create from message** (document or event; task once projects ship), **reply privately** |

## 3. Conversations

### 3.1 Types

| Type | Who sees it | Who posts | Notes |
|---|---|---|---|
| **Public channel** | Every member can find and read it | Members who join | Joining is free; leaving is free |
| **Private channel** | Members only; hidden from everyone else | Members | Members add people; channel admins remove them |
| **Announcement channel** | Public or private, as above | **Channel admins, plus people they choose** ("posters") | Everyone can read, react and reply in threads |
| **DM** | The two people | Both | Created on first message; `dm_key` keeps it unique |
| **Group DM** | 3 to 8 people | All | Fixed membership **(default)**. Adding someone creates a new group DM, and the old one stays. At more than 8 people, the app suggests "Convert to private channel", which keeps history. |

- **#general** is created at setup. Everyone is in it, and members can't leave it **(default)**. Owners can make it **read-only**, meaning it works like an announcement channel.

### 3.2 Channel properties and management

- **Properties:** name (unique, lowercase, `a-z0-9-_`, up to 80 characters), topic, description, type, **posting policy** (everyone, or admins and posters) and creator.
- **Channel roles:** the creator becomes channel admin. Channel admins can rename, edit the topic and description, set the posting policy, manage posters, remove members, archive, and convert public → private. Workspace admins have the same powers on every channel.
- **Join and leave:**
  - Public channels: join from the channel browser, or by being added or mentioned (with a prompt to add them).
  - Private channels: added by a member.
  - Leaving a private channel requires being re-added to return.
- **Archive:** the channel becomes read-only, stays searchable and is hidden from the sidebar; it can be unarchived. **Delete** (workspace admins only) moves it to Trash for 30 days (PRD §10.2).
- **Convert public → private:** channel admin only. Current members stay, and non-members lose access, including to search results. Private → public isn't possible.

### 3.3 Sidebar

- **Starred** at the top, then **custom sections** (named, collapsible, drag to reorder, per member), then the default **Channels** and **Direct messages** sections.
- **Unreads-first view:** a toggle that lists only conversations with unread messages, mentions first.
- **Mute:** no notifications or badges except direct mentions **(default)**. Muted conversations are dimmed. **Hide** removes a conversation from the sidebar until new activity arrives, or for good for muted channels.
- Badges: bold for unread, and a count for mentions and DMs.
- **Quick switcher** (Cmd/Ctrl+K): jump to any conversation, person or recent item.

## 4. Messages

### 4.1 Composer

- **Rich text with Markdown shortcuts:** bold, italic, strikethrough, inline code, code blocks (syntax highlighting on render), bulleted and numbered lists, quotes and links. Typing `**`, `_`, `` ` ``, ```` ``` ```` or `>` formats as you type.
- **Content format:** stored as structured rich text (ProseMirror JSON, the same schema family as documents) with a plain-text copy for search and notifications. The server never renders HTML (TDD §8.2).
- **Mentions** with autocomplete:
  - `@person`, `@group`, `@channel` and `@here`
  - `#channel` references
  - pasted Officebox links become rich references.
- **Emoji:** picker and `:shortcode:` autocomplete. Standard Unicode emoji only; custom emoji come later.
- **Attachments:** button, drag-and-drop or paste. Uploads show progress, and a message can be sent while they finish.
- **Drafts** are saved per conversation (and per thread) on the device and restored when you come back. Syncing drafts across devices comes later.
- **Keys:** Enter sends and Shift+Enter adds a new line **(default)**. Up arrow edits your last message.
- **Limit:** 40 KB of text per message (TDD §3.3).

### 4.2 Display

- Consecutive messages from the same person within 5 minutes are grouped **(default)**.
- Day dividers; a **"New" marker** at the first unread message; **"Jump to first unread"** and **"Jump to latest"** buttons.
- Times are shown in the viewer's time zone. Hovering shows the full date and time, plus the sender's local time if it differs.
- System messages (joined, renamed, Campfire started and ended, poll closed) appear in a lighter style.

### 4.3 Editing and deleting

- Authors can **edit anytime**. Edited messages show "(edited)", and no history is visible.
- Authors can **delete anytime**. Channel admins and workspace admins can delete any message in their scope, and that is audited.
- Deleting leaves a "This message was deleted" placeholder if the message has thread replies; otherwise it disappears. The content is redacted from the replay log, the D1 copy and search (TDD §2.2).

### 4.4 Reactions

- Quick reactions (the last 6 used) and the full picker. Hover shows who reacted. Your own reactions are highlighted. Unlimited distinct emoji per message **(default)**.

### 4.5 Message actions

| Action | Who | Notes |
|---|---|---|
| Reply in thread | Anyone who can read | |
| React | Anyone who can read | In announcement channels too |
| Edit / delete | Author; admins can delete | |
| **Copy link** | Anyone who can read | Permalink that opens the conversation scrolled to the message (or the thread) |
| **Forward** | Anyone who can read | Shares into another conversation as a quoted reference. Recipients without access to the source see "A message you don't have access to". Forwarding from a private channel to a wider audience asks for confirmation **(default)**. |
| **Create from message** | Anyone who can read | **Document** (title from the message, body quoting it, link back) or **calendar event** (title and description prefilled). **Task** arrives with projects (Phase 2). |
| **Reply privately** | Anyone who can read | Opens a DM with the author, quoting the message |
| Pin / unpin | Channel members, or posters in announcement channels **(default)** | |
| Save for later | Anyone | Private to the member |

## 5. Threads

Short exchanges stay in the flow of the conversation. Longer ones move aside.

- **Starting:** "Reply in thread" on any top-level message. Replies to replies aren't possible; threads are one level deep.
- **Up to 3 replies: inline.**
  - Replies appear **nested under the parent**: indented, with a connecting line and a small "Thread" label on the parent.
  - New replies are added under the parent, not at the bottom of the channel.
- **From the 4th reply: collapsed.**
  - The inline replies fold into a **thread marker** under the parent: "💬 4 replies · avatars of repliers · last reply 2m ago →".
  - Selecting it opens the **side panel** with the full thread and its own composer.
- **Clearly marked:** a parent always shows its thread indicator, whether inline or collapsed. Replies never appear loose in the main flow.
- **Also send to channel:** a checkbox on thread replies that also posts the reply at the bottom of the channel, with "replied to a thread: *parent excerpt*".
- **Activity far up the conversation:** when a reply lands on a parent that's scrolled out of view, members following the thread see a small **"New reply in thread: *excerpt*"** chip at the bottom of the conversation **(default)**.
- **Following:** you follow a thread automatically if you started it, replied, or were mentioned in it. You can follow or unfollow manually. A **Threads** view in the sidebar lists followed threads with unread replies.
- **Notifications:** thread replies notify followers through the inbox (`thread_reply`), unless muted.

## 6. Mentions and notifications

| Event | Who is notified | Default |
|---|---|---|
| DM / group DM message | Other participants | Notify |
| `@person` | That person, if they can see the conversation | Notify |
| `@group` | Group members who can see the conversation (Identity §4.9) | Notify |
| `@channel` | All channel members | Notify, unless muted |
| `@here` | Channel members currently online | Notify, unless muted |
| Thread reply | Thread followers | Notify |
| Keyword | Members who set keywords **(later)** | — |

- **@channel / @here:** anyone may use them. In channels with more than 20 members the composer asks "This will notify *N* people. Send?".
- **Per-conversation level:** all messages, mentions only (the default for channels), or nothing (mute). DMs default to all messages.
- **Do-not-disturb:** a schedule and manual DND (M2). Notifications are held and delivered when DND ends. The inbox still records them.
- **Offline email:**
  - If a mention, DM or thread reply is **still unread after 10 minutes** and the member isn't active, an email goes out.
  - Emails are batched **per conversation** (one email covers everything unread there) and contain no message text when the channel is private **(default)**, only "You have 3 new messages in #design-private".
  - Members can change the delay (5, 10 or 30 minutes, hourly or daily digest) or turn emails off.
- Email requires email to be configured; otherwise this setting is hidden.

## 7. Unread state

- A per-member **read cursor** per conversation (`last_read_seq`), advanced when the conversation is visible and focused. **Unread counts** come from the D1 copy (TDD §3.5).
- Opening a conversation marks it read up to what was shown. Mentions and DM inbox items for those messages resolve automatically.
- **Thread read state** is tracked separately per followed thread.
- Unread state syncs across a member's devices through the hub.

## 8. Pins and saved items

- **Pins:** up to 100 per channel **(default)**. A **Pinned** tab in the channel header lists them newest first, with a link back to the message. Pinning posts a small system message **(default)**.
- **Saved items:** members save any message they can read. The **Saved** view lists them with filters (in progress, done) **(default)**. Saved items disappear if the member loses access or the message is deleted.

## 9. Polls

- Created from the composer's "+" menu. A poll has a question, 2–10 options, and these settings:
  - **multiple choice** (allow several picks)
  - **anonymous** (results show counts only)
  - **closing time** (optional).
- Live results update in real time. Voters can change their vote until the poll closes.
- **Anonymous polls:** no member, including admins, can see who voted for what in the app. Voter identities are stored only to prevent double voting and are never exposed by the API.
- The creator can close a poll early, which posts a "Poll closed" system message with final results. Closed polls are read-only.

## 10. Files in chat

- Upload through the Worker into R2; multipart above 50 MB; default limit 2 GB, configurable (TDD §8.3).
- **Previews:**
  - images show inline with a lightbox; multiple images display as a grid
  - PDF, video and audio play inline (allow-listed types)
  - everything else is a file card with a download.
- A **Files** tab per channel lists files shared there (name, sharer, date, size, type filter).
- Files inherit the message's access. Deleting the message deletes its files.

## 11. Link previews

- **Internal Officebox links** (messages, documents, events, channels) always render a **permission-checked** preview. People without access see "You don't have access".
- **External links** (first release):
  - The Worker fetches the page server-side after sending: 5-second timeout, 1 MB limit, no cookies, HTML parsed not rendered. It reads Open Graph / Twitter metadata (title, description, site name, image).
  - The preview image is fetched once, resized and **stored in R2**, so viewers don't load third-party images (privacy).
  - Previews are cached per URL for 24 hours **(default)**.
  - Senders can remove a preview from their message. Admins can turn external previews off, or block domains.
  - Up to 3 previews per message **(default)**.

## 12. Search

- FTS5 over messages and file names (TDD §2.4), permission-filtered.
- **Filters:** `from:@handle`, `in:#channel`, `has:file`, `has:link`, `is:thread`, `before:` / `after:` / `on:` dates, and `with:@handle` (DMs).
- Results are grouped by conversation with highlighted snippets. Selecting one opens the conversation at that message.
- Deleted and archived content: deleted messages never appear. Archived channels are searchable unless filtered out.

## 13. Presence and typing

- Presence dots (online, away, DND) next to people (M2). Status emoji and text appear next to names.
- **Typing indicators:** "Sam is typing…" or "Several people are typing…". Typing events are throttled and never stored (TDD §3.4).
- **Time-off status** from the calendar shows "Away until Mon 3 Dec" on DMs and mentions, with a confirmation: "Sam is away until Monday — send anyway?" **(default)**.

## 14. Moderation and administration

- Channel admins remove messages, members and posters in their channel. Workspace admins can do the same everywhere, plus archive and delete any channel.
- Every admin removal is audited. The author is told their message was removed by an admin **(default)**.
- Workspace settings:
  - external link previews on or off, plus a blocked domains list
  - read-only #general
  - default channels (Identity §4.11).

## 15. Data model (additions)

**ChatChannel DO** (TDD §2.2): new event types alongside the existing ones.
- `message.pinned` / `message.unpinned`
- `poll.created` / `poll.voted` / `poll.closed`
- `preview.attached` / `preview.removed`

Message state adds:
- `format` (rich-text JSON) plus `text` (plain)
- `reply_count`, `last_reply_at`, `thread_participants`
- `also_in_channel`
- `forwarded_from` (message reference)
- `previews` (JSON)

Poll votes live in the channel DO. They're keyed by voter, and the voter is hidden from read APIs for anonymous polls.

**D1:**
```sql
ALTER TABLE channels ADD COLUMN topic TEXT;
ALTER TABLE channels ADD COLUMN description TEXT;
ALTER TABLE channels ADD COLUMN posting_policy TEXT NOT NULL DEFAULT 'everyone' CHECK (posting_policy IN ('everyone', 'posters'));
ALTER TABLE channels ADD COLUMN archived_at INTEGER;       -- (exists in TDD)
ALTER TABLE channel_members ADD COLUMN can_post INTEGER NOT NULL DEFAULT 0;   -- poster in announcement channels

CREATE TABLE thread_follows (user_id TEXT, channel_id TEXT, root_message_id TEXT, last_read_seq INTEGER NOT NULL DEFAULT 0,
  muted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, root_message_id));
CREATE TABLE saved_items (user_id TEXT, message_id TEXT, channel_id TEXT, state TEXT NOT NULL DEFAULT 'open', created_at INTEGER,
  PRIMARY KEY (user_id, message_id));
CREATE TABLE sidebar_prefs (user_id TEXT PRIMARY KEY, sections TEXT NOT NULL DEFAULT '[]', unreads_first INTEGER NOT NULL DEFAULT 0);
  -- sections: [{id, name, collapsed, conversationIds[]}]; starred is a reserved section
ALTER TABLE channel_members ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
ALTER TABLE channel_members ADD COLUMN email_delay TEXT;    -- per-conversation override, or NULL for the default
CREATE TABLE link_previews (url_hash TEXT PRIMARY KEY, url TEXT, title TEXT, description TEXT, site_name TEXT,
  image_key TEXT, fetched_at INTEGER, status TEXT);
```

## 16. Realtime protocol (additions)

- **Client → channel DO:**
  - `message.send` gains `format`, `mentions`, `alsoInChannel` and `forwardOf`
  - new: `message.pin`, `message.unpin`, `poll.create`, `poll.vote`, `poll.close`, `preview.remove`.
- **Channel DO → clients:** events as today, including the new types.
- **Hub → client:** `activity` gains thread updates for followed threads (M2).

## 17. Acceptance criteria

- **Conversations:** two members chat in a public channel, a private channel, a DM and a group DM. Non-members can't see or search a private channel.
- **Threads:**
  - the first 3 replies render nested inline; the 4th collapses the thread into a marker that opens the side panel
  - "also send to channel" posts to both places
  - followers see thread updates.
- **Announcement channels:** only admins and posters can post; everyone can react and reply in threads.
- **Edits and deletes:** an edit shows "(edited)"; a deleted message's text is absent from search and from replay.
- **@mentions:**
  - @channel in a 25-member channel asks for confirmation
  - @group notifies only members who can see the message
  - muted channels notify only direct mentions.
- **Offline email:** an unread DM sends one email after 10 minutes; reading it within 10 minutes sends none.
- **Polls:** multiple choice, anonymous (no voter identity in any API response) and auto-close all work.
- **Link previews:** an external preview stores its image in R2 and never loads third-party images in the viewer.
- **Unread state:** unread counts and the "New" marker are correct after a reconnect and across two devices.
- **Search:** filters work and respect access.
- **Performance:** p95 message round trip is under 300 ms in-region; channels with 10k messages scroll smoothly (virtualised list).

## 18. Later

Scheduled send and message reminders · mark unread · keyword notifications · custom emoji · slash commands · synced drafts · message edit history · Slack import (PRD §19) · bots and webhooks (PRD §19) · push notifications (Phase 2, PRD §8).

## 19. Open questions

1. **Group DM membership:** fixed (adding someone starts a new group DM, like Slack), or editable?
2. **Pinning permission:** any member, or only channel admins and posters?
3. **Offline email privacy:** include message text for DMs and public channels, and omit it only for private channels? (The default above omits it only for private channels.)
4. **Forwarding from private channels:** allow with a confirmation (the default above), or block?

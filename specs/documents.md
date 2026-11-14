# Spec: Documents, Whiteboards & Files

**Status:** Draft for review
**Feature name:** Documents (marketing name to be decided later)
**Milestone:** M6 ([PLAN](../PLAN.md)); file storage basics ship with Chat (M3b) · **Related:** PRD §5.5, §5.7, §10.1; TDD §2.4, §4, §8.3; [Chat](chat.md), [Calls](calls.md) (present mode)

Decisions marked **(default)** were not discussed; change them on review.

## 1. Summary

Collaborative documents and whiteboards, and the files around them, organised in **My files** and **shared drives**:
- real-time co-editing (Yjs)
- a rich editor with slash commands and live Officebox embeds
- inline comments
- version history
- offline editing of recently opened documents
- versioned files.

## 2. Decisions

| Topic | Decision |
|---|---|
| Organisation | **Folders + documents** (Drive-style), not nested wiki pages |
| Top level | **My files** (private until shared) **+ shared drives** (one per group automatically, plus drives members create) |
| Folder permissions | **Inherit, can widen.** Items get their folder's access and can be shared more widely, never narrower. |
| Channel folders | **Automatic.** Each channel has a linked folder; access follows channel membership. |
| Editor extras | **Slash commands; callouts, toggles, code blocks; Officebox embeds; Markdown & PDF export** |
| Review | **Comments only**: inline and page-level threads. No suggestion mode. |
| Whiteboards | **Standalone and embedded** in documents |
| Templates | **Later** (duplicate a document for now) |
| Public links | **Later** |
| File versions | **Yes.** Upload a new version and keep the old ones. |
| Offline | **Recently opened documents** stay editable offline and sync when back online |

## 3. Organisation

### 3.1 Drives

| Drive | Created | Owner | Default access |
|---|---|---|---|
| **My files** | Automatically per member | The member | Private until shared |
| **Group drive** | Automatically per group | The group (managed by group managers and admins) | Group members edit; others none **(default)** |
| **Shared drive** | Any member creates one | The drive itself; creator is the first drive manager | Shared with users, groups and channels as manager / editor / commenter / viewer |
| **Channels drive** | One, at setup | The workspace | Contains one folder per channel (§3.3) |

- **Shared drives belong to the team, not a person.** Content stays when people leave.
- **Leavers:** content in a departing member's **My files** is transferred to an admin (PRD §10.2), who can move it into a shared drive.
- A drive's managers can rename it, manage access and delete it. Deleting moves it to Trash for 30 days.

### 3.2 Folders and items

- Folders nest freely inside a drive. Items are **documents**, **whiteboards** and **files**.
- **Views:**
  - **Recent** (opened or edited by me)
  - **Shared with me**
  - **Starred**
  - **My files**
  - **Shared drives**
  - **Trash** (30-day restore, PRD §10.2).
- **Actions:**
  - create, upload (multiple files and folders by drag-and-drop), rename, move (within or between drives the member can edit)
  - duplicate (documents and whiteboards), star, delete
  - download, and export (§5.6).
- Moving an item into a different folder **changes its inherited access**. The move dialog warns when that widens or removes access for people.

### 3.3 Channel folders

- Every channel automatically has a folder in the **Channels drive**, named after the channel and renamed with it.
- **Access follows channel membership.** Public-channel folders are viewable by everyone; private-channel folders by members only. Channel members can **edit** **(default)**.
- **Contents:**
  - files shared in the channel (the channel's Files tab and this folder are the same set)
  - documents created from the channel ("Create from message")
  - documents a member saves there.
- When a channel is archived, its folder becomes read-only. When it's converted public → private, the folder's access narrows with it.

### 3.4 Permissions

- **Roles:** owner, editor, commenter, viewer (PRD §10.1). Drives add **manager**.
- **Effective access = the union** of grants on the item, its folders up to the drive, and the drive itself, plus the item's general access. Sharing can **widen** access but **never narrow** below what the folder gives.
- **Sharing dialog:**
  - add people, groups and channels with a role
  - general access: restricted, workspace can view, workspace can comment, workspace can edit
  - shows inherited access ("Inherited from *Design drive*")
  - **Copy link**.
- People without access who open a link see **"Request access"**. The owner or editors get an inbox request, which they approve with a role or decline **(default)**.
- **Admins** can see that items exist and manage drives, but don't read content they haven't been given access to (PRD §10.1).

## 4. Documents

### 4.1 Editor

- **Tiptap + Yjs**, using only the MIT packages (PRD §5.5).
- **Text and structure:** headings, paragraphs, bold, italic, underline, strikethrough, highlight, links, inline code, bulleted, numbered and **task lists**, quotes, dividers.
- **Tables:** add and remove rows and columns, a header row, cell alignment.
- **Media:** images (upload or paste, resizable, captions) and file attachments (cards).
- **Slash commands:** `/` opens a block menu (heading, list, table, callout, toggle, code, image, file, whiteboard, embed, divider, mention, date), filtered as you type.
- **Callouts:** info, tip, warning and danger styles with an emoji icon.
- **Toggles:** collapsible sections.
- **Code blocks:** language picker, syntax highlighting and copy.
- **Mentions:** `@person` (notifies them through the inbox, unless they lack access, in which case the author is asked to share), `@date`, and `#channel` or document links.
- **Officebox embeds** (§4.3).
- **Markdown shortcuts** throughout (`#`, `-`, `1.`, `[]`, `>`, ```` ``` ````, `**`).
- **Outline:** an automatic table-of-contents sidebar from headings.
- **Word count** and **reading time** in the document menu **(default)**.

### 4.2 Collaboration

- Live co-editing through the DocRoom DO (TDD §4). Edits converge, and presence shows collaborators' **avatars, cursors and selections** in their colours.
- **Viewers and commenters** can't edit; the server enforces this (TDD §4.4).
- Autosave is continuous, with a clear save state: "Saved", "Saving…", "Offline — changes will sync".
- **Present mode:** follow-the-presenter (Calls §6.6; TDD §4.5).

### 4.3 Officebox embeds

Live, permission-checked embeds inserted with `/embed` or by pasting an Officebox link and choosing "Embed":

| Embed | Shows | Interaction |
|---|---|---|
| **Chat message** | The message with author, time and reactions; updates live | Open in conversation |
| **Calendar event** | Title, time in the viewer's zone, attendees and RSVP | RSVP inline; join the call |
| **Whiteboard** | A live preview of the board | **Edit in place** (expands inline) or open full screen |
| **Document** | Title, owner and the first lines | Open |

- A viewer without access to the embedded object sees "You don't have access to this *event*" and a Request access button. Embedding never grants access (PRD §5.2).
- Deleted objects show "This *message* was deleted".

### 4.4 Comments

- **Inline comments:** select text, then comment. The thread is anchored to the text (Yjs relative positions), so it follows edits. If the anchored text is deleted, the thread becomes "orphaned" and is shown in the sidebar.
- **Page-level comments:** general discussion threads for the document.
- **Threads:** replies, @mentions (which reach the inbox), emoji reactions, edit and delete your own, **resolve and reopen**. Resolved threads are hidden, with a "Show resolved" toggle.
- **Permissions:** commenters and above can comment; viewers can read comments.
- **Notifications:** the document owner, people who commented in the thread, and anyone mentioned.

### 4.5 Version history

- **Automatic versions:** hourly while editing, kept for 7 days; daily, kept for 90 days. **Named versions:** "Save version…", kept for the document's lifetime (PRD §5.5; TDD §4.3).
- **History panel:** a list of versions with time and contributors, and a read-only preview of any version.
- **Compare** with the current version highlights added and removed text **(default)**.
- **Restore** brings an old version back as a new change, so history is kept and collaborators converge.

### 4.6 Export and import

- **Export as Markdown:** converted on the server from the document structure. Images are bundled in a `.zip` with relative links. Officebox embeds become links.
- **Export as PDF:** a print-optimised layout rendered by the browser ("Save as PDF"), with no server cost **(default)**. Server-side PDF rendering can come later.
- **Import:** `.md` and `.html` files become new documents (PRD §19, Phase 1).

### 4.7 Offline

- The **20 most recently opened documents** **(default)** are cached on the device (Yjs + IndexedDB) and stay **editable offline**. Edits sync and merge when the connection returns.
- Opening a document that isn't cached while offline shows "Not available offline".
- The offline state is obvious: a banner and the save state.
- **Security:** caches are wiped on sign-out and on session revocation (TDD §8.4). Admins can turn offline caching off.

## 5. Whiteboards

- **Excalidraw** (MIT) with an Officebox-maintained Yjs binding (TDD §4.2), so multiplayer works like documents.
- **Content:** shapes, freehand drawing, text, sticky notes, arrows and connectors, images (stored in R2 and referenced, never embedded in the Yjs document; TDD §4.3), frames and a library of shapes.
- **Collaboration:** live cursors and names, follow a collaborator, and present mode.
- **Standalone** in drives and folders, with the same sharing, comments **(later: comments on boards; first release has page-level comments only)** **(default)**, version history and Trash as documents.
- **Embedded in documents:** a live preview that can be **edited in place** (expands inline) or opened full screen. The embedded board is its own object with its own access (§4.3).
- **Export:** PNG and SVG (Excalidraw built-in).

## 6. Files

- **Upload:** drag-and-drop files and folders, or paste. Uploads stream through the Worker into R2, multipart above 50 MB; the default limit is 2 GB per file (TDD §8.3).
- **Previews:**
  - images, PDF, video and audio in the browser (allow-listed inline types)
  - text and code files in a read-only viewer **(default)**
  - everything else downloads.
- **Versions:**
  - "Upload new version" keeps previous versions, listed with uploader and date. Members can **download or restore** an older one.
  - Links and embeds always point to the **latest** version.
  - Old versions count towards storage and follow the file's retention.
- **Details panel:** name, type, size, owner, location, created and modified, versions, sharing and activity.
- Files shared in chat land in the channel's folder (§3.3) and behave like any other file.

## 7. Search

- FTS5 over document titles and content, whiteboard titles and text, and file names (TDD §2.4). Permission-filtered.
- **Filters:**
  - type (document, whiteboard, file)
  - drive or folder
  - owner, modified date
  - shared with me.
- Results show highlighted snippets, and opening one jumps to the match.

## 8. Data model (additions)

```sql
CREATE TABLE drives (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('personal', 'group', 'shared', 'channels')),
  name TEXT NOT NULL,
  owner_user_id TEXT REFERENCES users(id),          -- personal
  group_id TEXT REFERENCES groups(id),              -- group
  created_by TEXT REFERENCES users(id),
  created_at INTEGER NOT NULL,
  deleted_at INTEGER, purge_after INTEGER
);
-- folders: add drive and channel link
ALTER TABLE folders ADD COLUMN drive_id TEXT REFERENCES drives(id);
ALTER TABLE folders ADD COLUMN channel_id TEXT REFERENCES channels(id);   -- channel folders
-- documents: add folder
ALTER TABLE documents ADD COLUMN folder_id TEXT REFERENCES folders(id);
ALTER TABLE documents ADD COLUMN drive_id TEXT REFERENCES drives(id);
-- files: versions
ALTER TABLE files ADD COLUMN drive_id TEXT REFERENCES drives(id);
ALTER TABLE files ADD COLUMN current_version INTEGER NOT NULL DEFAULT 1;
CREATE TABLE file_versions (
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  r2_key TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  uploaded_by TEXT REFERENCES users(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (file_id, version)
);
CREATE TABLE stars (user_id TEXT, object_type TEXT, object_id TEXT, created_at INTEGER, PRIMARY KEY (user_id, object_type, object_id));
CREATE TABLE recent_items (user_id TEXT, object_type TEXT, object_id TEXT, opened_at INTEGER, PRIMARY KEY (user_id, object_type, object_id));
CREATE TABLE access_requests (id TEXT PRIMARY KEY, object_type TEXT, object_id TEXT, requester_id TEXT, message TEXT,
  state TEXT NOT NULL DEFAULT 'pending', decided_by TEXT, created_at INTEGER, decided_at INTEGER);

CREATE TABLE comment_threads (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  anchor TEXT,                                       -- Yjs relative positions (JSON); NULL = page-level
  quote TEXT,                                        -- the anchored text when created
  resolved_at INTEGER, resolved_by TEXT,
  created_by TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES comment_threads(id) ON DELETE CASCADE,
  author_id TEXT REFERENCES users(id),
  format TEXT NOT NULL, text TEXT NOT NULL,
  reactions TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL, edited_at INTEGER, deleted_at INTEGER
);
```

- `resource_grants` gains `resource_type` values `drive` and `folder`. The permission engine walks drive → folders → item and unions the grants (§3.4).
- **Comments** live in D1, not in the Yjs document, so they can be queried, notified and permission-checked independently. Their anchors use Yjs relative positions.
- **Embeds** are editor nodes holding `{ type, id }`. They're rendered client-side through permission-checked API calls; no content is copied into the document.

## 9. Acceptance criteria

- **Organisation:**
  - a member creates a document in **My files** and shares it with a group
  - a group drive exists for every group; an item in it is editable by group members
  - moving it to another folder changes its access, with a warning.
- **Inheritance:** a folder's viewers can view everything inside it; an item can't be restricted below its folder; sharing an item more widely works.
- **Channel folders:** files shared in a channel appear in its folder; a private channel's folder isn't visible to non-members; converting public → private narrows the folder.
- **Co-editing:** two people co-edit and converge; viewers can't edit (server-enforced); cursors and presence show.
- **Editor:** slash commands insert every listed block type; callouts, toggles and code blocks round-trip through Markdown export.
- **Embeds:** an embedded event shows its time in the viewer's zone and allows RSVP; an embedded whiteboard is editable in place; embeds respect access.
- **Comments:** an inline comment follows its text through edits; a mention reaches the inbox; resolve and reopen work.
- **Versions:** a restored version becomes the current content without losing history.
- **Offline:** an offline edit to a recently opened document syncs on reconnect without loss; sign-out wipes the cache.
- **Files:** a new file version keeps the old one downloadable, and links open the latest.
- **Exports:** Markdown export includes images in a zip; PDF export prints cleanly.
- **Search:** finds document text and file names and respects permissions.

## 10. Later

Templates · public read-only links · suggestion mode (track changes) · comments on whiteboards · server-side PDF rendering · Notion and Google Docs import (PRD §19) · nested pages and wiki spaces.

## 11. Open questions

1. **Group drive visibility:** can non-members of a group see that the drive exists, or is it hidden?
2. **Channel folder edit rights:** can all channel members edit, or only add files with documents read-only to non-authors?
3. **Whiteboard comments:** keep page-level only for the first release?
4. **Offline cache size:** is 20 documents right, or should it be size-based (for example 100 MB)?

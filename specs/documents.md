# Spec: Documents, Whiteboards & Files

**Status:** Draft for review
**Revision:** Revised after independent review (14 Nov 2026)
**Feature name:** Documents (marketing name to be decided later)
**Milestone:** M6 ([PLAN](../PLAN.md)), in slices M6a–M6c (§12). Chat attachments ship with Chat (M3b) and are message-owned, not drive files.
**Related:** PRD §5.5, §5.7, §10.1; TDD §2.4, §4, §8.3; [Permissions](permissions.md), [Notifications](notifications.md), [Platform](platform.md), [Chat](chat.md), [Calls](calls.md) (present mode)

Decisions marked **(default)** were not discussed; change them on review.

## 1. Summary

Collaborative documents and whiteboards, and the files around them, organised in **My files** and **shared drives**:
- real-time co-editing (Yjs)
- a rich editor with slash commands and live Officebox embeds
- inline comments
- version history
- offline editing of recently opened documents
- versioned drive files.

## 2. Decisions

| Topic | Decision |
|---|---|
| Organisation | **Folders + documents** (Drive-style), not nested wiki pages |
| Top level | **My files** (private until shared) **+ shared drives** (one per group automatically, plus drives members create) |
| Default access of new items | **Follow the container**: My files → private; a drive or folder → that drive's or folder's access; a channel folder → channel members. Nothing starts workspace-wide unless its folder is. *(Changes PRD §10.1, which said "workspace can edit".)* |
| Effective access | **Union** of the item's own grants, its folders' and drive's grants, and general access (permissions §5). Sharing can widen access, never narrow it below the folder. Moving an item can narrow its inherited access, so the move dialog warns. |
| Channel folders | **Automatic** for channels (not DMs). **Channel members edit everything.** |
| Channel made private | **Keep, but warn**: items with explicit wider access keep it, and the conversion dialog lists them so the channel admin can restrict them |
| Channel deleted | After the channel's 30-day Trash, documents in its folder **move to their creators' My files** (or to an admin if the creator is gone), keeping explicit shares |
| Chat attachments | **Message-owned**: not in the channel folder. "Save to folder" makes an independent drive copy. DMs and group DMs have no folder. |
| Group drives | **Listed by name** to every member; contents are group-only unless shared |
| Editor extras | **Slash commands; callouts, toggles, code blocks; Officebox embeds; Markdown & PDF export** |
| Review | **Comments only**: inline and page-level threads. No suggestion mode. Comments live in D1, not in the Yjs document. |
| Whiteboards | **Standalone and embedded** in documents; **page-level comments only** |
| Templates | **Later** (duplicate a document for now) |
| Public links | **Later** |
| File versions | **Yes** (drive files). Upload a new version and keep the old ones. |
| Offline | **Recently opened documents**: 20 documents **(default)**, capped at 100 MB **(default)** |

## 3. Organisation

### 3.1 Drives

| Drive | Created | Owner | Default access |
|---|---|---|---|
| **My files** | Automatically per member (platform §13) | The member | Private (restricted) |
| **Group drive** | Automatically per group (platform §13) | The group (managed by group managers and admins) | Group members edit. **Listed by name to all members**; contents are not visible to non-members unless shared. |
| **Shared drive** | Any member creates one | The drive itself; creator is the first drive manager | Shared with users, groups and channels as manager / editor / commenter / viewer. Restricted by default. |
| **Channels drive** | One, at setup (platform §13) | The workspace | Contains one folder per channel (§3.3); has no access of its own beyond listing |

- **Shared drives belong to the team, not a person.** Content stays when people leave.
- **Leavers:** a **disabled** member keeps ownership of their My files (PRD §6). When a member is **deleted**, their My files content transfers to an admin, who can move it into a shared drive (platform §3).
- **Deleting drives:**
  - A drive's managers can delete a shared drive, which moves it and its contents to Trash for 30 days (§3.5).
  - Group drives are deleted only with their group, in the same way (platform §4).
  - My files and the Channels drive can't be deleted.

### 3.2 Folders and items

- Folders nest inside a drive. Items are **documents**, **whiteboards** and **files**. Structural limits (folder depth, items per folder, drives) are in platform §8.
- **Views:**
  - **Recent** (opened or edited by me)
  - **Shared with me**
  - **Starred**
  - **My files**
  - **Shared drives** (including group drives listed by name)
  - **Trash** (§3.5).
- **Actions:**
  - create, upload (multiple files and folders by drag-and-drop, or the upload button), rename
  - **move** (drag-and-drop, or a **Move to…** dialog for keyboard and single-pointer use), duplicate (documents and whiteboards)
  - star, delete, download, and export (§4.6).
- **New items** take their container's access (§3.4). A document created in My files is private. One created in a shared drive or folder has that drive's or folder's access. One created in a channel folder is editable by channel members.

### 3.3 Channel folders

- Every **channel** (public, private or announcement) automatically has a folder in the **Channels drive**, named after the channel and renamed with it (platform §13). **DMs and group DMs have no folder.**
- **Access follows channel membership.** Channel members are **editors** of everything in the folder (decision). Public-channel folders are viewable by every member; private-channel folders are invisible to non-members.
- **Contents:**
  - documents and whiteboards created from the channel ("Create from message"), or created or moved there by members
  - **saved copies** of chat attachments: **Save to folder** on a chat file makes an independent drive file, and from then on it behaves like any drive file (versions, sharing, Trash).
- **Chat attachments are not in the folder.** They're owned by their message (Chat §10): they inherit the message's access, are deleted with it, and are listed only in the channel's **Files** tab.
- **Archived channel:** its folder becomes read-only and stays visible to channel members. Unarchiving restores edit access.
- **Converted public → private:** the folder narrows to channel members. **Items with explicit wider access keep it.** The conversion dialog lists those items (title, current access) so the channel admin can restrict them before confirming (decision).
- **Deleted channel:** after the channel's 30-day Trash, each item in its folder **moves to its creator's My files** (or to an admin's if the creator was deleted), keeping its explicit shares. The empty folder is then purged (platform §4).

### 3.4 Permissions

- **Roles:** owner, editor, commenter, viewer (permissions §3). Drives add **manager**.
- **Effective access is the union** of:
  - grants on the item
  - grants on each of its folders up to the drive
  - grants on the drive
  - the item's general access (permissions §5).

  Sharing can **widen** access but never narrow it below what the folder gives. "Restricted" is the default general access for My files, shared drives and new folders.
- **Moving an item** changes its inherited access. **Explicit item grants travel with the item.**
  - The move dialog lists who **gains** and who **loses** access ("3 people will lose access").
  - Moving out of a private space into a more open one needs confirmation.
- **Sharing dialog:**
  - add people, groups and channels with a role
  - general access: restricted, workspace can view, workspace can comment, workspace can edit
  - shows inherited access ("Inherited from *Design drive*")
  - **Copy link**.
- **Access requests and the no-access screen** follow permissions §7.
  - **Approvers** are owners and editors, plus drive managers for drive items.
  - The no-access screen **doesn't show the title** when the viewer can't see the containing space.
  - Requests are unique per requester and item, and expire (§9).
- **Admins** can see that items exist and manage drives, but don't read content they haven't been given access to (permissions §6).
- **Access changes on open sessions:** when a role is downgraded or removed through any route (item, folder, drive or general access), the Worker re-checks access and closes or re-scopes affected DocRoom sockets (platform §12). A downgraded editor's open document switches to read-only within seconds.

### 3.5 Trash and restore

- Deleting an item or folder moves it to Trash for **30 days**, after which it's purged (platform §5).
- **Who can restore:**

  | Container | Who can restore |
  |---|---|
  | My files | The owner (or an admin, after transfer) |
  | Shared drive | Drive managers, or the person who deleted the item |
  | Group drive | Group managers |
  | Channel folder | Channel admins, or the person who deleted the item |
  | Any | Workspace admins, for items in containers they manage |

- Restoring returns an item to its original folder if it still exists, otherwise to the drive root.
- Deleting a drive puts the whole drive in Trash. Restoring the drive restores items deleted with it; items deleted before the drive keep their own Trash timers.

## 4. Documents

### 4.1 Editor

- **Tiptap + Yjs**, using only the MIT packages (PRD §5.5).
- **Text and structure:** headings, paragraphs, bold, italic, underline, strikethrough, highlight, links, inline code, bulleted, numbered and **task lists**, quotes, dividers.
- **Tables:** add and remove rows and columns, a header row, cell alignment.
- **Media:** images (upload or paste, resizable, captions, **alt text**) and file attachments (cards).
- **Slash commands:** `/` opens a block menu (heading, list, table, callout, toggle, code, image, file, whiteboard, embed, divider, mention, date), filtered as you type.
- **Callouts:** info, tip, warning and danger styles with an emoji icon.
- **Toggles:** collapsible sections.
- **Code blocks:** language picker, syntax highlighting and copy.
- **Mentions:**
  - `@person` notifies them through the inbox (notifications §3). If they lack access, the author is asked to share.
  - `@date`, and `#channel` or document links.
- **Officebox embeds** (§4.3).
- **Markdown shortcuts** throughout (`#`, `-`, `1.`, `[]`, `>`, ```` ``` ````, `**`).
- **Outline:** an automatic table-of-contents sidebar from headings.
- **Word count** and **reading time** in the document menu **(default)**.
- **Keyboard shortcuts** are documented in a shortcuts panel (`?`). They use modifier keys; there are no single-character shortcuts in the editor (WCAG 2.1.4).

### 4.2 Collaboration

- Live co-editing through the DocRoom DO (TDD §4). Edits converge, and presence shows collaborators' **avatars, cursors and selections** in their colours.
- **Viewers and commenters** can't edit; the server enforces this (TDD §4.4). Role changes while a document is open take effect within seconds (§3.4).
- Autosave is continuous, with a clear save state: "Saved", "Saving…", "Offline — changes will sync", or "Read-only — your access changed".
- **Present mode:** follow-the-presenter (Calls §6.6; TDD §4.5).

### 4.3 Officebox embeds

Live, permission-checked embeds inserted with `/embed` or by pasting an Officebox link and choosing "Embed":

| Embed | Shows | Interaction | Updates |
|---|---|---|---|
| **Chat message** | The message with author, time and reactions | Open in conversation | Through hub activity (platform §12) |
| **Calendar event** | Title, time in the viewer's zone, attendees and RSVP | RSVP inline; join the call | Through hub activity |
| **Whiteboard** | A preview of the board | **Edit in place** (expands inline) or open full screen | A BoardRoom socket opens **only while editing in place** (platform §12); otherwise the preview refreshes through hub activity |
| **Document** | Title, owner and the first lines | Open | Through hub activity |

- A viewer without access to the embedded object sees the no-access state from permissions §7. Embedding never grants access (PRD §5.2).
- Deleted objects show "This *message* was deleted".

### 4.4 Comments

- **Storage:** comment threads and comments live in **D1, not in the Yjs document**, so they can be queried, notified, moderated and permission-checked independently. *(PRD §5.5's sentence that comments are "built on Officebox's own Yjs storage" needs changing to "stored in Officebox's database, anchored to the document with Yjs relative positions".)*
- **Inline comments:** select text, then comment. The thread is anchored with Yjs relative positions and keeps the **quoted text**.
- **Orphaned threads:** if the anchored text is deleted, the thread becomes orphaned and is shown in the sidebar under "Detached comments".
  - Orphan status is computed **client-side** when rendering.
  - The DocRoom also computes it **on compaction**, so participants can be notified "Your comment's text was removed" **(default)**.
- **Version restore:** after a restore, each thread is **re-anchored by matching its stored quote** in the restored content (first exact match, then the closest match nearby). If there's no match, the thread becomes orphaned.
- **Page-level comments:** general discussion threads for the document.
- **Threads:**
  - replies, @mentions (which reach the inbox), emoji reactions
  - edit and delete your own comments
  - **resolve and reopen**; resolved threads are hidden, with a "Show resolved" toggle.
- **Moderation:** the document **owner**, **editors** **(default)** and **admins** (on documents they can access) can delete any comment. A removed comment shows "Comment removed by *name*", and the removal is audited.
- **Permissions:** commenters and above can comment; viewers can read comments.
- **Realtime:** new, edited, resolved and removed comments fan out to viewers who have the document open, through hub activity (platform §12).
- **Notifications** (notifications §3): `doc_comment` to the document owner and thread participants; `doc_mention` to anyone mentioned.

### 4.5 Version history

- **Automatic versions:** hourly while editing, kept for 7 days; daily, kept for 90 days. **Named versions:** "Save version…", kept for the document's lifetime (PRD §5.5; TDD §4.3).
- **History panel:** a list of versions with time and contributors, and a read-only preview of any version.
- **Compare:**
  - Highlights added and removed text between a version and the current document.
  - Tiptap's snapshot-compare is a paid extension, so Officebox builds **its own diff**: both versions are rendered to text blocks from ProseMirror JSON and compared block by block, with a word-level diff inside changed blocks.
  - This is **custom work** to size before M6b. It moves to Later if it turns out too large **(default)**.
- **Restore** brings an old version back as a new change, so history is kept and collaborators converge. Comment threads are re-anchored (§4.4).

### 4.6 Export and import

- **Export as Markdown:** converted on the server from the document structure. Images are bundled in a `.zip` with relative links. Officebox embeds become links.
- **Export as PDF:** a print-optimised stylesheet, then the browser's "Save as PDF", with no server cost **(default)**.
- **Import:** `.md` and `.html` files become new documents in the chosen folder (PRD §19, Phase 1). Headings, lists, tables, code blocks, links and images (uploaded to R2) are converted. Unsupported HTML is reduced to plain text.

### 4.7 Offline

- The **20 most recently opened documents** **(default)**, capped at **100 MB** total **(default)**, are cached on the device (Yjs + IndexedDB) and stay **editable offline**. Edits sync and merge when the connection returns.
- Opening a document that isn't cached while offline shows "Not available offline".
- The offline state is obvious: a banner and the save state.
- **Access lost or downgraded while offline:**
  - On reconnect the server re-checks access and **rejects edits** the member is no longer allowed to make.
  - The client shows "Your changes couldn't be saved because your access changed" and offers **Export my local copy** (Markdown) before discarding (platform §12).
- **Settings:**
  - Offline caching follows the member's preference in `user_preferences` and the admin setting `offline_documents_enabled` (platform §7).
  - When an admin turns it off, caches are wiped at the next start.
- **Security:** caches are wiped on sign-out and on session revocation (TDD §8.4).

## 5. Whiteboards

- **Excalidraw** (MIT) with an Officebox-maintained Yjs binding (TDD §4.2), so multiplayer works like documents.
- **Content:** shapes, freehand drawing, text, sticky notes, arrows and connectors, images (stored in R2 and referenced, never embedded in the Yjs document; TDD §4.3), frames and a library of shapes.
- **Collaboration:** live cursors and names, follow a collaborator, and present mode.
- **Standalone** in drives and folders, with the same sharing, version history and Trash as documents. **Comments are page-level only** (decision). Comments anchored to objects on the board come later.
- **Embedded in documents:** a live preview that can be **edited in place** (expands inline) or opened full screen. The embedded board is its own object with its own access (§4.3).
- **Export:** PNG and SVG (Excalidraw built-in).
- **Accessibility limits** **(default)**:
  - canvas content isn't accessible to screen readers; the board title, description and comments are
  - exported images prompt for alt text when inserted into documents
  - keyboard shortcuts follow Excalidraw's (documented in the shortcuts panel).

## 6. Files

This section covers **drive files** only. Chat attachments are message-owned (Chat §10). They become drive files only through **Save to folder**, which makes an independent copy.

- **Upload:** drag-and-drop files and folders, the upload button, or paste. Uploads stream through the Worker into R2, multipart above 50 MB; the default limit is 2 GB per file (TDD §8.3; quotas in platform §8).
- **Previews:**
  - images, PDF, video and audio in the browser (allow-listed inline types)
  - text and code files in a read-only viewer **(default)**
  - everything else downloads.
- **Versions:**
  - "Upload new version" keeps previous versions, listed with uploader and date. Members can **download or restore** an older one; restoring makes it the new latest version.
  - Links and embeds always point to the **latest** version.
  - Old versions count towards storage and are purged with the file (platform §5).
- **Details panel:** name, type, size, owner, location, created and modified, versions, sharing and activity (§6.1).

### 6.1 Activity

Every document, whiteboard and file has an **Activity** section in its details panel:
- **edits**, grouped by person per day ("Ana and Joe edited · Tue")
- **comments** (counts, with links to threads)
- **sharing changes** (who granted what to whom)
- **versions** (named versions, restores, new file versions)
- **calls held** on the document: start time, duration and participants (Calls §3, §7).

Activity is visible to anyone who can view the item. It is kept for the life of the item **(default)**.

## 7. Search

- FTS5 over document titles and content, whiteboard titles and text, and drive file names (TDD §2.4). Permission-filtered, including inheritance through folders and drives (permissions §5).
- **Filters:**
  - type (document, whiteboard, file)
  - drive or folder
  - owner, modified date
  - shared with me.
- Results show highlighted snippets, and opening one jumps to the match.

## 8. Mobile

- Mobile browsers and the installed PWA can **browse, read and comment** on documents and view whiteboards.
- Editing documents on mobile is **supported but optimised later** **(default)**. Editing whiteboards on mobile is view-only in the first release **(default)**.

## 9. Data model (additions)

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

-- folders: baseline general_access default becomes 'restricted' (platform §14); add drive and channel link
ALTER TABLE folders ADD COLUMN drive_id TEXT REFERENCES drives(id);
ALTER TABLE folders ADD COLUMN channel_id TEXT REFERENCES channels(id);   -- channel folders only (never DMs)

-- documents (and whiteboards)
ALTER TABLE documents ADD COLUMN folder_id TEXT REFERENCES folders(id);
ALTER TABLE documents ADD COLUMN drive_id TEXT REFERENCES drives(id);
ALTER TABLE documents ADD COLUMN created_by TEXT REFERENCES users(id);     -- for the channel-deletion move

-- files: two kinds, kept apart
--   drive files:     folder_id + drive_id set, parent_type NULL, versioned
--   message files:   parent_type = 'message', folder_id NULL, never versioned (Chat §10)
-- The baseline CHECK (NOT (folder_id IS NOT NULL AND parent_type IS NOT NULL)) stays and now matches this model.
ALTER TABLE files ADD COLUMN drive_id TEXT REFERENCES drives(id);
ALTER TABLE files ADD COLUMN current_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE files ADD COLUMN copied_from_file_id TEXT;                     -- "Save to folder" provenance
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

CREATE TABLE access_requests (
  id TEXT PRIMARY KEY,
  object_type TEXT NOT NULL, object_id TEXT NOT NULL,
  requester_id TEXT NOT NULL REFERENCES users(id),
  message TEXT,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'approved', 'declined', 'expired', 'cancelled')),
  granted_role TEXT,
  decided_by TEXT REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,                      -- created_at + 30 days (default)
  decided_at INTEGER
);
CREATE UNIQUE INDEX access_requests_open ON access_requests(object_type, object_id, requester_id) WHERE state = 'pending';

CREATE TABLE comment_threads (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  anchor TEXT,                                       -- Yjs relative positions (JSON); NULL = page-level
  quote TEXT,                                        -- anchored text when created; used to re-anchor after restore
  orphaned_at INTEGER,                               -- set by DocRoom on compaction (client also computes live)
  resolved_at INTEGER, resolved_by TEXT,
  created_by TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES comment_threads(id) ON DELETE CASCADE,
  author_id TEXT REFERENCES users(id),
  format TEXT NOT NULL, text TEXT NOT NULL,
  reactions TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL, edited_at INTEGER,
  deleted_at INTEGER,
  removed_by TEXT REFERENCES users(id),              -- moderation: owner, editor or admin removal (audited)
  removed_at INTEGER
);

CREATE TABLE item_activity (                         -- details-panel activity (§6.1)
  id TEXT PRIMARY KEY,
  object_type TEXT NOT NULL, object_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('edit', 'comment', 'share', 'version', 'call')),
  actor_id TEXT REFERENCES users(id),
  day TEXT,                                          -- YYYY-MM-DD, for grouping edits
  detail TEXT,                                       -- JSON
  created_at INTEGER NOT NULL
);
CREATE INDEX item_activity_object ON item_activity(object_type, object_id, created_at);
```

- `resource_grants` takes `resource_type` values `drive` and `folder`, and the role `manager`, as defined in permissions §3 and platform §14. These are part of the baseline CHECK sets, not added later.
- The permission engine walks drive → folders → item and **unions** the grants (§3.4).
- **Embeds** are editor nodes holding `{ type, id }`. They're rendered client-side through permission-checked API calls; no content is copied into the document.
- Retention and purge of every table above follow platform §5. Export coverage (drives, folders, file versions, comments, activity) follows platform §6.

## 10. API (summary)

| Method and path | Purpose |
|---|---|
| `GET /drives` · `POST /drives` · `PATCH /drives/:id` · `DELETE /drives/:id` | List drives (including group drives by name), create, rename, delete a shared drive |
| `PUT /drives/:id/grants` | Drive managers and access |
| `GET /folders/:id` · `POST /folders` · `PATCH /folders/:id` · `DELETE /folders/:id` | Folder contents (paged), create, rename, delete |
| `GET /items?view=recent\|shared\|starred\|trash` | Recent, shared with me, starred, Trash |
| `POST /documents` · `GET /documents/:id` · `PATCH /documents/:id` · `DELETE /documents/:id` | Documents and whiteboards (type in body): create, metadata, rename, delete |
| `POST /items/:type/:id/move` · `POST /items/:type/:id/copy` | Move (returns the access diff for the warning, then confirm) and duplicate |
| `POST /items/:type/:id/restore` | Restore from Trash |
| `POST /files/uploads` · `PUT /files/uploads/:id/parts/:n` · `POST /files/uploads/:id/complete` | Multipart upload into a folder |
| `GET /files/:id` · `GET /files/:id/download?version=` | File details and download (Range supported) |
| `POST /files/:id/versions` · `POST /files/:id/versions/:n/restore` | New version, restore a version |
| `POST /chat-files/:id/save` | Save a chat attachment to a folder (independent copy) |
| `GET /items/:type/:id/grants` · `PUT /items/:type/:id/grants` | Sharing (people, groups, channels; general access) |
| `POST /items/:type/:id/access-requests` · `POST /access-requests/:id/approve` · `POST /access-requests/:id/decline` | Access requests |
| `GET /documents/:id/comments` · `POST /documents/:id/comments` (new thread) | Comment threads |
| `POST /comment-threads/:id/replies` · `POST /comment-threads/:id/resolve` · `POST /comment-threads/:id/reopen` | Replies, resolve, reopen |
| `PATCH /comments/:id` · `DELETE /comments/:id` | Edit or delete your own; moderators remove any |
| `GET /documents/:id/versions` · `GET /documents/:id/versions/:vid` | List versions, preview a version |
| `POST /documents/:id/versions` · `POST /documents/:id/versions/:vid/restore` | Name a version, restore |
| `GET /documents/:id/versions/:vid/compare?with=current` | Compare (diff blocks) |
| `GET /documents/:id/export.md` | Markdown export (zip when there are images); PDF is client-side |
| `POST /documents/import` | Import `.md` or `.html` into a folder |
| `PUT /stars/:type/:id` · `DELETE /stars/:type/:id` | Star and unstar |
| `GET /items/:type/:id/activity` | Activity (§6.1) |
| `GET /search?q=&type=&drive=&owner=&modified=` | Search (§7) |

Realtime: document content goes through the DocRoom/BoardRoom sockets (TDD §4). Comments, sharing changes, tree changes and embed updates arrive as hub `activity` (platform §12).

## 11. Acceptance criteria

- **Organisation and default access:**
  - a document created in **My files** is private (only the creator can open it)
  - a document created in a shared drive gets that drive's access
  - a document created in a channel folder is editable by channel members and invisible to non-members of a private channel.
- **Inheritance:**
  - a folder's viewers can view everything inside it
  - an item can't be restricted below its folder
  - sharing an item more widely works
  - moving an item to a more restricted folder shows the list of people who lose access, and after confirming they can no longer open it (explicit grants remain).
- **Group drives:** a non-member sees the group drive's name but gets the no-access state when opening it. Group members can edit inside.
- **Channel folders:**
  - **Save to folder** on a chat attachment creates an independent drive file; deleting the original message doesn't delete the copy
  - DMs have no folder
  - archiving a channel makes its folder read-only.
- **Public → private conversion:** the dialog lists items with explicit wider access. Those items keep it after confirming; all others narrow to channel members.
- **Channel deletion:** 30 days after a channel is deleted, its folder's documents appear in their creators' My files with explicit shares intact. A document whose creator was deleted lands in an admin's My files.
- **Co-editing:** two people co-edit and converge; viewers can't edit (the server rejects their updates).
- **Role downgrade while open:** an editor whose role is downgraded to viewer while the document is open is switched to read-only within 5 seconds, and further edits are rejected.
- **Editor:** each slash-command block type inserts correctly. Callouts, toggles and code blocks survive Markdown export and re-import with the same block types.
- **Embeds:**
  - an embedded event shows its time in the viewer's zone and allows RSVP
  - an embedded whiteboard is editable in place and opens a BoardRoom socket only while editing
  - a viewer without access to an embedded object sees the no-access state without its title.
- **Comments:**
  - an inline comment stays anchored to its text after 50 surrounding edits
  - a mention creates a `doc_mention` inbox item
  - resolve and reopen work
  - after a version restore, a thread whose quote exists in the restored text is re-anchored, and one whose quote doesn't is listed under "Detached comments"
  - the document owner can remove another member's comment, and the removal appears in the audit log.
- **Access requests:** requesting access to a document creates one pending request visible to its owner and editors; a second request from the same person is refused while one is pending; approving grants the chosen role; requests expire after 30 days.
- **Versions:** restoring a version makes it the current content and adds a new history entry; compare highlights an inserted and a removed sentence.
- **Offline (conflict scenario):** devices A and B open the same document. A goes offline and edits paragraph 1 while B edits paragraph 2. When A reconnects, both edits are present on both devices.
- **Offline (revoked access):** if A's access is revoked while offline, A's edits are rejected on reconnect and **Export my local copy** produces a Markdown file containing them.
- **Offline cache:** sign-out wipes the cache; the cache never exceeds 20 documents or 100 MB.
- **Files and versions:** uploading a new file version keeps the old one downloadable; restoring version 1 makes it the latest; links open the latest.
- **Trash:**
  - a deleted item restores to its original folder within 30 days and is purged after
  - deleting a shared drive and restoring it within 30 days brings back its contents
  - only the people listed in §3.5 can restore.
- **Exports and import:**
  - Markdown export of a document with two images produces a zip with the `.md` file and both images, linked relatively
  - PDF export (print stylesheet) produces one page per printed A4 or Letter page, with no app chrome, and every heading and table visible
  - importing a `.md` file with headings, a list, a table and a code block creates a document with those block types.
- **Search:** finds document text and file names, respects inherited access, and returns nothing from a group drive to a non-member.
- **Accessibility:** every drag-and-drop action (move, upload, reorder) has a keyboard and single-pointer alternative; axe reports no violations on the drive, editor and history screens.

## 12. Slices

| Slice | Contents |
|---|---|
| **M6a** | Drives (My files, group, shared, Channels), folders, default access and inheritance, sharing and access requests, the document editor (§4.1–4.2), Trash, search |
| **M6b** | Comments (with moderation and re-anchoring), version history and compare, Officebox embeds, Markdown/PDF export and import, activity |
| **M6c** | Whiteboards (standalone and embedded), drive files with versions and Save to folder, offline editing |

## 13. Limits and rate limits

Structural limits (folder depth, items per folder, drives per workspace, versions per file, comment length) and rate limits (uploads, access requests, imports) are defined in platform §8.

## 14. Later

Templates · public read-only links · suggestion mode (track changes) · comments anchored to whiteboard objects · server-side PDF rendering · Notion and Google Docs import (PRD §19) · nested pages and wiki spaces · optimised mobile editing · mobile whiteboard editing.

## 15. Open questions

Resolved in this revision:
- Group drive visibility: listed by name, contents group-only.
- Channel folder edit rights: channel members edit everything.
- Whiteboard comments: page-level only.
- Offline cache: 20 documents with a 100 MB cap.

Still open:
1. **Comment moderation by editors:** should editors (not just owners and admins) be able to remove others' comments? (The default above is yes.)
2. **Compare versions:** keep it in M6b if the custom diff fits, or move it to Later now?

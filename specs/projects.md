# Spec: Projects, Tasks & Issues

**Status:** Approved
**Revision:** Approved after four rounds of product-owner questions and independent review (15 Nov 2026)
**Feature name:** Projects (marketing name to be decided later)
**Milestones** ([PLAN](../PLAN.md)):
- M10a: projects, auto-provisioned channel/drive/calendar, ProjectRoom DO, issues, personal tasks, list and board views
- M10b: comments, relations, milestones, calendar capacity planning, Personal Inbox (`assignment`, `review_request`), and chat/document links
- M10c: Project Pulse (Overview), shared Project Memory, and Butler project/issue tools

**Related specs:**
- [Permissions](permissions.md) §3, §4, §5
- [Notifications & Attention](notifications.md) §3, §6
- [Platform Rules](platform.md): lifecycle, cascades, retention, export, settings, limits, timers, connection budget, provisioning, schema
- [Chat](chat.md): project channel, curated activity messages, issue chips (`ENG-42`), "Create issue from message"
- [Documents](documents.md): project drive, issue embeds, promote document checklist item to issue
- [Calendar](calendar.md): project calendar, milestones, releases, demos, team time-off/holiday capacity overlay
- [Calls](calls.md): project calls, call notes proposing issues and project memory
- [Assistant](assistant.md): project-scoped Butler, shared Project Memory, issue and capacity tools

**Related PRD and TDD sections:** PRD §5.1, §5.2, §5.3, §5.6, §5.9, §10.1, §10.2, §15; TDD §1.1, §2.0, §2.1, §2.2, §2.4, §3.3, §3.5, §5

Decisions marked **(default)** were not discussed; change them on review.

**Cross-cutting rules:** permissions follow [Permissions](permissions.md); notifications follow [Notifications & Attention](notifications.md); lifecycle, cascades, retention, export, admin settings, limits and timers follow [Platform Rules](platform.md). Those specs win on cross-cutting rules. §16 lists the changes those documents need when this spec is approved.

## 1. Summary

Projects in Officebox are living, connected workspaces—not isolated ticket trackers. Creating a project automatically provisions:
- **a project board and issue tracker** backed by a dedicated **`ProjectRoom` Durable Object** (real-time board movement, ordering, presence and instant updates) with a guaranteed outbox projection to D1
- **a dedicated project channel** (`#proj-<slug>` or promoted from an existing channel) for team conversation and curated project updates
- **a dedicated project drive** for the project's specs, whiteboards and files
- **a dedicated project calendar** that holds milestones, releases, demos and project meetings, and automatically overlays team members' declared time off, regional public holidays and working hours for **capacity planning**
- **a project-scoped Butler and Project Pulse**, maintaining a shared, permission-safe **Project Memory** (decisions, risks, status updates and conventions) alongside live progress and blockers.

Every work item uses **one unified model** (`issues`):
- **Project issues** (`ENG-42`, `DESIGN-7`) live inside a project, with configurable workflow columns across five canonical status categories, priority, assignee, reviewers, effort in days, due dates, milestones, one level of sub-issues, checklists and cross-object relationships.
- **Personal and ad-hoc tasks** (`TASK-12`) use the exact same model without requiring a project first. They are private to the creator by default, can be shared or assigned to colleagues, and can be moved into a project at any time.
- **Document checklists** (`[ ]` in Tiptap) remain lightweight document content unless explicitly promoted to an issue with one click.

## 2. Decisions

| Topic | Decision |
|---|---|
| Work-item model | **One unified model (`issues`)** for both project issues (`ENG-42`) and projectless personal/ad-hoc tasks (`TASK-12`), plus lightweight checklists inside an issue. Document `[ ]` checkboxes stay document-only unless explicitly promoted to an issue. |
| Project provisioning | **Auto-provisioned ecosystem.** Creating a project automatically creates its dedicated channel, project drive and project calendar—or promotes an existing channel into a project. |
| Project permissions | **Unified membership and role list.** One set of grants on the project (**Lead · Editor · Commenter · Viewer**, plus `general_access`) governs the project's issues, channel, drive and calendar through the permission engine's union rule. |
| Storage & realtime architecture | **`ProjectRoom` Durable Object per project (`idFromName(projectId)`)** is the source of truth for project issues, board ordering, checklists and live board presence, syncing to D1 via the outbox helper. Personal tasks (`project_id IS NULL`) live in a single workspace-wide **`ProjectRoom` Durable Object (`idFromName("personal")`)** (§11.1) using the same schema and outbox, with sequential `TASK-<n>` numbering and per-task access isolation (live updates for personal tasks are pushed through each authorised participant's `UserHub` socket rather than a shared board room). |
| Issue descriptions | **Rich-text Markdown composer** (ProseMirror JSON + plain-text copy, like Chat and Comments) with live Officebox embeds. No Yjs DocRoom DO per issue; longer specs link or embed a collaborative project document. |
| Issue keys | **Per-project uppercase prefix + counter** (`ENG-1`, `ENG-2`, 2–8 letters). Personal tasks use `TASK-<n>` per workspace **(default)**. Moving an issue to another project assigns a new key in the destination project and keeps a permanent redirect from the old key (`issue_key_aliases`). |
| Workflow statuses | **Configurable columns mapped to 5 fixed status categories:** `backlog`, `unstarted`, `started`, `completed`, `cancelled`. Default columns: *Backlog* (`backlog`), *Todo* (`unstarted`), *In Progress* (`started`), *In Review* (`started`), *Done* (`completed`), *Cancelled* (`cancelled`). |
| Assignees & reviewers | **One primary assignee** plus **optional reviewers** (`issue_reviewers` with state `pending`, `approved`, `changes_requested`, `cancelled`). Adding a reviewer raises the `review_request` inbox notification. |
| Hierarchy & relations | **One level of sub-issues** (parent → child; a child cannot have children) plus **checklists** inside an issue, and typed issue relations: `blocks` / `blocked_by`, `relates_to`, `duplicate_of`. |
| Personal tasks access | **Private to the creator by default.** Visible in **My Work**. Can be assigned or shared with specific members (granting them editor access to that task) or moved into a project at any time (inheriting the project's access). |
| Views | **Inside a project (5 tabs):** *Overview (Pulse)* · *Issues* (List, Kanban Board via `dnd-kit`, Table/Group-by) · *Calendar & Capacity* · *Docs & Files* · *Channel* (also available as a split-pane drawer alongside any tab). **Workspace-wide:** *My Work* (Assigned to me, Reviewing, Created by me, Personal tasks) and *All Projects*. |
| Planning & capacity | **Milestones, releases and demos** on the project calendar, with **capacity planning**: issues carry an optional simple effort in days (`0.5d`, `1d`, `2d`, etc.). For any milestone or date window, the project calculates each member's available working days (from profile working hours minus declared `time_off` and regional/company public holidays) vs. assigned issue effort, highlighting over-allocation. No story points or velocity charts. |
| Live activity in channel | **Curated, low-noise channel posts** (configurable per project): new issues created, issues completed, milestone/release/demo changes, and Butler's periodic Project Pulse. Granular field edits go only to the issue's activity log. Active calls, open docs and linked issues appear live in the project header. |
| Butler & Project Memory | **Project-scoped Butler + shared Project Memory.** Project Memory (`project_memories` in D1, indexed in FTS5 and Vectorize) holds decisions, risks, conventions and status notes visible to project members. Editors/Leads add or edit items directly, or confirm `pending` items Butler proposes from project calls, chat and docs. Never leaks any member's private personal memory. Purged automatically when a cited source is deleted. |
| Butler tools | Confirmed write tools: `create_issue`, `update_issue`, `comment_on_issue`, `propose_project_memory`. Read tools: `search_issues`, `get_project_pulse`, `check_project_capacity`. Butler can also draft a weekly or on-demand Project Pulse post for the Lead. |
| Archive & Delete | **Archive** makes the project board, channel, drive and calendar read-only (reversible). **Delete** moves the project, channel, calendar, issues and project memory to **30-day Trash**. On **purge**, documents, whiteboards and files in the project drive **move to their creators' My files** (or an admin's if deleted), matching the channel-purge rule so shared knowledge is never silently destroyed. |
| Member disabled or deleted | Open assigned issues stay open and are flagged **"Needs reassignment"** (`needs_reassignment = 1`) on the Project Overview and in the Project Lead's inbox. Pending review requests are cancelled. If they were the last Project Lead, the longest-standing Editor (or an admin) is promoted. On account deletion, open personal tasks transfer to an admin (completed ones are erased). |
| Milestone placement | **M10** in [PLAN.md](../PLAN.md), in slices M10a, M10b and M10c. |

---

## 3. Project Workspace & Auto-Provisioning

### 3.1 What a Project is

A Project is a cohesive workspace container for a stream of work, a product area or a team initiative. When a member creates a project (or promotes an existing channel into a project), Officebox provisions four connected surfaces under one identity in a single atomic flow:

| Surface | Backing primitive | What it holds |
|---|---|---|
| **Project Board & Issues** | `ProjectRoom` Durable Object + D1 copy | Issues, sub-issues, columns, labels, milestones, checklists, board presence |
| **Project Channel** | `ChatChannel` Durable Object (`channels.project_id`) | Team conversation, curated issue/milestone updates, calls, threads |
| **Project Drive** | Shared drive (`drives.kind = 'project'`, `drives.project_id`) | Specs, decision docs, whiteboards, design files |
| **Project Calendar** | Shared calendar (`calendars.kind = 'project'`, `calendars.project_id`) | Milestones, releases, demos, project meetings, team availability & capacity overlay |

### 3.2 Creating a project or promoting a channel

- **Who can create a project:** any workspace member (unless an owner restricts project creation to admins via `project_creation` setting; default `everyone` **(default)**). The creator becomes the first **Project Lead**.
- **Properties:**
  - **Name:** 1–80 characters (e.g. `Checkout Redesign`).
  - **Key:** 2–8 uppercase ASCII letters (`A–Z`, starting with a letter, e.g. `CHK`, `ENG`, `DESIGN`), unique across the workspace (including a 30-day hold after purge, and checked against `issue_key_aliases`). Suggested automatically from the name.
  - **Visibility:** `public` (visible and readable by every workspace member; `general_access = 'workspace_view'` by default, or `'workspace_comment'` / `'workspace_edit'`) or `private` (`general_access = 'restricted'`; visible only to project members).
  - **Summary & description:** short summary (up to 280 characters) and rich-text charter/overview on the Overview tab.
  - **Icon & colour:** emoji or icon + accent colour (inherited by the project calendar and badge).
  - **Status:** `planning`, `active` (default), `on_hold`, `completed`, `archived` **(default)**.
  - **Target date:** optional overall target completion date (`YYYY-MM-DD`).
- **Promote an existing channel to a project:**
  - Any channel admin (or workspace admin for a public channel) can click **Turn into project…** on a standard public or private channel (not `#general`, DMs or group DMs).
  - The existing channel becomes the project's dedicated channel (`channels.project_id = project.id`).
  - Current channel members become project members (channel admins → **Project Lead**, channel members → **Editor**).
  - The channel's existing folder in the Channels drive is migrated into the new **Project Drive** (preserving all documents, whiteboards, files and explicit item grants).
  - If the channel already had a channel calendar, it becomes the **Project Calendar**; otherwise one is created.

### 3.3 Unified permissions and roles

A project has a single membership and grant list (`resource_grants` with `resource_type = 'project'`, plus `projects.general_access`). Principals can be **users**, **groups** or **channels** ([Permissions §3.3](permissions.md)).

To keep access effortless and predictable, a member's effective role on the project automatically governs all four surfaces:

| Project role | Stored grant value | Issues & Board | Project Channel | Project Drive (Docs, Boards, Files) | Project Calendar | Project Memory & Pulse |
|---|---|---|---|---|---|---|
| **Project Lead** | `owner` | Full control: configure columns, labels, milestones, settings, archive, delete; edit/delete any issue or comment | Channel admin | Drive manager (full editor + manage) | Calendar owner / editor | Add, edit, confirm, delete memories; configure Pulse |
| **Editor** | `editor` | Create, edit, move, assign, close issues; delete own issues **(default)**; comment | Channel member (can post, reply, call) | Editor on drive root | Calendar editor (create/edit project events, milestones, demos, releases) | Add, edit, confirm memories; ask Butler |
| **Commenter** | `commenter` | View issues; comment and react; create issues in `triage`/`backlog` **(default)** | Channel member (can post and reply) | Commenter on drive root | Calendar viewer (details) | View memories; ask Butler |
| **Viewer** | `viewer` | Read-only (view board, list, issues, comments) | Public project: can read and join call; Private project: read-only member (`can_post = 0`) | Viewer on drive root | Calendar viewer (details) | View memories; ask Butler |
| **No role** | — | Nothing (or request access) | Public: see in browser; Private: hidden | Hidden (unless an individual doc/file is shared) | Nothing | Nothing |

- **Union inheritance ([Permissions §5.1](permissions.md)):**
  - An item inside the Project Drive (a document, whiteboard, folder or file) still supports explicit item-level or folder-level grants that **widen** access (for example, sharing one design spec with an outside group as `viewer` without adding them to the whole project).
  - Changing a member's project role or `projects.general_access` immediately updates their effective access across the `ProjectRoom` DO, `ChatChannel` DO, open `DocRoom` / `BoardRoom` DOs in the project drive, and calendar queries via `updateAccess(userId, role | null)` ([Platform §12](platform.md)).
- **Public → Private conversion:** a Project Lead can convert a public project to private (never private → public, matching channels). As in [Permissions §5.4](permissions.md), the conversion dialog lists any items in the project drive that have explicit wider shares so the Lead can restrict them with one click. Audited.
- **Workspace admins:** follow the exact privacy rules in [Permissions §6](permissions.md). Admins see that private projects exist (name, key, member count, storage size) and can archive or delete them or remove members, but **cannot read** private project issues, channel messages, docs or Project Memory unless a project member grants them access. An admin granting **themselves** access to a private project needs an **owner** and is audited.

---

## 4. Issues, Personal Tasks & Workflow

### 4.1 Unified work-item fields

Every project issue and personal task is a row in `issues` (authoritative in its `ProjectRoom` DO, mirrored to D1 `issues`):

| Field | Type / Values | Notes |
|---|---|---|
| `id` | ULID | Immutable primary key |
| `project_id` | ULID or `NULL` | `NULL` for personal/ad-hoc tasks |
| `key` | `ENG-42` or `TASK-12` | Sequential per project (or per workspace for `TASK-n`). Permanent aliases kept on move. |
| `title` | 1–500 chars | Required |
| `description` | Rich-text JSON + plain text | Markdown shortcuts, code blocks, tables, mentions, `#channel`, `ENG-42` chips, and live Officebox embeds (messages, docs, whiteboards, events). Max 40 KB text / 100 KB state **(default)**. |
| `status_id` | Column ID | Maps to one of the 5 status categories (§4.2) |
| `status_category` | `backlog` · `unstarted` · `started` · `completed` · `cancelled` | Denormalised from the column for fast cross-project queries and inbox resolution |
| `priority` | `urgent` · `high` · `medium` · `low` · `none` | Default `none` |
| `assignee_id` | User ID or `NULL` | One primary assignee. `needs_reassignment` flag set if assignee is disabled/deleted. |
| `reviewers` | List of `{ userId, state, updatedAt }` | Optional reviewers (`pending` · `approved` · `changes_requested`) |
| `creator_id` | User ID | "Former member" on account deletion |
| `parent_id` | Issue ID or `NULL` | Optional parent issue (max depth 1; a sub-issue must belong to the same project as its parent) |
| `milestone_id` | Milestone ID or `NULL` | Project milestone (§7.1) |
| `labels` | List of Label IDs | Project-scoped or workspace-wide labels (up to 20 per issue **(default)**) |
| `start_date` | `YYYY-MM-DD` or `NULL` | Optional scheduled start date |
| `due_date` | `YYYY-MM-DD` or `NULL` | Optional target due date |
| `effort_days` | Number or `NULL` | Optional simple effort in working days (`0.5` to `100`, in `0.5` increments **(default)**) for capacity planning (§7.2) |
| `board_order` | Float / LexoRank | Fractional index for deterministic ordering within a column or parent |
| `source_link` | `{ objectType, objectId }` or `NULL` | Provenance when created from a chat message, document or call note |
| `version` | Integer | Incremented on every change; used for `expectedVersion` compare-and-set |

### 4.2 Configurable workflow columns and status categories

Each project has 3 to 12 workflow columns **(default)**, configured by Project Leads. Every column belongs to one of **five fixed status categories**:

| Category | Meaning | Default columns created with a new project | Auto-resolution & metrics behaviour |
|---|---|---|---|
| `backlog` | Triage / icebox / not yet committed | **Backlog** | Open; excluded from active board filter if user hides backlog **(default)** |
| `unstarted` | Planned and ready to start | **Todo** | Open; counts toward milestone remaining effort |
| `started` | Work or review in progress | **In Progress**, **In Review** | Open; counts toward milestone remaining effort |
| `completed` | Done | **Done** | **Closed** (`completed_at` set). Resolves `assignment` and `review_request` inbox items. |
| `cancelled` | Won't do / duplicate | **Cancelled** | **Closed** (`completed_at` set). Resolves `assignment` and `review_request` inbox items. Excluded from velocity/completion totals. |

- **Deleting or merging a column:** a Project Lead deleting a column must choose which remaining column its issues move to. At least one column must exist in `unstarted`, `started`, `completed` and `cancelled` **(default)**.
- **Personal tasks** (`project_id IS NULL`) use the fixed default columns (*Todo*, *In Progress*, *Done*, *Cancelled*).

### 4.3 Sub-issues, checklists and issue relationships

Officebox provides two ways to break down an issue, plus cross-issue links:

1. **Checklists (inside an issue):**
   - Lightweight to-do items (`issue_checklist_items`: `id`, `issue_id`, `text`, `checked`, `assignee_id?`, `due_date?`, `sort_order`).
   - Shown on the issue detail view with a progress pill on the board card (`3/5`).
   - Any checklist item can be **converted to a sub-issue** in one click.
2. **Sub-issues (one level of hierarchy):**
   - Full issues with `parent_id` pointing to a top-level issue in the same project.
   - A sub-issue has its own key (`ENG-43`), status, assignee, reviewers, due date and effort, and can be viewed on the board or collapsed under its parent.
   - **No infinite nesting:** an issue that has sub-issues cannot itself be made a sub-issue of another issue, and a sub-issue cannot have sub-issues.
   - **Effort roll-up:** if a parent issue has no `effort_days` of its own, its effective effort is the sum of its open sub-issues' `effort_days`; if the parent also has an explicit `effort_days`, the UI shows both the parent estimate and the sub-issue sum so nothing is double-counted in capacity math (**sub-issues win when present (default)**).
   - Completing all sub-issues prompts (or badges) to complete the parent issue, without auto-closing it silently **(default)**.
3. **Issue relationships (`issue_relations`):**
   - `blocks` / `blocked_by` (directional; an open blocking issue badges the blocked issue with a red **Blocked by ENG-19** indicator on the board and in Today/My Work)
   - `relates_to` (symmetric)
   - `duplicate_of` (directional; marking A as a duplicate of B moves A to `cancelled` and links it to B **(default)**).
   - Cross-project relations are allowed. **Permission rule:** if a viewer cannot read the linked issue's project, they see only **"Private issue"** (never the key, title, status or assignee; [Permissions §7](permissions.md)).

### 4.4 Personal & ad-hoc tasks (`TASK-n`)

Not every piece of work belongs to a project immediately:
- Creating a task from **My Work**, the Personal Inbox or the quick switcher (`Cmd/Ctrl+K` → *New task*) with **no project selected** creates a personal task (`project_id = NULL`, key `TASK-12`).
- **Default access:** private to the creator (`creator_id`). Nobody else—including admins—can see it unless the creator assigns it to someone, adds a reviewer, or shares it via `resource_grants` (`resource_type = 'issue'`).
- **Assigning or sharing a personal task:** assigning a personal task to a colleague (or adding them as a reviewer) automatically grants them `editor` access on that task so they can view, comment and update its status.
- **Promoting to a project (or moving an issue between projects):** any editor of a personal task or issue (who also has `editor` access to the target project) can move it via `POST /issues/:id/move`. Because issues live in per-project `ProjectRoom` DOs (and `ProjectRoom("personal")` for personal tasks), moving an issue at `version = V` runs a 3-step cross-DO transfer:
  1. **Freeze on source DO:** sets `moved_to_project_id` on the source `ProjectRoom` row (and any sub-issues) at `version = V`, refusing further writes on the source DO.
  2. **Import on target DO:** allocates the next sequential key in the target `ProjectRoom` (e.g. `ENG-88`), imports the issue (and its sub-issues, checklists, reviewers, comments and activity, plus an `issue_activity` `'moved'` entry) at `version = V + 1`, and emits a `project-projection` outbox upsert—which updates `issues` in D1 (satisfying `WHERE excluded.version > issues.version`) and records `TASK-12 → ENG-88` in `issue_key_aliases` so old links redirect.
  3. **Clean up source DO:** deletes the frozen row(s) from the source `ProjectRoom` SQLite *without* emitting a D1 delete projection.
  - Moving switches inherited access to the target project's access (keeping any explicit grants on the issue itself, with a confirmation prompt if people gain or lose access, matching [Permissions §5.3](permissions.md)).

### 4.5 Document checklists vs. Issues

- Task lists (`- [ ] ...`) inside Tiptap documents ([Documents §4.1](documents.md)) stay lightweight document content—they do **not** create database rows in `issues` automatically.
- Hovering or selecting a `[ ]` item (or any text selection) in a document offers **Create issue…** (or **Promote to issue**):
  - Opens the quick-create popover pre-filled with the item's text, defaulting to the document's containing Project (if the document is in a Project Drive) or the user's Personal Tasks.
  - Replaces or appends a live issue chip (`ENG-42`) on that line in the document, and stores an `object_links` backlink from the issue to the document.

### 4.6 Comments, mentions and activity log

- **Comments:** every issue has a comment thread (`issue_comments`), using the same rich-text format, `@person` / `@group` mentions, reactions and inline file attachments as Chat.
- **Attachments on issues and comments:** files uploaded into an issue description or comment are **issue-owned** (`files.parent_type = 'issue'`, `files.parent_id = issue.id`), inherit the issue's access, and can be saved to the Project Drive via **Save to folder**.
- **Moderation:** authors can edit or delete their own comments; Project Leads and workspace admins (on projects they can access) can delete any comment (audited).
- **Issue activity timeline (`issue_activity`):** every state transition (created, status changed, priority changed, assigned/unassigned, reviewer added/decided, milestone changed, effort/due date changed, moved project, linked/unlinked) is recorded in chronological order alongside comments.

---

## 5. Views & Realtime Interaction

### 5.1 Inside a Project (5 tabs + split-pane chat)

Opening a project shows the **Project Header** (icon, name, key, status pill, live presence avatars of members currently viewing the project, an **Active Call** badge if a call is running in the project channel, and a **Toggle Chat** button that opens the project channel as a side-by-side split pane alongside any tab):

1. **Overview (Pulse):**
   - **Project Charter & Links:** description, Project Leads, pinned documents/whiteboards from the Project Drive, and key links.
   - **Live Pulse summary:** completion progress bar, milestone countdowns, newly blocked or overdue issues, **"Needs reassignment"** alerts (if a member was disabled/deleted), and the latest Project Pulse update from Butler (§8.1).
   - **Project Memory panel:** active decisions, risks, conventions and status notes, plus any `pending` items proposed by Butler awaiting Lead/Editor confirmation (§8.2).
2. **Issues:**
   - **Kanban Board** (built with `dnd-kit`, MIT, per PRD §5.6): columns by status (or grouped by Priority, Assignee, Milestone or Label). Supports multi-select, drag-and-drop reordering and column moves, keyboard moves (`Space` to lift, arrow keys to move, `Space` to drop; WCAG 2.5.7 single-pointer **Move to…** menu on every card), and live cursors/card highlights when a teammate is dragging or editing an issue.
   - **List / Table view:** fast keyboard-navigable (`j`/`k` or arrow keys, `x` to select, `s` status, `p` priority, `a` assignee, `m` milestone, `l` label, `e` effort, `c` new issue; single-key shortcuts respect `user_preferences.shortcuts.singleKey`).
   - **Filters & Search:** filter by status category, column, assignee, reviewer, priority, label, milestone, due date, blocked state, or full-text search within the project. Filter URLs are shareable.
3. **Calendar & Capacity:**
   - Month, week, timeline/horizon and agenda views of the **Project Calendar**, overlaying milestones, releases, demos, project meetings, issue due dates, and team members' time off and regional public holidays, plus the **Capacity Planner** bar (§7).
4. **Docs & Files:**
   - Embedded view of the **Project Drive** ([Documents §3](documents.md)): folders, collaborative Tiptap documents, Excalidraw whiteboards and versioned files belonging to this project. Creating a doc or whiteboard here automatically places it in the project drive.
5. **Channel:**
   - Full view of the project's dedicated `ChatChannel` (also accessible in the main Chat sidebar and as a split-pane drawer on tabs 1–4).

### 5.2 Workspace-wide views

- **My Work:** a top-level navigation item showing:
  - **Assigned to me:** open issues and personal tasks assigned to the user, grouped by *Overdue*, *Due today*, *In progress*, *Upcoming* and *No due date*.
  - **Review requests:** issues where the user is an active reviewer (`state = 'pending'`).
  - **Personal tasks:** the user's projectless `TASK-n` items (with quick inline creation).
  - **Created by me / Following:** issues the user created or follows.
- **All Projects directory:** browse and search all public projects and private projects the member belongs to, showing status, lead, target date, progress bar and recent pulse timestamp.

---

## 6. How Projects Feel Alive (Cross-Workspace Continuity)

### 6.1 Curated project channel activity (no spam)

A project's channel should feel like the heartbeat of the project without drowning human conversation in robotic field-edit logs.

- **Posted to the project channel** (as compact, grouped system/project cards from `sender_id = 'system'`, message kind `project_event`, configurable per project in Project Settings):
  - **Issue created or completed** (batched over a **2-minute window (default)** if someone bulk-creates or bulk-closes several issues: *"Ana completed 4 issues in Milestone Beta"*).
  - **Issue blocked** (when a `blocks` relation is added or an issue is flagged blocked).
  - **Milestone, Release or Demo** created, reached or date-shifted.
  - **Project Pulse** posted by the Project Lead or Butler (§8.1).
- **Never posted to the project channel** (recorded only in the issue's own activity timeline and delivered to relevant individuals' inboxes):
  - Priority, effort, label, description or due-date edits.
  - Moving an issue between intermediate columns (e.g. *Todo* → *In Progress*), unless the project lead explicitly turns on verbose board notifications **(default: off)**.
- **Issue comments:** commenting on an issue stays on the issue; however, a commenter can tick **"Also post to #project-channel"** (matching thread replies' "also send to channel"), which posts a linked card in the project channel.

### 6.2 Rich `ENG-42` auto-linking and embeds everywhere

- Typing an issue key (`ENG-42` or `TASK-12`) or pasting an issue URL in **any chat message, document, comment, calendar event description or whiteboard note** automatically resolves to a live, permission-checked **Issue Chip**:
  - **Authorised viewer:** shows `[ENG-42 · Fix Safari WebRTC renegotiation · In Progress · @ana]` with a status-category icon that updates live as the issue moves. Hovering or clicking opens a preview popover or side-peek drawer without leaving the conversation or document.
  - **Unauthorised viewer** (private project or private personal task): renders as plain text (or `"Private issue"` if pasted as a link), leaking **zero metadata** (not even whether `ENG-42` exists, its title, status or assignee; [Permissions §7](permissions.md)).
- **Automatic backlinks (`object_links`):** mentioning `ENG-42` in a channel message, document or calendar event automatically records a link (`object_links`). Opening `ENG-42` shows a **Linked activity** section listing every message, document, whiteboard and meeting that references it—filtered by the viewing member's permissions.

### 6.3 Contextual actions across Chat, Calls, Docs and Calendar

- **From a Chat message → Create issue:** copies the message text into the issue description, attaches a live reference to the originating message (`source_link`, plus an `object_links` row with `relation = 'created_from'`), and posts a subtle reply indicator under the message (`Created ENG-42`).
- **From an Issue → Start a discussion or call:**
  - **Discuss in channel** starts a linked thread in the project channel anchored to the issue card.
  - **Start call** starts or joins the active call in the project channel (or a dedicated issue call with `context_key = 'issue:<id>'` **(default)**) with the issue pinned in the call context.
- **From Call Notes → Action items to Issues:** when Butler finishes call notes ([Assistant §12.3](assistant.md)), each suggested action item offers **"Create issue"** alongside "Add to my reminders", pre-filling the title, assignee and backlink to the call notes.

---

## 7. Project Calendar, Milestones & Capacity Planning

### 7.1 Project calendar event types and Milestones

Every project has a dedicated calendar (`calendars.kind = 'project'`). In addition to standard meetings (`event`) and `deadline` items ([Calendar §4.1](calendar.md)), project calendars and the `project_milestones` table support:

| Item | Stored in | What it represents |
|---|---|---|
| **Milestone** | `project_milestones` (mirrored as a calendar marker on the project calendar) | A named target checkpoint (`M1 Alpha`, `Launch`) with an optional `start_date`, `target_date` (`YYYY-MM-DD`), description and status (`open`, `completed`). Issues link to it via `issues.milestone_id`. |
| **Release** | `events` (`type = 'release'` on the project calendar) | A planned version or deployment date/window, optionally linked to a Milestone. |
| **Demo / Review** | `events` (`type = 'demo'` on the project calendar) | A scheduled live demo or milestone review meeting (with an automatic event call link and linked milestone/issues). |
| **Project meeting** | `events` (`type = 'event'` on the project calendar) | Standups, planning, retros or design reviews. |

### 7.2 Team availability overlay (holidays, time off, working hours)

Because a project has a defined member list (Lead + Editors; Commenters and Viewers are excluded from capacity math by default unless toggled on as contributors **(default)**), the Project Calendar and Milestone planner automatically overlay:
1. **Declared time off** (`time_off` from [Calendar §7](calendar.md)): shown as "Away" bars for project contributors. As required by [Permissions §4.4](permissions.md), only the **dates** are visible; the time-off type and private note are never exposed.
2. **Regional public holidays** ([Calendar §6](calendar.md)): computed locally for each project contributor's profile `region`, plus workspace **company holidays**.
3. **Working hours & working days** (`users.working_hours` and `users.timezone` from [Identity §4.7](identity.md)): used to determine which weekdays a member works (default Mon–Fri, 5 days/week).

### 7.3 Deterministic capacity calculation

For any **Milestone** (from $d_1 = \max(\text{today}, \text{milestone.start\_date})$ to $d_2 = \text{milestone.target\_date}$) or any chosen **date window** $[d_1, d_2]$ on the Project Calendar (e.g. "Next 2 weeks", "November 2026"):

1. **Available working days per contributor ($A_u$):**
   - If $d_1 > d_2$ (for example, an overdue milestone where `target_date < today`), $\text{Available Days}(u, [d_1, d_2]) = 0$.
   - Otherwise:
   $$\text{Available Days}(u, [d_1, d_2]) = \sum_{d \in [d_1, d_2]} \mathbb{I}(\text{isWorkingDay}(u, d) \land \neg\text{isPublicOrCompanyHoliday}(u, d) \land \neg\text{isOnTimeOff}(u, d))$$
   Half-day time off (if supported later) subtracts `0.5`; full-day time off or holiday subtracts `1.0`.
2. **Assigned effort per contributor ($E_u$):**
   - Sum of `effort_days` for all **open** issues (`status_category IN ('backlog', 'unstarted', 'started')`) assigned to $u$ that belong to the milestone. For an arbitrary calendar date window $[d_1, d_2]$, an open issue's `effort_days` is attributed to $[d_1, d_2]$ if its `due_date` (or its milestone's `target_date`) falls in $[d_1, d_2]$, or pro-rated across its working days overlapping $[d_1, d_2]$ when both `start_date` and `due_date` are set **(default)**.
   - If an open parent issue has **any non-trashed sub-issues (open or completed) with effort estimates**, the sub-issues govern effort roll-up and only its *open* sub-issues' `effort_days` are summed per assignee instead of the parent's `effort_days` (so completing all estimated sub-issues leaves `0d` remaining rather than reverting to the parent's `effort_days`, §4.3).
   - Open issues assigned to $u$ in the milestone with **`effort_days IS NULL`** (and no estimated sub-issues) are counted separately as **"N unestimated issues"** rather than silently treated as zero.
3. **Capacity summary & warnings:**
   - **Per-member bar:** shows `Assigned Effort / Available Days` (e.g. `8.5d / 10d available — 2 days off, 1 holiday`), plus unestimated issue count.
   - **Over-allocated warning:** if $E_u > A_u$, the member and milestone show an amber/red warning (`Over-allocated by 2.5d — Ana is away 18–19 Nov`).
   - **Unassigned effort:** open issues in the milestone with `assignee_id IS NULL` are totalled separately against total remaining team capacity.

---

## 8. Butler in Projects: Project Pulse & Shared Project Memory

### 8.1 Project Pulse (Overview & automated status updates)

- **Live Pulse on Overview:** even with AI disabled, the Overview tab deterministically shows completion %, milestone countdowns, recently completed issues, blocked issues, overdue issues and "Needs reassignment" items.
- **Butler Project Pulse (when `assistant_enabled` is on):**
  - A Project Lead or Editor can click **Generate Pulse** on the Overview tab (or enable a **weekly scheduled Pulse draft** every Monday morning / Friday afternoon via a `project_pulse` trigger in `ReminderScheduler`, **off by default (default)**).
  - Butler synthesises changes since the last Pulse across the project's **issues, channel messages, call notes, documents and calendar** (including upcoming milestones, releases, demos and team time-off capacity changes).
  - Butler writes a `project_pulses` row (`status = 'draft'`, `created_by = 'assistant'` for scheduled runs or the invoking member's ID) with a structured status card (**On track / At risk / Off track**, key accomplishments, active blockers, upcoming dates & capacity risks) for a Project Lead or Editor to review, edit and **Publish to project Overview & `#project-channel`** (`status = 'published'`). It never posts to the channel without human confirmation unless the Project Lead explicitly sets `pulse_schedule.autoPost = true` **(default: confirm before posting)**.

### 8.2 Shared Project Memory (`project_memories`)

While personal memory ([Assistant §4.2](assistant.md)) lives inside each member's private `Assistant` DO and is never shared, a project has a **shared, transparent Project Memory** stored in D1 (`project_memories`):

| Aspect | Rule |
|---|---|
| **What it holds** | Short, structured project facts in four categories (`category`): **`decision`** ("Agreed to use Stripe Checkout v3 for the MVP — 14 Nov"), **`risk`** ("Vendor API rate limit may bottleneck bulk imports"), **`convention`** ("All migration PRs require expand/contract tests"), and **`context`** ("Target beta customer is Acme Corp"). |
| **Who can see it** | Every member who has at least **Viewer** access to the project. Displayed openly on the Project Overview tab. |
| **Who can add, edit, confirm or delete** | Project **Leads** and **Editors** directly from the Overview UI, or by telling Butler in the project channel / project assistant surface. Commenters and Viewers can read `active` memories but cannot propose, confirm, edit or delete them. |
| **How Butler proposes items (prompt-injection safe)** | When Butler summarises project call notes, answers an `@Butler` mention from a Project **Lead or Editor** in the project channel, or reviews a project document, it can propose new Project Memory items (at most **3 items per turn or call-notes run (default)**). **Every AI-proposed or source-derived item is created with `status = 'pending'`** (rule 4 of [Assistant §1](assistant.md): workspace content and transcripts are untrusted). A Project Lead or Editor must click **Confirm** on the Project Overview (or on a private DM confirmation card for an untainted turn) to make it `active`. `pending` items are never indexed in `search_index` or Vectorize and never recalled into prompts. |
| **Strict isolation from Personal Memory** | Generating or updating Project Memory **never** reads any member's private `Assistant` DO memory or private DMs. Conversely, when a member asks Butler a question in their private Assistant DM about a project they have access to, Butler can read that project's `active` Project Memory alongside their own personal memory. |
| **Audience safety in `@Butler` channel mentions** | When `@Butler` is mentioned in a project's channel, the audience is the project channel's members. Because project channel membership is locked to project grants (§3.3) so every member of the project channel has at least Viewer access to the project, `@Butler` in a project channel **can** use the project's issues, project drive root documents, project calendar (non-private events) and `active` Project Memory. It still **never** uses any member's private personal memory or items outside the project audience's access. |
| **Source tracking, Trash hiding & automatic purge** | Each `project_memories` row records its citing sources in `project_memory_sources (memory_id, object_type, object_id)`. When a cited document or issue moves to **30-day Trash**, any `project_memories` row citing it is immediately hidden from the Project Overview, `search_index` and Vectorize while the source is in Trash (and restored if the source is restored). When a cited message, document, call note or issue is deleted/purged, the deletion pipeline **immediately deletes** the dependent `project_memories` row (and its FTS5 and Vectorize entries) so deleted content never survives in Project Memory. |

### 8.3 Butler tools for Projects & Issues

Added to the tool catalogue in [Assistant §5](assistant.md):

| Tool | Kind | Private DM (`Assistant` DO) | Shared `@Butler` in Project Channel | Notes |
|---|---|---|---|---|
| `search_issues` | read | ✓ (across all projects & personal tasks the member can open) | ✓ (this project's issues only) | Filters by project, status category, assignee, reviewer, priority, label, milestone, due date, blocked, text |
| `get_project_pulse` | read | ✓ (if member can view project) | ✓ (this project) | Returns live metrics, blockers, milestones, recent completions and active `project_memories` |
| `check_project_capacity` | read | ✓ (if member can view project) | ✓ (this project) | Computes available days vs. assigned effort for a milestone or date range (§7.3), using free/busy + declared time-off dates + public holidays |
| `create_issue` | **write** | ✓ (confirmed via preview card) | ✗ (offers "Ask me privately" / quick-create button) | Creates a project issue or personal task (`idempotency_key` honoured) |
| `update_issue` | **write** | ✓ (confirmed via preview card, with `expectedVersion`) | ✗ | Updates status, priority, assignee, reviewers, due date, effort, milestone or parent (`idempotency_key` + `expectedVersion` honoured) |
| `comment_on_issue` | **write** | ✓ (confirmed via preview card) | ✗ | Posts a comment on an issue the member can comment on |
| `propose_project_memory` | **write** | ✓ (requires Lead/Editor on project; confirmed via preview card → saves `active` if untainted, or `pending` if tainted) | ✓ (requires asker to be Lead/Editor on project; stages a `pending` suggestion on the Project Overview, max 3 per turn, never `active` without human confirmation) | Records a decision, risk, convention or context note (`idempotency_key` honoured) |

---

## 9. Notifications & Personal Inbox Integration

### 9.1 Notification events

This activates the `assignment` and `review_request` event types reserved in [Notifications §3](notifications.md) and adds project-specific events:

| Event type | Source | Recipients | Default delivery | Dedupe / grouping key | Resolves when |
|---|---|---|---|---|---|
| `assignment` | Assigned an issue or personal task (or an assigned issue is reopened) | The assignee (never the actor themselves) | In-app; email after delay | `assignment:<issueId>` | The issue moves to `completed` or `cancelled`, is reassigned to someone else, or is marked done in the inbox (opening marks `read` without resolving the action item) |
| `review_request` | Added as a reviewer on an issue | The requested reviewer | In-app; email after delay | `review_request:<issueId>` | The reviewer submits `approved` or `changes_requested`, is removed as reviewer, or the issue closes (opening marks `read` without resolving the action item) |
| `issue_review_decided` | A reviewer approves or requests changes on an issue | The issue's assignee (or creator if unassigned) | In-app; email **(default)** | `issue_review_decided:<issueId>` | The recipient opens the issue |
| `issue_mention` | `@person` or `@group` in an issue description or issue comment | Mentioned members who have access to the issue | In-app; email after delay | `issue_mention:<issueId>:<commentOrDescId>` | The member opens the issue |
| `issue_comment` | New comment on an issue | Issue followers (creator, assignee, reviewers, prior commenters, explicit followers), except the author and mentioned users (who get `issue_mention`) | In-app; email **(default)** | `issue_comment:<issueId>` (one record per issue, with a count) | The member opens the issue |
| `issue_status` | An issue you follow or are blocked by is completed, cancelled or reopened | Issue followers and assignees of issues blocked by this issue (excluding the actor) **(default)** | In-app only **(default)** | `issue_status:<issueId>` | The member opens the issue or dismisses it |
| `issue_due_soon` | An open issue assigned to you is due today (fires at start of working hours via `ReminderScheduler` `issue_due`) | The assignee | In-app; email if chosen **(default)** | `issue_due_soon:<issueId>:<dueDate>` | The issue is completed/cancelled, its due date changes, or it is dismissed |
| `issue_needs_reassignment` | An open issue's assignee was disabled or deleted | Project Leads of the project | In-app; email **(default)** | `issue_needs_reassignment:<issueId>` | A new assignee is set or the issue is closed |

- **Privacy in offline emails ([Notifications §6](notifications.md)):**
  - For **private projects** and **personal tasks**, email notifications include **no issue title or comment text** by default (only *"Ana assigned you an issue in a private project"* or *"2 new comments on an issue"*), unless the recipient has enabled `email_include_private_text`.
  - For **public projects**, the issue key, title and comment excerpt are included **(default)**.

### 9.2 Personal Inbox views (PRD §5.3)

- **Today:**
  - Group 1 (*Action items due today or overdue*) automatically includes open issues and personal tasks assigned to the user whose `due_date <= today`, plus newly unblocked or blocked issues due today.
  - Group 2 (*Direct messages and mentions*) includes `issue_mention`.
  - Group 3 (*Review requests*) includes pending `review_request` items.
  - Group 4 (*Other action items*) includes `assignment` and `issue_needs_reassignment`.
  - Group 5 (*Followed activity*) includes `issue_comment`, `issue_status` and `issue_review_decided`.
- **Upcoming:** lists assigned issues with upcoming `due_date`s alongside calendar events and personal reminders.
- **Assigned to me:** lists all open `assignment` and `review_request` items across projects and personal tasks.

---

## 10. Lifecycle, Archiving, Deletion & Cascades

### 10.1 Archiving vs. Deleting a Project

| Action | Who can do it | What happens |
|---|---|---|
| **Archive project** | Project Lead, Workspace Admin | `projects.status` becomes `'archived'`, `archived_at` set. The project board/issues, project channel, project drive and project calendar all become **read-only**. Open polls in the channel close; active channel and issue calls end. Issues stay searchable (with an "Archived" filter). **Reversible** at any time by a Project Lead or Admin (**Unarchive** restores everything to active). Audited (`project.archive` / `project.unarchive`). |
| **Delete project (to Trash)** | Project Lead, Workspace Admin | `deleted_at` and `purge_after` (+30 days) set on the project, its channel, its drive and its calendar; active channel and issue calls end. Hidden from normal views, boards, My Work, calendar overlays, search and AI retrieval. Open `assignment` and `review_request` inbox items for its issues are hidden while in Trash. **Restorable for 30 days** by a Project Lead, the person who deleted it, or a Workspace Admin (canonical Trash rule, [Platform §5](platform.md)). Restoring brings back the project, channel, drive, calendar, issues and Project Memory intact. Audited (`project.delete` / `project.restore`). |
| **Purge project (after 30 days in Trash)** | Daily purge pipeline | 1. **Project Drive contents preserved:** every non-trashed document, whiteboard and drive file inside the Project Drive **moves to its creator's My files** (or to an admin's My files if the creator was deleted), keeping its explicit item grants and removing project-inherited access—matching the channel-purge rule ([Platform §4](platform.md)). The empty Project Drive and its folders are then deleted.<br>2. **Project Calendar purged:** project milestones are deleted; any standard meeting events on the project calendar with attendees **move to their organiser's personal calendar** (or are deleted with `event_cancel` if the organiser is deleted, matching [Platform §4](platform.md)).<br>3. **Project Channel purged:** `ChatChannel` DO `deleteAll()`, D1 messages copy, message-owned files in R2, call notes and transcripts deleted.<br>4. **Issues & ProjectRoom purged:** `ProjectRoom` DO `deleteAll()`, D1 `issues`, `issue_reviewers`, `issue_relations`, `issue_follows`, `issue_key_aliases`, `project_milestones`, `project_labels`, issue-owned R2 attachments and their `file_derived_text` / vectors, and issue-call `huddle_messages`, `call_notes` and `call_transcript_segments` (with their vectors) deleted.<br>5. **Project Memory & Assistant purge:** `project_memories`, `project_memory_sources`, `project_pulses` and their vectors are deleted, and `assistant-purge` jobs are enqueued via `assistant_source_refs` for any member whose personal Assistant memory cited an issue, project memory, doc or message from the project ([Platform §4](platform.md)). |

### 10.2 Deleting a single Issue or Personal Task

- **Who can delete an issue (to Trash):**
  - Project issues: **Project Leads**, **Workspace Admins** (on projects they can access), and the **issue's creator** (if they are still an Editor on the project **(default)**).
  - Personal tasks: the **creator** (owner).
- **30-day Trash:** deleting an issue moves it (and any sub-issues under it) to Trash for 30 days (`deleted_at`, `purge_after`), ends any active call on the issue, removes it from search, Vectorize and active boards, hides any `project_memories` citing it while in Trash, and resolves its inbox items. Restorable under the canonical rule.
- **Purge:** after 30 days, the issue, its comments, checklist items, reviewers, activity, relations, key aliases, issue-owned files in R2, issue-call `huddle_messages`, `call_notes` and `call_transcript_segments` (with their vectors), search entries, citing `project_memories` and vectors are permanently deleted, and `assistant-purge` runs for any member's assistant memory citing that issue.

### 10.3 Member Disabled or Deleted ([Platform §3](platform.md))

| Event | Impact on Projects, Tasks & Issues |
|---|---|
| **Member disabled** | - **Open sockets:** any open `ProjectRoom` WebSocket closes immediately with code **`4401`**.<br>- **Assigned project issues:** stay open with `assignee_id` kept, and `needs_reassignment = 1` is set on every open issue assigned to them. An `issue_needs_reassignment` inbox notification is raised for the Project Lead(s), and the issues are highlighted on the Project Overview.<br>- **Pending review requests:** their pending `issue_reviewers` rows are marked `cancelled` so reviews aren't blocked.<br>- **Last Project Lead:** if the disabled member was the **only active Project Lead** on a project, the longest-standing active **Editor** (or a workspace admin if no Editor exists) is automatically promoted to Project Lead (audited, with a system message in the project channel—matching Chat's last-channel-admin rule).<br>- **Capacity planning:** a disabled member's available days drop to `0` so milestone capacity reflects their absence immediately.<br>- **Personal tasks (`project_id IS NULL`):** kept in their account while disabled; if a personal task was shared/assigned to another active member, that member can still view and complete it. |
| **Member deleted (anonymised)** | Everything for *disabled*, plus:<br>- **Authorship & history:** `issues.creator_id`, `issue_comments.author_id`, `issue_activity.actor_id` and `project_memories.created_by` stay linked to the anonymised user ID and display as **"Former member"**. `@handle` mentions in issue descriptions, comments and D1 search projections are re-rendered as **"Former member"** (via a `ProjectRoom` DO erase task on `ProjectRoom("personal")` and each project `ProjectRoom` DO the member participated in, matching `ChatChannel`).<br>- **Assigned project issues:** `assignee_id` is kept as "Former member" with `needs_reassignment = 1` until a Project Lead reassigns or closes them **(default)**.<br>- **Personal tasks (`project_id IS NULL`):** **open** personal tasks owned by the deleted member are **transferred to an admin** (matching My files in [Platform §3](platform.md)), and **completed/cancelled** solo personal tasks (which have no other participants) are **erased** from `ProjectRoom("personal")` and D1 `issues` **(default)**.<br>- **Follows & preferences:** their `issue_follows` and board filter preferences are erased. |

### 10.4 Export and Restore ([Platform §6](platform.md), [Admin §11–§13](admin.md), TDD §7.5)

- **Workspace export (`workspace.export`):** run by owners and admins ([Admin §11.1](admin.md)), and includes private projects and personal tasks:
  - D1 tables: `projects`, `project_milestones`, `project_labels`, `issues`, `issue_key_aliases`, `issue_reviewers`, `issue_relations`, `issue_follows`, `project_memories`, `project_memory_sources`, `project_pulses`.
  - `ProjectRoom` DO state: `projects/<id>/state.jsonl` (from each project's `ProjectRoom` DO) plus `projects/personal/state.jsonl` (from `ProjectRoom("personal")`), containing authoritative `issues`, `issue_reviewers`, `issue_checklist_items`, `issue_comments` and `issue_activity`, plus each room's exported `seq` and `next_issue_number` in `manifest.json`.
  - Issue-owned attachments in R2 (`files/<file id>`).
- **Per-member export (`member.export`):** run by owners and admins for data-protection requests ([Admin §12](admin.md)); includes issues and personal tasks the subject created or is assigned to, their `issue_reviewers` rows and `issue_follows`, issue comments they wrote, and their issue-owned attachments.
- **Restore:** rebuilds D1 tables in foreign-key order, calls `importProjectState` on each project's `ProjectRoom` DO and on `ProjectRoom("personal")` (preserving `outbox_seq` and `next_issue_number`), and rebuilds `search_index` and Vectorize chunks for `issue` and `project_memory`.

---

## 11. Data Model

### 11.1 `ProjectRoom` Durable Object SQLite (authoritative for issues & board)

One `ProjectRoom` Durable Object per project (`idFromName(projectId)`), plus one workspace-wide instance `idFromName("personal")` for personal tasks (`project_id IS NULL`), extending the core DO base class (AGENTS §4.2: `meta`, `core_timers`, `core_outbox` and `core_outbox_dead` from TDD §2.2, lazy schema migration in `blockConcurrencyWhile`, single multiplexed alarm, WebSocket hibernation). Supports `updateAccess(userId, role | null)` for live role changes, `closeConnections(userId, reason, scope)` for revocation, and `setMaintenance(epoch, active)` (plus lazy `maintenance_epoch` check before any refused write, returning `maintenance` during a maintenance window per [Admin §13.2–§13.3](admin.md)):

```sql
-- Core base tables (meta, core_timers, core_outbox, core_outbox_dead) are owned by the base class (TDD §2.2).
-- meta keys used by ProjectRoom:
--   schema_version, config_version, project_config (JSON: key, visibility, archived, columns, members/roles),
--   next_issue_number (monotonic counter: 1, 2, ... for project issues or workspace TASK-<n>),
--   outbox_seq (monotonic event sequence projected to projects.projected_seq in D1; for ProjectRoom("personal"), reconciliation checks core_outbox depth directly).

CREATE TABLE issues (
  id TEXT PRIMARY KEY,
  project_id TEXT,                   -- NULL for personal tasks (in ProjectRoom("personal"))
  number INTEGER NOT NULL,           -- sequential number in project (or workspace for TASK-n)
  key TEXT NOT NULL,                 -- e.g. 'ENG-42' or 'TASK-12'
  title TEXT NOT NULL,
  description_json TEXT NOT NULL,    -- ProseMirror rich-text JSON
  description_text TEXT NOT NULL,    -- plain-text copy for search/previews
  status_id TEXT NOT NULL,
  status_category TEXT NOT NULL,     -- 'backlog' | 'unstarted' | 'started' | 'completed' | 'cancelled' (Zod)
  priority TEXT NOT NULL DEFAULT 'none', -- 'urgent' | 'high' | 'medium' | 'low' | 'none' (Zod)
  assignee_id TEXT,
  needs_reassignment INTEGER NOT NULL DEFAULT 0,
  creator_id TEXT NOT NULL,
  parent_id TEXT REFERENCES issues(id) ON DELETE SET NULL,
  milestone_id TEXT,
  labels_json TEXT NOT NULL DEFAULT '[]',
  start_date TEXT,                   -- YYYY-MM-DD
  due_date TEXT,                     -- YYYY-MM-DD
  effort_days REAL,                  -- e.g. 0.5, 1, 2.5
  board_order TEXT NOT NULL,         -- LexoRank / fractional order key
  source_link_json TEXT,             -- JSON { objectType, objectId }
  moved_to_project_id TEXT,          -- set while an issue move across DOs is in flight (§4.4)
  idempotency_key TEXT,              -- 24h dedupe for Assistant / client retries
  version INTEGER NOT NULL DEFAULT 1,
  completed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  purge_after INTEGER
);
CREATE INDEX issues_status_order ON issues(status_id, board_order) WHERE deleted_at IS NULL;
CREATE INDEX issues_parent ON issues(parent_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX issues_creator_idem ON issues(creator_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE issue_reviewers (
  issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'approved' | 'changes_requested' | 'cancelled' (Zod)
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (issue_id, user_id)
);

CREATE TABLE issue_checklist_items (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  checked INTEGER NOT NULL DEFAULT 0,
  assignee_id TEXT,
  due_date TEXT,
  sort_order TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE issue_comments (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL,
  format TEXT NOT NULL,              -- ProseMirror JSON
  body TEXT NOT NULL,                -- plain-text copy
  reactions TEXT NOT NULL DEFAULT '{}', -- JSON { emoji: [user IDs] }, max 50 distinct emoji
  client_id TEXT,
  edited_at INTEGER,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX issue_comments_issue ON issue_comments(issue_id, created_at);
CREATE UNIQUE INDEX issue_comments_client ON issue_comments(author_id, client_id) WHERE client_id IS NOT NULL;

CREATE TABLE issue_activity (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL,
  kind TEXT NOT NULL,                -- 'created' | 'status' | 'priority' | 'assignee' | 'reviewer' | 'milestone' | 'effort' | 'due_date' | 'moved' | 'relation' (Zod)
  payload TEXT NOT NULL,             -- JSON { from, to, ... }
  created_at INTEGER NOT NULL
);
CREATE INDEX issue_activity_issue ON issue_activity(issue_id, created_at);
```

- **Outbox projection (`core_outbox`):** every mutation in `ProjectRoom` increments `meta.outbox_seq` and `issues.version` in the same SQLite transaction and appends a message to `core_outbox` (stream `'project-projection'`). The `project-projection` queue consumer upserts D1 `issues` (guarded by `WHERE excluded.version > issues.version`), `issue_reviewers`, `issue_key_aliases` and `search_index`, advances `projects.projected_seq` for project rooms (while `ProjectRoom("personal")` reconciliation checks `core_outbox` depth directly and fans out live personal-task updates to authorised participants' `UserHub`s), and triggers inbox notifications and curated project-channel activity cards.

### 11.2 D1 Schema (Projects, Milestones, Relations, Project Memory & Search Copy)

Added in migration `NNNN_projects_init.sql` (following [Platform §14](platform.md), growable enums are Zod-validated without SQL `CHECK` constraints):

```sql
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,          -- 2-8 uppercase letters, e.g. 'ENG'
  name TEXT NOT NULL,
  summary TEXT,
  description_json TEXT,
  description_text TEXT,
  icon TEXT,
  colour TEXT NOT NULL DEFAULT 'blue',
  status TEXT NOT NULL DEFAULT 'active', -- 'planning' | 'active' | 'on_hold' | 'completed' | 'archived' (Zod)
  general_access TEXT NOT NULL DEFAULT 'workspace_view', -- 'restricted' | 'workspace_view' | 'workspace_comment' | 'workspace_edit' (Zod)
  channel_id TEXT NOT NULL REFERENCES channels(id),
  drive_id TEXT NOT NULL REFERENCES drives(id),
  calendar_id TEXT NOT NULL REFERENCES calendars(id),
  columns_json TEXT NOT NULL,        -- JSON array of { id, name, category, colour, position }
  channel_post_prefs TEXT NOT NULL DEFAULT '{"issueCreated":true,"issueCompleted":true,"issueBlocked":true,"milestones":true,"pulse":true}',
  pulse_schedule TEXT,               -- NULL (off) or JSON { weekday, time, timezone, autoPost?: boolean }
  target_date TEXT,                  -- YYYY-MM-DD
  config_version INTEGER NOT NULL DEFAULT 1,
  projected_seq INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER,
  deleted_at INTEGER,
  purge_after INTEGER
);

CREATE TABLE IF NOT EXISTS project_milestones (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  start_date TEXT,                   -- YYYY-MM-DD
  target_date TEXT,                  -- YYYY-MM-DD
  status TEXT NOT NULL DEFAULT 'open', -- 'open' | 'completed' (Zod)
  calendar_event_id TEXT REFERENCES events(id) ON DELETE SET NULL,
  sort_order TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS project_milestones_project ON project_milestones(project_id, sort_order);

CREATE TABLE IF NOT EXISTS project_labels (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE, -- NULL = workspace-wide label
  name TEXT NOT NULL,
  colour TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- D1 read/search/cross-project projection of issues (populated via ProjectRoom core_outbox)
CREATE TABLE IF NOT EXISTS issues (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id), -- NULL for personal tasks
  number INTEGER NOT NULL,
  key TEXT NOT NULL UNIQUE,          -- 'ENG-42' or 'TASK-12'
  title TEXT NOT NULL,
  description_text TEXT NOT NULL,
  status_id TEXT NOT NULL,
  status_category TEXT NOT NULL,     -- 'backlog' | 'unstarted' | 'started' | 'completed' | 'cancelled' (Zod)
  priority TEXT NOT NULL DEFAULT 'none',
  assignee_id TEXT REFERENCES users(id),
  needs_reassignment INTEGER NOT NULL DEFAULT 0,
  creator_id TEXT NOT NULL REFERENCES users(id),
  parent_id TEXT REFERENCES issues(id) ON DELETE SET NULL,
  milestone_id TEXT REFERENCES project_milestones(id) ON DELETE SET NULL,
  labels_json TEXT NOT NULL DEFAULT '[]',
  start_date TEXT,
  due_date TEXT,
  effort_days REAL,
  board_order TEXT NOT NULL,
  checklist_total INTEGER NOT NULL DEFAULT 0,
  checklist_done INTEGER NOT NULL DEFAULT 0,
  comment_count INTEGER NOT NULL DEFAULT 0,
  blocked_by_count INTEGER NOT NULL DEFAULT 0, -- maintained in D1 from issue_relations where blocker is open
  version INTEGER NOT NULL DEFAULT 1,
  completed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  purge_after INTEGER
);
CREATE INDEX IF NOT EXISTS issues_project_status ON issues(project_id, status_category, board_order) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS issues_assignee ON issues(assignee_id, status_category, due_date) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS issues_milestone ON issues(milestone_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS issue_key_aliases (
  old_key TEXT PRIMARY KEY,          -- e.g. 'TASK-12' or 'OLD-7'
  issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS issue_reviewers (
  issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  state TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'approved' | 'changes_requested' | 'cancelled' (Zod)
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (issue_id, user_id)
);
CREATE INDEX IF NOT EXISTS issue_reviewers_user ON issue_reviewers(user_id, state);

CREATE TABLE IF NOT EXISTS issue_relations (
  id TEXT PRIMARY KEY,
  source_issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  target_issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                -- 'blocks' | 'relates_to' | 'duplicate_of' (Zod)
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  UNIQUE (source_issue_id, target_issue_id, kind)
);
CREATE INDEX IF NOT EXISTS issue_relations_target ON issue_relations(target_issue_id);

CREATE TABLE IF NOT EXISTS issue_follows (
  issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  muted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (issue_id, user_id)
);

-- Shared Project Memory (§8.2)
CREATE TABLE IF NOT EXISTS project_memories (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  category TEXT NOT NULL,            -- 'decision' | 'risk' | 'convention' | 'context' (Zod)
  content TEXT NOT NULL,             -- plain text (up to 1,000 chars)
  status TEXT NOT NULL DEFAULT 'active', -- 'active' | 'pending' (Zod)
  proposed_by_assistant INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  confirmed_by TEXT REFERENCES users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS project_memories_project ON project_memories(project_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS project_memories_idem ON project_memories(created_by, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS project_memory_sources (
  memory_id TEXT NOT NULL REFERENCES project_memories(id) ON DELETE CASCADE,
  object_type TEXT NOT NULL,         -- 'message' | 'document' | 'call_notes' | 'issue'
  object_id TEXT NOT NULL,
  PRIMARY KEY (memory_id, object_type, object_id)
);
CREATE INDEX IF NOT EXISTS project_memory_sources_obj ON project_memory_sources(object_type, object_id);

CREATE TABLE IF NOT EXISTS project_pulses (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'draft', -- 'draft' | 'published' (Zod)
  health TEXT NOT NULL,              -- 'on_track' | 'at_risk' | 'off_track' (Zod)
  summary_json TEXT NOT NULL,        -- ProseMirror JSON
  summary_text TEXT NOT NULL,
  metrics_json TEXT NOT NULL,        -- snapshot of open/completed/blocked/capacity at pulse time
  posted_message_id TEXT,            -- message ID in the project channel when published
  created_by TEXT NOT NULL REFERENCES users(id), -- member ID, or reserved 'assistant' user row for scheduled runs
  created_at INTEGER NOT NULL,
  published_at INTEGER
);
CREATE INDEX IF NOT EXISTS project_pulses_project ON project_pulses(project_id, created_at DESC);
```

- **`blocked_by_count` maintenance in D1:** `issues.blocked_by_count` is owned by D1, not the DO payload. When `project-projection` upserts an issue into D1, it preserves or recomputes `blocked_by_count` from `issue_relations` (`COUNT(*)` of `kind = 'blocks'` where `target_issue_id = issues.id` and the `source_issue_id` has `deleted_at IS NULL AND status_category NOT IN ('completed', 'cancelled')`). When a blocking issue transitions into or out of `completed` / `cancelled` (or is trashed/restored), the consumer updates `blocked_by_count` on every target issue it blocks and raises `issue_status` inbox items when a blocker completes.

### 11.3 Realtime Connection Budget & Room Registry ([Platform §12](platform.md))

- The `ProjectRoom` WebSocket (`/ws/projects/:id`) uses the **same slot in the 6-socket per-tab budget** as the on-screen primary room (`DocRoom` / `BoardRoom`) when viewing a project board/list. If the user opens the split-pane project channel alongside the project board, the channel uses the Channel socket slot and the board uses the Room socket slot—never exceeding the 6-socket cap.
- `UserHub` room registry `kind` gains `'project'`. When a member is disabled (`4401`) or loses access to a project (`4403`), both the durable room registry and the Worker-side fallback call `closeConnections(userId)` or `updateAccess(userId, role | null)` on the `ProjectRoom` DO.

---

## 12. API & WebSocket Protocol

All bodies and WebSocket messages are validated with Zod schemas in `packages/shared` (AGENTS §4.1). Expected denials and validation errors return typed `Result<T, ProjectError>` values (`not_found`, `forbidden`, `conflict`, `key_taken`, `invalid_hierarchy`, `project_archived`, `maintenance`, `validation_error`), never thrown exceptions across DO RPC.

### 12.1 REST Endpoints

| Method and path | Who | Purpose |
|---|---|---|
| `GET /projects` · `POST /projects` | Member | List accessible projects; create a project (auto-provisions channel, drive, calendar and `ProjectRoom`) |
| `POST /channels/:id/promote-to-project` | Channel admin / Admin | Promote an existing channel into a project (§3.2) |
| `GET /projects/:keyOrId` · `PATCH /projects/:id` | Viewer / Lead | Get project overview & config; update settings, columns, status, visibility |
| `POST /projects/:id/archive` · `POST /projects/:id/unarchive` | Lead / Admin | Archive or unarchive the project and its channel, drive and calendar |
| `DELETE /projects/:id` · `POST /projects/:id/restore` | Lead / Admin (plus deleter on restore) | Move project to 30-day Trash or restore it |
| `GET /projects/:id/members` · `PUT /projects/:id/grants` | Viewer / Lead | View or update project role grants (user, group, channel) and `general_access` |
| `GET /projects/:id/capacity?milestoneId=&from=&to=` | Viewer | Compute per-member available days (working hours minus time off & holidays) vs. assigned issue effort (§7.3) |
| `GET /projects/:id/milestones` · `POST /projects/:id/milestones` · `PATCH /projects/:id/milestones/:mid` · `DELETE /projects/:id/milestones/:mid` | Viewer / Editor | List, create, update or delete milestones |
| `GET /projects/:id/memories` · `POST /projects/:id/memories` · `PATCH /projects/:id/memories/:mid` · `POST /projects/:id/memories/:mid/confirm` · `DELETE /projects/:id/memories/:mid` | Viewer / Editor | View, create, edit, confirm (`pending` → `active`) or delete shared Project Memory items |
| `GET /projects/:id/pulses` · `POST /projects/:id/pulses` · `POST /projects/:id/pulses/generate` · `POST /projects/:id/pulses/:pid/publish` | Viewer / Editor | List Project Pulses, create or ask Butler to draft a Pulse (`draft`), or publish a draft Pulse to the Overview & project channel |
| `GET /issues` | Member | Cross-project query (**My Work**, search, filters: `assignee`, `reviewer`, `creator`, `project`, `statusCategory`, `priority`, `dueBefore`, `needsReassignment`) |
| `POST /issues` | Editor (or Commenter for `backlog`; any member for personal tasks) | Create a project issue or personal task (`idempotencyKey` supported) |
| `GET /issues/:keyOrId` · `PATCH /issues/:id` · `DELETE /issues/:id` · `POST /issues/:id/restore` | Viewer / Editor / Lead | Read issue (follows `issue_key_aliases` on old keys); update fields (`expectedVersion` + `idempotencyKey` supported); Trash or restore |
| `POST /issues/:id/move` | Editor on source & target | Move a personal task into a project or an issue between projects (§4.4 cross-DO transfer; creates key alias, updates inherited access) |
| `PUT /issues/:id/reviewers/:userId` · `DELETE /issues/:id/reviewers/:userId` | Editor (add/remove) · Requested reviewer (submit own `approved` / `changes_requested` decision) | Manage reviewers or submit your own review decision |
| `POST /issues/:id/comments` · `PATCH /issues/:id/comments/:cid` · `DELETE /issues/:id/comments/:cid` · `POST /issues/:id/comments/:cid/reactions` | Commenter / Author / Lead | Create, edit, delete or react to an issue comment |
| `POST /issues/:id/relations` · `DELETE /issues/:id/relations/:rid` | Editor | Link or unlink `blocks`, `relates_to` or `duplicate_of` |

### 12.2 `ProjectRoom` WebSocket Protocol (`/ws/projects/:id`)

`/ws/projects/:id` connects to a project's `ProjectRoom` DO (requires at least `viewer` access on the project; `:id = "personal"` is rejected with `forbidden` so multi-tenant personal tasks in `ProjectRoom("personal")` never broadcast across users—live updates for personal tasks are pushed to authorised participants via `UserHub`):

| Client → Server | Server → Client |
|---|---|
| `issue.move { issueId, statusId, boardOrder, expectedVersion? }` | `issue.created { issue }` · `issue.updated { issue, actorId }` · `issue.deleted { issueId }` |
| `issue.quick_update { issueId, patch, expectedVersion? }` | `issue.comment_added { issueId, comment }` · `issue.comment_updated` · `issue.comment_deleted` |
| `checklist.toggle { issueId, itemId, checked }` · `comment.react { issueId, commentId, emoji }` | `project.config_updated { config }` · `access.changed { role }` · `status.changed { maintenance }` |
| `board.focus { issueId \| null }` (ephemeral awareness) | `board.presence { users: [{ userId, activeIssueId }] }` |

---

## 13. Acceptance Criteria

**M10a: Projects, auto-provisioned ecosystem, ProjectRoom DO, issues, personal tasks, list & board**
- [ ] **Auto-provisioning:** creating project `ENG` atomically creates the `projects` row, `#proj-eng` channel, `ENG` project drive (with root folder), `ENG` project calendar and `ProjectRoom` DO.
- [ ] **Promote channel:** promoting an existing channel into a project reuses the channel, migrates its channel-folder documents into the new Project Drive with explicit shares intact, and maps channel admins to Project Leads and members to Editors.
- [ ] **Unified permission matrix & channel lock:**
  - Granting a user, group or channel `editor`, `commenter` or `viewer` on a project grants the corresponding access across the project's issues, channel, drive and calendar. Direct membership or visibility mutations on the underlying project channel are rejected unless routed through project grants.
  - A member without access to a private project receives `forbidden` (or `not_found` where existence is hidden) across REST, `/ws/projects/:id`, search, issue chips and AI retrieval.
  - Downgrading an Editor to Viewer switches their open `/ws/projects/:id`, `/ws/channels/:id` and project-drive `DocRoom` sockets to read-only within 5 seconds; removing them closes the sockets with `4403`.
  - A Workspace Admin who is not a member of a private project can see its name, key and counts in admin views and archive/delete it, but cannot read its issues, comments, channel, drive or Project Memory. An admin granting themselves access requires an Owner and is audited.
- [ ] **Workflow, hierarchy & accessibility:**
  - Moving a card on the Kanban board updates its column, `status_category` and `board_order` across two connected browsers in real time, and persists across `evictDurableObject()`.
  - Every drag-and-drop action on the board has a working keyboard and single-pointer (`Move to…`) alternative, single-character list shortcuts (`j`/`k`, `x`, `s`, `p`, `a`, `m`, `l`, `e`, `c`) are disabled when `user_preferences.shortcuts.singleKey` is off (WCAG 2.1.4), and all project views pass axe accessibility checks.
  - Sub-issues are capped at depth 1 (attempting to add a child to a sub-issue or make a parent issue a child returns `invalid_hierarchy`).
- [ ] **Personal tasks & cross-DO moves:**
  - Creating personal tasks across multiple members allocates sequential workspace-wide `TASK-<n>` keys in `ProjectRoom("personal")` without collision and keeps each task private to its creator until assigned or shared.
  - Moving `TASK-12` (or a parent issue with sub-issues) into project `ENG` transfers full state (comments, checklists, reviewers, activity) to `ProjectRoom(ENG)`, assigns `ENG-<m>`, and redirects `GET /issues/TASK-12` and `TASK-12` chips to `ENG-<m>`.
- [ ] **Archive & Trash cascades:**
  - Archiving a project makes its issues, channel, drive and calendar read-only; unarchiving restores write access.
  - Deleting a project moves it and its containers to 30-day Trash; purging it moves documents/files in the Project Drive to their creators' My files (with explicit grants intact) and deletes issues, channel messages and project memories.
- [ ] **Member lifecycle:**
  - Disabling an assignee closes their `ProjectRoom` sockets with `4401`, keeps their open issues with `needs_reassignment = 1`, cancels their pending review requests, and promotes the longest-standing Editor if they were the last Project Lead.
  - Deleting a member anonymises their authored issues and comments to "Former member", transfers their open personal tasks to an admin, and erases their completed personal tasks.

**M10b: Comments, relations, milestones, calendar capacity planning, Inbox & cross-object links**
- [ ] **Capacity planning math:**
  - For a milestone or date range, each contributor's available working days equal their profile working days minus declared `time_off` dates and regional/company public holidays (and `0` if an overdue milestone has $d_1 > d_2$).
  - Assigned open issue `effort_days` (rolling up sub-issues without double-counting the parent, and keeping `0d` remaining when all estimated sub-issues complete while the parent stays open) are compared against available days, flagging over-allocated contributors and counting unestimated issues separately.
  - Time-off types and private notes are never exposed in capacity views or APIs.
- [ ] **Cross-project relation privacy:**
  - When an issue in Project A is linked (`blocks`, `relates_to`, `duplicate_of`) to an issue in private Project B, a viewer who can read Project A but not Project B sees only `"Private issue"` (leaking no key, title, status or assignee), and completing the blocking issue updates `blocked_by_count` and raises `issue_status`.
- [ ] **Inbox & notifications:**
  - Assigning an issue raises `assignment`; completing, cancelling or reassigning the issue auto-resolves the `assignment` inbox item.
  - Adding a reviewer (`Editor`+) raises `review_request`; the requested reviewer (even with `Viewer`/`Commenter` role) submitting `approved` or `changes_requested` resolves `review_request` and notifies the assignee (`issue_review_decided`).
  - Offline emails for private projects and personal tasks omit issue titles and text unless `email_include_private_text` is enabled.
- [ ] **Rich chips & contextual actions:**
  - Typing `ENG-42` in chat or a document renders a live status chip for authorised viewers and leaks nothing to unauthorised viewers.
  - Creating an issue from a chat message or promoting a Tiptap `[ ]` checklist item links the issue back to the source (`object_links` with `relation = 'created_from'`).
  - Curated project events post to the project channel (batched over 2 minutes for bulk actions), while priority/effort/label edits do not spam the channel.

**M10c: Project Pulse, Shared Project Memory & Butler tools**
- [ ] **Project Memory safety, Trash hiding & isolation:**
  - Items proposed by Butler from call notes, channel messages or documents always start as `pending` (capped at 3 per turn) until a Project Lead or Editor confirms them; `pending` items never enter `search_index`, Vectorize or prompts.
  - A Viewer or Commenter attempting to create, edit, confirm or delete a Project Memory item (directly or via `propose_project_memory`) receives `forbidden`.
  - Generating Project Memory or answering `@Butler` in a project channel never reads any member's private `Assistant` DO memory.
  - Moving a cited document or issue to Trash immediately hides citing `project_memories` rows from the Overview, `search_index` and Vectorize (restoring them on restore); purging a source message, document, call note or issue permanently deletes citing `project_memories` rows and enqueues `assistant-purge` for personal assistant memories citing the deleted object.
- [ ] **Butler tools & confirmation:**
  - `create_issue`, `update_issue`, `comment_on_issue` and `propose_project_memory` produce server-rendered confirmation cards, enforce the caller's role (`forbidden` for Viewers on write tools), and honour `idempotency_key` and `expectedVersion`.
  - `search_issues`, `get_project_pulse` and `check_project_capacity` enforce the caller's (or audience's) permissions through the permission engine.

---

## 14. Later

- Time-boxed recurring Cycles / Sprints and velocity charts
- Interactive Gantt chart with auto-shifting dependency dates
- Custom per-project fields (number, select, multi-select, URL)
- Issue templates and project templates
- Inbound email-to-issue creation
- GitHub / GitLab PR and commit status linking (via Phase 2 webhooks, PRD §19)
- Importing issues from Linear, Jira, Trello or GitHub Issues CSV/JSON.

## 15. Open Questions

1. **Default contributors in capacity math:** by default, Project Leads and Editors are included in a project's capacity calculation (with a per-member toggle to exclude stakeholders who have Editor access but don't take assigned issues). Is that the right default?
2. **Batching window for channel activity:** is a 2-minute batching window right for grouping bulk issue creations/completions into a single project-channel card?

*(Resolved during independent review, now in §2 and §11.1: projectless personal tasks (`TASK-n`) use a single workspace-wide `ProjectRoom` DO instance named `"personal"` (`idFromName("personal")`), preventing workspace `TASK-<n>` key collisions and simplifying routing for shared personal tasks.)*

---

## 16. Changes to Other Documents (when approved)

Per AGENTS §2, approving this spec updates these sections in the same PR:

| Document | Change |
|---|---|
| `AGENTS.md` §2 | Add `[Projects, Tasks & Issues](specs/projects.md)` to the feature specs list. |
| `PLAN.md` §2, §3, §4 | Add `projects/` feature folder; add Milestone **M10 — Projects, Tasks & Issues** (M10a, M10b, M10c). |
| `PRD.md` §5.3, §5.6, §5.9, §10.1, §10.2, §13, §15, Appendix A | Update §5.6 with auto-provisioned project channel/drive/calendar, `ProjectRoom` DO, unified issue/task model, capacity planning and shared Project Memory; add retention and export rows in §10.2 and §13. |
| `TDD.md` §1.1, §2.0, §2.1, §2.2, §2.4, §3.3, §3.5, §5, §6.1, §7.5 | Add `ProjectRoom` DO, project/issue/memory D1 tables, `search_index` and Vectorize object types (`issue`, `project_memory`), room registry kind `project`, and export coverage. |
| `specs/permissions.md` §3.2, §4, §5, §9 | Add §4.7 Projects & Issues permission matrix; add `project` and `issue` resource types and union inheritance across a project's channel, drive and calendar. |
| `specs/notifications.md` §3, §6 | Move `assignment` and `review_request` from reserved to active; add `issue_review_decided`, `issue_mention`, `issue_comment`, `issue_status`, `issue_due_soon`, `issue_needs_reassignment`. |
| `specs/platform.md` §3, §4, §5, §6, §7, §8, §11, §12, §13, §14 | Add Projects & Issues rows to member lifecycle, deletion cascades (project drive files move to creators' My files on purge), retention, export, settings (`project_creation`), `ReminderScheduler` kinds (`issue_due`, `project_pulse`), room registry (`project`), and schema reconciliation. |
| `specs/admin.md` §2, §6, §12, §13.3, §18 | Include private projects and personal tasks in workspace and per-member exports, `Projects` in settings groups, and projects/issues/personal tasks/pulses in maintenance-mode write classes. |
| `specs/calendar.md` §3, §4.1 | Add `project` calendar kind and `release` / `demo` event types. |
| `specs/documents.md` §3.1, §4.1, §6 | Add `project` drive kind, issue-owned attachments (`parent_type = 'issue'`), and "Promote checklist item to issue". |
| `specs/chat.md` §3.2, §4.6, §8 | Add "Promote channel to project", `project_event` system message kind, and `ENG-42` live issue chips. |
| `specs/assistant.md` §5, §8, §12.3 | Add the 7 project/issue tools (§8.3), shared Project Memory (`project_memories`), Project Pulse generation, and "Create issue" on call-notes action items. |

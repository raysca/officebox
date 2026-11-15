# Officebox — Product Requirements Document (PRD)

**Status:** Working baseline  
**Version:** 1.7  
**Date:** 15 November 2026  
**Changes in 1.7:** sign-in is **passwordless**: passkeys for everyone and magic links for members, with no passwords, password resets or password policy, built on the **better-auth** library (MIT). Owners are asked for two passkeys and keep the recovery secret as a fallback (product-owner decisions, 15 Nov 2026; §6, §7, §10.1, §10.2, §13, §15, §16, Appendix A; detail in [specs/identity.md](specs/identity.md)).
**Changes in 1.6:** the [assistant spec](specs/assistant.md) is adopted. Personal memory moves from deferred into the first AI release. New or changed: the assistant's display name, audience-safe mentions, voice, call notes and captions, AI Gateway logging off, indexing only while the assistant is enabled, the privacy scope, personal reminders, and assistant retention and export rules. Tasks and issues stay with projects. Phase 3 maps to PLAN M9 (§2, §4, §5.3, §5.8, §5.9, §10.2, §11, §13, §14, §15, §18, Appendix A).  
**Changes in 1.5:** second independent review decisions: admin self-access to groups and drives needs an owner; recovery links issued without email are flagged on the sign-in page and to every owner; first-release setup creates identity objects only, with other objects arriving with their milestones; editors moderate comments; viewers can start document calls; admins moderate private channels they belong to; orphaned private events can be removed by owners and admins; one Trash restore rule; calendar purge moves events to organisers; time off has no Trash (§5.3, §5.8, §6, §8, §10.1, §10.2, §18).  
**Changes in 1.4:** Feature specs ([identity](specs/identity.md), [chat](specs/chat.md), [calls](specs/calls.md), [calendar](specs/calendar.md), [documents](specs/documents.md)) and cross-cutting specs ([permissions](specs/permissions.md), [notifications](specs/notifications.md), [platform rules](specs/platform.md)) adopted. Calendar becomes a first-class feature (§5.10). Decisions from the spec interviews and the independent review are folded in: identity (§6), chat (§5.4), documents and files (§5.5, §5.7), calls (§5.8), notifications (§8), permissions (§10.1), retention (§10.2), export (§13), phases (§15) and limits (§18). **Where this PRD and a spec differ on feature detail, the spec wins.**  
**Changes in 1.3:** Screen sharing and present mode (§5.8). Remaining review items addressed:
- persona-to-role mapping (§3)
- SSO through Cloudflare Access and owner recovery (§6)
- file limits and previews (§5.7)
- data location, custom domain, usage panel, telemetry and support bundle privacy (§13)
- storage protective mode (§13)
- measurable success metrics (§16)
- non-functional requirements (§18)
- imports, integrations and APIs (§19).

**Changes in 1.2:** All open product questions now have a recommended decision (§17). New or expanded: Personal Inbox rules (§5.3), editor and revision history (§5.5), board component (§5.6), support plans (§1), AI log visibility (§11), export and restore (§13), native app criteria (§9).  
**Changes in 1.1:** Licence and business model defined (open source, paid support). Upgrade delivery via release-sync pull requests. Secure first-run setup. Baseline role model. Baseline retention and deletion rules. Message source of truth.

## 1. Product summary

Officebox is a Cloudflare-native, self-owned workspace suite for small teams. It brings team communication, shared knowledge, files, projects, issues, meetings and an AI assistant into one integrated environment—deployed in one click, owned by the customer, and operated with no servers, databases, or ports to manage.

The headline proposition: **an open-source workspace suite for your whole team, running in your own Cloudflare account for a flat infrastructure bill (often just the $5/month Workers Paid plan), with no per-seat fees.** The customer brings their own Cloudflare account. Officebox is deployed directly from GitHub using the Deploy to Cloudflare button, which copies the repository into the customer's GitHub account, provisions the required Cloudflare resources, and deploys the application to their Cloudflare account in a few clicks. The customer pays Cloudflare directly for infrastructure; the Workers Paid plan includes allowances for Durable Objects, D1, Vectorize and other services, and usage beyond them is billed by Cloudflare.

### Licence and business model

- **Licence:** Officebox is open source under the **GNU AGPL-3.0**. Customers can run, modify and self-host it freely. The AGPL requires anyone offering a modified Officebox as a network service to others to publish their changes, which discourages closed hosted forks.
- **All releases are free.** Every feature release, bug fix and security fix is published to everyone through the stable and beta channels. Beta access is free and opt-in. Security fixes are never withheld or paywalled.
- **Revenue comes from services, not code access:**
  - Paid support plans with response-time commitments. All plans are priced per installation, never per seat. The starting hypotheses below are to be validated with design partners:

    | Plan | Includes | Starting price hypothesis |
    |---|---|---|
    | Community | GitHub Discussions and issues, public documentation, security advisories | Free |
    | Standard | Private support channel, 2-business-day response, upgrade and restore assistance | ~$49/month per installation |
    | Priority | 1-business-day response, a quarterly allowance of priority fixes, a named contact | ~$199/month per installation |
    | One-off services | Assisted setup, migration from Slack, Notion or Google Workspace, recovery assistance | Fixed-price packages from ~$499 |
  - Priority fixes: paid prioritisation of bugs and small features the customer needs. The fix itself is released to everyone.
  - Assisted setup, migration from other tools, and upgrade or restore assistance.
- **Contributions:** external contributions are accepted under a Developer Certificate of Origin (DCO). Any future dual-licensing would need a Contributor Licence Agreement, which is not planned.
- **Trademark:** the Officebox name and logo are trademarks. Forks may not present themselves as official Officebox.

The initial target is organisations of approximately 5–100 people, particularly small startups that want ownership and data control without operational burden.

### The problem Officebox addresses

Small teams fragment their work across a chat tool, a docs tool, a ticket tracker, a meeting tool and a personal task app. Context is lost between them. Hosted SaaS alternatives impose per-seat costs that scale painfully with team size. Self-hosted alternatives require infrastructure skills the team does not have.

Officebox resolves all three: one connected workspace, owned by the customer, deployed in one click, and priced as a fixed infrastructure cost rather than a per-seat subscription.

## 2. Product direction

### Direction A — Self-owned, Cloudflare-native workspace

One installation = one organisation = one Cloudflare account = one workspace.

Officebox is not multi-tenant SaaS. Each customer deploys their own instance into their own Cloudflare account. Departments and teams are represented through channels, groups, projects and permissions within that workspace. There is no workspace switcher or shared hosting model.

### Product promise

- Own your workspace. Your data lives in your Cloudflare account, not ours.
- Deploy in one click. A Deploy to Cloudflare button gets you from GitHub to a working workspace with no servers, databases or ports to configure.
- No per-seat fees, ever. Officebox is open source. Infrastructure cost is your own Cloudflare bill, typically the $5/month Workers Paid plan for a small team, plus usage-based charges that grow with data and activity rather than headcount.
- One integrated experience. Chat, calls, calendars, documents, whiteboards, files, projects and issues are connected workspace objects, not disconnected apps.
- Realtime without operational burden. Presence, chat and collaborative editing work out of the box on Cloudflare's managed realtime primitives.
- AI on your terms. Workers AI works out of the box, or bring your own model provider key via AI Gateway; AI is optional and never disables core collaboration.
- Upgrade on your schedule. Stable and beta channels. New releases arrive as a reviewable pull request in your repository, and merging it upgrades the workspace. Rollback is supported.

## 3. Target users and needs

### Primary customer

A small startup or team (5–100 people) that wants an integrated collaboration suite, wants to own its data, and does not want to run infrastructure.

### Typical users

- Workspace administrator: deploys Officebox, configures Cloudflare bindings, manages members and upgrades.
- Team member: communicates, collaborates, manages their own work.
- Team lead: coordinates channels, projects, documents and priorities.
- Knowledge worker: creates and searches documents, uses the AI assistant.
- Founder/operator: needs a clear view of commitments, blockers and progress without paying per seat.

How personas map to the roles in §10.1:

| Persona | Typical workspace role | Typical resource roles |
|---|---|---|
| Workspace administrator | Owner or admin | — |
| Founder/operator | Owner | Member of key channels; viewer or editor on plans |
| Team lead | Member (sometimes admin) | Channel admin; document owner or editor; project lead (Phase 2) |
| Team member / knowledge worker | Member | Channel member; document editor or commenter |
| Contractor or client | Guest (Phase 2) | Only explicitly shared channels and documents |

### Problems to solve

- Per-seat SaaS pricing makes integrated suites expensive as teams grow.
- Self-hosted suites require infrastructure skills small teams do not have.
- Work context is fragmented across disconnected tools.
- AI features often require surrendering provider control or paying a markup.
- Upgrades and operations are opaque and risky.

## 4. Product principles

1. Self-owned first. The customer owns their Cloudflare account, their data and their deployment.
2. One-click, zero-ops. No servers, databases, ports or certificates to manage. Cloudflare manages the infrastructure; Officebox manages the experience.
3. One integrated workspace. Objects are connected; context follows the work.
4. Open source, no per-seat fees. The code is AGPL-3.0 and every release is free. Infrastructure cost is the customer's own, predictable Cloudflare bill.
5. Realtime by design, durable by default. Realtime is a first-class capability; important data is persisted independently of connections.
6. AI-native, not AI-dependent. Core collaboration works with no AI configured. With the assistant off, workspace content is not indexed or sent to any model.
7. BYOK via AI Gateway. Workers AI works by default. Customers who bring their own provider keys store them in their own Cloudflare account.
8. Privacy and permissions by default. Every feature, including AI retrieval and previews, respects access controls.
9. Visible operational risks, not blockers. Warn about misconfiguration without preventing evaluation.
10. Safe upgrades. Stable and beta channels, reviewable release pull requests, rollback-compatible migrations, and clear migration status.

## 5. The integrated workspace experience

### 5.1 Shared workspace objects

Core object types:

- Conversations, channels, direct messages and messages.
- Documents and knowledge pages.
- Whiteboards.
- Projects, boards, issues and tasks.
- Calendars, events and calls (huddles).
- Files and attachments.
- Users, teams and groups.

Objects are linkable through explicit relationships. Examples:

- A document is created from a conversation and retains a source link.
- An issue belongs to a project and references its originating discussion.
- A project is supported by documents and decisions.
- A meeting is associated with a document, project or conversation.
- A message references an issue or document as a rich workspace object.

Relationships are represented in application data, not only pasted URLs. Users can navigate between related objects and understand why they are connected.

### 5.2 Contextual actions and continuity

Users can move between activities without losing context:

- Create a document from a conversation, carrying over title, source link and selected context.
- Start a call from a conversation, document or calendar event and retain context in the call.
- Create an issue from a message or a decision in a document.
- Link an existing issue into a document or conversation.
- Convert a plan/document into a project while preserving content and links.

Contextual actions respect permissions. Creating a link does not grant access to the linked object. Users who cannot access a target object must not receive its private content through previews, search or AI.

### 5.3 Personal Inbox — the user's workday

The Personal Inbox is a first-class product area: a consolidated, actionable view of the user's work across the workspace.

It should answer:

1. What needs my attention?
2. What do I need to do?
3. What is coming up?
4. What has changed in work I'm involved in?

The Personal Inbox ships in the first release, in its own milestone after the main features (PLAN M8). Earlier milestones provide in-app notifications, which become the Inbox's first sources.

Initial conceptual views:

- Today: prioritised items for the current day.
- Upcoming: future commitments over the coming days/week.
- Inbox: items requiring acknowledgement, response or action.
- Assigned to me: items assigned to the user that exist in the first release (for example calendar invitations awaiting a response and access requests to approve). Issue assignments arrive with projects (Phase 2).
- Following: relevant activity from conversations, documents and projects the user follows.

These are views over underlying workspace objects, not duplicate copies. Users can act on an item in context and return to the inbox without losing their place.

The Inbox distinguishes:

- Notifications: an event occurred.
- Action items: the user is expected to do something.
- Schedule items: something is planned for a particular time.
- Followed activity: something the user wants to stay informed about.

Users can acknowledge, dismiss, snooze, complete or follow items. Dismissing an inbox notification does not delete the underlying message, issue or document.

The first release uses Officebox-native sources: mentions, direct messages, assignments, review requests, due dates and project/document activity. Commitment nudges arrive with the assistant (PLAN M9b): the member opts in, and each suggested reminder is added only if they accept it.

**Inbox rules:**

- **Ordering in Today:**
  1. Action items due today or overdue.
  2. Direct messages and mentions.
  3. Review requests.
  4. Other action items.
  5. Followed activity.

  Within each group, newest first. Users can pin an item to the top.
- **Grouping:** several events on the same object (for example, five replies in one thread) collapse into one item showing the latest event and a count.
- **States and actions:**
  - *Read* (acknowledge) marks an item as seen and keeps it in the inbox.
  - *Done* (complete) removes an action item from the active views.
  - *Dismiss* removes a notification without completing anything.
  - *Snooze* hides an item until a chosen time (later today, tomorrow morning, next week, or a custom time), then it returns as unread.
  - *Follow* or *unfollow* controls whether future activity on that object appears.
- **Automatic resolution:** items resolve themselves when the underlying work is done. Replying in a thread resolves the mention that prompted the reply. Opening a DM marks it read. Closing or reassigning an issue resolves its assignment item. Completing a review resolves the review request.
- **Retention:** resolved items are purged after 90 days (§10.2).

**Calendar in the Inbox:** today's events appear at the top of **Today**, and upcoming events, invitations and reminders in **Upcoming** and **Inbox**. If the calendar ships before the Personal Inbox, the calendar has its own Today panel until the Inbox arrives. There is no agenda email. The calendar itself is described in §5.10 and [specs/calendar.md](specs/calendar.md).

**Personal reminders and the assistant in the Inbox** (with the assistant, PLAN M9):

- **Personal reminders** are private notes-to-self with a time ("Send the deck — Fri 09:00"). The member creates them through the assistant (confirmed), by accepting a nudge, or with "Add to my reminders" on a call-notes action item. They fire as inbox items, appear in **Upcoming**, and can be marked done, snoozed or deleted. Only the member can see them.
- **Assistant items** (daily brief, meeting prep, commitment nudges, and "reply ready") appear in the Inbox with **no preview text** and open the assistant DM. They follow do-not-disturb, focus time and time off. Mentioning the assistant creates no inbox item.

Detail is in [specs/assistant.md](specs/assistant.md) §7.1 and §8.

### 5.4 Chat and communication

First-release capabilities (detail in [specs/chat.md](specs/chat.md)):

- **Conversations:**
  - public and private channels, which any member can create
  - **announcement channels**, where only channel admins and chosen posters write
  - an optional **read-only #general**
  - one-to-one DMs, and **group DMs** for 3–8 people with fixed membership (adding someone starts a new group DM).
- **Private channels** are hidden from non-members. Members add people and channel admins remove them. A public channel can become private, never the reverse.
- **Messages:**
  - a rich-text composer with Markdown shortcuts; mentions of people, groups, `#channels`, `@channel` and `@here`
  - reactions, edits and deletes at any time (shown as "edited", with no public history).
- **Threads:** the first 3 replies show inline under the parent; from the 4th, the thread collapses into an "N replies" marker that opens a side panel. Threads are always visibly marked.
- **Pins, saved items, polls** (multiple choice, closing time, and truly anonymous polls whose voters can't be recovered from exports) and **external link previews** at launch.
- **`@channel` / `@here`** are open to anyone, with a confirmation in channels of more than 20 members.
- **Files** belong to their message (same access, deleted with it) and appear in the channel's Files tab. **"Save to folder"** copies a file into a drive as an independent file.
- **Message actions:** forwarding shares a **live reference**, so people without access see nothing, and the app warns before forwarding out of a private channel. "Create document from message" and "Reply privately" copy the text.
- **Other:** no read receipts; unread markers, presence and typing indicators; a customisable sidebar (starred, custom sections, unreads-first, mute and hide); permission-filtered search.

Messages are durable workspace data. Each channel's Durable Object stores that channel's message history in its own SQLite storage. This is the **source of truth** for the channel. A message is written there before it is shown to anyone. Every message change (create, edit, delete, reaction) is then reliably copied to D1, where it supports cross-channel search, the Personal Inbox, notifications and export. The realtime connection is never the only copy of a message. The D1 copy may lag by a few seconds but is guaranteed to catch up. WebSocket connections use the Hibernation WebSocket API, so idle channels do not accrue billable duration while clients remain connected.

Calls (huddles) are specified in §5.8.

### 5.5 Knowledge, documents and whiteboards

Officebox provides shared documents and knowledge pages that connect naturally to conversations and work.

First-release document capabilities (detail in [specs/documents.md](specs/documents.md)):

- **Organisation:** folders and documents in **My files** (private until shared) and **shared drives** (one per group automatically, plus drives members create). New items take their container's access (§10.1).
- **Editing:**
  - real-time co-editing with Tiptap and Yjs, autosave and a clear save state
  - headings, lists, tables, task lists, links, images and mentions
  - **slash commands**, **callouts**, **toggles** and **code blocks**
  - live **Officebox embeds** of messages, events, whiteboards and other documents, which respect access.
- **Comments:** inline and page-level threads with mentions, resolve and reopen, and moderation (removing others' comments) by the document owner, editors and admins. No suggestion mode.
- **Revision history:** automatic versions hourly for 7 days and daily for 90 days, plus named versions kept for the document's lifetime. Users can view and restore any version, and restoring creates a new version. **Comparing versions** is custom work (Tiptap's compare is a paid extension) and may move later.
- **Offline:** the 20 most recently opened documents (up to 100 MB) stay editable offline and sync when back online. Caches are wiped on sign-out.
- **Export and import:** export as **Markdown** or **PDF** (printed by the browser); import Markdown and HTML.
- **Search:** title and content.
- **Links** to originating conversations, events and related objects.
- **Later:** templates and public links.

Whiteboards are a first-class collaborative surface, built on the same Yjs collaboration model, both standalone and embedded in documents (editable in place). Documents and whiteboards are both persisted as CRDT state in Durable Object SQLite, with periodic snapshots.

Officebox does not build a rich-text editing engine from scratch. The editor is Tiptap; collaborative state is Yjs. Officebox uses only the MIT-licensed open-source Tiptap packages:
- the core
- StarterKit
- Collaboration and the collaboration caret
- Link, Image, Table, Task list, Mention and Placeholder.

It does not depend on Tiptap's paid cloud features. Comments are stored in Officebox's database, anchored to the document with Yjs relative positions. Version history is built on Officebox's own Yjs storage. Both stay in the customer's account and remain compatible with the AGPL. A stock Yjs client can connect to the Durable Object sync endpoint using the standard Yjs protocol (y-websocket).

### 5.6 Projects, boards, issues and tasks

Projects and issue tracking are a planned Phase 2 capability.

Expected capabilities:

- Projects.
- Boards and configurable workflow columns.
- Issues/tasks with title, description, status, assignee and due date.
- Comments and activity.
- Links to documents, conversations and meetings.
- Assignment and mention events surfaced in the Personal Inbox.
- Basic filtering and search.

Officebox evaluates mature open-source React board components before building custom UI, and avoids components that create a disconnected application, separate identity model or competing source of truth.

**Recommendation:** build the board UI with a permissively licensed drag-and-drop toolkit (dnd-kit, MIT) on Officebox's own project and issue data in D1. Do not embed a standalone tracker such as Plane or Focalboard. Those bring their own data model, identity and deployment footprint, which the integration principles rule out.

### 5.7 Files

First-release capabilities (detail in [specs/documents.md](specs/documents.md)):

- **Drives:** **My files** per member, a **group drive** per group (listed by name to everyone, contents for the group only), **shared drives** that members create, and a **Channels drive** with one folder per channel. Shared drives belong to the team, so their content survives people leaving.
- **Channel folders:** their access follows channel membership, and channel members can edit everything in them. They hold documents and **saved copies** from chat. Chat attachments themselves stay with their message. DMs have no folder. When a channel is deleted, documents in its folder move to their creators.
- **Files:** uploads, metadata, access controls, downloads and previews, all stored in R2.
- **Versions:** upload a new version and keep the old ones, which can be downloaded or restored. Links always open the latest.
- **Files up to 2 GB by default** (configurable by owners).
- Images, PDFs, audio and video preview in the browser. Other types, including HTML and SVG, download instead of opening, for safety.
- Owners can block chosen file types.
- Files are not scanned for malware (§14).

### 5.8 Realtime collaboration and calls (huddles)

Realtime is fundamental to Officebox. The architecture uses two distinct realtime planes:

- Application realtime (Durable Objects): chat delivery, presence, typing indicators, inbox updates and object-link changes. WebSocket connections to Durable Objects, with hibernation to keep idle cost near zero.
- Collaborative state (Durable Objects + Yjs): document and whiteboard editing. One Durable Object holds one document or whiteboard; the authoritative Y.Doc lives in the object and is persisted to its SQLite storage, with snapshots and compaction.

Media for **calls** (called "huddles" in earlier drafts) uses Cloudflare Realtime SFU. Detail is in [specs/calls.md](specs/calls.md).

- **Ad-hoc, audio-first calls:** start one from a channel, DM, document or calendar event. Each context has one active call, and it ends 30 seconds after the last person leaves. There are no persistent rooms.
- **Who is alerted:**
  - **Channel calls never ring or ping anyone.** The channel shows a "call in progress" banner plus start and end messages.
  - **DM and group-DM calls ring** the others for 30 seconds. Unanswered rings become a "missed call".
  - Do-not-disturb, focus time and time off suppress ringing.
- **Calendar event calls** can be joined from 10 minutes before the start, and attendees get a "starting now" notification. **Document calls** are recorded in the document's activity list.
- **Joining:** mic on, camera off; automatically muted when the call already has 6 or more people. One call at a time per person. **Handoff** moves a call to another device. **Call waiting** rings someone already in a call, who must leave their current call to accept.
- **Video:** optional, and off by default.
- **Screen sharing and present mode:** see below.
- **Visible context:** each call shows where it started and links back to it, and the context shows who is in the call. When a call ends, a short summary (duration, participants) is posted to the context.
- **In-call chat** is kept afterwards: as a thread in channel and DM calls, and with the document or event otherwise.
- **Size:** up to 25 participants per call by default.
- **Controls:** mute, camera, share screen, reactions, raise hand (an ordered queue), noise suppression and leave. Moderation (muting, stopping a share, lowering hands, removing someone) belongs to the host and to channel admins, document owners or event organisers. It passes on if the host leaves.
- **Encryption:** media is encrypted in transit. It passes through Cloudflare's SFU and is not end-to-end encrypted, and Officebox says so plainly.
- **TURN:** provided by Cloudflare Realtime, sharing the SFU free tier: the first 1,000 GB of egress per month is free, then $0.05/GB. For small-team audio calls this is effectively free.

#### Screen sharing

Users can share their screen in any call, or start a call by sharing straight from a channel, DM, document or event.

- **What can be shared:** an entire screen, a single application window or a single browser tab, through the browser's standard picker. Tab audio can be included where the browser supports it (Chromium-based browsers). Full system audio is not promised.
- **One presenter at a time,** which keeps attention focused and bandwidth predictable. Another participant can ask to take over, and the presenter accepts with one click. The call's host or a moderator can hand over directly.
- **Viewing:**
  - the share becomes the main view, with participant tiles alongside
  - viewers can go full screen or pop the share into its own window (picture-in-picture where supported)
  - viewers can zoom and pan to read small text.
- **Clarity first:**
  - shares are tuned for readable text by default: up to 1080p at a low frame rate
  - presenters can switch to *motion* for video or animation: a higher frame rate with adaptive resolution
  - viewers on slow connections automatically get a lower-quality version without affecting anyone else.
- **Presenter safety:**
  - a persistent "You are sharing" bar with a Stop button
  - Officebox notifications are suppressed on the presenter's device while sharing
  - a reminder appears when sharing an entire screen.
- **Devices:** sharing needs a desktop browser (Chrome, Edge, Firefox or Safari). Mobile browsers and the installed PWA can view shares but not share, because mobile browsers don't offer screen capture.
- **Administration:** owners choose who may share: everyone (default), *admins* (workspace owners and admins, plus channel admins in channel calls), or nobody. They can also cap share resolution at 720p or 1080p to limit bandwidth.
- **Not included:** remote control of another person's screen, annotation on shared screens, and recording (§14).

#### Present mode for documents and whiteboards

When the thing being shown is an Officebox document or whiteboard, users can **present** it instead of sharing their screen:

- Followers' views track the presenter's position, zoom and selection in real time, at full quality and with no video bandwidth.
- Any follower can break away to look around, then rejoin with one click.
- Present mode works inside a call or on its own. For example, a user can walk a colleague through a spec while talking on a call elsewhere.

#### Media usage

Screen sharing and video use the most bandwidth. As a guide, a 30-minute 1080p share watched by 8 people uses about 3–4 GB of SFU egress, so the free allowance covers a few hundred such sessions a month. The usage panel (§13) shows call bandwidth.

Delivery sequence:

1. Application realtime (Durable Objects) and core chat presence.
2. Collaborative documents and whiteboards (Durable Objects + Yjs).
3. Channel and DM calls with audio, video and screen sharing (Realtime SFU).
4. Event calls (with the calendar) and document calls with present mode (with documents).
5. Call notes and live captions with the assistant (PLAN M9c). Detail is in [specs/assistant.md](specs/assistant.md) §12.3–§12.4.
   - **Notes are visible and stoppable.** Any participant with assistant access can start notes. Everyone sees a persistent banner saying who started them and who will be able to read them. Anyone in the call can stop them.
   - **Joining a call with notes on requires acknowledging a notice first.** Until then the person isn't in the call and no audio is sent.
   - Participants without assistant access are transcribed too, and get the same notice and Stop control.
   - Notes (summary, decisions, suggested action items) go to the call's context. Transcripts are kept for a set period (§10.2). Audio is never stored.
   - **Captions are separate from notes.** Any participant can turn on captions for themselves. They are never stored, and everyone sees a "Captions on" indicator because audio is sent to the model provider.

Recording is not an initial requirement.

### 5.9 AI workspace assistant

The assistant helps users:

- Search permitted messages, documents, files and meeting notes.
- Summarise conversations, documents, files and calls.
- Draft or create documents and messages.
- Schedule meetings and set personal reminders.
- Answer questions grounded in workspace knowledge.
- Remember what the user has discussed with it.

The first AI release (Phase 3, PLAN M9) gives every member a **personal assistant with private memory**. Its behaviour is specified in [specs/assistant.md](specs/assistant.md).

- **Name:** the name people see is an admin setting that defaults to **"Butler"**. Code and tables say `assistant`.
- **No access of its own.** It always acts as the person asking, or for the audience of a shared conversation. It can never be granted anything.
- **Personal memory is in scope.** Each member's conversations and remembered items stay in that member's own storage, are never used to answer anyone else, and can't be read by admins. Members can view and delete what it remembers, use incognito conversations, and shorten the retention window an owner sets (§10.2).
- **Audience-safe mentions.** Anyone with assistant access can `@mention` it in a conversation. A reply others can see uses only the conversation and sources the whole audience can open, never the asker's memory or private material.
- **Voice:** push-to-talk and call notes (M9c), and live spoken conversation (M9d). Call notes and captions follow §5.8.
- **Proactive help:** a daily brief, meeting prep and commitment nudges, each off until the member turns it on.
- **Rollout:** an admin turns it on for the workspace or chosen groups. Owners set a monthly budget and admins set usage caps.
- **Tasks and issues** stay with projects (Phase 2). They are not part of the first AI release.

AI actions that modify data or affect external systems require confirmation and permission checks. The assistant shows a preview card and nothing changes until the member confirms. Sensitive actions are auditable.

Semantic retrieval uses Vectorize with Workers AI embeddings. The retrieval pipeline filters results by the requesting user's permissions before returning content to the model. Workspace content is indexed only while the assistant is enabled. Turning it on back-fills the index, and an owner can delete the index.

### 5.10 Calendar

A team calendar built into the workspace. It replaces the earlier plan of only an outbound ICS feed. Detail is in [specs/calendar.md](specs/calendar.md).

- **Calendar kinds:**
  - **personal** (one per member; others see free/busy only)
  - **group** (one per group, viewable by everyone)
  - **channel** (optional)
  - **standalone** shared calendars (such as an on-call rota)
  - a **workspace** calendar for all-hands and company holidays
  - a generated **public holidays** overlay.
- **Events:**
  - timed or all-day, with explicit time zones and recurrence ("this event", "this and following", "all events")
  - private events show others "busy"
  - optional **call** links and links to documents and channels.
- **Invitations:** inviting members adds the event to their calendar straight away as *tentative* until they reply Yes, No or Maybe.
- **Outside attendees:**
  - invited by email with a standard calendar invitation
  - on by default, limited to 50 external recipients per member per day; admins can restrict or turn this off
  - RSVP links open a confirmation page, so mail scanners can't answer for people.
- **Public holidays for every country** from a bundled dataset, with no external service. Each member's region is highlighted. Admins add company holidays.
- **Time off** is declared without approval:
  - everyone sees the dates; the type and note are visible only to the member
  - it sets an "away until" status and silences rings and email.
- **Focus time** (acts as do-not-disturb), **working location** (office, home, elsewhere) and **deadlines and milestones**.
- **Reminders:** 10 minutes before timed events and 09:00 the day before all-day events, in-app by default. Email reminders are opt-in.
- **Find a time** across attendees' working hours, time zones, time off and holidays.
- **ICS feeds:**
  - **Out:** a private, revocable feed per member, to subscribe to from Google, Outlook or Apple.
  - **In:** read-only subscriptions to external calendars, visible only to the subscriber.
  - Two-way Google and Microsoft sync comes later.

## 6. Identity, onboarding and authentication

Initial product direction:

- Built-in local user accounts in D1.
- Invitation-based membership; no public registration.
- First-run setup creates the initial owner. **Setup is protected by a one-time setup token** that only the person who deployed can obtain, either set as a secret during deployment or read from the Worker's logs in their Cloudflare dashboard. Without the token, a freshly deployed URL cannot be claimed by anyone who finds it. Once setup completes, the setup flow is permanently disabled.
- **Owners and admins invite members.** Only owners can invite or promote admins.
- Invitation links are single-use, bound to the invitee's email, and expire after 7 days. When email is unavailable, admins copy and share links manually.
- **Onboarding:** account creation, a profile step, joining default (public) channels, a welcome post and a short tour.

First-release sign-in and security (detail in [specs/identity.md](specs/identity.md)):

- **Passwordless: passkeys, plus magic links by email for members.** There are no passwords. Everyone signs in with a passkey, and passkeys always require the device's PIN or biometric (user verification). Members can also use a magic link when email is configured; **owners and admins use passkeys only**. Owners are reminded to keep **two passkeys** (for example a laptop and a phone) and can't invite anyone until they have a second passkey or the recovery secret is set. Passkeys are tied to the workspace's address, which is recorded at setup and changed only by an owner (§13).
- People are told about every new passkey on their account and about a magic-link sign-in from a new device.
- Built on **better-auth**, an MIT-licensed authentication library, pinned to exact versions and upgraded only after reviewing its security advisories.
- Secure browser sessions: 30 days, sliding. Members can see their devices and sign them out ("My devices" doubles as login-activity visibility).
- **Scanner-safe email links:** magic-link, reset, recovery, invitation and email-change links open a confirmation page, and only a deliberate click uses them. Mail scanners can't use them up.
- A lost passkey is replaced by signing in with a magic link (members, when email is configured) or with a recovery link (from an admin for members, from an owner for admins and owners). Email changes are confirmed through the new address.
- **Admin powers are limited:**
  - Admins can disable, delete, change the email of, or issue a **recovery link** to *members*.
  - Doing any of those to admins or owners needs an owner.
  - Every use notifies the person, by email to their old address and with an in-app banner, and revokes their pending sign-in links.
  - **Without email configured**, a recovery link is still allowed for members, but it's loudly flagged: the member sees a notice on the sign-in page ("An admin reset your account on …"), and every owner sees it flagged on the member list until one acknowledges it.
  - An admin adding **themselves** to a group, or granting **themselves** access to a group drive or folder, needs an owner.
- **Security notices** are sent for: recovery link issued, email changed, role changed, and passkey clone detected. They're never held or muted.
- **What the identity milestone creates:** setup and account creation make identity objects only (the workspace, people, handles, groups, invitations, sessions and passkeys). `#general` and default channels arrive with chat, calendars with calendar, and drives with documents; each of those milestones backfills them for people and groups that already exist.
- **Profiles:** name, unique **@handle** (shared namespace with groups), avatar, time zone, working hours, region, title, team, pronouns, phone, location and status. The directory shows contact details to every member.
- **Groups** have **group managers**, and **@group mentions** notify members who can see the conversation.
- **TOTP multi-factor authentication arrives after launch.**

Further identity capabilities:

- **SSO through Cloudflare Access (Phase 2):** customers can put their workspace behind Cloudflare Access, which is free for small teams. Officebox then signs members in with the company's identity provider, such as Google Workspace, Microsoft Entra, Okta or GitHub. This gives single sign-on and identity-provider MFA without Officebox implementing OIDC. Only existing or invited members can sign in this way.
- **Owner recovery:** if every owner is locked out (passkeys lost, and no email configured), someone with access to the Cloudflare account can set a one-time recovery secret. The secret lets one owner register a new passkey (and resets their MFA, once MFA exists). Recovery is audited, and a banner shows until the secret is removed.
- **Disabled members:** their content stays, and so does their ownership. Their open issue assignments are flagged for reassignment. **Deleting** a member transfers their My files to an admin and erases their personal data. What happens per feature is set out in [platform §3](specs/platform.md).
- **Device data:** signing out clears cached workspace data from the device. Revoking a session clears it the next time that device connects.

## 7. Email

Officebox does not operate a mail server. Outgoing email uses **Cloudflare Email Service** by default, when the workspace's domain is on Cloudflare DNS. An external email API provider or SMTP relay can be configured instead (TDD §7.6). Likely uses:

- Invitations.
- Magic sign-in links.
- Email verification.
- Optional notifications.
- Important system/security notices.

Email configuration is optional. Officebox remains usable without it. Manual invitation-link creation and sharing is a supported, tested flow rather than a debugging workaround.

## 8. Notifications and delivery

Notifications are a product capability with multiple delivery channels:

- In-app notifications and Personal Inbox items.
- Realtime updates via Durable Objects WebSockets.
- Browser/web push (Phase 2).
- Email notifications.
- Future native mobile push through APNs/FCM if native apps are built.

Behaviour is specified in [specs/notifications.md](specs/notifications.md), including the catalogue of notification types.

- **Levels per conversation:**
  - **All**
  - **Mentions** (the default for channels)
  - **Mute** (only direct @you mentions, no badges)
  - **Nothing** (complete silence).

  DMs default to All.
- **Do-not-disturb:**
  - Manual or on a weekly schedule. Working hours don't imply DND.
  - DND holds in-app banners and sounds, **email notifications** and **call rings**. The inbox still records everything.
  - In DMs, a sender can choose **"Notify anyway"** to break through, which is rate-limited.
- **Focus time** acts as DND. **Time off** silences rings and email.
- **Disclosure:** presence, senders and callers see "in do-not-disturb", "focusing until…" or "away until…".
- **Offline email:** sent after 10 minutes unread by default; configurable to 5 or 30 minutes, hourly or daily digests, or off. Batched per conversation and cancelled when read.
- **Emails for DMs, group DMs and private channels contain no message text** unless the member opts in.
- **Security notices** (recovery link issued, email changed, role changed, passkey clone detected) are never held or muted.
- **Web push** (PWA) arrives in Phase 2.

Push payloads are generic by default and avoid sensitive message content. The client fetches the actual content after authenticating.

## 9. Desktop and mobile experience

Initial direction:

- Responsive React web application.
- Installable Progressive Web App (PWA) where supported.
- Browser notifications and Web Push on supported platforms.
- No mandatory native desktop or mobile application.

Native desktop, iOS and Android applications are deferred until customer demand justifies the additional build and maintenance burden. Native work is reconsidered after Phase 2 only if design-partner data shows both of these:
- more than 30% of active sessions come from mobile, and
- users report PWA limitations, such as unreliable push on iOS or missing background behaviour, as a top-three pain point.

The first native step would be a thin wrapper around the PWA, not a separate client. A future native client reuses the same backend, identity, workspace object model and notification services.

## 10. Workspace model and permissions

Officebox is a single-workspace, single-organisation product per installation.

- One deployment serves one organisation.
- One global member directory exists within that installation.
- Teams and departments are represented through channels, groups and projects.
- Roles and resource-level permissions control access.
- Private channels and restricted documents remain private.
- No tenant switching or multi-tenant hosting.

A stable installation identity represents organisation-level settings and integrations. This does not imply multi-tenancy.

All object relationships, previews, inbox aggregations, search results and AI retrieval respect permissions. Linking an object never implicitly grants access to it.

### 10.1 Role model (baseline)

**Workspace roles.** Every account has exactly one.

| Role | Can |
|---|---|
| Owner | Everything an admin can, plus invite, promote and manage admins and owners, transfer ownership, and see installation, upgrade, backup and export settings. Owners are asked to keep two passkeys. At least one active owner must always exist. |
| Admin | Invite members; disable, delete, change the email of, or issue recovery links to *members* (acting on admins or owners needs an owner, and the person is always notified); manage groups (adding **themselves** to a group or drive needs an owner); configure workspace settings; archive or delete any channel or object (without reading private content); delete messages in public channels and in private channels they're a member of; view the audit log. |
| Member | Use the workspace; create public and private channels, documents, whiteboards and files; share what they own. |

Guest and external-collaborator accounts are out of scope for the first release. A **guest** role is planned for Phase 2. Guests can see only the channels and documents explicitly shared with them. They never see the member directory, public channels or workspace-wide search, and they can't create channels or invite others. The `users.role` column reserves this value, so adding guests needs no schema redesign.

The baseline role model is validated through interviews with at least five design-partner teams before Phase 1 exits.

**Groups.** Admins create named groups (for example, teams or departments) and appoint group managers. A group can be granted access to documents, folders, drives and calendars. It can't be a member of a channel: "invite this group" adds its members individually.

The full role and access rules, including the permission matrix for every object type, are in [specs/permissions.md](specs/permissions.md).

**Channels.**

- *Public channels:* every member can find, read and join them.
- *Private channels:* visible only to their members. **Members can add people; channel admins remove them.** Workspace admins can archive or delete private channels and remove members, but **can't join or read them** unless a member adds them.
- *Announcement channels:* everyone can read; only channel admins and chosen posters write.
- *Direct messages and group DMs:* visible only to their participants.

Channel roles are *channel admin* (rename, manage members, archive), *poster* (announcement channels) and *channel member*.

**Documents, whiteboards, folders, drives and files.**
- **Roles:** *owner*, *editor*, *commenter* and *viewer* (drives add *manager*). They can be granted to a user, a group, or a channel's members.
- **General access:** *restricted*, *workspace can view*, *workspace can comment* or *workspace can edit*.
- **Effective access is the union** of the item's own grants, its folders up to the drive, the drive, and general access; the highest role wins. Sharing can widen access, never narrow it below what the folder gives.
- **New items take their container's access:**
  - My files: private
  - a shared or group drive or folder: that drive's or folder's access
  - a channel folder: channel members, who can edit.

  Nothing starts workspace-wide unless its folder is.
- **A channel made private** keeps any explicitly wider shares on items in its folder. The conversion dialog lists them so the channel admin can restrict them first.
- **Group drives** are listed by name to everyone; their contents are visible only to the group unless shared.

**Files attached to messages** belong to the message and share its access. Drive files follow the document rules.

**Calendars.**
- **Personal calendars** show others only when the person is busy (*free/busy*).
- **Group calendars** are viewable by every member. Standalone calendars are shared like documents.
- **Private events** show calendar editors a "busy" block they can't open or edit. Invitees always see the details.
- **Time off:** everyone sees the dates; the type and note are visible only to the member.

- **Orphaned private events:** if a private event's organiser is disabled or deleted, an owner or admin can delete it without seeing its details.
- **Purged group and channel calendars:** each event moves to its organiser's personal calendar so attendees keep it.

**Comments and calls on documents.** Document owners, editors and admins can remove others' comments. Anyone who can open a document, viewers included, can start a call on it.

**Restoring from Trash** follows one rule everywhere: the item's owner, the person who deleted it, drive managers of its drive, and admins.

**Projects (Phase 2).** Public or private, like channels.

**Administrative access to private content.**

- Admins and owners **cannot read** private channels, DMs or restricted documents in the app unless they are granted access.
- Admins can see that private objects exist (name, member count, size) and can delete them. Every such action is audited.
- Officebox states clearly that the Cloudflare account owner has direct technical access to all stored data. Content is not end-to-end encrypted.

### 10.2 Retention and deletion (baseline)

These rules are the baseline for the Phase 1 schema. Full detail per object, including who can restore from Trash, is in [platform §5](specs/platform.md). Phase 1 uses the fixed defaults below. **Configurable retention policies** arrive in Phase 2: owners can set per-workspace and per-channel auto-deletion of messages and files after N days. The schema supports them from the start, through `purge_after` and the purge pipeline.

| Data | Default retention | On deletion |
|---|---|---|
| Messages | Kept until deleted | The author, a channel admin, or a workspace admin (public channels and private channels they belong to) deletes a message. Its body, attachments and reactions are removed immediately from the channel, the D1 copy and the search and AI indexes. A "message deleted" tombstone keeps thread structure intact. |
| Channels | Kept until deleted | Archive is reversible. Delete moves the channel to Trash for 30 days, then it is purged with all its messages. |
| Documents and whiteboards | Kept until deleted | Moved to Trash for 30 days, restorable under the Trash rule (§10.1), then purged along with all revisions and snapshots. |
| Document revisions | Same as the parent document | Purged with the parent. |
| Files | Kept until deleted | Moved to Trash for 30 days, then the R2 object and its metadata are purged. Files attached to a deleted message are purged with it. |
| Inbox items | 90 days after being completed or dismissed | Purged automatically. Underlying objects are unaffected. |
| User accounts | Disabled accounts are kept indefinitely | **Disable** (the default) blocks sign-in and keeps everything. **Delete** removes personal data (email, passkeys, MFA, sessions, preferences) and shows the person as "Former member". Content they authored belongs to the workspace and stays. Ownership of their documents passes to an admin. |
| Audit log | 365 days, configurable | Purged automatically. It never stores message or document content. |
| AI interaction logs (Phase 3) | 30 days, configurable by an owner (`assistant_interaction_retention_days`) | Metadata only, never prompts or replies. Purged automatically. |
| Assistant memory (conversations and remembered items) | 365 days **(default)**, set by an owner (`assistant_memory_retention_days`). Members can shorten it for themselves. | Private to the member. Members can delete one item, a conversation or everything. Content derived from a deleted source is purged; content whose source the member can no longer open is hidden at once and deleted after 7 days **(default)**. Erased when the member is deleted. |
| Incognito assistant conversations | Until the member ends them, or 24 hours after their last activity **(default)** | Never remembered. |
| Personal reminders | Until done or dismissed | Deleted 30 days after done or dismissed **(default)**. Erased when the member is deleted. |
| Call (huddle) history | 365 days | Metadata only (context, participants, times, rings). No audio, video or screen content is ever recorded. Text transcripts exist only when someone turns on call notes (next row). Separate from in-call chat. |
| Call notes and transcripts | Notes: life of their context. Transcripts: 90 days **(default)**, set by an owner (`call_transcript_retention_days`). | Transcripts are purged with their search vectors. Deleting the channel, event or document deletes its notes and transcripts. |
| In-call chat | Life of its context | Channel and DM calls: a thread in the conversation. Document and event calls: kept with the document or event, not purged with the call record. |
| Calendars and events | Kept until deleted | Trash for 30 days, restorable under the Trash rule (§10.1). Purged group and channel calendars move their events to the organisers' personal calendars. |
| Time off | Until the member deletes it | No Trash: a deleted entry is kept for audit and hard-deleted 30 days later. Erased when the member is deleted (it can contain sensitive types). |
| External attendee emails | 90 days after the event ends (the last occurrence, for a series) | Purged automatically |
| Drives and folders | Kept until deleted | Trash for 30 days, restorable under the Trash rule (§10.1) |
| Comments | Life of the document | Deleted immediately when the author, the document owner, an editor or an admin deletes them |
| File versions | With their file (at most 100 versions; the oldest are dropped first) | Purged with the file |
| Polls and votes | Life of the channel | Votes are stored only as per-poll hashed keys |
| Saved items | Until removed, or until access is lost or the message is deleted | — |
| Access requests | Pending ones expire after 30 days; decided ones are kept 90 days | Purged automatically |
| Search and AI indexes | Same as the source object | Updated or removed whenever the source is edited, deleted or has its access changed. The AI index is built only while the assistant is enabled, and an owner can delete it. |

**Platform recovery windows.** Cloudflare keeps point-in-time recovery data for up to 30 days: D1 Time Travel, Durable Object point-in-time recovery, and R2 noncurrent versions if the customer enables versioning. So purged data can remain recoverable by the account owner for up to 30 days after purge. Officebox documents this rather than promising instant permanent erasure.

## 11. AI and model-provider strategy

### BYOK via AI Gateway

Customers store their own model-provider API keys in Cloudflare AI Gateway's BYOK feature. Keys are stored securely in Secrets Store and referenced by the gateway at runtime; applications make requests without exposing provider keys. Multiple keys per provider and key rotation are supported without code changes.

Potential providers: OpenAI, Anthropic, Google Gemini, Workers AI, and optional local models through a compatible runtime.

The assistant works with Workers AI straight after deploy. An owner can move each model role (chat, summaries, speech, vision) to their own provider through AI Gateway, where AI Gateway supports that role. Embeddings use Workers AI.

### AI safety and governance

- API credentials are never exposed to browser JavaScript.
- Provider keys are stored in Secrets Store and referenced only via AI Gateway.
- Retrieval enforces the same permissions as normal application access.
- Users do not receive answers based on documents or messages they cannot access.
- Retrieved workspace content is untrusted input, not trusted instruction. Prompt-injection attempts in documents, messages and files must not override system policy or grant tool authority. The same applies to transcripts, pasted text and the member's own stored history and memory.
- The assistant has no access of its own. It acts as the person asking, or, in shared conversations, for the audience (§5.9).
- AI Gateway request logging and caching are turned off for assistant traffic **(default)**.
- Tool access is permission-checked server-side.
- Mutating or sensitive actions require confirmation where appropriate.
- Important AI actions and tool invocations are auditable.
- AI interaction and audit retention is defined and configurable.
- **Visibility of AI logs:**
  - Each user can see and delete their own assistant conversation history and memory.
  - Owners and admins can see *metadata* for every AI interaction: who, when, which model, which tools ran, which workspace objects were read or changed, and the outcome.
  - Owners and admins **cannot** see prompt, response or memory content, which follows the same rule as private content (§10.1).
  - Tool actions that changed data are also recorded in the audit log.
- AI outages do not disable core collaboration.

The initial AI release (Phase 3, PLAN M9) is a personal assistant with private memory for every member (§5.9, [specs/assistant.md](specs/assistant.md)).

**What the privacy guarantee covers:**
- **Within Officebox.** The guarantee holds inside the application.
- **Model provider.** Prompts and audio go to the configured model provider: Workers AI by default, or a BYOK provider an owner chooses.
- **Cloudflare account access.** Anyone with direct access to the customer's Cloudflare account (for example Durable Object storage) is outside Officebox's control.
- **Logging.** Officebox turns off AI Gateway request logging and caching for assistant calls.
- **Other members' data.** Memory may hold things a member said about other people. Those stay in the member's memory until it's deleted or retention expires, even if the other person's account is deleted.

The privacy statement ([permissions §6](specs/permissions.md)) says all of this.

## 12. Open-source reuse and integration strategy

Officebox reuses mature open-source projects and libraries wherever practical, while owning the integrated experience, identity, permissions, durable workspace model and contextual relationships.

### Integration levels

1. Embedded libraries/components: Tiptap editor, Yjs, board UI components and other frontend capabilities integrated into the React application.
2. Cloudflare-native services: Durable Objects, D1, R2, Vectorize, Workers AI, AI Gateway, Realtime SFU and Queues.
3. Optional services: email (Cloudflare Email Service by default, or an external API provider or SMTP relay); model providers via BYOK.

Every candidate is assessed for licence, maturity, security, React integration, identity integration, data ownership, deployment footprint and replaceability.

Officebox avoids components that create competing sources of truth or force users into separate application experiences.

## 13. Operational product experience

### One-click deployment

The primary deployment mechanism is the Deploy to Cloudflare button. It copies the repository into the customer's GitHub account, configures the project, provisions the supported Cloudflare resources (Durable Objects, D1, R2, Vectorize, Queues) and deploys the application. D1 migrations run as part of the deploy script. GitHub is the supported host in the first release, because upgrades rely on GitHub Actions; GitLab support is a later consideration.

During deployment the customer can set a setup token secret. If they skip it, the application generates a one-time token and writes it to the Worker's logs, which only the Cloudflare account can see. The first visit to the workspace asks for this token before the owner account can be created.

**Custom domain.** Using a custom domain is recommended before inviting the team. Sign-in, installed PWAs, push subscriptions and **passkeys** are tied to the domain. Changing it later is an explicit owner action: it signs everyone out, push must be re-enabled, and passkeys stop working; members sign in again with a magic link (when email is configured) or a recovery link, admins and owners with a recovery link, and everyone registers a new passkey. Officebox warns when a passkey is registered on a `workers.dev` address.

**Data location.** D1 keeps its primary copy in one location, chosen at deployment with a location hint. Durable Objects are created near their first user. Performance targets assume members are in the same broad region as the data; members elsewhere see higher latency. An **EU data-residency option** (Phase 2) keeps D1, R2 and Durable Objects in Cloudflare's EU jurisdiction wherever each service supports it.

Some capabilities need a short manual step after deployment. The admin UI shows these as a post-deploy checklist:
- allowing GitHub Actions to open pull requests, needed for upgrades
- AI Gateway provider keys
- Realtime SFU credentials
- Email provider API key or SMTP credentials (not needed with Cloudflare Email Service)
- a custom domain

The customer does not manage servers, databases, ports or certificates. There is no persistent volume to provision and no backup policy to configure manually.

### Upgrades and rollback

A safe, understandable upgrade path is a product requirement:

- **Versioned releases.** Officebox publishes signed, semantically versioned releases.
  - Stable channel: `vX.Y.Z` tags from the main branch.
  - Beta channel: `vX.Y.Z-beta.N` tags from the beta branch. Free and opt-in.
- **Update awareness.** The workspace checks the public Officebox release feed daily. It shows owners the installed version, any available update for their channel, release notes, and a prominent flag on security releases.
- **Upgrade delivery as a pull request.** The customer's repository is a disconnected copy, so it includes a release-sync GitHub Actions workflow. It runs on a schedule, or on demand when the owner clicks **Check for updates now** in GitHub. When a new release is available on the chosen channel, the workflow opens a pull request in the customer's repository. The PR contains the release notes, migration notes and a rollback-compatibility statement.
- **Upgrading is merging.** Merging the pull request triggers Workers Builds, which runs migrations and deploys the new version. The admin UI links directly to the open pull request. No Cloudflare or GitHub credentials are stored inside the running application.
- **Optional auto-merge.** Owners can opt in to automatic merging of patch and security releases on the stable channel.
- **Customisation.** Customers may modify their copy, but only changes inside documented extension points are guaranteed to merge cleanly. If a release conflicts with local changes, the pull request is marked as conflicted and links to resolution guidance.
- **Channel selection.** The channel is a setting in the customer's repository, shown in the admin UI. Switching from beta back to stable takes effect at the next stable release that is newer than the installed beta.
- **Build history and rollback.** Workers Builds keeps build history and logs for 90 days. Worker versions remain in version history and can be rolled back from the Cloudflare dashboard or Wrangler, which immediately creates a new active deployment. To make a rollback permanent, the customer also reverts the upgrade pull request so the next build doesn't redeploy it.
- **Rollback-compatible migrations.** Every release's database changes must work with the previous release's code, so rolling back one version never needs a database restore. Changes that can't meet this rule (for example, dropping data) are spread over at least two releases and called out in the release notes.
- **Pre-upgrade checks.** The deploy step checks the required resources and bindings before migrating.
- **Clear migration status.** Progress and failures are shown in the admin UI and the build log.

### Health and diagnostics

The administrator experience includes:

- Health and readiness status for the Worker, Durable Objects, D1, R2, Vectorize and (once configured) Realtime SFU.
- Disk/storage visibility (R2 usage, D1 storage).
- **Usage and cost panel:** month-to-date usage against the Workers Paid allowances, with projected overage. With an optional read-only Cloudflare analytics token it shows Cloudflare's own figures. Without one, it uses Officebox's own counters. Owners are prompted to set Cloudflare billing notifications, because Cloudflare has no hard spending cap.
- **Post-deploy checklist** status (see One-click deployment).
- Application version and upgrade status.
- Backup and data export status.
- Diagnostic information and a support bundle. The owner reviews the bundle before sharing it, and sends it only by attaching it to a support request. It contains versions, configuration, counts and error summaries. It never contains message, document or file content, email addresses or secrets.
- **Optional telemetry,** off by default. If enabled, a weekly anonymous report sends Officebox the version, channel, a member-count range, enabled features and error counts. It never sends content, names or emails. Owners can view the exact payload before turning it on.
- Clear guidance for moving or restoring an installation.

Officebox does not claim that a backup exists or is healthy unless it has reliable evidence.

### Storage, backup and data ownership

All persistent application data lives in the customer's Cloudflare account:

- D1: users, groups, permissions, channel and document metadata, a searchable copy of messages, projects, issues, inbox records, audit logs.
- Durable Object SQLite: authoritative message history per channel, Yjs CRDT state per document/whiteboard, and each member's assistant conversations and memory. Presence is held in memory only and is not persisted.
- R2: files and attachments.
- Vectorize: embeddings for AI retrieval.

D1 Time Travel provides point-in-time recovery to any minute within the last 30 days. R2 provides object versioning and lifecycle policies. Officebox provides an application-level export for portability and supplementary recovery, including file data and metadata.

**Export and restore:**

- **Format:** owners can produce an **Officebox export**, a versioned archive written to the installation's R2 bucket. It contains:
  - a manifest (format version, Officebox version, counts, checksums)
  - one JSON Lines file per table
  - channel messages
  - document and whiteboard state, both in native Yjs form and as readable Markdown or JSON
  - all files and their versions
  - calendars, events, attendees and time off; drives and folders; comments; polls (votes as hashed keys only); saved items and preferences.

  **Excluded:** sessions, sign-in tokens, passkeys (members register again after a restore to a new domain), MFA secrets, ICS feed tokens and the URLs of subscribed external calendars, which are secrets. Full coverage is in [platform §6](specs/platform.md).

  **Assistant data:** the export includes assistant interaction metadata, and call notes and transcripts within retention. It **excludes** assistant conversations and memory **(default)**, because admins can't read them, and personal reminders. Members download these themselves with "Download my assistant data" ([specs/assistant.md](specs/assistant.md) §13).

  The format is documented and stable across versions, so other tools can read it.
- **Running exports:** an export can be started on demand or on a schedule (for example, weekly). Each export is internally consistent per object, recording each channel's message position and each document's state. It is not one instant across the whole workspace. For a fully consistent export, the owner can put the workspace in read-only maintenance mode while the export runs.
- **Restore:** a fresh Officebox installation offers **Restore from export** as an alternative to first-run setup. It imports everything into the new installation, which is also how a workspace moves to a different Cloudflare account. A command-line restore tool covers very large exports. Assistant memory is not part of a restore, and the AI index is rebuilt by back-fill.
- **Testing:** restore is tested on every release.

Data ownership is the customer's. They can export, delete or migrate their data at any time. Deletion follows the rules in §10.2, including Cloudflare's recovery windows of up to 30 days. Officebox does not hold customer data outside the customer's Cloudflare account.

Admin settings and rate limits are listed in [platform §7–§8](specs/platform.md).

Missing backup or export configuration does not block startup. Demos, evaluation and development remain possible. Warnings are visible to administrators, not ordinary users.

### Storage exhaustion

Officebox monitors each store against its real limit and never silently discards messages or documents to free space.

- **D1 (10 GB hard limit per database):**
  - Admins are warned at 70% and 85%.
  - At 95%, **protective mode** pauses creating new channels, documents, files and invitations. Messaging continues, because messages are stored in their channels first.
  - Admins are guided to free space. The most effective step is shortening how long the *searchable copy* of old messages is kept: older messages stay in their channels and exports but drop out of search. Emptying Trash, retention policies and archiving also help.
- **Durable Objects (10 GB per channel or document):** admins are warned if any single channel or document approaches the limit. This is very unlikely for small teams.
- **R2 (no hard limit; a cost question):** owners can set a storage budget. Admins are warned when it is exceeded, and new uploads can be blocked above a hard budget the owner sets.

## 14. Explicitly out of scope initially

- Building or hosting an email server.
- Replacing Excel or providing a full spreadsheet suite.
- Building a video-conferencing platform or SFU from scratch.
- Complex enterprise workflow automation.
- Federation across independent Officebox installations.
- Public multi-tenancy and workspace switching.
- Mandatory external identity-provider integration.
- Kubernetes-based deployment (Cloudflare-native only).
- Native desktop and native mobile apps at launch.
- Enterprise-scale compliance and administration features before customer need is demonstrated.
- Recording calls, remote control of shared screens, and annotation on shared screens.
- Malware scanning of uploaded files.

## 15. Phased delivery

Phases describe product capability, not a requirement to postpone foundational architecture. Durable Objects, the shared workspace object model, permissions and durable event handling are architectural foundations even when some user-facing features arrive later.

### Phase 1 — First release

Delivered in the milestones in [PLAN.md](PLAN.md): foundation → identity → realtime → chat → calls → calendar → documents, with operations and the Personal Inbox alongside.

- One-click Deploy to Cloudflare deployment.
- Token-protected first-run setup.
- Single-workspace identity and local accounts in D1, with the baseline role model (§10.1).
- Trash, purge and the retention rules in §10.2.
- Member invitations and basic administration.
- React application shell and responsive experience.
- Passwordless sign-in with passkeys (and magic links for members); profiles, @handles, groups and group managers (§6).
- Notifications, levels, do-not-disturb and offline email (§8).
- Chat: channels, announcement channels, DMs and group DMs, threads, pins, saved items, polls and link previews (§5.4).
- Durable message history in channel Durable Objects, with a D1 copy for search.
- Calls: channel and DM calls with audio, video, screen sharing and ringing; event and document calls; present mode (§5.8).
- Calendar: personal, group, channel, standalone and workspace calendars, holidays, time off, invitations (including outside attendees), reminders, focus time, working location and ICS in and out (§5.10).
- Basic permission-filtered full-text search across messages and documents.
- Documents in drives and folders using Tiptap + Yjs in Durable Objects, with comments, version history, embeds, export and offline editing (§5.5).
- Whiteboards using Yjs in Durable Objects, standalone and embedded.
- Files in R2: message attachments and versioned drive files (§5.7).
- Personal Inbox with Today, Upcoming, Inbox, Assigned to me and Following views, using Officebox-native sources (§5.3).
- Explicit links between conversations and documents.
- Basic in-app notifications via Durable Objects.
- Email configuration for transactional email (Cloudflare Email Service sender domain, or a provider or SMTP).
- Application realtime via Durable Object WebSockets with hibernation.
- Health checks, diagnostics, storage protective mode, post-deploy checklist and usage panel.
- Owner recovery procedure.
- Markdown document import.
- Stable and beta channels with release-sync upgrade pull requests, update awareness in the admin UI, and rollback.
- Application export/migration foundation.

### Phase 2 — Connected collaboration and work management

- Guest role; SSO through Cloudflare Access; configurable retention policies.
- Imports from Slack, Notion and Google Docs; webhooks and the public REST API (§19).
- EU data-residency option.
- PWA installation and web push (including ringing when the app is closed).
- Projects, boards, issues and lightweight tasks.
- Two-way Google and Microsoft calendar sync; time-off approvals; booking pages.
- Document templates, public links and suggestion mode.
- Richer contextual object links and previews.
- TOTP MFA.
- Richer search filters and cross-object search.
- Improved notification preferences and digest controls.

### Phase 3 — Workspace intelligence

Delivered as PLAN M9 (M9a–M9d), after the Personal Inbox. Detail is in [specs/assistant.md](specs/assistant.md).

- A personal assistant for every member, with private memory (§5.9). Workers AI by default; BYOK via AI Gateway optional.
- Permission-aware semantic search and embeddings using Vectorize + Workers AI, indexed only while the assistant is enabled.
- AI-assisted document, message, calendar and reminder actions, each confirmed by the member. Task and issue actions arrive with projects.
- Audience-safe `@mentions` of the assistant in conversations.
- AI tool audit trail and configurable retention.
- Summaries of conversations, documents, files and calls, with action items from call notes.
- Push-to-talk, call notes and live captions (M9c), and live voice (M9d), with the notes rules in §5.8.
- Daily brief, meeting prep and commitment nudges, each opt-in, with personal reminders in the Personal Inbox (§5.3).

The exact sequencing should be validated against user research, component evaluations and implementation capacity. The calendar ships in its own milestone after calls (§5.10, PLAN M5).

## 16. Product success criteria

The initial product should be judged by whether a small organisation can:

- Deploy Officebox from the Deploy to Cloudflare button without specialist infrastructure knowledge.
- Invite and onboard its team, including when SMTP is not configured.
- Use chat and shared knowledge reliably.
- Find messages and documents they are authorised to see.
- Move between conversations and related workspace objects without losing context.
- Understand what needs their attention through a coherent Personal Inbox as that capability ships.
- Receive useful notifications without being overwhelmed.
- Collaborate in realtime and use calls without a separate account or disconnected workflow.
- Plan their time with shared calendars, holidays and time off in the same workspace.
- Operate without configuring AI.
- Configure AI without surrendering control of its provider account.
- Understand its storage, backup and data ownership responsibilities.
- Upgrade and roll back the installation using the stable or beta channel.

**Measurable targets** (measured with design partners):

| Metric | Target |
|---|---|
| Time from Deploy button to first message, without help | Median under 15 minutes |
| Invitation activation | 80% of invited members active within 7 days |
| Ongoing use | At least 70% of members active weekly after 4 weeks |
| Reliability | No acknowledged message or saved document edit ever lost |
| Support load | At most 1 support request per installation per month after onboarding |
| Cost | Median Cloudflare bill at or below $6/month for teams of up to 25 |

Before Phase 1 exit, validate at minimum:

- Search returns relevant authorised messages/documents and excludes inaccessible objects.
- A document can be created from a conversation and retains a navigable relationship.
- Manual invitation-link onboarding works without SMTP.
- An upgrade from stable to beta and rollback works on a representative installation. The release-sync workflow opens a correct pull request, merging it deploys the new version, and rolling back one version works without a database restore.
- A freshly deployed installation cannot be claimed without the setup token. The setup flow is disabled once setup completes.
- No acknowledged message is lost when the D1 copy is delayed or fails. Edits and deletions reach every connected client, the D1 copy and search.
- Deleting a message, document, file or user removes the content as described in §10.2, including from search indexes.
- A member without access cannot read a private channel, DM or restricted document through any route: the API, WebSocket, search, previews or links.
- The permission engine passes the matrix test across every role and object type in [specs/permissions.md](specs/permissions.md). Admins can't act on admins or owners without an owner.
- Disabling or deleting a member behaves as the lifecycle matrix in [platform §3](specs/platform.md) says, including dropping them from open calls, documents and channels.
- Email links (magic link, recovery, invitation, RSVP) survive being opened by a mail scanner without being used up.
- Storage warnings and protective mode behave safely as D1 approaches its limit, and trimming the searchable message copy frees space without losing messages.
- Durable Object WebSocket hibernation keeps idle channels connected without accruing billable duration.
- Durable Object Yjs sync supports a stock Yjs client and persists document state across object eviction.
- Missing backup/export configuration produces an administrator warning but does not block evaluation startup.

Cost success criterion: a team of 25 can operate within the Workers Paid plan at $5/month plus minimal R2/Realtime usage, with no per-seat charge. This is a target to be confirmed by load testing before it is used in marketing. The pre-test estimate is in TDD Appendix B.

## 17. Open product questions

Every question open at v1.1 now has a recommended decision, recorded here and in the sections listed. Decisions marked *Validate* are the working baseline but must be confirmed with design partners before the stated milestone.

| Question | Recommendation | Where | Status |
|---|---|---|---|
| Role model, and whether guests are needed sooner | Keep the §10.1 baseline. Guest role in Phase 2. Validate with at least five design-partner teams. | §10.1 | Validate before Phase 1 exit |
| Configurable retention policies | Fixed defaults in Phase 1. Per-workspace and per-channel auto-deletion in Phase 2. | §10.2 | Decided |
| Tiptap extension set | MIT open-source Tiptap packages only. No paid Tiptap cloud. Comments in Officebox's database, history on Officebox's own Yjs storage. | §5.5 | Decided |
| Revision history depth | Hourly for 7 days, daily for 90 days, named versions kept for the document's lifetime | §5.5 | Decided |
| Board/issue component | dnd-kit with Officebox's own D1 data model. No embedded standalone tracker. | §5.6 | Decided |
| Personal Inbox semantics | Ordering, grouping, states, snooze presets and automatic resolution as specified | §5.3 | Validate in usability testing before the Inbox milestone |
| Calendar | A first-class calendar in the first release, with ICS in (personal) and out. Two-way Google/Microsoft sync later. | §5.10 | Decided |
| AI log visibility | Users see and delete their own history. Admins see metadata only, never content. | §11 | Decided |
| Export format and restore | Versioned JSON Lines + Yjs + files archive in R2. "Restore from export" in a fresh installation. Restore tested every release. | §13; TDD §7.5 | Decided |
| Native mobile apps | Reconsider after Phase 2 if mobile is more than 30% of sessions and PWA limits are a top-three pain point. Start with a PWA wrapper. | §9 | Decided |
| Support plans and pricing | Community (free), Standard (~$49/month), Priority (~$199/month), one-off packages; all per installation | §1 | Validate pricing with design partners |

Resolved in v1.1:
- Role model and default permissions: baseline in §10.1.
- Data retention and deletion: baseline in §10.2.
- Beta access: free, opt-in (§1).
- Upgrade mechanism: release-sync pull requests (§13).

Feature-level open questions now live in each spec's "Open questions" section. New product questions should be added to this table with an owner and a decision deadline.

## 18. Non-functional requirements

| Area | Requirement |
|---|---|
| Accessibility | WCAG 2.2 AA for all core flows. Full keyboard operation, screen-reader labels and support for reduced motion. Live call captions arrive with the assistant's call features (PLAN M9c), separate from call notes. Single-key shortcuts can be turned off or remapped, and drag actions have keyboard and single-pointer alternatives. |
| Browsers | The latest two major versions of Chrome, Edge, Firefox and Safari on desktop. Safari on iOS 16.4+ and Chrome on Android for the PWA. Web push on iOS requires installing to the home screen. Screen sharing needs a desktop browser. |
| Languages | English at launch. All interface text is externalised for translation. Dates, times and numbers follow the user's locale. Right-to-left languages come later. |
| Availability | Inherits Cloudflare's platform availability; Officebox offers no separate uptime SLA (support plans cover response times). Chat and documents keep working when optional services (AI, email, calls) are unavailable. |
| Performance | The targets in TDD §9.2. |
| Security | OWASP ASVS Level 2 as the baseline for the web application (TDD §8). |
| Limits (defaults) | Designed and tested for 100 members (soft limit 250). Messages up to 40 KB (rich text up to 100 KB), with 20 attachments, 3 link previews and 50 distinct reactions per message. In-call chat: 20 messages per 10 seconds per person. Group DMs of 3–8 people; 100 pins per channel. Files up to 2 GB, with 100 versions per file. Calls of 25 participants, one screen share per call. Offline documents: 20, up to 100 MB. External calendar subscriptions: 50 per workspace. External invitation recipients: 50 per member per day. Documents tested to 5 MB of content. All limits and rate limits: [platform §8](specs/platform.md). |

## 19. Imports, integrations and APIs

- **Phase 1:**
  - Import Markdown and HTML files as documents.
  - Full export (§13).
- **Phase 2:**
  - Import a Slack workspace export: channels, threads, reactions, files, and the DMs included in the export. Users are matched by email.
  - Import Notion and Google Docs exports as documents.
  - Incoming webhooks to post into channels.
  - Outgoing webhooks for selected events.
  - A documented REST API (OpenAPI) with personal access tokens that carry the user's own permissions.
- **Later:** bot users and an app framework, once API usage is understood.
- Assisted migration is also available as a paid service (§1).

---

## Appendix A — Product decision register

| Decision | Baseline | Status |
|---|---|---|
| Product direction | Cloudflare-native, self-owned workspace | Agreed |
| Target organisation | Approximately 5–100 people | Agreed |
| Workspace model | One installation = one Cloudflare account = one workspace | Agreed |
| Product experience | One connected environment, not stitched-together applications | Agreed |
| Personal Inbox | First-class view of the user's day, attention and assigned work | Agreed direction |
| Platform | Cloudflare-native; no VPS, no Go monolith | Agreed |
| Frontend | React + TypeScript | Agreed |
| Runtime | Workers (TypeScript/JavaScript) | Agreed |
| Application realtime | Durable Objects WebSockets with hibernation | Agreed |
| Collaborative editing | Durable Objects + Yjs; Tiptap frontend | Agreed |
| Database | D1 (SQLite) | Agreed |
| Vector search | Vectorize + Workers AI embeddings | Agreed |
| Media | Cloudflare Realtime SFU (SFU + TURN) | Agreed |
| File storage | R2 | Agreed |
| AI | Workers AI by default; BYOK via AI Gateway optional, per model role | Agreed ([assistant](specs/assistant.md)) |
| Authentication | Built-in local accounts, **passwordless**: passkeys for everyone (user verification required), magic links for members only, no passwords; owners need a second passkey or the recovery secret before inviting; exports include passkey public keys; TOTP after launch | Agreed (revised 15 Nov 2026) |
| Authentication library | **better-auth** (MIT) for sessions, magic links and passkeys; exact version pins and an advisory review on every upgrade | Agreed (15 Nov 2026) |
| First-run setup | Protected by a one-time setup token; disabled after use | Agreed |
| Role model | Owner/admin/member workspace roles; channel, drive and calendar roles; union inheritance; admins cannot read or join private content; only owners act on admins and owners | Agreed ([permissions](specs/permissions.md)) |
| Retention and deletion | Kept until deleted; 30-day Trash; immediate message deletion; documented 30-day platform recovery window | Baseline |
| Message storage | Channel Durable Object is the source of truth; guaranteed asynchronous copy to D1 for search, inbox and export | Agreed |
| Onboarding | Invitation-based; manual links supported without SMTP | Agreed |
| Email | Cloudflare Email Service by default; external API provider or SMTP as alternatives; no mail server | Agreed (revised 15 Nov 2026) |
| Notifications | Central service with multiple delivery adapters; All/Mentions/Mute/Nothing; DND holds banners, email and rings; "Notify anyway"; no text in DM and private-channel emails unless opted in | Agreed ([notifications](specs/notifications.md)) |
| Web push | Phase 2 | Agreed |
| Tasks/projects | Phase 2 | Agreed |
| Personal AI memory | In the first AI release: private to each member, never used for anyone else, not readable by admins; view, delete, incognito and an owner-set retention window | Agreed ([assistant](specs/assistant.md)) |
| Assistant name | Admin-set display name, default "Butler"; code and tables say `assistant` | Agreed (AGENTS §8 exception) |
| Assistant mentions | Audience-safe: shared replies use only sources the whole audience can open, never the asker's memory or private material | Agreed |
| Assistant voice | Push-to-talk and call notes (M9c); live voice (M9d) | Agreed |
| Call notes | Visible and stoppable: banner naming who started them and who can read them; mandatory notice on joining; anyone can stop; captions separate and never stored | Agreed |
| AI Gateway logging | Off for assistant traffic (default) | Agreed |
| AI privacy scope | The guarantee holds within Officebox; content goes to the configured model provider; Cloudflare account access is outside Officebox's control; memory may hold what a member said about others (§11) | Agreed |
| AI task and issue actions | Arrive with projects, not in the first AI release | Agreed |
| Guest accounts | Guest role in Phase 2 with access to explicitly shared channels and documents only | Agreed |
| Editor licensing | MIT Tiptap packages only; no paid Tiptap cloud dependency | Agreed |
| Board UI | dnd-kit on Officebox's own data model | Agreed |
| Calendar | First-class calendar in the first release: all calendar kinds, holidays for all countries, declared time off, outside invitations with limits, ICS in and out | Agreed ([calendar](specs/calendar.md)) |
| Chat files | Belong to their message; "Save to folder" copies them into a drive; DM files stay in the DM | Agreed |
| Document defaults | New items follow their container's access; My files private; channel folders editable by channel members | Agreed |
| Calls | Ad-hoc, audio-first; channel calls never ping; DM calls ring; event and document calls; 25 participants | Agreed ([calls](specs/calls.md)) |
| Feature names | Generic names for now; marketing names later | Agreed |
| AI log visibility | Users: own history; admins: metadata only | Agreed |
| Export and restore | Versioned open archive; Restore from export in a fresh installation | Agreed |
| Support plans | Community, Standard and Priority plus one-off packages; per installation | Pricing to validate |
| Screen sharing | Screen, window or tab; one presenter at a time with take-over; text-first quality; desktop sharing, view anywhere; admin policy and resolution cap | Agreed |
| Present mode | Follow-the-presenter for documents and whiteboards, with no video | Agreed |
| SSO | Through Cloudflare Access in Phase 2; native OIDC later if needed | Agreed |
| Imports and API | Markdown import in Phase 1; Slack, Notion and Google Docs imports, webhooks and REST API in Phase 2 | Agreed |
| Non-functional baseline | WCAG 2.2 AA; latest two browser versions; OWASP ASVS L2 | Agreed |
| Backup responsibility | Customer owns Cloudflare account; Officebox provides export and D1 Time Travel guidance | Agreed |
| Deployment | Deploy to Cloudflare button; supported resources provisioned automatically; post-deploy checklist for the rest | Agreed |
| Upgrade model | Stable and beta channels; release-sync GitHub Actions pull request; merge to upgrade; rollback-compatible migrations | Agreed |
| Licence | GNU AGPL-3.0; DCO for contributions | Agreed |
| Business model | All releases free, including security fixes; revenue from paid support, priority fixes and assisted setup/migration; customer pays Cloudflare directly for infrastructure | Agreed |
| Native apps | Deferred | Deferred |

## Appendix B — Related documents

- [Technical Design Document (TDD)](TDD.md): architecture, Durable Object design, D1 schema, Yjs sync, AI pipeline, deployment, upgrades and operations.
- [Feature specs](specs/): [identity](specs/identity.md), [chat](specs/chat.md), [calls](specs/calls.md), [calendar](specs/calendar.md), [documents](specs/documents.md), [assistant](specs/assistant.md); cross-cutting [permissions](specs/permissions.md), [notifications](specs/notifications.md) and [platform rules](specs/platform.md).
- [Build plan](PLAN.md): milestones, slices and the definition of done.
- [AGENTS.md](AGENTS.md): how we work, for people and coding agents.
- Open-Source Component Evaluation Register: candidate projects, licences, maturity, integration model, data ownership and replacement strategy.
- Architecture Decision Records (ADRs): detailed rationale for consequential technical choices.

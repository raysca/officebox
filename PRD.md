# Officebox — Product Requirements Document (PRD)

**Status:** Working baseline  
**Version:** 1.3  
**Date:** 14 November 2026  
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
- One integrated experience. Chat, documents, whiteboards, files, projects, issues and huddles are connected workspace objects, not disconnected apps.
- Realtime without operational burden. Presence, chat and collaborative editing work out of the box on Cloudflare's managed realtime primitives.
- AI on your terms. Bring your own model provider key via AI Gateway; AI is optional and never disables core collaboration.
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
6. AI-native, not AI-dependent. Core collaboration works with no AI configured.
7. BYOK via AI Gateway. Customers store their own provider keys in their own Cloudflare account.
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
- Meetings and collaboration sessions.
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
- Start a huddle from a document or project and retain context in the meeting.
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

The Personal Inbox ships in Phase 2. Phase 1 provides basic in-app notifications, which become the Inbox's first sources.

Initial conceptual views:

- Today: prioritised items for the current day.
- Upcoming: future commitments over the coming days/week.
- Inbox: items requiring acknowledgement, response or action.
- Assigned to me: tasks and issues assigned to the user.
- Following: relevant activity from conversations, documents and projects the user follows.

These are views over underlying workspace objects, not duplicate copies. Users can act on an item in context and return to the inbox without losing their place.

The Inbox distinguishes:

- Notifications: an event occurred.
- Action items: the user is expected to do something.
- Schedule items: something is planned for a particular time.
- Followed activity: something the user wants to stay informed about.

Users can acknowledge, dismiss, snooze, complete or follow items. Dismissing an inbox notification does not delete the underlying message, issue or document.

The first release uses Officebox-native sources: mentions, direct messages, assignments, review requests, due dates and project/document activity. Automatic commitment extraction arrives with AI in Phase 3.

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

**Calendar:**

- *Phase 2:* each user gets a private, revocable ICS feed URL of their Officebox schedule items (due dates, milestones, scheduled huddles). It can be subscribed to from Google Calendar, Outlook or Apple Calendar. This is outbound only, with no OAuth and no third-party data stored.
- *Phase 3 or later:* read-only, per-user Google and Microsoft calendar connections that show meetings in Today and Upcoming, if design partners ask for them. Write-back to external calendars is out of scope.

### 5.4 Chat and communication

Initial capabilities:

- Public and private channels.
- One-to-one direct messages.
- Durable message history and search.
- Threads/replies.
- Reactions.
- Mentions.
- Presence and unread indicators.
- Attachments.
- Links/previews to workspace objects.
- Notification preferences.

Messages are durable workspace data. Each channel's Durable Object stores that channel's message history in its own SQLite storage. This is the **source of truth** for the channel. A message is written there before it is shown to anyone. Every message change (create, edit, delete, reaction) is then reliably copied to D1, where it supports cross-channel search, the Personal Inbox, notifications and export. The realtime connection is never the only copy of a message. The D1 copy may lag by a few seconds but is guaranteed to catch up. WebSocket connections use the Hibernation WebSocket API, so idle channels do not accrue billable duration while clients remain connected.

Huddles are specified in §5.8.

### 5.5 Knowledge, documents and whiteboards

Officebox provides shared documents and knowledge pages that connect naturally to conversations and work.

Initial document capabilities:

- Rich document authoring using Tiptap with the Yjs Collaboration extension.
- Rendered editing with common formatting, headings, lists, links and images.
- Autosave and clear save state.
- Document title, ownership and access controls.
- Revision history. Automatic versions are kept hourly for 7 days and daily for 90 days. Named versions are kept for the document's lifetime. Users can view, compare and restore any version, and restoring creates a new version.
- Comments on documents, available to users with commenter access or higher (Phase 2).
- Searchable title and content.
- Links to originating conversations, projects and related issues.

Whiteboards are a first-class collaborative surface, built on the same Yjs collaboration model. Documents and whiteboards are both persisted as CRDT state in Durable Object SQLite, with periodic snapshots.

Officebox does not build a rich-text editing engine from scratch. The editor is Tiptap; collaborative state is Yjs. Officebox uses only the MIT-licensed open-source Tiptap packages:
- the core
- StarterKit
- Collaboration and the collaboration caret
- Link, Image, Table, Task list, Mention and Placeholder.

It does not depend on Tiptap's paid cloud features. Comments and version history are built on Officebox's own Yjs storage, so they stay in the customer's account and remain compatible with the AGPL. A stock Yjs client can connect to the Durable Object sync endpoint using the standard Yjs protocol (y-websocket).

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

Initial capabilities:

- Shared file storage and folders in R2.
- Uploads and attachments.
- File metadata and access controls.
- Download links and previews where practical.
- Links to messages, documents, projects and issues.
- Versioning phased in as requirements become clear.
- Files up to 2 GB by default (configurable by owners).
- Images, PDFs, audio and video preview in the browser. Other types, including HTML and SVG, download instead of opening, for safety.
- Owners can block chosen file types.
- Files are not scanned for malware (§14).

### 5.8 Realtime collaboration and huddles

Realtime is fundamental to Officebox. The architecture uses two distinct realtime planes:

- Application realtime (Durable Objects): chat delivery, presence, typing indicators, inbox updates and object-link changes. WebSocket connections to Durable Objects, with hibernation to keep idle cost near zero.
- Collaborative state (Durable Objects + Yjs): document and whiteboard editing. One Durable Object holds one document or whiteboard; the authoritative Y.Doc lives in the object and is persisted to its SQLite storage, with snapshots and compaction.

Media (huddles) uses Cloudflare Realtime SFU:

- **Instant huddles:** audio-first huddles start from conversations, documents and projects. Starting one notifies the context's members, and anyone with access to that context can join.
- **Video:** optional, and off by default.
- **Screen sharing and present mode:** see below.
- **No scheduling:** join and leave without calendar ceremony.
- **Visible context:** each huddle shows the context it started in and links back to it, and the context shows who is in the huddle. When a huddle ends, a short summary (duration, participants) is posted to the context.
- **Size:** up to 25 participants per huddle by default.
- **Controls:** mute, camera, share screen, raise hand and leave. The person who started the huddle, and channel admins for channel huddles, can mute participants and stop a share.
- **Encryption:** media is encrypted in transit. It passes through Cloudflare's SFU and is not end-to-end encrypted, and Officebox says so plainly.
- **TURN:** provided by Cloudflare Realtime, sharing the SFU free tier: the first 1,000 GB of egress per month is free, then $0.05/GB. For small-team audio huddles this is effectively free.

#### Screen sharing

Users can share their screen in any huddle, or start a huddle by sharing straight from a channel, DM, document or project.

- **What can be shared:** an entire screen, a single application window or a single browser tab, through the browser's standard picker. Tab audio can be included where the browser supports it (Chromium-based browsers). Full system audio is not promised.
- **One presenter at a time,** which keeps attention focused and bandwidth predictable. Another participant can ask to take over, and the presenter accepts with one click. The huddle starter or a channel admin can hand over directly.
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
- **Administration:** owners choose who may share (everyone by default, admins and channel admins only, or nobody). They can also cap share resolution at 720p or 1080p to limit bandwidth.
- **Not included:** remote control of another person's screen, annotation on shared screens, and recording (§14).

#### Present mode for documents and whiteboards

When the thing being shown is an Officebox document or whiteboard, users can **present** it instead of sharing their screen:

- Followers' views track the presenter's position, zoom and selection in real time, at full quality and with no video bandwidth.
- Any follower can break away to look around, then rejoin with one click.
- Present mode works inside a huddle or on its own. For example, a user can walk a colleague through a spec while talking on a call elsewhere.

#### Media usage

Screen sharing and video use the most bandwidth. As a guide, a 30-minute 1080p share watched by 8 people uses about 3–4 GB of SFU egress, so the free allowance covers a few hundred such sessions a month. The usage panel (§13) shows huddle bandwidth.

Delivery sequence:

1. Application realtime (Durable Objects) and core chat presence.
2. Collaborative documents and whiteboards (Durable Objects + Yjs).
3. Audio huddles (Realtime SFU).
4. Video, screen sharing and present mode.
5. Optional AI transcription, summaries and action items, with consent and retention controls.

Recording is not an initial requirement.

### 5.9 AI workspace assistant

The assistant helps users:

- Search permitted messages and documents.
- Summarise conversations and documents.
- Draft or create documents.
- Create and update tasks/issues.
- Answer questions grounded in workspace knowledge.
- Understand related workspace context.

The first AI release (Phase 3) is a permission-aware team workspace assistant. A separate personal assistant with private memory is deferred until its ownership, isolation, retention and retrieval rules are separately specified.

AI actions that modify data or affect external systems require confirmation and permission checks. Sensitive actions are auditable.

Semantic retrieval uses Vectorize with Workers AI embeddings. The retrieval pipeline filters results by the requesting user's permissions before returning content to the model.

## 6. Identity, onboarding and authentication

Initial product direction:

- Built-in local user accounts in D1.
- Invitation-based membership; no public registration.
- First-run setup creates the initial owner. **Setup is protected by a one-time setup token** that only the person who deployed can obtain, either set as a secret during deployment or read from the Worker's logs in their Cloudflare dashboard. Without the token, a freshly deployed URL cannot be claimed by anyone who finds it. Once setup completes, the setup flow is permanently disabled.
- Administrators invite members.
- Invitation links are single-use and expire.
- When email is unavailable, administrators can copy and share invitation links manually.
- Users complete account setup and receive a concise first-use introduction.

Planned security capabilities:

- Secure password storage.
- Secure browser sessions.
- Password reset when outgoing email is configured.
- Configurable email verification.
- TOTP multi-factor authentication.
- Account disablement and session revocation by administrators.
- Login activity visibility.

OIDC/SSO and passkeys are future considerations, not MVP dependencies.

Further identity capabilities:

- **SSO through Cloudflare Access (Phase 2):** customers can put their workspace behind Cloudflare Access, which is free for small teams. Officebox then signs members in with the company's identity provider, such as Google Workspace, Microsoft Entra, Okta or GitHub. This gives single sign-on and identity-provider MFA without Officebox implementing OIDC. Only existing or invited members can sign in this way. Owners can turn off local passwords for members.
- **Owner recovery:** if every owner is locked out (password and MFA lost, and no email configured), someone with access to the Cloudflare account can set a one-time recovery secret. The secret allows resetting one owner's password and MFA. Recovery is audited, and a banner shows until the secret is removed.
- **Disabled members:** their content stays. Their documents stay theirs until an admin transfers ownership, and their open issue assignments are flagged for reassignment.
- **Device data:** signing out clears cached workspace data from the device. Revoking a session clears it the next time that device connects.

## 7. Email

Officebox does not operate a mail server. It supports configurable outgoing email through an external SMTP service or relay. Likely uses:

- Invitations.
- Password resets.
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

User controls:

- Per-event preferences.
- Per-channel preferences.
- Per-conversation or per-channel mute settings.
- Do-not-disturb schedules.
- Email digest preferences.
- Per-device push settings where appropriate.

Potential notification events:

- Direct messages.
- Mentions.
- Thread replies.
- Channel invitations.
- Document sharing and review requests.
- Task/issue assignments.
- Due dates and project milestones.
- A huddle starting in a channel, document or project the user follows.
- Important security or system events.

The first release includes basic in-app notifications. PWA installation and web push are Phase 2.

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
| Owner | Everything an admin can, plus manage admins and owners, transfer ownership, and see installation, upgrade, backup and export settings. At least one active owner must always exist. |
| Admin | Invite, disable and remove members; reset member MFA; manage groups; configure email, notifications and storage thresholds; archive or delete any channel or object; view the audit log. |
| Member | Use the workspace; create public and private channels, documents, whiteboards and files; share what they own. |

Guest and external-collaborator accounts are out of scope for the first release. A **guest** role is planned for Phase 2. Guests can see only the channels and documents explicitly shared with them. They never see the member directory, public channels or workspace-wide search, and they can't create channels or invite others. The `users.role` column reserves this value, so adding guests needs no schema redesign.

The baseline role model is validated through interviews with at least five design-partner teams before Phase 1 exits.

**Groups.** Admins create named groups (for example, teams or departments). A group can be granted access anywhere a user can.

**Channels.**

- *Public channels:* every member can find, read and join them.
- *Private channels:* visible only to their members. Members are added by a channel admin.
- *Direct messages:* visible only to their participants.

Channel roles are *channel admin* (rename, manage members, archive) and *channel member*.

**Documents and whiteboards.** Resource roles are *owner*, *editor*, *commenter* and *viewer*. They can be granted to a user, a group, or a channel's members. Each document also has a general-access setting:

- *Restricted:* only explicit grants.
- *Workspace can view*, *workspace can comment* or *workspace can edit*.

Defaults:

- A document created from a public channel or from scratch: workspace can edit.
- A document created from a private channel or DM: restricted, with editor access for that channel's members.

**Files.** A file attached to a message, document or issue inherits the access of that object. Files in shared folders use the same grants and general access as documents.

**Projects (Phase 2).** Public or private, like channels.

**Administrative access to private content.**

- Admins and owners **cannot read** private channels, DMs or restricted documents in the app unless they are granted access.
- Admins can see that private objects exist (name, member count, size) and can delete them. Every such action is audited.
- Officebox states clearly that the Cloudflare account owner has direct technical access to all stored data. Content is not end-to-end encrypted.

### 10.2 Retention and deletion (baseline)

These rules are the baseline for the Phase 1 schema. Phase 1 uses the fixed defaults below. **Configurable retention policies** arrive in Phase 2: owners can set per-workspace and per-channel auto-deletion of messages and files after N days. The schema supports them from the start, through `purge_after` and the purge pipeline.

| Data | Default retention | On deletion |
|---|---|---|
| Messages | Kept until deleted | The author or a channel admin deletes a message. Its body, attachments and reactions are removed immediately from the channel, the D1 copy and the search and AI indexes. A "message deleted" tombstone keeps thread structure intact. |
| Channels | Kept until deleted | Archive is reversible. Delete moves the channel to Trash for 30 days, then it is purged with all its messages. |
| Documents and whiteboards | Kept until deleted | Moved to Trash for 30 days and restorable by the owner or an admin, then purged along with all revisions and snapshots. |
| Document revisions | Same as the parent document | Purged with the parent. |
| Files | Kept until deleted | Moved to Trash for 30 days, then the R2 object and its metadata are purged. Files attached to a deleted message are purged with it. |
| Inbox items | 90 days after being completed or dismissed | Purged automatically. Underlying objects are unaffected. |
| User accounts | Disabled accounts are kept indefinitely | **Disable** (the default) blocks sign-in and keeps everything. **Delete** removes personal data (email, password, MFA, sessions, preferences) and shows the person as "Former member". Content they authored belongs to the workspace and stays. Ownership of their documents passes to an admin. |
| Audit log | 365 days, configurable | Purged automatically. It never stores message or document content. |
| AI interaction logs (Phase 3) | 30 days, configurable | Purged automatically. |
| Huddle history | 365 days | Metadata only (context, participants, times). No audio, video or screen content is ever recorded. |
| Search and AI indexes | Same as the source object | Updated or removed whenever the source is edited, deleted or has its access changed. |

**Platform recovery windows.** Cloudflare keeps point-in-time recovery data for up to 30 days: D1 Time Travel, Durable Object point-in-time recovery, and R2 noncurrent versions if the customer enables versioning. So purged data can remain recoverable by the account owner for up to 30 days after purge. Officebox documents this rather than promising instant permanent erasure.

## 11. AI and model-provider strategy

### BYOK via AI Gateway

Customers store their own model-provider API keys in Cloudflare AI Gateway's BYOK feature. Keys are stored securely in Secrets Store and referenced by the gateway at runtime; applications make requests without exposing provider keys. Multiple keys per provider and key rotation are supported without code changes.

Potential providers: OpenAI, Anthropic, Google Gemini, Workers AI, and optional local models through a compatible runtime.

Different model choices may be configured for assistant responses, summarisation and embeddings.

### AI safety and governance

- API credentials are never exposed to browser JavaScript.
- Provider keys are stored in Secrets Store and referenced only via AI Gateway.
- Retrieval enforces the same permissions as normal application access.
- Users do not receive answers based on documents or messages they cannot access.
- Retrieved workspace content is untrusted input, not trusted instruction. Prompt-injection attempts in documents, messages and files must not override system policy or grant tool authority.
- Tool access is permission-checked server-side.
- Mutating or sensitive actions require confirmation where appropriate.
- Important AI actions and tool invocations are auditable.
- AI interaction and audit retention is defined and configurable.
- **Visibility of AI logs:**
  - Each user can see and delete their own assistant conversation history.
  - Owners and admins can see *metadata* for every AI interaction: who, when, which model, which tools ran, which workspace objects were read or changed, and the outcome.
  - Owners and admins **cannot** see prompt or response content, which follows the same rule as private content (§10.1).
  - Tool actions that changed data are also recorded in the audit log.
- AI outages do not disable core collaboration.

The initial AI release (Phase 3) includes a permission-aware team assistant. Personal assistant memory is deferred.

## 12. Open-source reuse and integration strategy

Officebox reuses mature open-source projects and libraries wherever practical, while owning the integrated experience, identity, permissions, durable workspace model and contextual relationships.

### Integration levels

1. Embedded libraries/components: Tiptap editor, Yjs, board UI components and other frontend capabilities integrated into the React application.
2. Cloudflare-native services: Durable Objects, D1, R2, Vectorize, Workers AI, AI Gateway, Realtime SFU and Queues.
3. Optional external services: SMTP relay for email; model providers via BYOK.

Every candidate is assessed for licence, maturity, security, React integration, identity integration, data ownership, deployment footprint and replaceability.

Officebox avoids components that create competing sources of truth or force users into separate application experiences.

## 13. Operational product experience

### One-click deployment

The primary deployment mechanism is the Deploy to Cloudflare button. It copies the repository into the customer's GitHub account, configures the project, provisions the supported Cloudflare resources (Durable Objects, D1, R2, Vectorize, Queues) and deploys the application. D1 migrations run as part of the deploy script. GitHub is the supported host in the first release, because upgrades rely on GitHub Actions; GitLab support is a later consideration.

During deployment the customer can set a setup token secret. If they skip it, the application generates a one-time token and writes it to the Worker's logs, which only the Cloudflare account can see. The first visit to the workspace asks for this token before the owner account can be created.

**Custom domain.** Using a custom domain is recommended before inviting the team. Sign-in, installed PWAs and push subscriptions are tied to the domain, so changing it later signs everyone out and push must be re-enabled.

**Data location.** D1 keeps its primary copy in one location, chosen at deployment with a location hint. Durable Objects are created near their first user. Performance targets assume members are in the same broad region as the data; members elsewhere see higher latency. An **EU data-residency option** (Phase 2) keeps D1, R2 and Durable Objects in Cloudflare's EU jurisdiction wherever each service supports it.

Some capabilities need a short manual step after deployment. The admin UI shows these as a post-deploy checklist:
- allowing GitHub Actions to open pull requests, needed for upgrades
- AI Gateway provider keys
- Realtime SFU credentials
- SMTP credentials
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
- Durable Object SQLite: authoritative message history per channel, Yjs CRDT state per document/whiteboard. Presence is held in memory only and is not persisted.
- R2: files and attachments.
- Vectorize: embeddings for AI retrieval.

D1 Time Travel provides point-in-time recovery to any minute within the last 30 days. R2 provides object versioning and lifecycle policies. Officebox provides an application-level export for portability and supplementary recovery, including file data and metadata.

**Export and restore:**

- **Format:** owners can produce an **Officebox export**, a versioned archive written to the installation's R2 bucket. It contains:
  - a manifest (format version, Officebox version, counts, checksums)
  - one JSON Lines file per table
  - channel messages
  - document and whiteboard state, both in native Yjs form and as readable Markdown or JSON
  - all files.

  The format is documented and stable across versions, so other tools can read it.
- **Running exports:** an export can be started on demand or on a schedule (for example, weekly). Each export is internally consistent per object, recording each channel's message position and each document's state. It is not one instant across the whole workspace. For a fully consistent export, the owner can put the workspace in read-only maintenance mode while the export runs.
- **Restore:** a fresh Officebox installation offers **Restore from export** as an alternative to first-run setup. It imports everything into the new installation, which is also how a workspace moves to a different Cloudflare account. A command-line restore tool covers very large exports.
- **Testing:** restore is tested on every release.

Data ownership is the customer's. They can export, delete or migrate their data at any time. Deletion follows the rules in §10.2, including Cloudflare's recovery windows of up to 30 days. Officebox does not hold customer data outside the customer's Cloudflare account.

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
- Recording huddles, remote control of shared screens, and annotation on shared screens.
- Malware scanning of uploaded files.
- A separate personal AI memory system in the first AI release.

## 15. Phased delivery

Phases describe product capability, not a requirement to postpone foundational architecture. Durable Objects, the shared workspace object model, permissions and durable event handling are architectural foundations even when some user-facing features arrive later.

### Phase 1 — Integrated workspace foundation

- One-click Deploy to Cloudflare deployment.
- Token-protected first-run setup.
- Single-workspace identity and local accounts in D1, with the baseline role model (§10.1).
- Trash, purge and the retention rules in §10.2.
- Member invitations and basic administration.
- React application shell and responsive experience.
- Channels and direct messages.
- Durable message history in channel Durable Objects, with a D1 copy for search.
- Basic permission-filtered full-text search across messages and documents.
- Shared documents using Tiptap + Yjs in Durable Objects.
- Whiteboards using Yjs in Durable Objects.
- R2 file uploads and attachments.
- Explicit links between conversations and documents.
- Basic in-app notifications via Durable Objects.
- SMTP configuration for transactional email.
- Application realtime via Durable Object WebSockets with hibernation.
- Health checks, diagnostics, storage protective mode, post-deploy checklist and usage panel.
- Owner recovery procedure.
- Markdown document import.
- Stable and beta channels with release-sync upgrade pull requests, update awareness in the admin UI, and rollback.
- Application export/migration foundation.

### Phase 2 — Connected collaboration and work management

- Audio huddles via Cloudflare Realtime SFU.
- Video, screen sharing and present mode (§5.8).
- Guest role; SSO through Cloudflare Access; configurable retention policies.
- Imports from Slack, Notion and Google Docs; webhooks and the public REST API (§19).
- Document comments; personal calendar (ICS) feed.
- EU data-residency option.
- PWA installation and web push.
- Projects, boards, issues and lightweight tasks.
- Personal Inbox with Today, Upcoming, Inbox, Assigned to me and Following views, using Officebox-native event sources.
- Richer contextual object links and previews.
- More complete document editing, revision history and collaborative awareness.
- TOTP MFA.
- Richer search filters and cross-object search.
- Improved notification preferences and digest controls.

### Phase 3 — Workspace intelligence

- BYOK team AI assistant via AI Gateway.
- Permission-aware semantic search and embeddings using Vectorize + Workers AI.
- AI-assisted document and issue/task actions.
- AI tool audit trail and configurable retention.
- Summaries and action-item extraction from conversations and meetings.
- Optional meeting transcription and summaries, subject to consent and retention controls.
- Further Personal Inbox intelligence, such as suggested follow-ups and extracted commitments, with user review and clear provenance.

The exact sequencing should be validated against user research, component evaluations and implementation capacity. Calendar support is an outbound ICS feed in Phase 2 and optional read-only calendar connections in Phase 3 or later (§5.3).

## 16. Product success criteria

The initial product should be judged by whether a small organisation can:

- Deploy Officebox from the Deploy to Cloudflare button without specialist infrastructure knowledge.
- Invite and onboard its team, including when SMTP is not configured.
- Use chat and shared knowledge reliably.
- Find messages and documents they are authorised to see.
- Move between conversations and related workspace objects without losing context.
- Understand what needs their attention through a coherent Personal Inbox as that capability ships.
- Receive useful notifications without being overwhelmed.
- Collaborate in realtime and use huddles without a separate account or disconnected workflow.
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
| Tiptap extension set | MIT open-source Tiptap packages only. No paid Tiptap cloud. Comments and history built on Officebox's own Yjs storage. | §5.5 | Decided |
| Revision history depth | Hourly for 7 days, daily for 90 days, named versions kept for the document's lifetime | §5.5 | Decided |
| Board/issue component | dnd-kit with Officebox's own D1 data model. No embedded standalone tracker. | §5.6 | Decided |
| Personal Inbox semantics | Ordering, grouping, states, snooze presets and automatic resolution as specified | §5.3 | Validate in Phase 2 usability testing |
| Calendar integration | Outbound per-user ICS feed in Phase 2. Optional read-only Google/Microsoft in Phase 3 or later. No write-back. | §5.3 | Decided |
| AI log visibility | Users see and delete their own history. Admins see metadata only, never content. | §11 | Decided |
| Export format and restore | Versioned JSON Lines + Yjs + files archive in R2. "Restore from export" in a fresh installation. Restore tested every release. | §13; TDD §7.5 | Decided |
| Native mobile apps | Reconsider after Phase 2 if mobile is more than 30% of sessions and PWA limits are a top-three pain point. Start with a PWA wrapper. | §9 | Decided |
| Support plans and pricing | Community (free), Standard (~$49/month), Priority (~$199/month), one-off packages; all per installation | §1 | Validate pricing with design partners |

Resolved in v1.1:
- Role model and default permissions: baseline in §10.1.
- Data retention and deletion: baseline in §10.2.
- Beta access: free, opt-in (§1).
- Upgrade mechanism: release-sync pull requests (§13).

New questions should be added to this table with an owner and a decision deadline.

## 18. Non-functional requirements

| Area | Requirement |
|---|---|
| Accessibility | WCAG 2.2 AA for all core flows. Full keyboard operation, screen-reader labels and support for reduced motion. Huddle captions arrive with transcription (Phase 3). |
| Browsers | The latest two major versions of Chrome, Edge, Firefox and Safari on desktop. Safari on iOS 16.4+ and Chrome on Android for the PWA. Web push on iOS requires installing to the home screen. Screen sharing needs a desktop browser. |
| Languages | English at launch. All interface text is externalised for translation. Dates, times and numbers follow the user's locale. Right-to-left languages come later. |
| Availability | Inherits Cloudflare's platform availability; Officebox offers no separate uptime SLA (support plans cover response times). Chat and documents keep working when optional services (AI, email, huddles) are unavailable. |
| Performance | The targets in TDD §9.2. |
| Security | OWASP ASVS Level 2 as the baseline for the web application (TDD §8). |
| Limits (defaults) | Designed and tested for 100 members (soft limit 250); messages up to 40 KB; 20 attachments per message; files up to 2 GB; 25 huddle participants; one screen share per huddle; documents tested to 5 MB of content. |

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
| AI | BYOK via AI Gateway | Agreed |
| Authentication | Built-in local accounts initially | Agreed |
| First-run setup | Protected by a one-time setup token; disabled after use | Agreed |
| Role model | Owner/admin/member workspace roles; channel and document resource roles; admins cannot read private content in the app | Baseline |
| Retention and deletion | Kept until deleted; 30-day Trash; immediate message deletion; documented 30-day platform recovery window | Baseline |
| Message storage | Channel Durable Object is the source of truth; guaranteed asynchronous copy to D1 for search, inbox and export | Agreed |
| Onboarding | Invitation-based; manual links supported without SMTP | Agreed |
| Email | External SMTP; no mail server | Agreed |
| Notifications | Central service with multiple delivery adapters | Agreed |
| Web push | Phase 2 | Agreed |
| Tasks/projects | Phase 2 | Agreed |
| Personal AI memory | Deferred pending separate privacy and retention design | Deferred |
| Guest accounts | Guest role in Phase 2 with access to explicitly shared channels and documents only | Agreed |
| Editor licensing | MIT Tiptap packages only; no paid Tiptap cloud dependency | Agreed |
| Board UI | dnd-kit on Officebox's own data model | Agreed |
| Calendar | Outbound ICS feed in Phase 2; optional read-only connections later | Agreed |
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
- Open-Source Component Evaluation Register: candidate projects, licences, maturity, integration model, data ownership and replacement strategy.
- Architecture Decision Records (ADRs): detailed rationale for consequential technical choices.

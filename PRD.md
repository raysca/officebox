# Officebox — Product Requirements Document (PRD)

**Status:** Working baseline  
**Version:** 1.0  
**Date:** 14 November 2026

## 1. Product summary

Officebox is a Cloudflare-native, self-owned workspace suite for small teams. It brings team communication, shared knowledge, files, projects, issues, meetings and an AI assistant into one integrated environment—deployed in one click, owned by the customer, and operated with no servers, databases, or ports to manage.

The headline proposition is pay once, $5/month Cloudflare workspace suite for you and your team. The customer brings their own Cloudflare account. Officebox is deployed directly from GitHub using the Deploy to Cloudflare button, which clones the repository into the customer's GitHub account, provisions all required Cloudflare resources, and deploys the application to their Cloudflare account in a few clicks. There is no per-seat billing. The customer pays Cloudflare for infrastructure (often within the Workers Paid plan at $5/month, which includes generous allowances for Durable Objects, D1, Vectorize and other services). Officebox charges only for big fixes and upgrades.

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
- Pay once, not per seat. Infrastructure cost is a flat Cloudflare bill—typically $5/month on the Workers Paid plan—regardless of team size.
- One integrated experience. Chat, documents, whiteboards, files, projects, issues and huddles are connected workspace objects, not disconnected apps.
- Realtime without operational burden. Presence, chat and collaborative editing work out of the box on Cloudflare's managed realtime primitives.
- AI on your terms. Bring your own model provider key via AI Gateway; AI is optional and never disables core collaboration.
- Upgrade on your schedule. Stable and beta channels, one-click upgrades, and rollback.

## 3. Target users and needs

### Primary customer

A small startup or team (5–100 people) that wants an integrated collaboration suite, wants to own its data, and does not want to run infrastructure.

### Typical users

- Workspace administrator: deploys Officebox, configures Cloudflare bindings, manages members and upgrades.
- Team member: communicates, collaborates, manages their own work.
- Team lead: coordinates channels, projects, documents and priorities.
- Knowledge worker: creates and searches documents, uses the AI assistant.
- Founder/operator: needs a clear view of commitments, blockers and progress without paying per seat.

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
4. Pay once, not per seat. Infrastructure cost is flat and predictable.
5. Realtime by design, durable by default. Realtime is a first-class capability; important data is persisted independently of connections.
6. AI-native, not AI-dependent. Core collaboration works with no AI configured.
7. BYOK via AI Gateway. Customers store their own provider keys in their own Cloudflare account.
8. Privacy and permissions by default. Every feature, including AI retrieval and previews, respects access controls.
9. Visible operational risks, not blockers. Warn about misconfiguration without preventing evaluation.
10. Safe upgrades. Stable and beta channels, rollback, and clear migration status.

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

The first release uses Officebox-native sources: mentions, direct messages, assignments, review requests, due dates and project/document activity. Calendar aggregation and automatic commitment extraction are added when the required integrations and semantics are defined.

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

Messages are durable workspace data, stored in D1. Realtime delivery uses Durable Objects and is separate from persistence; the realtime connection is never the only copy of a message. WebSocket connections use the Hibernation WebSocket API, so idle channels do not accrue billable duration while clients remain connected.

Huddles are specified in §5.8.

### 5.5 Knowledge, documents and whiteboards

Officebox provides shared documents and knowledge pages that connect naturally to conversations and work.

Initial document capabilities:

- Rich document authoring using Tiptap with the Yjs Collaboration extension.
- Rendered editing with common formatting, headings, lists, links and images.
- Autosave and clear save state.
- Document title, ownership and access controls.
- Revision history (initial depth validated during implementation).
- Searchable title and content.
- Links to originating conversations, projects and related issues.

Whiteboards are a first-class collaborative surface, built on the same Yjs collaboration model. Documents and whiteboards are both persisted as CRDT state in Durable Object SQLite, with periodic snapshots.

Officebox does not build a rich-text editing engine from scratch. The editor is Tiptap; collaborative state is Yjs. A stock Yjs client can connect to the Durable Object sync endpoint using the standard Yjs protocol (y-websocket).

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

### 5.7 Files

Initial capabilities:

- Shared file storage and folders in R2.
- Uploads and attachments.
- File metadata and access controls.
- Download links and previews where practical.
- Links to messages, documents, projects and issues.
- Versioning phased in as requirements become clear.

### 5.8 Realtime collaboration and huddles

Realtime is fundamental to Officebox. The architecture uses two distinct realtime planes:

- Application realtime (Durable Objects): chat delivery, presence, typing indicators, inbox updates and object-link changes. WebSocket connections to Durable Objects, with hibernation to keep idle cost near zero.
- Collaborative state (Durable Objects + Yjs): document and whiteboard editing. One Durable Object holds one document or whiteboard; the authoritative Y.Doc lives in the object and is persisted to its SQLite storage, with snapshots and compaction.

Media (huddles) uses Cloudflare Realtime SFU:

- Instant audio-first huddles from conversations, documents and projects.
- Optional video.
- Screen sharing as a subsequent capability.
- Join and leave without calendar ceremony.
- Clear indication of the context in which a session started.
- TURN is provided by Cloudflare Realtime and shares the SFU free tier: first 1,000 GB of egress per month is free, then $0.05/GB. For small-team audio huddles this is effectively free.

Delivery sequence:

1. Application realtime (Durable Objects) and core chat presence.
2. Collaborative documents and whiteboards (Durable Objects + Yjs).
3. Audio huddles (Realtime SFU).
4. Video and screen sharing.
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

The first AI release is a permission-aware team workspace assistant. A separate personal assistant with private memory is deferred until its ownership, isolation, retention and retrieval rules are separately specified.

AI actions that modify data or affect external systems require confirmation and permission checks. Sensitive actions are auditable.

Semantic retrieval uses Vectorize with Workers AI embeddings. The retrieval pipeline filters results by the requesting user's permissions before returning content to the model.

## 6. Identity, onboarding and authentication

Initial product direction:

- Built-in local user accounts in D1.
- Invitation-based membership; no public registration.
- First-run setup creates the initial administrator.
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
- Important security or system events.

The first release includes basic in-app notifications. PWA installation and web push are Phase 2.

Push payloads are generic by default and avoid sensitive message content. The client fetches the actual content after authenticating.

## 9. Desktop and mobile experience

Initial direction:

- Responsive React web application.
- Installable Progressive Web App (PWA) where supported.
- Browser notifications and Web Push on supported platforms.
- No mandatory native desktop or mobile application.

Native desktop, iOS and Android applications are deferred until customer demand justifies the additional build and maintenance burden. A future native client reuses the same backend, identity, workspace object model and notification services.

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
- AI outages do not disable core collaboration.

The initial AI release includes a permission-aware team assistant. Personal assistant memory is deferred.

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

The primary deployment mechanism is the Deploy to Cloudflare button. It clones the repository into the customer's GitHub/GitLab account, configures the project, provisions required Cloudflare resources (Durable Objects, D1, R2, Vectorize, AI Gateway) and deploys the application. Supported resources are automatically provisioned and bound without additional setup. D1 migrations run as part of the deploy script.

The customer does not manage servers, databases, ports or certificates. There is no persistent volume to provision and no backup policy to configure manually.

### Upgrades and rollback

A safe, understandable upgrade path is a product requirement:

- Versioned releases. Stable and beta channels.
- Stable channel: production releases deployed from the main branch.
- Beta channel: upcoming releases deployed from a beta branch, available to customers who opt in.
- One-click upgrade: the administrator triggers a new deployment from the chosen channel.
- Build history and rollback: Workers Builds retains build history and logs for 90 days; versions and deployments remain in version history and can be rolled back. Rollback to a previous Worker version immediately creates a new deployment and becomes the active deployment.
- Pre-upgrade checks: verify required resources and bindings before deploying.
- Clear migration status: surface progress and failure; document rollback limitations where D1 migrations are not reversible.

### Health and diagnostics

The administrator experience includes:

- Health and readiness status for the Worker, Durable Objects, D1, R2, Vectorize and Realtime SFU.
- Disk/storage visibility (R2 usage, D1 storage).
- Application version and upgrade status.
- Backup and data export status.
- Diagnostic information and a support bundle.
- Clear guidance for moving or restoring an installation.

Officebox does not claim that a backup exists or is healthy unless it has reliable evidence.

### Storage, backup and data ownership

All persistent application data lives in the customer's Cloudflare account:

- D1: users, messages, documents metadata, projects, issues, inbox records, audit logs.
- Durable Object SQLite: message history per channel, Yjs CRDT state per document/whiteboard, presence state.
- R2: files and attachments.
- Vectorize: embeddings for AI retrieval.

D1 Time Travel provides point-in-time recovery to any minute within the last 30 days. R2 provides object versioning and lifecycle policies. Officebox provides an application-level export for portability and supplementary recovery, using database-consistent methods and including file data and metadata.

Data ownership is the customer's. They can export, delete or migrate their data at any time. Officebox does not hold customer data outside the customer's Cloudflare account.

Missing backup or export configuration does not block startup. Demos, evaluation and development remain possible. Warnings are visible to administrators, not ordinary users.

### Storage exhaustion

Officebox monitors D1 storage, R2 usage and Durable Object storage. It warns administrators at configurable thresholds, rejects new uploads before storage exhaustion threatens integrity, and provides clear recovery guidance. It does not silently discard durable messages or documents to free space.

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
- A separate personal AI memory system in the first AI release.

## 15. Phased delivery

Phases describe product capability, not a requirement to postpone foundational architecture. Durable Objects, the shared workspace object model, permissions and durable event handling are architectural foundations even when some user-facing features arrive later.

### Phase 1 — Integrated workspace foundation

- One-click Deploy to Cloudflare deployment.
- Single-workspace identity and local accounts in D1.
- Member invitations and basic administration.
- React application shell and responsive experience.
- Channels and direct messages.
- Durable message history in D1 and Durable Object SQLite.
- Basic permission-filtered full-text search across messages and documents.
- Shared documents using Tiptap + Yjs in Durable Objects.
- Whiteboards using Yjs in Durable Objects.
- R2 file uploads and attachments.
- Explicit links between conversations and documents.
- Basic in-app notifications via Durable Objects.
- SMTP configuration for transactional email.
- Application realtime via Durable Object WebSockets with hibernation.
- Health checks and diagnostics.
- Stable and beta channels with one-click upgrades and rollback.
- Application export/migration foundation.

### Phase 2 — Connected collaboration and work management

- Audio huddles via Cloudflare Realtime SFU.
- Video and screen sharing.
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

The exact sequencing should be validated against user research, component evaluations and implementation capacity. Calendar aggregation depends on a deliberate calendar integration decision; it is not assumed to exist in Phase 1.

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

Before Phase 1 exit, validate at minimum:

- Search returns relevant authorised messages/documents and excludes inaccessible objects.
- A document can be created from a conversation and retains a navigable relationship.
- Manual invitation-link onboarding works without SMTP.
- An upgrade from stable to beta and rollback works on a representative installation.
- Storage warnings and upload rejection behave safely under low-storage conditions.
- Durable Object WebSocket hibernation keeps idle channels connected without accruing billable duration.
- Durable Object Yjs sync supports a stock Yjs client and persists document state across object eviction.
- Missing backup/export configuration produces an administrator warning but does not block evaluation startup.

Cost success criterion: a team of 25 can operate within the Workers Paid plan at $5/month plus minimal R2/Realtime usage, with no per-seat charge from Officebox.

## 17. Open product questions

- Exact role model and default permissions.
- Final Tiptap extension set and editor UX after evaluation.
- Exact board/issue component or engine selection.
- Detailed Personal Inbox prioritisation, snooze and acknowledgement semantics.
- Calendar integration scope and provider strategy.
- Data retention and deletion rules, including messages, revisions, attachments, audit records and AI indexes.
- AI interaction log retention and administrator visibility.
- Exact upgrade rollback and application export format.
- Whether native mobile apps are justified by actual usage.
- Whether beta channel access is included or a paid add-on.

Data retention and deletion rules must be resolved before the Phase 1 schema is frozen because they affect soft deletion, auditability, object relationships, backups and future AI index invalidation.

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
| Onboarding | Invitation-based; manual links supported without SMTP | Agreed |
| Email | External SMTP; no mail server | Agreed |
| Notifications | Central service with multiple delivery adapters | Agreed |
| Web push | Phase 2 | Agreed |
| Tasks/projects | Phase 2 | Agreed |
| Personal AI memory | Deferred pending separate privacy and retention design | Deferred |
| Backup responsibility | Customer owns Cloudflare account; Officebox provides export and D1 Time Travel guidance | Agreed |
| Deployment | Deploy to Cloudflare button; one-click resource provisioning | Agreed |
| Upgrade model | Stable and beta channels; one-click upgrade; rollback | Agreed |
| Business model | Pay once ($5/month Cloudflare); charge only for big fixes and upgrades | Agreed |
| Native apps | Deferred | Deferred |

## Appendix B — Related documents

- [Technical Design Document (TDD)](TDD.md): architecture, Durable Object design, D1 schema, Yjs sync, AI pipeline, deployment, upgrades and operations.
- Open-Source Component Evaluation Register: candidate projects, licences, maturity, integration model, data ownership and replacement strategy.
- Architecture Decision Records (ADRs): detailed rationale for consequential technical choices.

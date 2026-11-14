Officebox — Product Requirements Document (PRD)

Status: Working baseline
Version: 1.0
Date: 14 November 2026

1. Product summary

Officebox is a Cloudflare-native, self-owned workspace suite for small teams. It brings team communication, shared knowledge, files, projects, issues, meetings and an AI assistant into one integrated environment—deployed in one click, owned by the customer, and operated with no servers, databases, or ports to manage.

The headline proposition is pay once, $5/month Cloudflare workspace suite for you and your team. The customer brings their own Cloudflare account. Officebox is deployed directly from GitHub using the Deploy to Cloudflare button, which clones the repository into the customer's GitHub account, provisions all required Cloudflare resources, and deploys the application to their Cloudflare account in a few clicks. There is no per-seat billing. The customer pays Cloudflare for infrastructure (often within the Workers Paid plan at $5/month, which includes generous allowances for Durable Objects, D1, Vectorize and other services). Officebox charges only for big fixes and upgrades.

The initial target is organisations of approximately 5–100 people, particularly small startups that want ownership and data control without operational burden.

The problem Officebox addresses

Small teams fragment their work across a chat tool, a docs tool, a ticket tracker, a meeting tool and a personal task app. Context is lost between them. Hosted SaaS alternatives impose per-seat costs that scale painfully with team size. Self-hosted alternatives require infrastructure skills the team does not have.

Officebox resolves all three: one connected workspace, owned by the customer, deployed in one click, and priced as a fixed infrastructure cost rather than a per-seat subscription.

2. Product direction

Direction A — Self-owned, Cloudflare-native workspace

One installation = one organisation = one Cloudflare account = one workspace.

Officebox is not multi-tenant SaaS. Each customer deploys their own instance into their own Cloudflare account. Departments and teams are represented through channels, groups, projects and permissions within that workspace. There is no workspace switcher or shared hosting model.

Product promise

· Own your workspace. Your data lives in your Cloudflare account, not ours.
· Deploy in one click. A Deploy to Cloudflare button gets you from GitHub to a working workspace with no servers, databases or ports to configure.
· Pay once, not per seat. Infrastructure cost is a flat Cloudflare bill—typically $5/month on the Workers Paid plan—regardless of team size.
· One integrated experience. Chat, documents, whiteboards, files, projects, issues and huddles are connected workspace objects, not disconnected apps.
· Realtime without operational burden. Presence, chat and collaborative editing work out of the box on Cloudflare's managed realtime primitives.
· AI on your terms. Bring your own model provider key via AI Gateway; AI is optional and never disables core collaboration.
· Upgrade on your schedule. Stable and beta channels, one-click upgrades, and rollback.

3. Target users and needs

Primary customer

A small startup or team (5–100 people) that wants an integrated collaboration suite, wants to own its data, and does not want to run infrastructure.

Typical users

· Workspace administrator: deploys Officebox, configures Cloudflare bindings, manages members and upgrades.
· Team member: communicates, collaborates, manages their own work.
· Team lead: coordinates channels, projects, documents and priorities.
· Knowledge worker: creates and searches documents, uses the AI assistant.
· Founder/operator: needs a clear view of commitments, blockers and progress without paying per seat.

Problems to solve

· Per-seat SaaS pricing makes integrated suites expensive as teams grow.
· Self-hosted suites require infrastructure skills small teams do not have.
· Work context is fragmented across disconnected tools.
· AI features often require surrendering provider control or paying a markup.
· Upgrades and operations are opaque and risky.

4. Product principles

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

5. The integrated workspace experience

5.1 Shared workspace objects

Core object types:

· Conversations, channels, direct messages and messages.
· Documents and knowledge pages.
· Whiteboards.
· Projects, boards, issues and tasks.
· Meetings and collaboration sessions.
· Files and attachments.
· Users, teams and groups.

Objects are linkable through explicit relationships. Examples:

· A document is created from a conversation and retains a source link.
· An issue belongs to a project and references its originating discussion.
· A project is supported by documents and decisions.
· A meeting is associated with a document, project or conversation.
· A message references an issue or document as a rich workspace object.

Relationships are represented in application data, not only pasted URLs. Users can navigate between related objects and understand why they are connected.

5.2 Contextual actions and continuity

Users can move between activities without losing context:

· Create a document from a conversation, carrying over title, source link and selected context.
· Start a huddle from a document or project and retain context in the meeting.
· Create an issue from a message or a decision in a document.
· Link an existing issue into a document or conversation.
· Convert a plan/document into a project while preserving content and links.

Contextual actions respect permissions. Creating a link does not grant access to the linked object. Users who cannot access a target object must not receive its private content through previews, search or AI.

5.3 Personal Inbox — the user's workday

The Personal Inbox is a first-class product area: a consolidated, actionable view of the user's work across the workspace.

It should answer:

1. What needs my attention?
2. What do I need to do?
3. What is coming up?
4. What has changed in work I'm involved in?

Initial conceptual views:

· Today: prioritised items for the current day.
· Upcoming: future commitments over the coming days/week.
· Inbox: items requiring acknowledgement, response or action.
· Assigned to me: tasks and issues assigned to the user.
· Following: relevant activity from conversations, documents and projects the user follows.

These are views over underlying workspace objects, not duplicate copies. Users can act on an item in context and return to the inbox without losing their place.

The Inbox distinguishes:

· Notifications: an event occurred.
· Action items: the user is expected to do something.
· Schedule items: something is planned for a particular time.
· Followed activity: something the user wants to stay informed about.

Users can acknowledge, dismiss, snooze, complete or follow items. Dismissing an inbox notification does not delete the underlying message, issue or document.

The first release uses Officebox-native sources: mentions, direct messages, assignments, review requests, due dates and project/document activity. Calendar aggregation and automatic commitment extraction are added when the required integrations and semantics are defined.

5.4 Chat and communication

Initial capabilities:

· Public and private channels.
· One-to-one direct messages.
· Durable message history and search.
· Threads/replies.
· Reactions.
· Mentions.
· Presence and unread indicators.
· Attachments.
· Links/previews to workspace objects.
· Notification preferences.

Messages are durable workspace data, stored in D1. Realtime delivery uses Durable Objects and is separate from persistence; the realtime connection is never the only copy of a message. WebSocket connections use the Hibernation WebSocket API, so idle channels do not accrue billable duration while clients remain connected.

Huddles are specified in §5.8.

5.5 Knowledge, documents and whiteboards

Officebox provides shared documents and knowledge pages that connect naturally to conversations and work.

Initial document capabilities:

· Rich document authoring using Tiptap with the Yjs Collaboration extension.
· Rendered editing with common formatting, headings, lists, links and images.
· Autosave and clear save state.
· Document title, ownership and access controls.
· Revision history (initial depth validated during implementation).
· Searchable title and content.
· Links to originating conversations, projects and related issues.

Whiteboards are a first-class collaborative surface, built on the same Yjs collaboration model. Documents and whiteboards are both persisted as CRDT state in Durable Object SQLite, with periodic snapshots.

Officebox does not build a rich-text editing engine from scratch. The editor is Tiptap; collaborative state is Yjs. A stock Yjs client can connect to the Durable Object sync endpoint using the standard Yjs protocol (y-websocket).

5.6 Projects, boards, issues and tasks

Projects and issue tracking are a planned Phase 2 capability.

Expected capabilities:

· Projects.
· Boards and configurable workflow columns.
· Issues/tasks with title, description, status, assignee and due date.
· Comments and activity.
· Links to documents, conversations and meetings.
· Assignment and mention events surfaced in the Personal Inbox.
· Basic filtering and search.

Officebox evaluates mature open-source React board components before building custom UI, and avoids components that create a disconnected application, separate identity model or competing source of truth.

5.7 Files

Initial capabilities:

· Shared file storage and folders in R2.
· Uploads and attachments.
· File metadata and access controls.
· Download links and previews where practical.
· Links to messages, documents, projects and issues.
· Versioning phased in as requirements become clear.

5.8 Realtime collaboration and huddles

Realtime is fundamental to Officebox. The architecture uses two distinct realtime planes:

· Application realtime (Durable Objects): chat delivery, presence, typing indicators, inbox updates and object-link changes. WebSocket connections to Durable Objects, with hibernation to keep idle cost near zero.
· Collaborative state (Durable Objects + Yjs): document and whiteboard editing. One Durable Object holds one document or whiteboard; the authoritative Y.Doc lives in the object and is persisted to its SQLite storage, with snapshots and compaction.

Media (huddles) uses Cloudflare Realtime SFU:

· Instant audio-first huddles from conversations, documents and projects.
· Optional video.
· Screen sharing as a subsequent capability.
· Join and leave without calendar ceremony.
· Clear indication of the context in which a session started.
· TURN is provided by Cloudflare Realtime and shares the SFU free tier: first 1,000 GB of egress per month is free, then $0.05/GB. For small-team audio huddles this is effectively free.

Delivery sequence:

1. Application realtime (Durable Objects) and core chat presence.
2. Collaborative documents and whiteboards (Durable Objects + Yjs).
3. Audio huddles (Realtime SFU).
4. Video and screen sharing.
5. Optional AI transcription, summaries and action items, with consent and retention controls.

Recording is not an initial requirement.

5.9 AI workspace assistant

The assistant helps users:

· Search permitted messages and documents.
· Summarise conversations and documents.
· Draft or create documents.
· Create and update tasks/issues.
· Answer questions grounded in workspace knowledge.
· Understand related workspace context.

The first AI release is a permission-aware team workspace assistant. A separate personal assistant with private memory is deferred until its ownership, isolation, retention and retrieval rules are separately specified.

AI actions that modify data or affect external systems require confirmation and permission checks. Sensitive actions are auditable.

Semantic retrieval uses Vectorize with Workers AI embeddings. The retrieval pipeline filters results by the requesting user's permissions before returning content to the model.

6. Identity, onboarding and authentication

Initial product direction:

· Built-in local user accounts in D1.
· Invitation-based membership; no public registration.
· First-run setup creates the initial administrator.
· Administrators invite members.
· Invitation links are single-use and expire.
· When email is unavailable, administrators can copy and share invitation links manually.
· Users complete account setup and receive a concise first-use introduction.

Planned security capabilities:

· Secure password storage.
· Secure browser sessions.
· Password reset when outgoing email is configured.
· Configurable email verification.
· TOTP multi-factor authentication.
· Account disablement and session revocation by administrators.
· Login activity visibility.

OIDC/SSO and passkeys are future considerations, not MVP dependencies.

7. Email

Officebox does not operate a mail server. It supports configurable outgoing email through an external SMTP service or relay. Likely uses:

· Invitations.
· Password resets.
· Email verification.
· Optional notifications.
· Important system/security notices.

Email configuration is optional. Officebox remains usable without it. Manual invitation-link creation and sharing is a supported, tested flow rather than a debugging workaround.

8. Notifications and delivery

Notifications are a product capability with multiple delivery channels:

· In-app notifications and Personal Inbox items.
· Realtime updates via Durable Objects WebSockets.
· Browser/web push (Phase 2).
· Email notifications.
· Future native mobile push through APNs/FCM if native apps are built.

User controls:

· Per-event preferences.
· Per-channel preferences.
· Per-conversation or per-channel mute settings.
· Do-not-disturb schedules.
· Email digest preferences.
· Per-device push settings where appropriate.

Potential notification events:

· Direct messages.
· Mentions.
· Thread replies.
· Channel invitations.
· Document sharing and review requests.
· Task/issue assignments.
· Due dates and project milestones.
· Important security or system events.

The first release includes basic in-app notifications. PWA installation and web push are Phase 2.

Push payloads are generic by default and avoid sensitive message content. The client fetches the actual content after authenticating.

9. Desktop and mobile experience

Initial direction:

· Responsive React web application.
· Installable Progressive Web App (PWA) where supported.
· Browser notifications and Web Push on supported platforms.
· No mandatory native desktop or mobile application.

Native desktop, iOS and Android applications are deferred until customer demand justifies the additional build and maintenance burden. A future native client reuses the same backend, identity, workspace object model and notification services.

10. Workspace model and permissions

Officebox is a single-workspace, single-organisation product per installation.

· One deployment serves one organisation.
· One global member directory exists within that installation.
· Teams and departments are represented through channels, groups and projects.
· Roles and resource-level permissions control access.
· Private channels and restricted documents remain private.
· No tenant switching or multi-tenant hosting.

A stable installation identity represents organisation-level settings and integrations. This does not imply multi-tenancy.

All object relationships, previews, inbox aggregations, search results and AI retrieval respect permissions. Linking an object never implicitly grants access to it.

11. AI and model-provider strategy

BYOK via AI Gateway

Customers store their own model-provider API keys in Cloudflare AI Gateway's BYOK feature. Keys are stored securely in Secrets Store and referenced by the gateway at runtime; applications make requests without exposing provider keys. Multiple keys per provider and key rotation are supported without code changes.

Potential providers: OpenAI, Anthropic, Google Gemini, Workers AI, and optional local models through a compatible runtime.

Different model choices may be configured for assistant responses, summarisation and embeddings.

AI safety and governance

· API credentials are never exposed to browser JavaScript.
· Provider keys are stored in Secrets Store and referenced only via AI Gateway.
· Retrieval enforces the same permissions as normal application access.
· Users do not receive answers based on documents or messages they cannot access.
· Retrieved workspace content is untrusted input, not trusted instruction. Prompt-injection attempts in documents, messages and files must not override system policy or grant tool authority.
· Tool access is permission-checked server-side.
· Mutating or sensitive actions require confirmation where appropriate.
· Important AI actions and tool invocations are auditable.
· AI interaction and audit retention is defined and configurable.
· AI outages do not disable core collaboration.

The initial AI release includes a permission-aware team assistant. Personal assistant memory is deferred.

12. Open-source reuse and integration strategy

Officebox reuses mature open-source projects and libraries wherever practical, while owning the integrated experience, identity, permissions, durable workspace model and contextual relationships.

Integration levels

1. Embedded libraries/components: Tiptap editor, Yjs, board UI components and other frontend capabilities integrated into the React application.
2. Cloudflare-native services: Durable Objects, D1, R2, Vectorize, Workers AI, AI Gateway, Realtime SFU and Queues.
3. Optional external services: SMTP relay for email; model providers via BYOK.

Every candidate is assessed for licence, maturity, security, React integration, identity integration, data ownership, deployment footprint and replaceability.

Officebox avoids components that create competing sources of truth or force users into separate application experiences.

13. Operational product experience

One-click deployment

The primary deployment mechanism is the Deploy to Cloudflare button. It clones the repository into the customer's GitHub/GitLab account, configures the project, provisions required Cloudflare resources (Durable Objects, D1, R2, Vectorize, AI Gateway) and deploys the application. Supported resources are automatically provisioned and bound without additional setup. D1 migrations run as part of the deploy script.

The customer does not manage servers, databases, ports or certificates. There is no persistent volume to provision and no backup policy to configure manually.

Upgrades and rollback

A safe, understandable upgrade path is a product requirement:

· Versioned releases. Stable and beta channels.
· Stable channel: production releases deployed from the main branch.
· Beta channel: upcoming releases deployed from a beta branch, available to customers who opt in.
· One-click upgrade: the administrator triggers a new deployment from the chosen channel.
· Build history and rollback: Workers Builds retains build history and logs for 90 days; versions and deployments remain in version history and can be rolled back. Rollback to a previous Worker version immediately creates a new deployment and becomes the active deployment.
· Pre-upgrade checks: verify required resources and bindings before deploying.
· Clear migration status: surface progress and failure; document rollback limitations where D1 migrations are not reversible.

Health and diagnostics

The administrator experience includes:

· Health and readiness status for the Worker, Durable Objects, D1, R2, Vectorize and Realtime SFU.
· Disk/storage visibility (R2 usage, D1 storage).
· Application version and upgrade status.
· Backup and data export status.
· Diagnostic information and a support bundle.
· Clear guidance for moving or restoring an installation.

Officebox does not claim that a backup exists or is healthy unless it has reliable evidence.

Storage, backup and data ownership

All persistent application data lives in the customer's Cloudflare account:

· D1: users, messages, documents metadata, projects, issues, inbox records, audit logs.
· Durable Object SQLite: message history per channel, Yjs CRDT state per document/whiteboard, presence state.
· R2: files and attachments.
· Vectorize: embeddings for AI retrieval.

D1 Time Travel provides point-in-time recovery to any minute within the last 30 days. R2 provides object versioning and lifecycle policies. Officebox provides an application-level export for portability and supplementary recovery, using database-consistent methods and including file data and metadata.

Data ownership is the customer's. They can export, delete or migrate their data at any time. Officebox does not hold customer data outside the customer's Cloudflare account.

Missing backup or export configuration does not block startup. Demos, evaluation and development remain possible. Warnings are visible to administrators, not ordinary users.

Storage exhaustion

Officebox monitors D1 storage, R2 usage and Durable Object storage. It warns administrators at configurable thresholds, rejects new uploads before storage exhaustion threatens integrity, and provides clear recovery guidance. It does not silently discard durable messages or documents to free space.

14. Explicitly out of scope initially

· Building or hosting an email server.
· Replacing Excel or providing a full spreadsheet suite.
· Building a video-conferencing platform or SFU from scratch.
· Complex enterprise workflow automation.
· Federation across independent Officebox installations.
· Public multi-tenancy and workspace switching.
· Mandatory external identity-provider integration.
· Kubernetes-based deployment (Cloudflare-native only).
· Native desktop and native mobile apps at launch.
· Enterprise-scale compliance and administration features before customer need is demonstrated.
· A separate personal AI memory system in the first AI release.

15. Phased delivery

Phases describe product capability, not a requirement to postpone foundational architecture. Durable Objects, the shared workspace object model, permissions and durable event handling are architectural foundations even when some user-facing features arrive later.

Phase 1 — Integrated workspace foundation

· One-click Deploy to Cloudflare deployment.
· Single-workspace identity and local accounts in D1.
· Member invitations and basic administration.
· React application shell and responsive experience.
· Channels and direct messages.
· Durable message history in D1 and Durable Object SQLite.
· Basic permission-filtered full-text search across messages and documents.
· Shared documents using Tiptap + Yjs in Durable Objects.
· Whiteboards using Yjs in Durable Objects.
· R2 file uploads and attachments.
· Explicit links between conversations and documents.
· Basic in-app notifications via Durable Objects.
· SMTP configuration for transactional email.
· Application realtime via Durable Object WebSockets with hibernation.
· Health checks and diagnostics.
· Stable and beta channels with one-click upgrades and rollback.
· Application export/migration foundation.

Phase 2 — Connected collaboration and work management

· Audio huddles via Cloudflare Realtime SFU.
· Video and screen sharing.
· PWA installation and web push.
· Projects, boards, issues and lightweight tasks.
· Personal Inbox with Today, Upcoming, Inbox, Assigned to me and Following views, using Officebox-native event sources.
· Richer contextual object links and previews.
· More complete document editing, revision history and collaborative awareness.
· TOTP MFA.
· Richer search filters and cross-object search.
· Improved notification preferences and digest controls.

Phase 3 — Workspace intelligence

· BYOK team AI assistant via AI Gateway.
· Permission-aware semantic search and embeddings using Vectorize + Workers AI.
· AI-assisted document and issue/task actions.
· AI tool audit trail and configurable retention.
· Summaries and action-item extraction from conversations and meetings.
· Optional meeting transcription and summaries, subject to consent and retention controls.
· Further Personal Inbox intelligence, such as suggested follow-ups and extracted commitments, with user review and clear provenance.

The exact sequencing should be validated against user research, component evaluations and implementation capacity. Calendar aggregation depends on a deliberate calendar integration decision; it is not assumed to exist in Phase 1.

16. Product success criteria

The initial product should be judged by whether a small organisation can:

· Deploy Officebox from the Deploy to Cloudflare button without specialist infrastructure knowledge.
· Invite and onboard its team, including when SMTP is not configured.
· Use chat and shared knowledge reliably.
· Find messages and documents they are authorised to see.
· Move between conversations and related workspace objects without losing context.
· Understand what needs their attention through a coherent Personal Inbox as that capability ships.
· Receive useful notifications without being overwhelmed.
· Collaborate in realtime and use huddles without a separate account or disconnected workflow.
· Operate without configuring AI.
· Configure AI without surrendering control of its provider account.
· Understand its storage, backup and data ownership responsibilities.
· Upgrade and roll back the installation using the stable or beta channel.

Before Phase 1 exit, validate at minimum:

· Search returns relevant authorised messages/documents and excludes inaccessible objects.
· A document can be created from a conversation and retains a navigable relationship.
· Manual invitation-link onboarding works without SMTP.
· An upgrade from stable to beta and rollback works on a representative installation.
· Storage warnings and upload rejection behave safely under low-storage conditions.
· Durable Object WebSocket hibernation keeps idle channels connected without accruing billable duration.
· Durable Object Yjs sync supports a stock Yjs client and persists document state across object eviction.
· Missing backup/export configuration produces an administrator warning but does not block evaluation startup.

Cost success criterion: a team of 25 can operate within the Workers Paid plan at $5/month plus minimal R2/Realtime usage, with no per-seat charge from Officebox.

17. Open product questions

· Exact role model and default permissions.
· Final Tiptap extension set and editor UX after evaluation.
· Exact board/issue component or engine selection.
· Detailed Personal Inbox prioritisation, snooze and acknowledgement semantics.
· Calendar integration scope and provider strategy.
· Data retention and deletion rules, including messages, revisions, attachments, audit records and AI indexes.
· AI interaction log retention and administrator visibility.
· Exact upgrade rollback and application export format.
· Whether native mobile apps are justified by actual usage.
· Whether beta channel access is included or a paid add-on.

Data retention and deletion rules must be resolved before the Phase 1 schema is frozen because they affect soft deletion, auditability, object relationships, backups and future AI index invalidation.

---

Appendix A — Product decision register

Decision Baseline Status
Product direction Cloudflare-native, self-owned workspace Agreed
Target organisation Approximately 5–100 people Agreed
Workspace model One installation = one Cloudflare account = one workspace Agreed
Product experience One connected environment, not stitched-together applications Agreed
Personal Inbox First-class view of the user's day, attention and assigned work Agreed direction
Platform Cloudflare-native; no VPS, no Go monolith Agreed
Frontend React + TypeScript Agreed
Runtime Workers (TypeScript/JavaScript) Agreed
Application realtime Durable Objects WebSockets with hibernation Agreed
Collaborative editing Durable Objects + Yjs; Tiptap frontend Agreed
Database D1 (SQLite) Agreed
Vector search Vectorize + Workers AI embeddings Agreed
Media Cloudflare Realtime SFU (SFU + TURN) Agreed
File storage R2 Agreed
AI BYOK via AI Gateway Agreed
Authentication Built-in local accounts initially Agreed
Onboarding Invitation-based; manual links supported without SMTP Agreed
Email External SMTP; no mail server Agreed
Notifications Central service with multiple delivery adapters Agreed
Web push Phase 2 Agreed
Tasks/projects Phase 2 Agreed
Personal AI memory Deferred pending separate privacy and retention design Deferred
Backup responsibility Customer owns Cloudflare account; Officebox provides export and D1 Time Travel guidance Agreed
Deployment Deploy to Cloudflare button; one-click resource provisioning Agreed
Upgrade model Stable and beta channels; one-click upgrade; rollback Agreed
Business model Pay once ($5/month Cloudflare); charge only for big fixes and upgrades Agreed
Native apps Deferred Deferred

Appendix B — Related documents

· Technical Design Document (TDD): architecture, Durable Object design, D1 schema, Yjs sync, AI pipeline, deployment, upgrades and operations.
· Open-Source Component Evaluation Register: candidate projects, licences, maturity, integration model, data ownership and replacement strategy.
· Architecture Decision Records (ADRs): detailed rationale for consequential technical choices.

---

Officebox — Technical Design Document (TDD)

Status: Draft for engineering review
Version: 1.0
Date: 14 November 2026
Companion to: Officebox PRD v1.0

1. Architecture overview

Officebox is a single Cloudflare Worker application (with Durable Objects) plus Cloudflare-managed services. There is no origin server, no VPS, no Go runtime, no PostgreSQL and no LiveKit. The entire stack runs inside the customer's Cloudflare account.

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│                              BROWSER / PWA CLIENT                             │
│                                                                               │
│  ┌──────────────────┐  ┌──────────────────┐  ┌────────────────────────────┐  │
│  │ React Shell       │  │ Tiptap + Yjs      │  │ Realtime SFU Client SDK    │  │
│  │ (Workers Assets)  │  │ (y-websocket)     │  │ (WebRTC)                   │  │
│  └────────┬─────────┘  └────────┬─────────┘  └────────────┬───────────────┘  │
└───────────┼─────────────────────┼──────────────────────────┼──────────────────┘
            │ HTTPS               │ WSS                      │ WebRTC
            │                     │                          │
┌───────────▼─────────────────────▼──────────────────────────▼──────────────────┐
│                         CLOUDFLARE WORKER (edge)                              │
│                                                                               │
│  • REST API (auth, members, objects, inbox, search, admin)                    │
│  • WebSocket upgrade routing to Durable Objects                               │
│  • AI Gateway proxy and Vectorize retrieval                                   │
│  • R2 presigned upload/download                                               │
│  • SMTP relay dispatch via Queues                                             │
│  • Static asset serving for the React app                                     │
└───────────┬─────────────────────┬──────────────────────────┬──────────────────┘
            │                     │                          │
┌───────────▼─────────┐ ┌─────────▼──────────┐ ┌─────────────▼─────────────────┐
│  DURABLE OBJECTS    │ │        D1          │ │         R2 / VECTORIZE        │
│                     │ │                    │ │                               │
│  • ChatChannel DO   │ │  • users           │ │  • R2: files, attachments,    │
│    (messages,       │ │  • memberships     │ │    exports                    │
│     presence)       │ │  • channels        │ │  • Vectorize: document and    │
│                     │ │  • documents       │ │    message embeddings         │
│  • DocRoom DO       │ │  • issues/tasks    │ │                               │
│    (Yjs document)   │ │  • projects        │ │                               │
│                     │ │  • inbox_items     │ │                               │
│  • BoardRoom DO     │ │  • audit_log       │ │                               │
│    (Yjs whiteboard) │ │  • notifications   │ │                               │
│                     │ │                    │ │                               │
│  • InboxFanout DO   │ │                    │ │                               │
│    (per-user)       │ │                    │ │                               │
└─────────────────────┘ └────────────────────┘ └───────────────────────────────┘
            │                     │                          │
            └─────────────────────┴──────────────────────────┘
                                  │
                    ┌─────────────▼─────────────┐
                    │   AI GATEWAY (BYOK)        │
                    │   Provider keys in         │
                    │   Secrets Store            │
                    └───────────────────────────┘
```

1.1 Component responsibilities

Component Responsibility Cloudflare primitive
React shell UI, routing, optimistic updates, PWA Workers Assets
Worker API Auth, domain logic, permissions, search, AI orchestration, R2 signing, SMTP dispatch Workers
ChatChannel DO Message ordering, fan-out, presence, typing, history replay Durable Object + SQLite
DocRoom DO Authoritative Y.Doc per document, sync, awareness, snapshots Durable Object + SQLite
BoardRoom DO Authoritative Y.Doc per whiteboard Durable Object + SQLite
InboxFanout DO Per-user notification fan-out and unread aggregation Durable Object
D1 Durable domain records, permissions, audit, inbox items D1
R2 Files, attachments, exports R2
Vectorize Embeddings for permission-aware retrieval Vectorize
Realtime SFU Audio/video huddles, TURN Cloudflare Realtime
AI Gateway BYOK provider proxy, fallback, rate limiting AI Gateway
Queues Async email, webhook, AI indexing jobs Queues

1.2 Why Durable Objects for both chat and Yjs

Durable Objects provide a single-threaded, stateful coordinator with private SQLite storage and WebSocket hibernation. This is the right primitive for both:

· Chat: one DO per channel provides total ordering, presence and fan-out.
· Yjs: one DO per document/whiteboard provides authoritative CRDT state, conflict-free sync and persistent storage.

Yjs on Durable Objects is a proven pattern: one object holds one document, speaks the standard y-websocket protocol, relays presence, supports snapshots and compaction, and hibernates when idle. Durable Object SQLite can store both chat messages and Yjs updates without a separate database engine.

2. Data model

2.1 D1 schema (core domain)

D1 uses SQLite semantics. Each D1 database has a 10 GB limit on Workers Paid (500 MB free), with 1 TB total per account. Officebox keeps one D1 database per installation, with logical separation by table.

```sql
-- Identity
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE memberships (
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  role TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, workspace_id)
);

-- Workspace objects
CREATE TABLE channels (
  id TEXT PRIMARY KEY,
  name TEXT,
  type TEXT NOT NULL, -- public, private, dm
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'document', -- document, whiteboard
  owner_id TEXT NOT NULL,
  origin_channel_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE object_links (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE issues (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL,
  assignee_id TEXT,
  due_date INTEGER,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Inbox and notifications
CREATE TABLE inbox_items (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL, -- notification, action, schedule, follow
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'unread',
  priority INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE notification_preferences (
  user_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  channel TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, event_type, channel)
);

-- Audit
CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  actor_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  metadata TEXT,
  created_at INTEGER NOT NULL
);

-- AI indexing state
CREATE TABLE embedding_jobs (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  state TEXT NOT NULL, -- pending, indexed, failed
  attempts INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
```

2.2 Durable Object SQLite schemas

ChatChannel DO — one per channel:

```sql
CREATE TABLE messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  sender_id TEXT NOT NULL,
  body TEXT NOT NULL,
  metadata TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE presence (
  connection_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  state TEXT NOT NULL, -- online, away, typing
  updated_at INTEGER NOT NULL
);
```

Message sequence (seq) is assigned by the DO, giving a total order within a channel. Clients use seq for gap detection and replay after reconnect. Message bodies are also written to D1 for cross-channel search and retention, but the DO is the realtime source of ordering.

DocRoom / BoardRoom DO — one per document/whiteboard:

```sql
CREATE TABLE updates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  update_blob BLOB NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  state_blob BLOB NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
```

Updates append to a log; every N updates (configurable, default 50) the log folds into a snapshot to bound storage and load time. A snapshot or update must stay under 2 MB (Durable Object storage limit); the DO rejects or chunks oversized payloads.

InboxFanout DO — one per user:

```sql
CREATE TABLE pending (
  id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
```

Used for low-latency fan-out of inbox events to connected clients. Durable record lives in D1.

3. Application realtime design (Durable Objects)

3.1 Connection lifecycle

1. The client authenticates via the Worker (POST /auth/session) and receives a short-lived JWT.
2. The client opens a WebSocket to /ws/channels/:channelId or /ws/docs/:documentId, passing the JWT as a query parameter (browsers cannot set headers on WebSocket upgrades).
3. The Worker validates the JWT and permission, then forwards the request to the appropriate Durable Object.
4. The DO accepts the WebSocket using ctx.acceptWebSocket(server) and attaches serialized state (user ID, permissions, connection ID) via serializeAttachment.
5. On hibernation wake, the constructor runs and state is restored from the attachment.

3.2 Hibernation

All application WebSockets use the Hibernation WebSocket API. When no events arrive, the DO is evicted from memory; clients remain connected to Cloudflare's network and billable duration stops accruing. A message wakes the object automatically.

Design rule: minimize constructor work. Do not fetch from D1 or rebuild large state in the constructor; load only what is needed to handle the waking event, and persist durable state in DO SQLite or connection attachments.

3.3 Message flow

1. Client sends { type: "message.send", body, clientId } over the channel WebSocket.
2. DO validates payload, assigns seq, writes to DO SQLite, and broadcasts { type: "message.created", seq, id, ... } to all connected sockets.
3. DO enqueues a D1 write for cross-channel search and durability (via an internal alarm or Queues).
4. Client uses clientId for optimistic reconciliation.

Message history is replayable: clients send { type: "sync", afterSeq } and the DO returns messages with seq > afterSeq. Hibernation does not lose this capability because the log is in DO SQLite.

3.4 Presence

Presence is ephemeral and stored in DO memory and connection attachments, not in D1. On connect/disconnect, the DO broadcasts presence.joined / presence.left. Typing indicators are presence states with a short TTL, refreshed by the client and expired by the DO.

Presence is never the source of truth for durable data.

4. Collaborative editing design (Yjs on Durable Objects)

4.1 Server architecture

Each document or whiteboard is a DocRoom Durable Object. The DO:

· Holds the authoritative Y.Doc in memory.
· Accepts WebSocket connections using the standard Yjs sync protocol (y-websocket).
· Applies incoming updates to the Y.Doc.
· Persists updates to DO SQLite.
· Broadcasts updates to other connected clients.
· Compacts the update log into snapshots periodically.
· Manages awareness (presence, cursors) and relays it to peers.
· Enforces roles (owner/editor/commenter/viewer) server-side; read-only roles' updates are rejected.

4.2 Client architecture

The React client uses:

· Tiptap with the Collaboration extension for documents.
· A Yjs-based whiteboard component (e.g. Excalidraw with Yjs binding) for whiteboards.
· y-websocket provider pointed at /ws/docs/:id.
· IndexedDB persistence for offline support and reconnection.

The client sends a JWT in the WebSocket URL. The DO validates it via the authorize hook (implemented in the Worker before forwarding) and assigns a role.

4.3 Persistence and compaction

· Updates append to updates table in DO SQLite.
· Every SYNC_COMPACT_EVERY updates (default 50), the DO merges the log into a single snapshot in snapshots and truncates the update log.
· On cold start, the DO loads the latest snapshot and replays any subsequent updates.
· Snapshots are also copied to R2 for export and disaster recovery (via an alarm or Queues job).

4.4 Permissions

Permissions are resolved by the Worker before the WebSocket reaches the DO. The DO trusts the role passed in the connection attachment and enforces it:

· Owner/editor: may send Yjs updates.
· Commenter/viewer: may receive updates and awareness, but outbound updates are dropped and answered with a permission error.
· No access: connection is rejected.

Link previews and AI retrieval always re-check permissions in the Worker/D1; the DO is not the authority for cross-object access.

5. AI design (BYOK, permission-aware RAG)

5.1 BYOK flow

1. Administrator configures provider keys in AI Gateway → Provider Keys. AI Gateway stores them in Secrets Store; the application never handles the raw key.
2. The Worker calls AI Gateway with the provider path (e.g. /openai/chat/completions) and cf-aig-authorization for gateway auth.
3. AI Gateway substitutes the stored provider key at runtime.
4. Key rotation is done in the dashboard with no code changes.

5.2 Ingestion pipeline

1. On document save or message creation, the Worker enqueues an embedding_jobs record in D1 and a message on a Queue.
2. A queue consumer Worker loads the content (from D1 or DO), chunks it, generates embeddings via Workers AI, and upserts vectors into Vectorize.
3. Each vector carries metadata for permission filtering: workspace_id, object_type, object_id, allowed_roles, allowed_user_ids, channel_id.
4. On document deletion or permission change, the Worker enqueues an invalidation job that removes or re-scopes vectors.

5.3 Retrieval flow

1. User asks a question.
2. Worker generates a query embedding via Workers AI.
3. Vectorize query returns candidate vectors with metadata.
4. Worker filters candidates by the requesting user's permissions (roles, channel membership, explicit grants) before passing content to the model.
5. The model receives only permitted snippets; the response cites source objects the user can access.

Design rule: permission filtering happens before model invocation, not after. No vector is passed to the model unless the requesting user is authorised to see its source.

5.4 Audit

AI tool invocations and mutating actions are written to audit_log with actor, action, target, model/provider and outcome. Retention is configurable; default retention is defined before Phase 3.

6. Deployment and upgrades

6.1 Deploy to Cloudflare

The repository includes a wrangler.jsonc with bindings for:

· Durable Object namespaces (ChatChannel, DocRoom, BoardRoom, InboxFanout).
· D1 database.
· R2 bucket.
· Vectorize index.
· AI Gateway.
· Queues.

The Deploy to Cloudflare button clones the repo, provisions supported resources automatically, and runs the deploy script. D1 migrations run as part of the deploy script.

6.2 Channels and releases

· main branch → stable channel.
· beta branch → beta channel.
· Each release is a Worker version with an associated tag.
· Customers choose a channel in the admin UI.

6.3 Upgrade flow

1. Admin selects "Upgrade to latest stable" or "Upgrade to beta."
2. Worker triggers a deployment from the corresponding branch (via Workers Builds or a webhook to a small deploy Worker).
3. Pre-upgrade checks validate bindings and D1 migrations.
4. D1 migrations run; progress is surfaced.
5. If migration fails, the Worker remains on the previous version and the admin receives a clear error with rollback guidance.
6. On success, the new version becomes active.

6.4 Rollback

Workers retain version history; rollback to a previous version creates a new deployment and becomes active. Build history and logs are retained for 90 days; versions remain available for rollback after that.

Limitation: D1 migrations that are not backward-compatible cannot be automatically rolled back. The PRD requires documenting rollback limitations for each migration and recommending export before irreversible upgrades.

7. Operations and observability

7.1 Health checks

A /health endpoint checks:

· Worker and D1 connectivity.
· Durable Object namespace availability (lightweight ping to a system DO).
· R2 bucket access.
· Vectorize index presence.
· AI Gateway configuration (if configured).
· Realtime SFU credentials (if configured).

7.2 Diagnostics bundle

The admin can download a support bundle containing:

· Worker version and deployment ID.
· Binding configuration (without secrets).
· Recent audit log entries.
· D1 storage usage.
· R2 usage summary.
· Durable Object error counts (last 24h).
· Queue backlog.

7.3 Alerts

Officebox uses Cloudflare's observability and optional external alerting (email/webhook) for:

· Elevated Worker error rate.
· D1 query failures.
· Durable Object exceptions.
· R2 write failures.
· Queue backlog growth.
· Storage approaching limits.

7.4 Backup and recovery guidance

· D1: Time Travel restores to any minute in the last 30 days. Officebox documents how to use it and warns when a restore point is needed.
· R2: lifecycle rules and object versioning; Officebox documents recommended configuration.
· DO SQLite: snapshots are copied to R2 for export; the export is the portable recovery path.
· Application export: a Worker endpoint produces a database-consistent export (D1 dump + R2 manifest + DO snapshots) for portability.

8. Security model

· Authentication: local accounts; passwords hashed with a memory-hard KDF; session JWTs short-lived and rotated.
· Authorisation: role-based at workspace level; resource-level checks for channels, documents, projects and files. All checks occur in the Worker before DO access.
· Secrets: provider keys in AI Gateway Secrets Store; SMTP credentials as Worker secrets; no provider keys in D1 or browser code.
· AI: retrieval permission-filtered; prompt-injection treated as untrusted input; tool calls permission-checked server-side; mutating actions require confirmation.
· WebSockets: JWT validated on upgrade; DO attachment stores user and role; read-only roles cannot write.
· Audit: administrative and AI-sensitive actions written to audit_log.
· Data ownership: all data in the customer's Cloudflare account; export endpoint for portability.

9. Testing and validation

9.1 Phase 1 validation tests

· Deploy test: fresh Cloudflare account → Deploy to Cloudflare → invited user can log in and send a message.
· Hibernation test: idle channel for >5 minutes; client remains connected; sending a message wakes the DO and delivers to all clients.
· Yjs sync test: two clients edit the same document concurrently; both converge; a stock Yjs client can connect.
· Persistence test: restart/evict DO; document state survives via snapshot + update replay.
· Permission test: viewer cannot write Yjs updates; AI retrieval excludes inaccessible documents.
· Upgrade test: stable → beta upgrade succeeds; rollback to previous version succeeds.
· Storage test: upload rejection triggers before D1/DO storage exhaustion; admin warning appears.
· Backup test: export produces a restorable manifest; missing export configuration warns but does not block startup.

9.2 Performance targets

· Chat message round-trip: p95 < 300 ms within region.
· Document sync latency: p95 < 200 ms for keystroke propagation.
· Cold document load: < 1 s for documents under 100 KB snapshot.
· Huddle join: < 2 s from click to audio.

10. Open technical questions

· Exact D1 vs. DO SQLite split for message durability (how much history lives in D1 vs. DO).
· Vectorize metadata filtering limits and whether a secondary D1 index is needed for permission checks at scale.
· Whether InboxFanout DO per user is necessary in Phase 1 or can be a D1 polling model.
· Snapshot compaction tuning (frequency, size thresholds).
· Whether to use Workers Builds entirely or a small deploy Worker for channel upgrades.
· Export format and restore tooling.
· SMTP relay provider matrix and queue retry policy.

---

Appendix — Key Cloudflare references

Concern Reference
Durable Object WebSocket hibernation Hibernation API keeps clients connected while the DO sleeps, reducing cost
D1 limits 10 GB per database on Workers Paid; 100,000 databases included
D1 Time Travel Restore to any minute in the last 30 days
Vectorize + Workers AI RAG Managed RAG pipeline with D1, Vectorize and Workers AI
AI Gateway BYOK Keys stored in Secrets Store; rotate without code changes
Realtime SFU/TURN pricing 1,000 GB free egress/month shared; $0.05/GB thereafter
Yjs on Durable Objects One object per document; standard y-websocket; hibernation; snapshots
Deploy to Cloudflare Clones repo, provisions resources, builds and deploys
Workers Builds retention 90-day build/log retention; versions persist for rollback
Worker rollback Roll back to a previous version via dashboard or Wrangler

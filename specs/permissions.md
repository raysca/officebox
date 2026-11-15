# Spec: Permissions

**Status:** Draft for review
**Revision:** Written after the independent spec review (14 Nov 2026)
**Scope:** Cross-cutting. Defines the permission engine that every feature uses.
**Related:** PRD §10.1; TDD §2.1 (permission resolution), §3.5; [Identity & Access](identity.md), [Chat](chat.md), [Calls](calls.md), [Calendar](calendar.md), [Documents](documents.md), [Assistant](assistant.md), [Platform](platform.md)

Decisions marked **(default)** were not discussed; change them on review.

## 1. Summary

One engine answers every "can this person do this to that object?" question, for HTTP routes, WebSocket connections, search, previews, embeds, notifications and AI retrieval. This spec defines:
- the roles
- the permission matrix for every object type
- how access is inherited through containers
- what admins can and can't do
- what people see when they don't have access.

It replaces TDD §2.1's "stop at first match" resolution with a **union** rule.

## 2. Decisions

| Topic | Decision |
|---|---|
| Inheritance | **Union.** Effective role = the highest role from any grant on the item, its folders up to the drive, the drive, or general access. |
| New items | **Follow the container.** New items take their location's access; nothing starts workspace-wide unless its container is. |
| Channel made private | **Keep explicit wider shares, but warn.** The conversion dialog lists those items so the channel admin can restrict them first. |
| Group principals | Valid on **documents, whiteboards, folders, files, drives and calendars**. **Not on channels**: "invite this group" adds the current members individually. |
| Private channel membership | **Any member can add people; channel admins remove them.** This corrects PRD §10.1. |
| Admin powers over people | Admins act on **members only**. Recovery, email change, disable and delete on **admins or owners need an owner**. **Only owners invite or promote admins.** |
| Notice of admin actions | Every recovery link or email change **notifies the person** (email to the old address and an in-app banner) and **revokes their pending sign-in, reset and recovery tokens**. |
| Admins and private content | Admins see that private objects **exist** but can't read them. They **can't add themselves to private channels**; they can archive, delete and remove members. In private channels they **are** members of (added by a member), admins can delete messages. |
| Admins giving themselves access | An admin **adding themselves** to a group, or **granting themselves** a role on a group drive or folder, **needs an owner**. Audited. |
| Recovery links without email | Allowed for members, **loudly flagged**: a notice on the member's **sign-in page** and a flag on the member list for **every owner** until acknowledged (Identity §4.6). |
| Comment moderation | Document **owners, editors and admins** can remove others' comments |
| Document calls | **Anyone who can open the document** (viewers included) can start one |
| Orphaned private events | An **owner or admin** can delete a private event whose organiser is disabled or deleted, **without seeing its details** |
| Restore from Trash | **Canonical rule:** the item's **owner**, the **person who deleted it**, **drive managers** of its drive, and **admins** |
| Group calendars | **Viewable by every member** |
| Private events | Calendar editors see a **busy block they can't open or edit**. Only the organiser and attendees see and edit details. |
| Personal calendars | **Free/busy** to others |
| Event calls | **Invitees plus anyone with details-level access** to the event's calendar. Free/busy-only viewers can't join. |
| ICS-in subscriptions | **Personal only** |
| Group drives | **Listed by name to everyone**; contents are group-only unless shared |
| Channel folders | Channel members **edit everything** |
| DM files | **Conversation-only**. Message-owned, with no folder. |
| Access requests | Unique per requester and object, rate-limited, **expire after 30 days (default)** |

## 3. Roles

### 3.1 Workspace roles

| Role | Summary |
|---|---|
| **Owner** | Everything an admin can do, plus owner-only actions (§6). At least one active owner. |
| **Admin** | Manages members (not admins or owners), groups, settings and moderation (§6) |
| **Member** | Uses the workspace |
| *Guest* | **Reserved for Phase 2.** Present in the `users.role` value list from the baseline; not assignable yet. |

### 3.2 Scoped roles

| Role | Where | Granted by |
|---|---|---|
| **Channel admin** | One channel | The creator becomes one automatically; channel admins and workspace admins appoint others |
| **Poster** | One announcement channel | Channel admins |
| **Group manager** | One group | Admins |
| **Drive manager** | One shared or group drive | The creator automatically (shared drives); group managers are managers of their group's drive |
| **Resource roles:** owner · editor · commenter · viewer | Documents, whiteboards, folders, files, drives, calendars | Owners and managers of the resource, or inherited |
| **Freebusy** | Calendars | Default for others on personal calendars, or granted |

**Role ranking** (highest first): owner > manager > editor > commenter > viewer > freebusy. Manager applies to drives only; on other resources the highest role is owner.

### 3.3 Principals

A grant names a **user**, a **group** (meaning its current members) or a **channel** (meaning its current members). Group and channel principals are re-evaluated on every check, so joining or leaving changes access immediately.

**The assistant is never a principal.** It's a **system actor** with no access of its own, and nothing can be granted to it. It always acts **as** the member asking, with that member's current access, or **for** an audience, with only what the whole audience can open (§8, [Assistant](assistant.md) §1, §6). Its reserved sender (`sender_id = 'assistant'`) is not a user for permission purposes.

## 4. Permission matrix

Legend: ✓ allowed · — not allowed · *(cond.)* allowed under the stated condition. "Member" means any active workspace member who has no other role on the object.

### 4.1 Conversations

| Action | Public channel member | Public channel non-member | Private channel member | Announcement: poster or channel admin | Announcement: other member | Channel admin | Workspace admin (not a member) |
|---|---|---|---|---|---|---|---|
| See it exists, in the browser and search | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | Public ✓; private: name, member count and size only |
| Read messages and search content | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | Public ✓; **private —** |
| Join | — | ✓ | n/a | n/a | ✓ (public) | n/a | Public ✓; **private —** |
| Post top-level messages | ✓ | — (must join) | ✓ | ✓ | — | ✓ | Public only after joining |
| Reply in threads, react, vote in polls | ✓ | — | ✓ | ✓ | ✓ | ✓ | as for posting |
| Add members | n/a | n/a | ✓ | ✓ | n/a | ✓ | Public ✓; **private —** |
| Remove members | — | — | — | — | — | ✓ | ✓ (private too, without reading) |
| Rename, topic, posting policy, posters | — | — | — | — | — | ✓ | ✓ |
| Delete any message | — | — | — | — | — | ✓ | **Public channels**, and **private channels they're a member of**. Private-channel messages they can't read can't be moderated. |
| Pin and unpin | ✓ | — | ✓ | ✓ | — | ✓ | as for posting |
| Archive / unarchive | — | — | — | — | — | ✓ | ✓ |
| Convert public → private | — | — | — | — | — | ✓ | ✓ |
| Delete (to Trash) | — | — | — | — | — | — | ✓ |
| Start or join a channel call | ✓ | ✓ (joins the call, not the channel) | ✓ | ✓ | ✓ | ✓ | Public ✓; **private —** |

**DMs and group DMs:** only participants can see, read, post, react or call. Nobody else, including admins, can see the content or add people. Group DMs have fixed membership: adding someone starts a new group DM. Admins can see that a DM exists only in the export and in storage figures, never the participants' messages.

**Assistant writes into DMs and group DMs:** when a member confirms an assistant write there (for example `post_message`), the audit entry records only the **object type**, not the conversation ID ([Assistant](assistant.md) §5.1).

### 4.2 Message-level objects

| Object | Read | Create | Edit | Delete |
|---|---|---|---|---|
| Message | Anyone who can read the conversation | Anyone who can post (threads: anyone who can reply) | Author | Author; channel admins (in their channel); workspace admins (public channels, and private channels they're a member of) |
| Thread | As message | As reply | — | Deleting the root leaves a placeholder |
| Poll | As message | Anyone who can post | — | Creator closes or deletes it; moderators as for messages. **Voter identity is never readable by anyone** (Chat §9). |
| Pin | Anyone who can read | Anyone who can post | — | Anyone who can post; channel admins |
| Saved item | The member only | Anyone who can read the message | — | The member. Disappears when access is lost. |
| File attachment (message-owned) | **Inherits the message's access** | With the message | — | Deleted with the message. "Save to folder" makes an independent copy that follows §4.3. |

### 4.3 Documents, whiteboards, folders, files and drives

Resource roles apply to documents, whiteboards, files and folders. Effective role = union (§5).

| Action | Owner | Editor | Commenter | Viewer | No role |
|---|---|---|---|---|---|
| Open and read (document, whiteboard, file preview or download) | ✓ | ✓ | ✓ | ✓ | — (§7) |
| Comment and reply; react to comments | ✓ | ✓ | ✓ | — | — |
| Edit content; upload a new file version | ✓ | ✓ | — | — | — |
| Resolve or reopen comment threads | ✓ | ✓ | Own threads | — | — |
| Delete any comment (moderation) | ✓ | ✓ | — | — | — (admins ✓, on documents they can access; audited) |
| Restore an old version | ✓ | ✓ | — | — | — |
| Share (add grants up to their own role; change general access) | ✓ | ✓ **(default)** | — | — | — |
| Move within or between drives they can edit | ✓ | ✓ | — | — | — |
| Delete (to Trash) | ✓ | — (folders: editors can delete items they created **(default)**) | — | — | — |
| Restore from Trash | ✓ — plus the person who deleted it, drive managers of its drive, and admins (canonical rule) | — (unless they deleted it) | — | — | — |
| Transfer ownership | ✓; admins (for leavers) | — | — | — | — |
| Approve access requests | ✓ | ✓ | — | — | — |

**Folders:** a folder role applies to the folder and, through inheritance, to everything inside it. Creating an item inside a folder needs editor on the folder.

**Drives:**

| Drive | See it exists | Read contents | Add or edit contents | Manage (rename, access, delete) |
|---|---|---|---|---|
| My files | Owner only | Owner, plus anyone an item is shared with (that item only) | Owner | Owner (admins for leavers) |
| Group drive | **Every member** (name only) | Group members, plus explicit shares | Group members (editor by default) | Group managers and admins (an admin **granting themselves** a role needs an owner) |
| Shared drive | Those with a grant on the drive, or on something inside it | Per drive grants | Editors and managers | Drive managers |
| Channels drive | Every member (but private-channel folders are hidden from non-members) | Per channel folder: channel members, or everyone for public channels (viewer) | **Channel members (editor)** | **Admins manage the drive.** Channel folders follow their channel; the drive itself grants no content access. |

**DM files** have no folder. They live only in the conversation's Files view.

### 4.4 Calendars and events

| Calendar kind | Owner / manager | Editors | Viewers (details) | Freebusy |
|---|---|---|---|---|
| Personal | The member | Members the owner shares with | Members the owner shares with | **Everyone else** |
| Group | Group managers and admins | **Group members** | **Every member** | — |
| Channel | Channel admins | Channel members | Everyone (public channel) or members (private channel) | — |
| Standalone | Creator (owner) | Per grants and general access | Per grants and general access | Per grants |
| Workspace | Admins | Admins | Every member | — |
| Public holidays | — (generated) | — | Every member | — |
| External (ICS in) | Subscriber | — (read-only) | **Subscriber only**; not shareable | — |

**Events:** what a person sees and can do depends on the calendar role, the event's visibility, and whether they're the organiser or an attendee. Organiser and attendee rights apply even without any role on the calendar.

| Viewer of the event | `default` visibility | `private` visibility | `public` visibility |
|---|---|---|---|
| Organiser | Full details, edit, delete | Full details, edit, delete | Full details, edit, delete |
| Attendee (member) | Full details; RSVP; own notes and reminders; no edit | Full details; RSVP; no edit | Full details; RSVP; no edit |
| Calendar editor (not organiser or attendee) | Full details, edit, delete, move | **Busy block only; can't open, edit, delete or move** | Full details, edit, delete, move |
| Calendar viewer | Full details, read-only | **Busy block only** | Full details |
| Freebusy viewer | Busy block only | Busy block only | **Full details** (public overrides freebusy) |
| No calendar role, not invited | Nothing | Nothing | Nothing |

- **Event calls:** the organiser, attendees and anyone whose effective view of the event is "full details" can **start or join** the call **(default)**. Free/busy viewers can't.
- **Moving an event between calendars** needs editor on both calendars and organiser rights **(default)**.
- **Orphaned private events:** if the organiser of a private event is disabled or deleted, an **owner or admin** can delete it. They see only a busy block and the attendee count, never the details. Audited.

**Time off:**
- Every member sees **the dates** of anyone's time off, shown as "Away".
- The **type and note are visible only to the member**: not to admins, not to group managers.
- Members create, edit and cancel their own time off. Admins can edit or cancel anyone's dates (audited), but never see type or note.

### 4.5 Calls

| Context | Start | Join | Moderate (mute, stop a share, lower hands, remove) |
|---|---|---|---|
| Channel | Anyone who can read the channel, including announcement channels ([Chat](chat.md) owns this) | Anyone who can read the channel | Host (the starter), channel admins |
| DM / group DM | A participant | Participants | Host |
| Document / whiteboard | **Anyone who can open it** (viewer or above) | Anyone with access to the document | Host, document owner |
| Calendar event | Organiser or attendee | Invitees, plus full-details viewers (§4.4) | Host, event organiser |

- Archived channels can't host calls.
- If the host leaves, moderation passes to a moderator who is present (channel admin, document owner or event organiser). Otherwise, in DM and group-DM calls, any participant may stop a screen share. Otherwise, moderation passes to the earliest remaining participant **(default)**. [Calls](calls.md) §6.7 says the same.
- Losing access to the context removes the person from an active call: the call's socket closes with code **4403** and its SFU tracks are closed (platform §3 Member lifecycle). Disabling a member closes it with 4401.

### 4.6 Profiles, directory and groups

| Action | Self | Member | Group manager | Admin | Owner |
|---|---|---|---|---|---|
| View the directory and profiles (including email, phone, region, working hours) | ✓ | ✓ | ✓ | ✓ | ✓ |
| Edit own profile, status, handle, sign-in methods, devices | ✓ | — | — | — | — |
| Change someone's email · issue a recovery link · disable · delete · sign out all sessions | — | — | — | **Members only** | Anyone |
| Change role to member or admin | — | — | — | — (admins can't promote) | ✓ |
| Invite with role member | — | — | — | ✓ | ✓ |
| Invite with role admin | — | — | — | — | ✓ |
| Create, rename or delete groups; appoint managers | — | — | — | ✓ | ✓ |
| Add or remove group members | — | — | Own group | ✓ (adding **themselves** needs an owner) | ✓ |
| View the audit log | — | — | — | ✓ | ✓ |

## 5. Containers and inheritance

### 5.1 The union rule

For documents, whiteboards, files and folders:

```text
effective role(user, item) = max(
  grants on the item            (user, any of the user's groups, any channel the user is in),
  grants on each ancestor folder up to the drive root (same principals),
  grants on the drive           (same principals, plus built-in drive roles: My files owner, group drive → group members),
  channel folder rule           (channel members → editor; public channel → everyone viewer),
  general access of the item and of each ancestor (workspace_view / workspace_comment / workspace_edit)
)
```

- The **highest role wins**. There is **no "deny"** and no way to narrow below what a container gives. Sharing can only widen.
- **Calendars** use the same rule, without folders: grants on the calendar, its built-in kind rules (§4.4) and its general access. Event visibility then filters the result (§4.4).
- **Channels and messages** don't use grants. Access is channel membership, channel type and DM participation (§4.1).

### 5.2 New items follow the container

| Created in | Starting access |
|---|---|
| My files | Private to the creator (owner) |
| Group drive or a folder in it | Inherited: group members edit |
| Shared drive or folder | Inherited from the drive and folders |
| Channel folder | Inherited: channel members edit; public channel → everyone can view |
| From a chat message ("Create from message") | The channel's folder for channels (as above); the creator's My files for DMs **(default)** |

- No item has workspace-wide general access unless someone sets it, or its container has it.
- This replaces PRD §10.1's "a document created from scratch: workspace can edit".

### 5.3 Moving items

- Moving changes inherited access. The item **keeps its own explicit grants**; the old container's inherited access is lost and the new container's is gained.
- The move dialog lists people who will **lose** or **gain** access and asks for confirmation.
- Moving needs editor on the item and on the destination.

### 5.4 Channel made private

- Members keep access. Non-members lose channel-derived access to the channel, its messages, its message-owned files and its channel folder.
- **Items in the channel folder with explicit wider access keep it** (for example "workspace can view", or a grant to a group). Before confirming, the conversion dialog **lists those items**, with a one-click "restrict to channel members" for each or for all. The conversion is audited.

### 5.5 Group and channel membership changes

- Joining or leaving a group or channel changes access through group and channel principals immediately.
- Group managers' membership changes are audited, because they can widen access to everything shared with the group.

## 6. Admin powers

| Power | Admin | Owner |
|---|---|---|
| Invite members | ✓ | ✓ |
| Invite or promote admins; demote admins; manage owners | — | ✓ |
| Change email, issue recovery link, disable, re-enable, delete, sign out all sessions: **members** | ✓ | ✓ |
| Same actions on **admins or owners** | — | ✓ (an owner can't disable or delete the last owner) |
| Transfer content of leavers (My files, organised events, owned calendars) | ✓ | ✓ |
| Archive, delete or remove members of **any** channel, including private ones (without reading) | ✓ | ✓ |
| Join or read **private channels, DMs or restricted items** they haven't been given | **—** | **—** |
| Delete messages in private channels they're a member of (added by a member) | ✓ | ✓ |
| Moderate messages in private channels they're not in | — | — |
| Add **themselves** to a group, or grant **themselves** a role on a group drive or folder | — (needs an owner) | ✓ |
| Delete a private event whose organiser is disabled or deleted (without seeing details) | ✓ | ✓ |
| Restore items from Trash | ✓ | ✓ |
| See that private objects exist (name, member count, size), in admin views only | ✓ | ✓ |
| Manage groups and group managers | ✓ | ✓ |
| Workspace settings | ✓ (except owner-only: platform §7 Admin settings) | ✓ |

**Notification and token revocation:**
- When anyone issues a **recovery link** for a person or **changes their email**:
  - an email goes to the person's **current (old) address** (if email is configured): "Your Officebox email was changed by *Admin Name* on *date*" or "*Admin Name* issued a recovery link for your account"
  - a **notice on the sign-in page** and after sign-in, on any device (`users.pending_security_notice`), plus a `security_notice` inbox item
  - **without email configured**, the recovery link is also **flagged to every owner** on the member list until an owner acknowledges it (Identity §4.6)
  - all their **pending magic-link, password-reset and recovery tokens are revoked**, except the newly issued recovery link
  - an audit entry is written.
- Using a recovery link also signs out all the person's existing sessions (Identity §4.6).

**Privacy statement** (help and admin guide): admins can't read private channels, DMs or restricted documents through Officebox. These things are stated plainly:
- **Recovery links.** An admin could sign in as an ordinary **member** by issuing them a recovery link. Officebox emails the member (if email is configured), shows a notice on their sign-in page, flags it to every owner when email isn't configured, and audits it. The member may only find out at their next sign-in, so this is visible, not prevented.
- **Deleted members' files.** Deleting a member hands their private My files to an admin, who can then read them (platform §3 Member lifecycle).
- **Groups.** An admin can't add themselves to a group or grant themselves group-drive access without an owner, because that would expose everything shared with the group.
- **Assistant** ([Assistant](assistant.md) §1, §9, §11):
  - **Scope.** The assistant's privacy guarantee holds **within Officebox**. Anyone with direct access to the Cloudflare account (for example Durable Object storage) is outside Officebox's control.
  - **Model provider.** Prompts and audio go to the configured model provider: Workers AI by default, or a BYOK provider an owner chooses.
  - **Logging.** Officebox turns off AI Gateway request logging and caching for assistant calls.
  - **Other members' data in memory.** A member's assistant memory may hold things they said about other people. Those stay until the member deletes them or retention expires, even if the other person's account is deleted.
  - **What is indexed.** While the assistant is enabled, only content that **at least one member with assistant access can read** is indexed **(default)**. With `assistant_access = everyone`, that's all content.
  - **Admins see metadata only:** who used the assistant, when, and which objects were touched, never prompts, replies or memory.

The Cloudflare account owner has direct technical access to all stored data (PRD §10.1).

## 7. Access requests and no-access screens

### 7.1 No-access screens

| Object | What a person without access sees | Request access? |
|---|---|---|
| Document, whiteboard, file, folder | "You don't have access to this *document*." **The title is shown only if the object sits in a space the viewer can see** (a public channel folder, a group drive listed to them, or shared metadata); otherwise "this item". | ✓ |
| Drive | "You don't have access to this drive." The name is shown for group drives (listed to all); hidden otherwise. | ✓ (to drive managers) |
| Calendar or event | "You don't have access to this *event*." No title. | ✓ (to calendar owners; for events, to the organiser) |
| Private channel | "This conversation is private." No name. | **—** |
| Message (in a private channel, DM or embedded) | "A message you don't have access to." | **—** |
| Deleted object | "This *message* was deleted." | — |

These screens apply everywhere an object can be referenced: links, embeds, forwards, link previews, search results (which never include inaccessible objects), notifications and AI answers.

### 7.2 Requests

| Object | Approvers |
|---|---|
| Document, whiteboard, file | Owner and editors |
| Folder | Owner and editors of the folder |
| Drive | Drive managers |
| Calendar | Calendar owner (personal: the member; group: group managers; workspace: admins) |
| Event | The organiser |

- A request goes to approvers' inboxes (notifications §3 Notification events: `access_request`).
- **What approving does:**
  - documents, whiteboards, files, folders and drives: the approver grants a role up to their own
  - **calendars:** the approver grants a calendar role (viewer, editor, or freebusy)
  - **events have no grants:** the organiser approves by **adding the requester as an attendee**, which gives them full details (§4.4).
- Approvers can also decline.
- **One open request per requester per object.** Repeats update the existing one.
- Requests are rate-limited (platform §8 Rate limits and quotas) and **expire after 30 days (default)**.
- The requester is notified of the outcome (notifications §3 Notification events: `access_request_decided`).

## 8. Enforcement points

| Path | Rule |
|---|---|
| HTTP routes | Every route that reads or writes user content calls the engine. No ad-hoc checks (AGENTS §4.1). |
| WebSocket upgrades | The Worker resolves the role before forwarding (TDD §3.1). The DO stores it in the socket attachment. |
| Revocation | Total loss of access is `updateAccess(userId, null)`: sockets close with `4403` through the UserHub room registry (TDD §3.5). Disabling a member closes everything with `4401`. The registry covers ChatChannel, DocRoom, BoardRoom, HuddleRoom **and the Assistant DO** (kind `assistant`: losing assistant access closes with `4403`), and is persisted (platform §12). |
| **Access change on open sockets** | When a person's effective role on an open document, whiteboard, channel or call context changes (for example editor → viewer, or they leave a group), the Worker calls **`updateAccess(userId, role | null)`** on the affected DOs through the room registry. The DO updates the attachment and sends **`{ type: "access.changed", role }`**. A DocRoom then rejects that socket's updates (read-only) and the client switches to view mode without reconnecting. When `role` is **null** (all access lost), the DO closes the socket with **4403**. This is the only name for the mechanism (platform §12, TDD §3.5). |
| Search, previews, embeds, forwards, notifications, AI | Filtered through the engine at read time (TDD §2.4, §5.3) |
| **AI assistant** ([Assistant](assistant.md) §4, §5, §6) | **Private surfaces** (assistant DM, Talk, live voice, proactive): every tool runs **as the member** through the engine, with their current access; confirmed writes re-check permission. **Mentions in shared conversations** use the **audience rule**: only sources the **whole audience** can open (public channel: public-channel messages, this conversation's files and `workspace_view` objects; private channel: plus objects shared with the channel; DMs, group DMs and private channels of 8 or fewer: plus objects the engine confirms **each** member can open **(default)**), re-checked when the reply is posted. **Personal memory is isolated:** it lives only in the member's own Assistant DO, addressed only by the authenticated member's ID, never used to answer anyone else, and not readable by admins. Cited sources are re-checked on every recall; lost access hides them immediately. |
| Offline edits | Queued offline edits are rejected if the role no longer allows editing when they reach the server. The client keeps them locally and offers "Copy your changes" **(default)**. |

## 9. Data model

**Final value lists, part of the baseline schema** (platform §14 Schema reconciliation). These replace the CHECK constraints in TDD §2.1.

```sql
resource_grants.resource_type  IN ('document', 'whiteboard', 'folder', 'file', 'drive', 'calendar', 'project')
resource_grants.principal_type IN ('user', 'group', 'channel')
resource_grants.role           IN ('owner', 'manager', 'editor', 'commenter', 'viewer', 'freebusy')
users.role                     IN ('owner', 'admin', 'member', 'guest')      -- guest reserved, not assignable until Phase 2
general_access (documents, folders, files, drives, calendars)
                               IN ('restricted', 'workspace_freebusy', 'workspace_view', 'workspace_comment', 'workspace_edit')
                               -- workspace_freebusy: calendars only
group_members.role             IN ('manager', 'member')
channel_members.role           IN ('admin', 'member');  channel_members.can_post (poster flag)
```

- `manager` is valid only for drives, and `freebusy` only for calendars. This is enforced by the engine and Zod, not a CHECK.
- **Defaults:** `folders.general_access` defaults to `restricted`, not `workspace_view` as in TDD §2.1. Personal calendars use `workspace_freebusy`; group calendars use `workspace_view`.
- **Access requests:** `access_requests` gains `expires_at` and a unique index on `(object_type, object_id, requester_id) WHERE state = 'pending'`. `object_type` includes `event`; approving an event request adds an `event_attendees` row rather than a grant.

## 10. API

The engine is internal. It's exposed only through:
- `GET /permissions/:type/:id`: the caller's effective role and allowed actions, for UI affordances
- `GET/PUT /:type/:id/grants`: sharing, per feature routes
- `POST /:type/:id/access-requests`, `POST /access-requests/:id/approve|decline`.

## 11. Acceptance criteria

- **Matrix test.** An automated test enumerates every object type × role × action in §4 and checks the engine's answer. It runs in CI, and a change to §4 must update the test. **It grows per milestone:** M1 covers workspace roles, groups and profiles; M3a adds channels, DMs and messages; M4 adds calls; M5a adds calendars and events; M6a adds documents, folders, drives and files.
- **Union:** a viewer grant on a folder plus an editor grant on an item inside gives editor. An item can't be restricted below its folder.
- **New items:** a document created in My files is private; one created in a channel folder is editable by channel members; none starts workspace-wide.
- **Channel made private:** non-members lose access to messages, attachments and the folder within 5 seconds, open sockets included. Items with explicit wider shares keep them, and those items were listed in the conversion dialog.
- **Admin powers:**
  - an admin can't issue a recovery link, change the email of, disable or delete an admin or owner; an owner can
  - an admin can't invite or promote an admin
  - a recovery link or email change sends an email to the old address, shows the sign-in notice, and revokes pending tokens
  - without email configured, a recovery link flags the member to every owner until acknowledged
  - an admin adding themselves to a group, or granting themselves a group-drive role, gets 403; an owner can do it for them.
- **Admins and private content:** an admin can't join or read a private channel or DM. They can remove members from it and archive it. An admin who was added to a private channel by a member can delete messages in it.
- **Comments:** an editor can delete another person's comment; a commenter can't.
- **Document calls:** a viewer can start a call on a document.
- **Trash:** the item's owner, the person who deleted it, a drive manager and an admin can each restore it; an editor who didn't delete it can't.
- **Orphaned private event:** after its organiser is disabled, an admin can delete it, and the API never returns its details to them.
- **Event access request:** approving adds the requester as an attendee; they then see full details.
- **Calendar:**
  - a calendar editor sees a private event as an unopenable busy block, and API attempts to edit it fail
  - a free/busy viewer sees `public` events in full
  - a free/busy viewer can't join an event call; an invitee can.
- **Access change:** a socket whose role becomes null is closed with 4403; one whose role drops receives `access.changed`.
- **Time off:** type and note are absent from every API response except the member's own, including for admins.
- **Role downgrade:** an editor downgraded to viewer while connected has their next update rejected and their client switches to view mode, without a reconnect.
- **No-access screens:** a no-access screen for an item in a private space doesn't reveal its title. Messages in private channels have no request option.
- **Access requests:** a second request from the same person updates the first; requests expire after 30 days.

## 12. Later

Guest role (Phase 2) · custom roles · deny rules · per-item narrowing below the container · admin "break-glass" access to private content with member notification.

## 13. Open questions

1. **Editors sharing:** can editors share and change general access, or only owners? The default above allows editors.

Resolved: calls in announcement channels can be started by anyone who can read the channel (Chat owns this); host powers pass to a present moderator, otherwise any participant in DM calls, otherwise the earliest remaining participant (§4.5, Calls §6.7); comment moderation, document calls, admin moderation in private channels, orphaned private events, Trash restore and admin self-access were decided after the second review.

**Still pending in other documents:** TDD §2.1 and §3.5 and PRD §10.1 should use the decisions above (comment moderation by editors, viewers starting document calls, admin moderation in private channels they're in, the canonical Trash restore rule, admin self-access needing an owner, `updateAccess` / `access.changed`).

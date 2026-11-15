# Spec: Calls (huddles)

**Status:** Draft for review
**Revision:** Revised after independent review (14 Nov 2026); revised after the second review (`/calls` API with an explicit join step, `call_chat` messages, 4403 on lost access); updated for the [Assistant](assistant.md) spec (15 Nov 2026: call notes, mandatory join notice, live captions, notetaker participant)
**Feature name:** Calls (marketing name to be decided later; "huddles" in the PRD and TDD)
**Milestones** ([PLAN](../PLAN.md)):
- M4: channel and DM calls
- M5b: event calls
- M6: document calls
- M9c: call notes and live captions ([Assistant §12.3, §12.4](assistant.md))

**Related specs:**
- [Permissions](permissions.md) §4
- [Notifications](notifications.md) §5
- [Platform](platform.md): lifecycle, retention, timers, connection budget
- [Chat](chat.md)
- [Calendar](calendar.md)
- [Documents](documents.md)
- [Assistant](assistant.md) §12.3, §12.4

**Related PRD and TDD sections:** PRD §5.8; TDD §3.6, §4.5

Decisions marked **(default)** were not discussed; change them on review.

**Cross-cutting rules:** permissions follow [Permissions](permissions.md); notifications follow [Notifications & Attention](notifications.md); lifecycle, cascades, retention, export, admin settings, limits and timers follow [Platform Rules](platform.md). Those specs win on cross-cutting rules.

## 1. Summary

Instant, audio-first calls you can start from any conversation, document or calendar event, with optional video, screen sharing and present mode. Media goes through the Cloudflare Realtime SFU. Signalling and call state go through Officebox (TDD §3.6). No recording. From M9c, a participant can turn on **call notes** (a transcript and summary written by the assistant) or **live captions** for themselves; audio is never stored ([Assistant §12.3, §12.4](assistant.md)).

**Gate:** the real-media run (`spikes/realtime`, `npm run test:media`) must pass on a real Realtime app before M4 starts.

## 2. Decisions

| Topic | Decision |
|---|---|
| Call model | **Ad-hoc only.** A call starts in a context and ends 30 seconds after the last person leaves. No persistent rooms. |
| Ringing | **DM and group-DM calls ring** the others for 30 seconds. Channel calls never ring. |
| External participants | **Later**, with guest accounts |
| In-call features | **In-call chat, reactions and raise hand, noise-suppression toggle**. Background blur later. |
| Channel call start | **Banner only**: "Call in progress" plus a system message. No pings. |
| Calendar event calls | **Joinable from 10 minutes before start.** At start time attendees get "starting now — join". |
| Event call access | **Invitees, plus anyone with details-level access to the event's calendar.** Free/busy-only viewers can't join. |
| In-call chat retention | **Kept for the life of the context** (channel, DM, document or event). The call's metadata record is purged separately after 365 days. |
| Layout | **Auto**: grid for up to 4 people, active-speaker focus above that. A screen share takes the main stage. Manual switch available. |
| Size | **Up to 25 participants** |
| Join state | **Mic on, camera off.** Mic is auto-muted when joining a call that already has 6 or more people. |
| Two devices | **Handoff**: "Move call here", and the other device leaves. One presence per person. |
| Concurrency | **One call at a time**. Joining another asks "Leave the current call and join?", enforced by `POST /calls/:id/join` (§11). |
| API prefix | **`/calls`** for REST and **`/ws/calls/:id`** for the WebSocket. TDD §3.6's `/huddles` paths change to these. |
| Screen sharing / present mode | As specified in PRD §5.8 and TDD §3.6 / §4.5 |
| Call notes (M9c) | **Visible and stoppable.** Any participant with assistant access can start notes; everyone sees a persistent banner and can stop them; **joining while notes are on requires acknowledging a notice first** ([Assistant §12.3](assistant.md)). |
| Live captions (M9c) | **Per participant, never stored.** Everyone sees a "Captions on" indicator ([Assistant §12.4](assistant.md)) **(default)**. |
| Recording | **Out of scope.** No audio, video or screen content is recorded. |

## 3. Where calls happen

| Context | Milestone | Start from | Who can join | Notes |
|---|---|---|---|---|
| Channel | M4 | Channel header "Start call" (anyone who can read the channel, including announcement channels) | Anyone who can read the channel | One active call per channel. Banner in the header and sidebar. Not available in archived channels. |
| DM / group DM | M4 | DM header | DM participants | **Rings** the others |
| Calendar event | M5b | Event "Join call", by the **organiser, attendees, or anyone with details-level access** to the event's calendar **(default)** | **Invitees + anyone with details-level access to the event's calendar** ([Calendar](calendar.md) §4.5). Free/busy-only viewers can't. | Join window opens 10 minutes before start |
| Document / whiteboard | M6 | Document header, by **anyone with access, viewers included** | Anyone with access to the document, viewers included | Present mode is suggested |
| Issue / personal task | M10b | Issue detail header "Start call", by **anyone who can view the issue** ([Projects §6.3](projects.md)) | Anyone with access to the issue | Not available on issues in archived projects |

**Context keys.** At most one active call per context key, and starting one when a call already exists joins it (TDD §3.6):

| Context | Key |
|---|---|
| Channel or DM | `channel:<channelId>` |
| Document | `document:<documentId>` |
| Single event | `event:<eventId>` |
| Recurring event occurrence | `event:<eventId>:<occurrenceStart>`, where `occurrenceStart` is the occurrence id used by `event_exceptions.original_start` |
| Issue / personal task | `issue:<issueId>` (project-level calls use the project's channel, `channel:<project.channel_id>`) |

**Start and end records:**
- **Channels and DMs:** start and end **system messages**. The end message shows duration and participants.
- **Events:** recorded on the event (shown in the event detail).
- **Documents:** recorded in the **document details panel → Activity** ([Documents](documents.md) §6.1 Activity) **(default)**.
- **Issues:** recorded in the issue's **Activity & Comments** timeline (`call.started` / `call.ended`, [Projects §6.3](projects.md)) **(default)**.
- **Call notes** (M9c), when taken, go to the same context: a `call_notes` message in the channel or DM ([Chat](chat.md) §4.6), a "Call notes" section on the event ([Calendar](calendar.md) §9), the document's Activity section, or the issue's Activity & Comments timeline. They are visible to that context's audience ([Assistant §12.3](assistant.md)).
- The channel `call_started` system message is posted by the HuddleRoom through a **typed-result RPC to the ChatChannel DO** ([Chat](chat.md) §4.6 System messages).

## 4. Ringing (DMs and group DMs)

- Starting a call in a DM sends a **ring** through each other participant's UserHub (M2). Their app shows an incoming-call banner with the caller's name and avatar plus **Accept** and **Decline**, and a ring sound (with a per-member setting to silence it).
- Rings last **30 seconds**. Accepting joins the call. Declining tells the caller "*Ana* declined".
- If nobody answers in 30 seconds, the caller sees "No answer". A **"Missed call" system message** goes into the DM and a `missed_call` inbox item is created ([Notifications](notifications.md) §3).
- **Do-not-disturb** (manual, scheduled or focus time) and **time off** suppress ringing ([Notifications](notifications.md) §5). The caller sees "*Ana* is in do-not-disturb" or "*Ana* is away until Monday", and a missed call is recorded.
- Ringing goes to every device where the person is online. Accepting on one device stops it on the others.
- A group DM rings everyone. The call carries on for whoever joins.
- **Call waiting:** calling someone who is already in another call still rings them, with **"*Ana* is calling (you're in a call)"**. Accepting asks "Leave your current call and join?", because the one-call-at-a-time rule applies (§5).
- **Source of truth:** the **UserHub** holds live ring state (ringing, accepted, declined). `call_rings` in D1 is the durable record, written when a ring ends, used for missed calls and history.

## 5. Joining

- **Join state:**
  - Mic on and camera off by default.
  - Joining a call that already has 6 or more participants starts **muted**, with a hint "You're muted — the call has *N* people" (*N* is 6 or more).
  - DM calls never auto-mute.
- **Device choice:** microphone, camera and speaker can be picked from the call controls at any time. The last choice is remembered per device. A **pre-join screen** appears only when the browser hasn't granted permission, or the remembered device is missing **(default)**. The call-notes notice below is shown even when the pre-join screen is skipped.
- **Joining while notes are on (M9c):** `POST /calls/:id/join` returns **`notes_ack_required`** with the notice text instead of joining ([Assistant §12.3](assistant.md)).
  - The client shows a **modal dialog**, with focus trapped and Escape meaning "Don't join". It offers **Join** or **Don't join**, even if the member's devices would otherwise skip the pre-join screen. The notice also mentions captions when anyone has them on.
  - **Join** repeats the request with **`ackNotes: true`**. "Don't join" leaves cleanly.
  - Until then the member isn't in the call, so no audio is sent or transcribed.
  - If notes start while someone is joining, the same check applies.
- **Two devices (handoff):**
  - Joining from a second device while already in the call shows "**Move call here?**". Confirming moves the person, and the first device leaves with "Call moved to another device".
  - The HuddleRoom enforces **one connection per person**.
- **One call at a time:** joining a second call asks "Leave *#design* call and join *#ops* call?". The server enforces it with an explicit join step:
  - `POST /calls/:id/join` checks access, capacity and the member's current call, recorded in their UserHub (`currentCall`).
  - If the member is already in another call, it returns **`409 { currentCallId }`**, and the client shows the question. Sending `{ leaveCurrent: true }` leaves the other call (its socket closes with `4002 "moved"`) and joins this one.
  - On success the UserHub records this call as current, and the WebSocket upgrade to `/ws/calls/:id` is refused unless it is.
  - The UserHub keeps `currentCall` and live ring state in its own storage, so they survive eviction ([Platform §12](platform.md)).
- **Capacity:** 25 participants.
- **Event calls:**
  - "Join call" appears on the event **10 minutes before** start and stays while the call is active.
  - The call can still be joined until the event's end time, plus as long as people remain **(default)**.
  - At start time, attendees who've accepted or not answered get a **"*Weekly sync* is starting — Join"** notification, triggered by the ReminderScheduler ([Platform](platform.md) §11). Declined attendees get none.

## 6. In the call

### 6.1 Controls

Mute, camera, share screen, reactions, raise hand, in-call chat, participants list, layout switch, device settings, noise suppression and leave. From M9c, also **Take notes / Stop notes** and **Captions** ([Assistant §12.3, §12.4](assistant.md)).

**Notes and captions (M9c):**
- **Take notes** is shown to participants with assistant access when `assistant_call_notes` is on. It's disabled, with an explanation, when the workspace call-notes cap is reached. **Stop** is available to every participant. After a stop, notes can be restarted after **10 seconds (default)**.
- **Banner:** while notes are on, everyone sees a persistent banner, "Butler is taking notes — started by *Name*", with **Stop**, naming who will see the notes for this context. It's a labelled region announced once (`role="status"`) and doesn't steal focus.
- **Notetaker:** the assistant appears in the participants list as a **notetaker** with no camera or microphone. It's a virtual entry in HuddleRoom state, **not a `huddle_participants` row**, and **isn't counted toward the 25-person limit**.
- **Captions** are turned on per participant, for themselves, when `call_captions` is on. While anyone has captions on, all participants see a **"Captions on"** indicator. Others can't turn off someone's captions **(default)**.
- In channel and DM calls, a system message in the in-call chat records each start and stop of notes.

**Keyboard shortcuts:**

| Shortcut | Action |
|---|---|
| Cmd/Ctrl+D | Mute / unmute |
| Cmd/Ctrl+E | Camera on / off |
| Cmd/Ctrl+Shift+S | Share screen |
| Space (hold) | **Push-to-talk** while muted |

**Push-to-talk** is **off by default** and can be turned on in call settings. It's disabled while any text input has focus, including the in-call chat (WCAG 2.1.4).

### 6.2 Layout

- **Auto:** grid for 1–4 participants, **active-speaker focus** with a filmstrip for 5 or more. A screen share always takes the main stage, with participants in a side strip.
- People can switch to **Grid** or **Speaker** for themselves.
- **Tiles:**
  - with camera off: avatar, name, mic state and a speaking ring
  - with camera on: video, name and mic state.
- At most 9 video tiles are visible at once **(default)**. Others can be paged.
- The active speaker is detected from audio levels on the client.

### 6.3 Reactions and raise hand

- **Reactions:** quick emoji (👍 ❤️ 😂 🎉 👏 😮) **(default)** that float over the sender's tile for 3 seconds **(default)**. Reactions are ephemeral and not stored.
- **Raise hand:**
  - A hand icon on the tile, and an **ordered queue** in the participants list, showing who raised first.
  - People lower their own hand. Moderators (§6.7) can lower anyone's. Hands lower automatically when that person unmutes and speaks for a few seconds **(default)**.

### 6.4 In-call chat

- A chat panel inside the call. It supports text, mentions, links and emoji. Files come later **(default)**.
- **Saved afterwards:**
  - **Channel and DM calls:** messages are posted as a **thread under the call's "started" system message**, reusing chat ([Chat](chat.md) §5), with **`kind = 'call_chat'`** ([Chat](chat.md) §4.7). These messages create no thread follows, no `thread_reply` notifications, no offline email and no unread counts, so a busy call doesn't flood the channel. The HuddleRoom writes them through a **typed-result RPC to the ChatChannel DO**, never throwing expected denials ([AGENTS.md](../AGENTS.md) §4.1).
  - **Document, event and issue calls:** messages are stored in `huddle_messages`, **attached to the context** (document, event or issue), not to the call record. The HuddleRoom writes them to D1 **through an outbox** (the outbox pattern of TDD §3.3). They're linked from the call record in the document's Activity, on the event, or in the issue's Activity & Comments timeline. They raise no notifications.
- **Rate limit:** in-call chat has its own limit, not the channel's per-conversation send limit ([Platform §8](platform.md)).
- **Retention:** in-call chat is kept for **the life of the context**. It isn't deleted when the call's metadata is purged after 365 days ([Platform](platform.md) §5). It's deleted with its context.
- Everyone who can see the context can read the saved chat, whether or not they were in the call.

### 6.5 Audio

- Opus audio through the SFU.
- A **noise suppression** toggle, on by default, uses the browser's built-in noise suppression, echo cancellation and auto gain (`getUserMedia` constraints).
- An input level meter appears in device settings.

### 6.6 Screen sharing and present mode

As specified in **PRD §5.8** and **TDD §3.6 / §4.5**, and validated in the spike:
- screen, window or tab, with tab audio where supported
- **one presenter at a time**, with take-over requests and hand-over (force-closed after 5 seconds)
- text-first quality (up to 1080p at 15 fps) with a **motion** mode (30 fps)
- **simulcast** layers chosen per viewer
- viewer full screen, picture-in-picture, zoom and pan
- moderator stop
- the workspace sharing policy (everyone / admins / off) and resolution cap
- sharing from desktop browsers only; viewing everywhere.

**Present mode** for documents and whiteboards: follow the presenter with no video.

### 6.7 Moderation

- **Moderators:**
  - the **host**: the person who started the call
  - in channel calls: **channel admins**
  - in document calls: **document owners**
  - in event calls: the **event organiser**
  - in issue calls: **Project Leads** (or the issue creator for personal tasks).
- **When the host leaves,** moderation passes to a moderator who is present: a channel admin, the document owner, the event organiser or a Project Lead (or issue creator). Otherwise, in DM and group-DM calls, any participant may stop a screen share. Otherwise, moderation passes to the **earliest remaining participant** **(default)**. [Permissions](permissions.md) §4.5 says the same.
- **Moderators can:**
  - mute a participant (the participant must unmute themselves; they can't be force-unmuted)
  - stop a screen share
  - lower hands
  - **remove a participant** from the call; they can rejoin unless they lose access **(default)**.
- Moderation actions are audited.

## 7. Ending

- A call ends **30 seconds after the last participant leaves** (TDD §3.6). The end record shows duration and who attended (§3).
- **Huddle records** are **metadata only** (context, participants, times, whether a screen was shared) and are purged after 365 days ([Platform](platform.md) §5). No audio, video or screen content is ever recorded. In-call chat is separate and follows its context (§6.4).
- **Call notes and transcripts** (M9c) are also separate from the huddle record and never cascade from it. Notes stop when the call ends, or when no human participants remain; they're finalised after the call. Notes stay for the life of the context; transcripts are purged after `call_transcript_retention_days` ([Assistant §12.3](assistant.md)).

## 8. Errors and edge cases

| Situation | Behaviour |
|---|---|
| **SFU unreachable** (session creation or publish fails) | "Can't connect to the call service — retrying…" with automatic retries (1 s, 2 s, 4 s, up to 30 s) **(default)**, then "Try again". Chat and the rest of the app keep working (PRD §18). |
| **Room full** (26th person) | Join refused: "This call is full (25)". No connection is opened. |
| **Microphone denied** | The member joins **listen-only**, with a banner explaining how to allow the mic in the browser. Camera denied disables only the camera control. |
| **Network drop** | The client keeps the participant's slot for 30 seconds (the SFU's session reuse window), shows "Reconnecting…", and renegotiates on return. After 30 seconds they're removed and can rejoin. |
| **Host disabled mid-call** | Revocation closes their call connection like any room, with code **4401** ([Platform](platform.md) §3). Moderation passes on as in §6.7. |
| **Participant loses access mid-call** (removed from the channel, invitation withdrawn, document access revoked) | The Worker calls `updateAccess(userId, null)` on the HuddleRoom, which closes their call connection with code **4403** and "You no longer have access to this call", and closes their SFU tracks. |
| **Presenter's capture ends unexpectedly** (window closed) | Treated as stopping the share; the presenter slot is released. |

**Revocation:** the HuddleRoom **joins the UserHub room registry** like channel and document objects. Disabling a member (code 4401), or removing their access to the call's context (code 4403), closes their call connection within seconds ([Platform](platform.md) §3, §12; TDD §3.5).

## 9. Mobile

- Mobile browsers and the installed PWA can **join with audio and video**, receive rings while the app is open, and view screen shares.
- They can't share their screen; the control is hidden.
- Push-notification ringing when the app is closed arrives later, with web push (PRD §8).

## 10. Data model (additions to TDD §3.6)

```sql
-- huddles.context_type gains 'event' and 'issue' (schema reconciliation, platform §14).
-- The call "kind" is derived, not stored: DM = channel context whose channel type is a DM or group DM; event = 'event' context; issue = 'issue' context.
ALTER TABLE huddles ADD COLUMN context_key TEXT;            -- e.g. 'event:<eventId>:<occurrenceStart>' or 'issue:<issueId>' (§3)
ALTER TABLE huddles ADD COLUMN started_message_id TEXT;     -- channel/DM: the "call started" message (in-call chat thread root)
-- Active-call uniqueness moves to the context key:
--   CREATE UNIQUE INDEX huddles_active ON huddles(context_key) WHERE ended_at IS NULL;

CREATE TABLE huddle_messages (                              -- in-call chat for document, event and issue calls
  id TEXT PRIMARY KEY,
  context_type TEXT NOT NULL,                               -- 'document' | 'event' | 'issue' (Zod-validated)
  context_id TEXT NOT NULL,                                 -- document id, event id (occurrence in context_key), or issue id
  context_key TEXT NOT NULL,
  huddle_id TEXT,                                           -- informational link; no cascade from huddles
  sender_id TEXT REFERENCES users(id),
  format TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX huddle_messages_context ON huddle_messages(context_type, context_id, created_at);
-- Deleted with the context (document, event or issue purge), never with the huddle record (platform §4, §5).

CREATE TABLE call_rings (                                   -- durable record; live ring state is in the UserHub
  huddle_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  state TEXT NOT NULL,                                      -- 'accepted','declined','missed','suppressed','refused' (Zod-validated)
                                                            --   suppressed: callee in DND, focus or time off
                                                            --   refused: callee disabled, or the ring rate limit was hit (Platform §3, §8)
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (huddle_id, user_id)
);
```

**HuddleRoom DO** additions:
- one connection per user, with handoff closing the old socket with code `4002 "moved"`
- the raise-hand queue and moderator hand-over when the host leaves
- reaction relay, which is ephemeral and not stored
- in-call chat relay: typed-result RPC to the ChatChannel DO, or outbox to `huddle_messages`
- participant removal
- registration in the UserHub room registry, and `updateAccess(userId, role | null)` (null closes with 4403).

**Call notes (M9c):** tables `call_notes` and `call_transcript_segments` are defined in [Assistant §14.2](assistant.md). `call_notes` holds the context (`context_type`, `context_id`), is reparented to the context and **must not cascade from `huddles`** (Platform §5). Transcript segments are written in batches through the outbox, and D1 is their only lasting copy.

**HuddleRoom DO** additions for M9c ([Assistant §12.3, §12.4](assistant.md)):
- notes state: the **notetaker virtual participant** (not a `huddle_participants` row, not counted toward 25), the open transcription window, and who started and stopped notes; start and stop are serialised in arrival order
- per-track transcription only while a window is open (by HuddleRoom server time); "transcription gap" markers after eviction
- the set of participants with captions on, for the "Captions on" indicator; captions are never stored
- the join check that returns `notes_ack_required`
- named timers **`notes_idle`** (stop when no humans remain) and **`notes_finalize`** (write the notes after the call ends or after a crash).

**UserHub** additions (persisted in its storage):
- `currentCall` (the one-call-at-a-time rule), set by `POST /calls/:id/join`
- live ring state and delivery: `call.ring`, `call.ring.cancel`, `call.accepted-elsewhere`, and call waiting.

## 11. API

All routes need a session. State-changing routes need the CSRF header (TDD §8.2). **This table is the complete calls API**; TDD §3.6's `/huddles/...` paths change to these `/calls/...` paths, with the same request and response bodies as the spike.

| Method and path | Purpose |
|---|---|
| `POST /calls` `{ contextType, contextId, occurrence? }` | Start a call in a context, or get the active one. Returns `{ huddleId, created }`. DM contexts start ringing. Starting doesn't join: the client then calls `/join`. |
| `POST /calls/:id/join` `{ leaveCurrent?, ackNotes? }` | Join: checks access, capacity (25) and the one-call rule. Returns `200 { connectUrl: "/ws/calls/:id" }`, `409 { currentCallId }` if already in another call (unless `leaveCurrent: true`), `409 { full: true }` when full, or `403`. While notes are on (M9c), returns **`notes_ack_required`** with the notice text unless the request has `ackNotes: true` (§5). |
| `POST /calls/:id/leave` | Leave (also happens when the socket closes) |
| `GET /calls/:id` | Call state: context, participants, presenter |
| `GET /calls/:id/ice-servers` | STUN, and short-lived TURN credentials if configured |
| `POST /calls/:id/tracks/publish` `{ connId, sessionDescription, tracks[{ mid, kind }] }` | Publish local tracks (SFU session created on first publish) |
| `POST /calls/:id/tracks/subscribe` `{ connId, tracks[{ connId, kind, preferredRid? }] }` | Pull remote tracks; returns the SFU's offer |
| `POST /calls/:id/renegotiate` `{ connId, sessionDescription }` | Answer the SFU's offer |
| `POST /calls/:id/tracks/close` `{ connId, mids, sessionDescription? }` | Close own tracks |
| `POST /calls/:id/tracks/layer` `{ connId, mid, preferredRid }` | Switch simulcast layer |
| `POST /calls/:id/ring/accept` · `POST /calls/:id/ring/decline` | Answer a ring |
| `POST /calls/:id/participants/:connId/remove` | Moderator removes a participant |
| `GET /calls/:id/chat` · `GET /contexts/:type/:id/call-chat?before=…` | In-call chat history for the live call, or saved chat for a document or event |
| `POST /calls/:id/notes` · `DELETE /calls/:id/notes` | Start or stop call notes (M9c): any participant; starting needs assistant access ([Assistant §15](assistant.md)) |
| `POST /calls/:id/captions` · `DELETE /calls/:id/captions` | Turn your own captions on or off (M9c) |
| `GET /calls/:id/notes` · `GET /call-notes/:id/transcript` | Call notes and transcript, permission-checked against the call's context (M9c) |

**WebSocket** (`/ws/calls/:id`, authenticated as in TDD §3.1).

Client → room:

| Message | Purpose |
|---|---|
| `screen.start` · `screen.stopped` · `screen.handover { toConnId }` | Screen sharing (TDD §3.6) |
| `screen.stop { targetConnId }` · `mute { targetConnId }` | Moderation |
| `hand { raised }` · `hand.lower { targetConnId }` | Raise hand |
| `reaction { emoji }` | Reactions |
| `chat.send { clientId, format, text }` | In-call chat |
| `handoff.confirm` | Move the call to this device |

Room → client:

| Message | Purpose |
|---|---|
| `welcome` (connId, policy, roster) · `roster` | Join and roster updates |
| `screen.granted` · `screen.pending` · `screen.request` · `screen.stop-requested` · `screen.stopped-by` | Screen sharing |
| `muted-by` | Moderation |
| `hand.queue` | Raise-hand queue |
| `reaction` | Reactions |
| `chat.message` · `chat.ack` | In-call chat |
| `moderators` | Who moderates now |
| `removed` · `moved` (close codes `4003` removed, `4002` moved, `4403` access lost, `4401` session revoked) | Leaving the call |
| `error` | Typed errors |

Hub → client (UserHub): `call.ring`, `call.ring.cancel`, `call.accepted-elsewhere`, `call.declined`.

## 12. Acceptance criteria

**M4: channel and DM calls**
- **Real media:** `test:media` passes against the production Worker (join-to-audio under 2 s, share start under 3 s, screen latency p95 under 500 ms, moderator stop under 3 s).
- **Ringing:**
  - a DM call rings the other person on all their online devices; accepting on one sends `call.ring.cancel` to the others within 1 s
  - an unanswered ring creates a missed-call message, a `call_rings` row (`missed`) and a `missed_call` inbox item after 30 s
  - DND suppresses the ring and records `suppressed`
  - calling someone already in a call shows the call-waiting banner, and accepting asks them to leave their current call.
- **Channel calls:** a channel call shows the banner and system messages, and creates no inbox items.
- **Joining:**
  - joining a call with 6 or more participants starts muted
  - joining from a second device hands off the call, and the first socket closes with `4002`
  - `POST /calls/:id/join` while in another call returns `409 { currentCallId }`; with `leaveCurrent: true` the first call's socket closes with `4002` and the join succeeds
  - a WebSocket upgrade to a call the member hasn't joined is refused.
- **Capacity:** the 26th join is refused with "This call is full (25)".
- **In-call chat:** in a channel call it ends up as a thread under the call's start message, written through a typed-result RPC, as `call_chat` messages that create no thread follows, no `thread_reply` notifications, no offline email and no unread counts.
- **Raise hand and moderation:**
  - the raise-hand queue shows the correct order; moderators can lower hands
  - when the host leaves, a channel admin present receives `moderators` and can stop a share
  - in a group-DM call any participant can stop a share
  - a removed participant's socket closes with `4003`.
- **Revocation:** disabling a member closes their call connection with `4401` within 5 seconds; removing a member from the call's channel closes it with `4403`.
- **Ring records:** a ring to a disabled member is recorded as `refused`.
- **Errors:** with the SFU unreachable, the client shows the retry message and the rest of the app keeps working (fake SFU returning errors).
- **Accessibility:** push-to-talk is off by default and ignored while a text input has focus.
- **Browsers (manual):** a call between Chrome and Safari has two-way audio and screen sharing.

**M5b: event calls**
- The call is joinable 10 minutes before start; earlier joins are refused.
- Invitees and details-level calendar viewers can join; free/busy-only viewers get 403.
- Each recurring occurrence gets its own call (distinct context keys).
- Attendees (except those who declined) get "starting now" within 1 minute of start.
- In-call chat is stored in `huddle_messages` against the event and survives the purge of the call's metadata.

**M6: document calls**
- Anyone with access to the document, including viewers, can start or join.
- The call appears in the document details panel → Activity.
- In-call chat is stored against the document and is deleted only with the document.

**M9c: call notes and captions** (full criteria in [Assistant §16](assistant.md), M9c)
- `POST /calls/:id/join` without `ackNotes` returns `notes_ack_required` while notes are on, even when devices would skip pre-join; nothing is sent or transcribed before Join; the dialog traps focus and Escape means Don't join.
- Any participant can stop notes; a start and stop arriving together resolve in arrival order; no segment comes from audio received outside an open window.
- The notetaker appears in the participants list, isn't a `huddle_participants` row, and doesn't count toward the 25-person limit.
- Evicting the HuddleRoom mid-call records a gap and still produces notes through `notes_finalize`.
- Notes post to the right context and are visible only to its audience; `POST`/`DELETE /calls/:id/notes` return `forbidden` to non-participants, and `GET /call-notes/:id/transcript` to people outside the context.
- Captions work with notes off, store nothing, and show the "Captions on" indicator to everyone.
- The notes banner, joining notice and captions region pass axe and keyboard checks; `test:media` passes before merging.

## 13. Later

External participants by link (with guest accounts) · background blur and virtual backgrounds · push-notification ringing · persistent rooms · files in in-call chat.

Transcription and summaries moved from here to **M9c** as call notes and live captions ([Assistant §12.3, §12.4](assistant.md)). Recording stays out of scope.

## 14. Open questions

None outstanding. Resolved in this revision:
- Event call access: invitees plus details-level calendar viewers.
- Push-to-talk: off by default and disabled while typing.
- Participant removal: kept **(default)**.

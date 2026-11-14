# Spec: Calls (huddles)

**Status:** Draft for review
**Feature name:** Calls (marketing name to be decided later; "huddles" in the PRD and TDD)
**Milestone:** M4 ([PLAN](../PLAN.md)) · **Related:** PRD §5.8; TDD §3.6, §4.5; [Chat](chat.md), [Calendar](calendar.md)

Decisions marked **(default)** were not discussed; change them on review.

## 1. Summary

Instant, audio-first calls you can start from any conversation, document or calendar event, with optional video, screen sharing and present mode. Media goes through the Cloudflare Realtime SFU. Signalling and call state go through Officebox (TDD §3.6). No recording.

**Gate:** the real-media run (`spikes/realtime`, `npm run test:media`) must pass on a real Realtime app before this milestone starts.

## 2. Decisions

| Topic | Decision |
|---|---|
| Call model | **Ad-hoc only.** A call starts in a context and ends 30 seconds after the last person leaves. No persistent rooms. |
| Ringing | **DM and group-DM calls ring** the others for 30 seconds. Channel calls never ring. |
| External participants | **Later**, with guest accounts (Phase 2) |
| In-call features | **In-call chat, reactions and raise hand, noise-suppression toggle**. Background blur later. |
| Channel call start | **Banner only**: "Call in progress" plus a system message. No pings. |
| Calendar event calls | **Joinable from 10 minutes before start.** At start time attendees get "starting now — join". |
| Layout | **Auto**: grid for up to 4 people, active-speaker focus above that. A screen share takes the main stage. Manual switch available. |
| Size | **Up to 25 participants** |
| Join state | **Mic on, camera off.** Mic is auto-muted when joining a call that already has 6 or more people. |
| Two devices | **Handoff**: "Move call here", and the other device leaves. One presence per person. |
| Concurrency | **One call at a time**. Joining another asks "Leave the current call and join?". |
| Screen sharing / present mode | As specified in PRD §5.8 and TDD §3.6 / §4.5 |

## 3. Where calls happen

| Context | Start from | Who can join | Notes |
|---|---|---|---|
| Channel | Channel header "Start call" | Anyone who can read the channel | One active call per channel. Banner in the header and sidebar. |
| DM / group DM | DM header | DM participants | **Rings** the others |
| Document / whiteboard | Document header | Anyone with access to the document | Present mode is suggested |
| Calendar event | Event "Join call" | Event attendees, plus anyone who can see the event **(default)** | Join window opens 10 minutes before start |

- A context has at most one active call. Starting one when a call already exists joins it (TDD §3.6).
- **Start and end system messages** appear in the channel or DM. The end message shows duration and participants. Event calls record this on the event, and document calls in the document's activity **(default)**.

## 4. Ringing (DMs and group DMs)

- Starting a call in a DM sends a **ring** through each other participant's UserHub (M2). Their app shows an incoming-call banner with the caller's name and avatar plus **Accept** and **Decline**, and a ring sound (with a per-member setting to silence it).
- Rings last **30 seconds**. Accepting joins the call. Declining tells the caller "*Ana* declined".
- If nobody answers in 30 seconds, the caller sees "No answer". A **"Missed call" system message** goes into the DM and a `missed_call` inbox item is created.
- **Do-not-disturb** (manual or scheduled) and **time off** suppress ringing. The caller sees "*Ana* is in do-not-disturb" or "*Ana* is away until Monday", and a missed call is recorded.
- Ringing goes to every device where the person is online. Accepting on one device stops it on the others.
- A group DM rings everyone. The call carries on for whoever joins.

## 5. Joining

- **Join state:**
  - Mic on and camera off by default.
  - Joining a call that already has 6 or more participants starts **muted**, with a hint "You're muted — the call has 7 people".
  - DM calls never auto-mute.
- **Device choice:** microphone, camera and speaker can be picked from the call controls at any time. The last choice is remembered per device. A **pre-join screen** appears only when the browser hasn't granted permission, or the remembered device is missing **(default)**.
- **Permissions:** if the browser denies microphone access, the member joins listen-only with a clear prompt to fix it.
- **Two devices (handoff):**
  - Joining from a second device while already in the call shows "**Move call here?**". Confirming moves the person, and the first device leaves with "Call moved to another device".
  - The HuddleRoom enforces **one connection per person**.
- **One call at a time:** joining a second call asks "Leave *#design* call and join *#ops* call?". The server enforces this too. A member's UserHub records their current call, and joining another requires confirmation.
- **Capacity:** 25 participants. The 26th sees "This call is full (25)".
- **Event calls:**
  - "Join call" appears on the event **10 minutes before** start and stays while the call is active.
  - The call can still be joined until the event's end time, plus as long as people remain **(default)**.
  - At start time, attendees who've accepted or not answered get a **"*Weekly sync* is starting — Join"** notification. Declined attendees get none.

## 6. In the call

### 6.1 Controls

Mute, camera, share screen, reactions, raise hand, in-call chat, participants list, layout switch, device settings, noise suppression and leave.

**Keyboard shortcuts:**

| Shortcut | Action |
|---|---|
| Cmd/Ctrl+D | Mute / unmute |
| Cmd/Ctrl+E | Camera on / off |
| Cmd/Ctrl+Shift+S | Share screen |
| Space (hold) | Push-to-talk while muted **(default)** |

### 6.2 Layout

- **Auto:** grid for 1–4 participants, **active-speaker focus** with a filmstrip for 5 or more. A screen share always takes the main stage, with participants in a side strip.
- People can switch to **Grid** or **Speaker** for themselves.
- **Tiles:**
  - with camera off: avatar, name, mic state and a speaking ring
  - with camera on: video, name and mic state.
- At most 9 video tiles are visible at once **(default)**. Others can be paged.
- The active speaker is detected from audio levels on the client.

### 6.3 Reactions and raise hand

- **Reactions:** quick emoji (👍 ❤️ 😂 🎉 👏 😮) that float over the sender's tile for 3 seconds.
- **Raise hand:**
  - A hand icon on the tile, and an **ordered queue** in the participants list, showing who raised first.
  - People lower their own hand. The host and channel admins can lower anyone's. Hands lower automatically when that person unmutes and speaks for a few seconds **(default)**.

### 6.4 In-call chat

- A chat panel inside the call. It supports text, mentions, links and emoji. Files come later **(default)**.
- **Saved afterwards:**
  - Channel and DM calls: messages are posted as a **thread under the call's "started" system message**, reusing chat (`specs/chat.md` §5). The conversation stays with the channel.
  - Document and event calls: messages are kept with the call record and linked from the call summary in the document's activity or on the event **(default)**.
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

- **Host:** the person who started the call. The host and channel admins (document owners for document calls, event organisers for event calls) can:
  - mute a participant (the participant must unmute themselves; they can't be force-unmuted)
  - stop a screen share
  - lower hands
  - remove a participant from the call (they can rejoin unless they lose access) **(default)**.
- Moderation actions are audited.

## 7. Ending

- A call ends **30 seconds after the last participant leaves** (TDD §3.6). The end system message shows duration and who attended.
- Huddle records are **metadata only** (context, participants, times, whether a screen was shared) and are kept for 365 days (PRD §10.2). No audio, video or screen content is ever recorded.

## 8. Mobile

- Mobile browsers and the installed PWA can **join with audio and video**, receive rings while the app is open, and view screen shares.
- They can't share their screen; the control is hidden.
- Push-notification ringing when the app is closed arrives with web push (Phase 2, PRD §8).

## 9. Data model (additions to TDD §3.6)

```sql
-- huddles: new context types and the in-call chat link
-- context_type: 'channel' (includes DMs), 'document', 'event'
ALTER TABLE huddles ADD COLUMN started_message_id TEXT;    -- channel/DM: the "call started" message (in-call chat thread root)
ALTER TABLE huddles ADD COLUMN kind TEXT NOT NULL DEFAULT 'ad_hoc' CHECK (kind IN ('ad_hoc', 'dm', 'event'));

CREATE TABLE huddle_messages (                              -- in-call chat for document/event calls only
  id TEXT PRIMARY KEY,
  huddle_id TEXT NOT NULL REFERENCES huddles(id) ON DELETE CASCADE,
  sender_id TEXT REFERENCES users(id),
  format TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE call_rings (                                   -- for missed-call records and ring state
  huddle_id TEXT NOT NULL REFERENCES huddles(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  state TEXT NOT NULL CHECK (state IN ('ringing', 'accepted', 'declined', 'missed', 'suppressed')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (huddle_id, user_id)
);
```

**HuddleRoom DO** additions:
- one connection per user, with handoff closing the old socket with code `4002 "moved"`
- the raise-hand queue
- reaction relay, which is ephemeral and not stored
- in-call chat relay, writing to the channel DO thread or to `huddle_messages`
- participant removal.

**UserHub** additions:
- `currentCall` (the one-call-at-a-time rule)
- ring delivery: `call.ring`, `call.ring.cancel` and `call.accepted-elsewhere`.

## 10. Acceptance criteria

- **Real media:** `test:media` passes against the production Worker (join-to-audio under 2 s, share start under 3 s, screen latency p95 under 500 ms, moderator stop under 3 s).
- **Ringing:**
  - a DM call rings the other person on all their online devices; accepting on one stops the others
  - an unanswered ring creates a missed-call message and inbox item
  - DND suppresses the ring.
- **Channel calls:** a channel call shows the banner and system messages and pings nobody.
- **Joining:**
  - joining a call with 6 or more people starts muted
  - joining from a second device hands off the call
  - joining a second call asks to leave the first.
- **In-call chat:** in a channel call it ends up as a thread under the call's start message.
- **Raise hand:** the queue shows the correct order; the host can lower hands.
- **Event calls:** the event call is joinable 10 minutes before start, and attendees are notified at start time.
- **Capacity:** the 26th participant is refused with a clear message.
- **Browsers:** a call between Chrome and Safari has two-way audio and screen sharing.

## 11. Later

External participants by link (with guest accounts) · background blur and virtual backgrounds · transcription and summaries (Phase 3) · push-notification ringing (Phase 2) · persistent rooms · files in in-call chat.

## 12. Open questions

1. **Event call access:** attendees only, or anyone who can see the event? (The default above is anyone who can see it.)
2. **Push-to-talk with Space:** useful, or risky when typing in the in-call chat? (It would be disabled while the chat input has focus.)
3. **Participant removal by hosts:** needed in the first release, or is muting enough?

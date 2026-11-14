# Realtime spike

A throwaway prototype of Officebox's realtime core. It tests the riskiest parts of [TDD](../../TDD.md) §2–4 against the real Workers runtime before Phase 1 is built on them. It is **not** production code. There's no UI, sign-in is a password-less dev route, and permissions are simplified.

## What it covers

| TDD design point | Where | Proven by |
|---|---|---|
| Cookie auth on WebSocket upgrade, `Origin` check, disabled accounts refused (§3.1) | `src/auth.ts`, `src/index.ts` | `chat.test.ts` › authentication |
| One-time, target-bound tickets for non-browser clients; CSRF header to issue them (§3.1) | `src/auth.ts` | `doc.test.ts` › tickets; the stock client script |
| Private-channel and document access resolved in the Worker before reaching a DO (§2.1, §4.4) | `src/index.ts` | both test files |
| Channel DO as source of truth: event log, `seq` ordering, acknowledge only after a durable write (§3.3) | `src/chat-channel.ts` | write path tests |
| `clientId` dedupe of retried sends (§3.3) | `src/chat-channel.ts` | "retried send" test |
| Reconnect replay (`sync afterSeq`), log horizon and `reset` (§2.2, §3.3) | `src/chat-channel.ts` | replay and horizon tests |
| Edits, deletes, reactions, threads as events; deletion redacts the replay log (§2.2) | `src/chat-channel.ts` | edit/delete and thread tests |
| Transactional outbox → Queue → idempotent, order-independent D1 copy; retry with backoff on queue outage (§3.3) | `src/chat-channel.ts`, `src/projection.ts` | D1 copy tests |
| Sockets survive DO eviction (hibernation path) and sequencing continues (§3.2) | — | eviction test |
| Revocation closes a removed member's sockets with `4403` (§3.5) | `closeConnections` | revocation test |
| Yjs document DO speaking the **standard y-websocket protocol** (§4.1) | `src/doc-room.ts` | `doc.test.ts`, plus a real `y-websocket` client |
| Viewer edits refused with the standard permission-denied message (§4.4) | `src/doc-room.ts` | viewer test |
| Awareness (cursors) relayed and cleared on disconnect | `src/doc-room.ts` | awareness test |
| Compaction at 500 updates or on last disconnect; reload after eviction (§4.3) | `src/doc-room.ts` | compaction tests |
| Snapshots split into 4 MB chunks under the 8 MB row limit (a 9 MB document) (§4.3) | `src/doc-room.ts` | chunking test |
| `databaseSize` available for storage monitoring (§7.7) | `stats()` | introspection test |
| **UserHub:** one hub socket per tab; several tabs count as one presence (§3.5) | `src/user-hub.ts` | `hub.test.ts` › presence |
| **WorkspacePresence:** online/offline/status broadcasts; heartbeats; expiry of crashed hubs (§3.5) | `src/presence.ts` | presence tests |
| **Batched fan-out** to online members only: one hub call per consumer batch; offline users cost nothing (§3.5) | `src/fanout.ts` | fan-out tests |
| Inbox items for mentions and DMs: members only, never the sender, not for deleted messages, idempotent on redelivery (§3.3, PRD §5.3) | `src/fanout.ts` | inbox tests |
| Unread and mention counts; marking a channel read resolves its inbox items (§3.5, PRD §5.3) | `/api/unread`, `/api/channels/:id/read`, `/api/inbox` | DM test |
| **Full revocation:** disabling a user closes their hub, channel and document sockets (`4401`), and `session_epoch` kills old cookies (§3.5, §8.1) | `revoke()`, `registerRoom()` | revocation test |
| **Huddles:** one active huddle per context, even when started concurrently; access follows the channel or document; host and channel admins moderate; "huddle started/ended" system messages (§3.6) | `src/huddle-room.ts`, `src/index.ts` | `huddle.test.ts` › starting and joining |
| **SFU signalling through the Worker:** session on first publish; subscribe returns the SFU's offer and the client answers via renegotiate; app secret never leaves the Worker (§3.6) | `src/sfu.ts`, huddle routes | publish/subscribe tests |
| **Track isolation:** no pulling tracks from another huddle, no using another user's connection ID (§3.6) | `authorizeSubscribe()` | isolation test |
| **Screen sharing:** grant before publish, one presenter, take-over request and hand-over, force-close after 5 s, moderator stop and mute (forced SFU close), presenter leaving hands over (PRD §5.8) | `src/huddle-room.ts` | screen sharing tests |
| Workspace sharing policy (everyone / admins / off) and 720p/1080p cap (PRD §5.8) | `settings` table | policy test |
| Simulcast layer requests and layer switching (`tracks/update`) (§3.6) | huddle routes | simulcast test |
| Huddle ends 30 s after the last participant leaves; metadata only (§3.6) | `alarm()` | ending tests |
| **Present mode:** one presenter per document; a second claim is stripped before peers see it (§4.5) | `src/doc-room.ts` | present mode test |
| Realtime SFU HTTP client matches the documented API (paths, methods, Bearer auth, bodies, 2xx-with-error handling); TURN credentials with port 53 filtered | `src/sfu.ts` | contract tests |
| **Browser screen capture in Chromium:** cap and frame rate applied, `contentHint`, simulcast `f;h;q` in the offer, frames flowing over a real peer connection, browser "Stop sharing" releases the slot | `client/screen-share.ts` | `npm run test:browser` |

**Results:** 59 of 59 tests pass (three consecutive runs), plus the Chromium screen-share check in the local Workers runtime (Miniflare / workerd). The stock-client check passes against `wrangler dev`.

## Running it

```sh
cd spikes/realtime
npm install --legacy-peer-deps   # see "Tooling notes"
npm test                         # 59 tests
npm run test:browser             # screen capture in headless Chromium
npm run typecheck

# Stock y-websocket client against a local dev server
cp .dev.vars.example .dev.vars
npx wrangler d1 migrations apply DB --local
npm run dev                      # terminal 1
npm run stock-client             # terminal 2
```

## Findings

### The design holds

Everything in the table works as the TDD describes. In particular:

- The DO-first write path with an outbox to D1 kept every acknowledged message during a simulated queue outage. D1 caught up after the queue recovered.
- Sending full message state with a `last_event_seq` guard made the D1 copy correct regardless of duplicate or out-of-order delivery.
- An unmodified `y-websocket` client works against the document DO, so the "stock Yjs client" requirement in PRD §16 is met.

### Changes to feed back into the TDD

1. **Awareness can't use the y-protocols `Awareness` class on the server.** Its constructor starts a `setInterval` timer, which would stop a Durable Object from hibernating. The spike relays the awareness wire format directly and keeps states only in memory.
   - Consequence: cursors are lost when the object hibernates. Clients re-announce within about 15 seconds, which is acceptable.
   - Add this to TDD §4.1.
2. **Queue size limits need chunking in the outbox drain.** A queue message is limited to 128 KB and a `sendBatch` call to 256 KB. Messages can be up to 40 KB, so a full batch of 100 can exceed the batch limit. The drain chunks by size, and rows are only removed from the outbox once their chunk has been sent.
3. **Stock clients need a fresh ticket on every reconnect.** Tickets are single-use, so `y-websocket`'s automatic reconnect fails with a used ticket. `y-websocket` rebuilds its URL from `provider.params` on each connect, so a client can set `provider.params.ticket` from a new `POST /auth/ws-ticket` before reconnecting. Officebox's own browser client uses cookies and is unaffected.
4. **Revocation needs to know which rooms a user is in.** Disabling a user must close their sockets in every channel and document, but nothing central knew which ones. Each channel or document object now registers the connection with the user's UserHub (`registerRoom`), costing one call per connection. `revoke()` closes the user's hub sockets and asks each registered room to close theirs. Registrations are only hints: stale ones are harmless and are pruned after 24 hours. Add this to TDD §3.5.
5. **The fan-out caches the online list per consumer isolate for 5 seconds.** The cache must be scoped so a user who has just connected can be missed for at most that long. Their hub's welcome and REST unread counts cover the gap.
6. **Expected denials shouldn't be thrown across Durable Object RPC.** The spike throws `forbidden: …` errors from the HuddleRoom and maps them to HTTP statuses in the Worker. It works, but the runtime logs every one as an uncaught exception, which would swamp real errors in Workers Logs. Production code should return typed results for expected outcomes.
7. **Keep RPC return types concrete.** Returning `unknown` or `any` fields from a Durable Object method breaks TypeScript's RPC type instantiation ("never" or "excessively deep"). Use concrete types, or JSON text for logs.
8. **Re-encode awareness instead of relaying raw bytes.** To strip a second present-mode claim, the document object re-encodes awareness from its own state instead of forwarding client bytes, so a stripped claim never reaches peers.
9. **Browser simulcast needs the real SFU to verify end to end.** Chromium advertises `a=simulcast:send f;h;q` with the three encodings, as the SFU docs expect. The loopback receiver in the browser test is an ordinary peer and can't receive simulcast, so the sender drops to one layer after its answer.
10. **Headless Chromium can capture a fake screen**, using `--use-fake-ui-for-media-stream` and `--auto-select-desktop-capture-source`. Screen-share flows can therefore be tested automatically in CI.
11. **Durable Objects get one alarm each, so timers must share it.** This confirms the TDD's "multiplex timers in `meta`" note. The outbox drain reschedules itself for the earliest pending retry.

### Not covered

- **Billing behaviour.** The spike shows sockets survive eviction, but whether idle hibernation stops billed duration can only be measured on a real deployment.
- **Real media through the Realtime SFU.** The huddle logic runs against a fake SFU. A real run needs a Realtime app (`SFU_MODE=real`, `REALTIME_APP_ID`, `REALTIME_APP_SECRET`) and will check simulcast negotiation, TURN on restrictive networks, and latency.
- **Huddle UI,** camera video, mobile viewing and picture-in-picture.
- **Production pieces:** search projection, revision history, multi-tab leader election (each tab opens its own hub socket here), refresh-token rotation, and email/push for offline recipients.
- **Load and latency** against the TDD §9.2 targets.

### Tooling notes

- `@cloudflare/vitest-pool-workers` is deprecated. Use **`@cloudflare/vitest-plugin`** (used here) with Vitest 4.
- npm 10.9 crashes resolving this dependency set's peer dependencies ("Cannot read properties of null (reading 'edgesOut')"). `--legacy-peer-deps` works around it.
- Storage is **not** isolated between tests in a file, so tests create their own channels and documents with unique IDs.
- `evictDurableObject()` from `cloudflare:test` is the way to test hibernation and cold-start paths.

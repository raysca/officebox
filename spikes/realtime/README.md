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

**Results:** 30 of 30 tests pass in the local Workers runtime (Miniflare / workerd). The stock-client check passes against `wrangler dev`.

## Running it

```sh
cd spikes/realtime
npm install --legacy-peer-deps   # see "Tooling notes"
npm test                         # 30 tests
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
4. **Durable Objects get one alarm each, so timers must share it.** This confirms the TDD's "multiplex timers in `meta`" note. The outbox drain reschedules itself for the earliest pending retry.

### Not covered

- **Billing behaviour.** The spike shows sockets survive eviction, but whether idle hibernation stops billed duration can only be measured on a real deployment.
- **Production pieces:** the UserHub, WorkspacePresence and HuddleRoom objects, search projection, revision history, multi-tab leader election, and `session_epoch` checks on refresh.
- **Load and latency** against the TDD §9.2 targets.

### Tooling notes

- `@cloudflare/vitest-pool-workers` is deprecated. Use **`@cloudflare/vitest-plugin`** (used here) with Vitest 4.
- npm 10.9 crashes resolving this dependency set's peer dependencies ("Cannot read properties of null (reading 'edgesOut')"). `--legacy-peer-deps` works around it.
- Storage is **not** isolated between tests in a file, so tests create their own channels and documents with unique IDs.
- `evictDurableObject()` from `cloudflare:test` is the way to test hibernation and cold-start paths.

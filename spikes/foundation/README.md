# Foundation spike (M0d)

Throwaway checks for the five M0 foundation-spike questions ([PLAN](../../PLAN.md) §4 M0, [TDD](../../TDD.md) §10), answered before M1 code depends on them. It is **not** production code and nothing imports it.

Each answer is labelled with its evidence level:

- **Verified locally:** a test or script in this folder shows it, in the local Workers runtime (workerd 1.20261113 via `@cloudflare/vitest-plugin` / `wrangler dev`) or in Playwright Chromium 153.
- **Documented:** quoted from Cloudflare's documentation or source, with the URL (all read on 15 November 2026).
- **Needs production run:** only a real Cloudflare deployment can answer it. The [production probe](#production-probe) does that in two commands.

## Summary

| # | Question | Answer | Evidence | Recommendation |
|---|---|---|---|---|
| 1 | Does production cap PBKDF2? | **Almost certainly yes, at 100,000.** Local workerd accepts 600,000 only because the standalone server removes the cap that the default limit enforcer applies. | Source + open issue (documented); local timings (verified); **production: needs production run** | M1 ships **PBKDF2-SHA256 100k + HMAC pepper** (`pbkdf2-sha256-hmac$…`). If the probe shows 600k works, switch to 600k with upgrade at next sign-in. Argon2id works too, but not with `hash-wasm` as published. |
| 2 | Does a maintained WebAuthn library run in Workers? | **Yes.** `@simplewebauthn/server` 14.0.3 (MIT) registers and verifies passkeys in workerd, including discoverable sign-in and `sign_count` clone detection. | Verified locally, end to end with a CDP virtual authenticator | Use SimpleWebAuthn. ~87 KiB gzip. Map its counter error to `clone_detected`. |
| 3 | Rate Limiting binding: periods, scope, consistency? | Periods **10 or 60 s only**; limits are **per Cloudflare location**; counts are **approximate and eventually consistent**. Miniflare is exact and single-location. | Documented; local behaviour verified; **production: needs production run** | Binding for abuse limits only (sign-in per IP, setup/recovery/invite, link previews, general API). Everything else stays DO or D1 as platform §8 says. [Table](#q3-rate-limiting-binding). |
| 4 | Maximum queue `delaySeconds`? | **86,400 s (24 hours)** for `send`, `sendBatch` and retries, not the 12 hours the specs assume. Miniflare rejects 86,401. | Documented; local verified | Holds of up to 24 h can be queue messages. Keep `email_release` for longer holds, with the threshold raised from 12 h to 24 h (or kept at 12 h for margin). Validate the delay before sending. |
| 5 | Does Chrome's PDF viewer render under `CSP: sandbox`? | **Yes**, directly and in an `<iframe>`. **But an `<iframe sandbox>` attribute blocks it** ("This page has been blocked by Chromium"), whatever tokens it allows. | Verified locally in full Chromium (new headless and headed under Xvfb); headless shell can't tell (no viewer) | Keep `Content-Security-Policy: sandbox` on file responses. Preview PDFs in a plain `<iframe>` without the `sandbox` attribute. Firefox and Safari not tested. |

## Running it

```sh
cd spikes/foundation
npm install --legacy-peer-deps
npm test                 # 23 Vitest tests in workerd: hashing, WebAuthn routes, rate limits, queue delays
npm run typecheck
npm run test:webauthn    # wrangler dev + Playwright Chromium virtual authenticator
npm run test:pdf         # PDF viewer under CSP sandbox; re-runs itself under xvfb-run for headed mode
npm run bundle-size      # added bundle size per candidate
```

`test:webauthn` and `test:pdf` use the machine's Playwright 1.63.0 (`require("playwright")`, resolved through `NODE_PATH`), as `spikes/realtime` does. If it isn't installed: `npm i --no-save playwright@1.63.0 && npx playwright install chromium`.

## Q1 PBKDF2 iteration limit and fallbacks

### Evidence

**Local timings** (`npm test`, `test/hash.test.ts`, 4-core Intel Xeon @ 2.30 GHz; workerd rounds `performance.now()` to whole milliseconds):

| Candidate | Result | Time per hash (3 runs) |
|---|---|---|
| PBKDF2-SHA256, 100,000 iterations | ok | 12, 13, 12 ms |
| PBKDF2-SHA256, 100,001 iterations | ok (locally) | 13, 12, 12 ms |
| PBKDF2-SHA256, 600,000 iterations | ok (locally) | 74, 73, 73 ms |
| HMAC-SHA256 pepper + PBKDF2 100k | ok | 14 ms |
| Argon2id m=19 MiB, t=2, p=1 (OWASP minimum), `hash-wasm` **as published** | **fails**: `WebAssembly.compile(): Wasm code generation disallowed by embedder` | – |
| Argon2id m=19 MiB, t=2, p=1, `hash-wasm` + precompiled-module shim | ok | 47, 40, 40 ms |
| Argon2id m=46 MiB, t=1, p=1 (OWASP alternative), with shim | ok | 77 ms |
| scrypt N=2^17, r=8, p=1 (native `node:crypto`, OWASP minimum) | ok | 296 ms |
| scrypt N=2^18, r=8, p=1 | **refused**: `Scrypt failed: cost exceeds maximum (1048576).` | – |

**Why local accepts 600k (documented, workerd source):**

- [`src/workerd/io/limit-enforcer.h`](https://github.com/cloudflare/workerd/blob/main/src/workerd/io/limit-enforcer.h): `static constexpr size_t DEFAULT_MAX_PBKDF2_ITERATIONS = 100'000;` and, in the default `checkPbkdfIterations`: *"By default, historically we've limited this to 100,000 iterations max. We'll set that as the default for now. … Note, this current default limit is \*WAY\* below the recommended minimum iterations for pbkdf2."*
- [`src/workerd/server/factory/worker-factory.c++`](https://github.com/cloudflare/workerd/blob/main/src/workerd/server/factory/worker-factory.c++): the standalone server's limit enforcer overrides it with `checkPbkdfIterations(...) { return kj::none; }`, i.e. no limit. That is what `wrangler dev` and Miniflare run. It does **not** override the scrypt check, which is why the scrypt cap shows up locally and the PBKDF2 cap doesn't.
- [`src/workerd/api/crypto/impl.c++`](https://github.com/cloudflare/workerd/blob/main/src/workerd/api/crypto/impl.c++): over the limit, `deriveBits` fails (per the source) with `NotSupportedError: Pbkdf2 failed: iteration counts above 100000 are not supported (requested 100001).`

**Production status (documented, not authoritative):** Cloudflare's [Web Crypto docs](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/) list PBKDF2 as supported and say nothing about a limit. The only statements come from [workerd issue #1346](https://github.com/cloudflare/workerd/issues/1346) ("crypto: 100,000 iterations of PBKDF2 is insecure"), **still open**:

> "A change has been landed that makes the max iteration count configurable in `workerd`. … However, in the production environment the current limit will remain for at least some period of time." (jasnell, 3 January 2024)
>
> "No ETA yet. … we still need to do more work on the production system to enable use." (jasnell, 2 February 2024); "Not yet." (19 April 2024)

A user reported hitting the error at 210,000 iterations in production in January 2026, in the same issue. I found no changelog entry lifting the limit. **Production behaviour: needs production run** (probe check `PBKDF2 100,001` / `600,000`).

**CPU limits** ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/)): Workers Free "10 ms" CPU per request; Workers Paid "5 min (default: 30 seconds)"; memory "128 MB" per isolate. PBKDF2 100k already takes about 12 ms locally, so **sign-in on the Free plan would likely exceed its CPU limit**. Officebox targets Workers Paid (PRD §1), so this is fine, but the deploy docs should say so.

### Fallback A: HMAC pepper + PBKDF2 100k (`src/pbkdf2.ts`)

```
pbkdf2-sha256-hmac$<pepperId>$100000$<salt b64>$<hash b64>
input = HMAC-SHA256(PEPPER_<pepperId>, password)   -- Worker secret, never in D1
hash  = PBKDF2-SHA256(input, salt, 100000, 32 bytes)
```

- **What it buys:** a D1 dump or export on its own can't be attacked offline at all, because the pepper lives only in Worker secrets. With the secret too, the cost per guess equals plain PBKDF2 100k, 6× cheaper than OWASP's 600k.
- **Rotation:** `pepperId` names the secret (`PEPPER_1`, `PEPPER_2`, …). Add the new secret, write new hashes with it, re-hash at next sign-in, and delete the old secret when no row uses it. Losing every pepper secret means every password must be reset, so the secrets inventory (platform §16) and the restore guide must cover it: an export restored to a new installation needs the same pepper secrets or passwords fall back to reset/magic link.
- **Cost:** 0.5 KiB, no dependency, about 13 ms CPU.
- Tested: hash and verify, wrong password, wrong secret, unknown pepper id.

### Fallback B: Argon2id in WASM (`src/hash.ts`, `src/argon2-shim.ts`)

- **`hash-wasm` (MIT, 4.12.0) does not run in Workers as published.** It embeds its WASM as base64 and calls `WebAssembly.compile(bytes)` at runtime, which Workers forbid. This is verified locally (`test/argon2-unshimmed.test.ts`), and the probe checks it in production. Per Cloudflare's [Node.js crypto docs](https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/), "`argon2` and `argon2Sync` are not supported" natively either.
- **Workaround, proven locally:** `scripts/extract-wasm.mjs` writes `hash-wasm`'s argon2 and blake2b binaries to `src/wasm/*.wasm`. Wrangler compiles imported `.wasm` files at upload time, and a small shim hands those precompiled modules to `hash-wasm`. For production, vendor `hash-wasm`'s ~200-line argon2 wrapper (MIT) and pass the modules in directly, instead of patching the global.
- **Cost:** 40–47 ms locally at m=19 MiB, t=2; **+25 KiB** (11.6 KiB gzip JS + 13.8 KiB WASM).
- **Risk:** each hash allocates its memory (19–46 MiB) inside a 128 MB isolate. A few concurrent sign-ins in one isolate could approach the limit. Not measured.

### Also tried: native scrypt (`node:crypto`)

This works with `nodejs_compat`, but the OWASP minimum (N=2^17, r=8) sits exactly at workerd's cost cap of 2^20, takes about 300 ms CPU and needs 128 MiB of memory. Not recommended.

### Recommendation

1. **M1 default: Fallback A** (PBKDF2-SHA256 100k + HMAC pepper). It's native, tiny and fast, and works whether or not the cap exists.
2. **Run the probe.** If production accepts 600,000, M1 can use `pbkdf2-sha256$600000$…` (pepper optional) instead. Either way the versioned format allows upgrade at next sign-in.
3. **Argon2id stays the upgrade path** if a stronger KDF is wanted. It needs the vendored loader above and a concurrency check on memory.
4. **Spec follow-up (not edited here):** Identity §4.4 / TDD §8.1 should name the chosen format, the `PEPPER_*` secrets (platform §16) and the restore implication.

## Q2 WebAuthn in Workers

**Library:** `@simplewebauthn/server` **14.0.3** (MIT; 14.x released September–November 2026, so actively maintained). Its dependencies are all MIT, BSD-3-Clause, Apache-2.0 or 0BSD (`@peculiar/*`, `asn1js`, `@levischuck/tiny-cbor`, `@hexagon/base64`, `reflect-metadata`, `tsyringe`, `tslib`). It uses WebCrypto, which workerd provides. The browser side uses `@simplewebauthn/browser` 14.0.0 (MIT), dev dependency only.

**Evidence: verified locally, end to end** (`npm run test:webauthn`, passing three runs in a row). `wrangler dev` serves `src/index.ts`. Playwright Chromium 153 attaches a CDP virtual authenticator (`WebAuthn.enable`, then `WebAuthn.addVirtualAuthenticator` with `protocol: "ctap2"`, `transport: "internal"`, `hasResidentKey`, `hasUserVerification`, `isUserVerified`, `automaticPresenceSimulation`) and drives `navigator.credentials.create` / `get` through `startRegistration` / `startAuthentication`:

```
registration:  ok, fmt "none", userVerified true, counter 1, resident credential
sign-in 1:     ok, discoverable (no email typed), right userId, counter 1 -> 2, userVerified true
sign-in 2:     ok, counter 2 -> 3; stored counter = 3
cloned:        credential re-added with signCount rewound -> authenticator reports 1
               -> 403 {"error":"clone_detected","detail":"Response counter value 1 was lower than expected 3"}
               stored counter unchanged (3)
replay:        assertion for challenge A submitted against flow B -> refused (challenge mismatch)
```

`npm test` (`test/webauthn.test.ts`) covers the library loading in workerd, option shape (`residentKey: "required"`, `userVerification: "preferred"`, ES256/RS256, no `allowCredentials` for passkey sign-in), garbage responses returned as typed errors, single-use challenges and unknown credentials.

**Findings for M1:**

- **Counter semantics:** the library throws when the new counter is **less than or equal to** the stored one, unless both are 0. Authenticators that always report 0 (most synced passkeys) pass; a counter that repeats a non-zero value is treated as a clone too, slightly stricter than "goes backwards" in Identity §4.4. It's an exception, not a result, so the service must catch it, map it to `clone_detected` (typed result) and send the `security_notice`.
- **`requireUserVerification` defaults to `true`.** Identity §4.4 says UV is "preferred", so pass `false` explicitly (as the spike does) and record `userVerified`.
- **Challenge storage:** challenges must be single-use and short-lived (the spike deletes the flow on first read, with a 5-minute TTL). In M1 use a D1 row or a signed, `HttpOnly` cookie bound to the session attempt.
- **RP ID and origin** come from configuration (`RP_ID`, `RP_ORIGIN`). That ties into the domain-change caveat in Identity §4.4.
- **Bundle:** about 87 KiB gzip (314 KiB minified), the largest dependency so far. Comfortably inside the Worker size limit.

**WebCrypto-only alternative** (not needed, recorded in case the library becomes a problem): parse CBOR `attestationObject` (`fmt: "none"` only) and `authenticatorData` (rpIdHash, flags, signCount, attested credential data). Convert the COSE key to JWK for ES256 (`crypto.subtle.importKey("jwk", {kty:"EC",crv:"P-256",x,y})`) and RS256. Verify `clientDataJSON` (type, challenge, origin). Convert ES256 DER signatures to raw r‖s before `crypto.subtle.verify({name:"ECDSA",hash:"SHA-256"})`. That's roughly 400 lines plus a CBOR decoder, and loses attestation formats, which Officebox doesn't need anyway.

## Q3 Rate Limiting binding

**Documented** ([Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)):

- Period: *"Must be either `10` or `60`."*
- Limit: *"The request threshold for calls to `limit()` within the given `period`, per Cloudflare location."* *"Requests served in another Cloudflare location count toward a separate limit"*; *"These counts do not combine into one worldwide limit."*
- Consistency: *"The Rate Limiting API provides an approximate limit. Counts are eventually consistent:"* *"Requests can exceed your configured limit before those updates arrive."* *"Sharing a namespace across Workers or awaiting each call does not make the combined limit strict."*
- Keys: *"It is not recommended to use IP addresses or locations"*, because many users can share one address.
- `delta` (weighted calls) is supported; local use needs Wrangler 4.157.0 or later.

**Local behaviour (verified, `test/platform.test.ts`):** Miniflare implements the binding as an **exact fixed window aligned to the wall clock** (`floor(now / period)`), in one location. With limit 5 / 60 s, calls go `true ×5` then `false`. Keys are independent. `delta: 5` uses up a limit of 5. Config with `period` other than 10/60 is rejected by Wrangler's validation, and a per-call `period: 30` is rejected with `unsupported period: 30`. **Tests written against Miniflare will see exact limits that production does not give.**

**Production (needs production run):** whether limits really are per colo, how far over the limit a burst gets, and whether a per-call `period` is accepted. Probe checks: `ratelimit` (12 separate requests, 12 calls in one request, a 10-second window and its reset, period 30).

**Proposed mechanism for each limit in platform §8.** The spec isn't edited here; the "Change?" column lists suggested follow-ups.

| Action | Limit | Spec says | Proposed | Change? | Why |
|---|---|---|---|---|---|
| Sign-in attempts, per IP | 5 / min | binding | **binding** (60 s) | – | Abuse throttle; approximate is fine. The progressive delay and account limit are the real protection. Docs discourage IP keys, but per-IP is the point here; combine with the account counter. |
| Sign-in attempts, per account | 10 / h + progressive delay | D1 counter | **D1 counter** | – | Window > 60 s, and the delay schedule needs an exact failure count per account. |
| Magic-link and reset requests | 3 / 15 min per account; 20 / h per IP | D1 counter | **D1 counter** | – | Both windows > 60 s; the account limit protects inboxes, so it must be exact. |
| Setup, recovery, invitation acceptance | 5 / min per IP | binding | **binding** (60 s) | – | Tokens are 32 random bytes, so the limit only slows noise. Per-location leakage (5 × N colos) is harmless. |
| Message sends | 10 / 10 s per user per conversation | DO (ChatChannel) | **DO** | – | The ChatChannel DO is already on the write path, so an exact count is free. The binding's 10 s period would fit but adds a call and is approximate. |
| `@channel` / `@here` | 1 / 5 min per user per channel | DO | **DO** | – | Window > 60 s; the owning DO is on the path. |
| "Notify anyway" | 1 / 30 min per sender per recipient | D1 (`notify_anyway_log`) | **D1** | – | Window > 60 s, and the spec already keeps a log table. |
| Group DM creation | 20 / h per user | D1 counter | **D1 counter** | – | Window > 60 s. |
| Poll creation | 10 / h per user | D1 counter | **D1 counter** | – | Window > 60 s; spans channels, so no single DO owns it. |
| Rings | 5 / 10 min to the same person | DO (UserHub) | **DO** | – | Window > 60 s; the caller's UserHub already holds ring state. |
| In-call chat | 20 / 10 s per user per call | DO | **DO** | – | Same reasoning as message sends. |
| Handle changes | 3 / 30 days | D1 (history) | **D1** | – | Long window; history already exists. |
| Access requests | 1 pending per object; 20 / day | D1 unique index + counter | **D1** | – | Uniqueness needs a constraint; daily window. |
| External invitation emails | 50 / member / day | D1 counter | **D1 counter** | – | Daily quota must be exact (cost and reputation). |
| Uploads | 2 GB per file; 10 GB / user / day | request check + D1 | **request check + D1** | – | Byte quota summed over a day. |
| Link-preview fetches | 60 / min per workspace; 3 per message | binding + request check | **binding** (60 s) + request check | – | A cost and abuse guard. Per-colo means up to 60 × (colos the team uses), still bounded. Use a DO if an exact workspace-wide cap becomes necessary. |
| ICS-in fetches | 1 / subscription / h; 50 per workspace | cron + D1 | **cron + D1** | – | Not a request-rate limit. |
| General API requests | 300 / min per session | binding | **binding** (60 s) | – | Abuse throttle keyed by session ID (a stable identifier, as the docs recommend). |

**Spec follow-ups:**
- Platform §8 says the binding allows "windows of **60 seconds or less**". It's exactly **10 or 60 seconds**. Every binding row above uses 60 s, so nothing moves.
- The M0 Rate Limiting wrapper should treat a binding result as advisory: return `rate_limited` with `retry-after = period`. Its tests must not assume production is as exact as Miniflare.

## Q4 Queue delays

**Documented:**

- [Queues limits](https://developers.cloudflare.com/queues/platform/limits/): *"`delaySeconds` (when sending or retrying) | 24 hours"*; *"Message retries | 100"*; *"Message retention period | Configurable up to 14 days"*; *"Maximum messages per `sendBatch` call | 100 (or 256KB in total)"*; *"Message size | 128 KB"*.
- [JavaScript APIs](https://developers.cloudflare.com/queues/configuration/javascript-apis/): `QueueSendOptions.delaySeconds` and `MessageSendRequest.delaySeconds`: *"Must be an integer between 0 and 86400 (24 hours)."* `QueueSendBatchOptions` and `QueueRetryOptions` only say *"Must be a positive integer."*, but the limits page applies 24 hours to sending and retrying alike.
- [Batching and retries](https://developers.cloudflare.com/queues/configuration/batching-retries/): *"Messages can be delayed by up to 24 hours."* `max_retries` *"defaults to 3"*.

**Local (verified, `test/platform.test.ts`):** Miniflare accepts `delaySeconds: 86400` and **rejects 86,401** on both `send` and `sendBatch`. The error is the opaque `Unknown Internal Error (15000)`; Miniflare's schema is `z.number().int().min(0).max(86400)`. A 2-second delayed message was delivered after about 3 s. **Production rejection above 86,400: needs production run** (probe `queue` checks).

**Implications for platform §11 (offline email and DND holds):**

- The specs (platform §11 and TDD §10) say Queues allow at most **12 hours**. **The current limit is 24 hours.** Every unread-email delay option and most DND/time-off holds fit in one delayed message.
- `email_release` in ReminderScheduler is still needed for holds over 24 hours (multi-day time off). Its threshold can move from 12 h to 24 h. Keeping 12 h is also safe, and leaves margin if the limit ever drops back.
- Validate `delaySeconds` with Zod (integer, 0–86,400) before sending. Over the limit the runtime error is opaque, and it must become a typed result, not a thrown error.
- Retries can also be delayed up to 24 h, and `max_retries` goes up to 100. The email consumer's "8 retries, backoff capped at 2 h" (TDD §7.6) fits.

## Q5 PDF preview under `Content-Security-Policy: sandbox`

**Verified locally** (`npm run test:pdf`, Chromium 153.0.8010.12). A one-page PDF is served with `Content-Type: application/pdf`, `X-Content-Type-Options: nosniff`, `Content-Disposition: inline` and each CSP variant, and opened both directly and inside an `<iframe>` on a same-origin page. "RENDERED" means the browser created the PDF viewer (extension frame and `<embed>`) **and** the page's black box was painted (screenshot pixel check).

| Mode | direct, `CSP: sandbox` | iframe, `CSP: sandbox` | `sandbox allow-scripts` / `+ allow-same-origin` / `default-src 'none'` / none | `<iframe sandbox="allow-scripts allow-same-origin">` | `<iframe sandbox="">` |
|---|---|---|---|---|---|
| `chromium.launch()` default (headless shell) | download | download | download | not rendered | not rendered |
| `channel: "chromium"` (new headless, full Chromium) | **RENDERED** | **RENDERED** | RENDERED | **blocked** | **blocked** |
| `headless: false` under `xvfb-run` | **RENDERED** | **RENDERED** | RENDERED | **blocked** | **blocked** |

"Blocked" is Chromium's error page, *"This page has been blocked by Chromium"* (frame URL `chrome-error://chromewebdata/`).

**What can be concluded:**
- The default headless shell has no PDF viewer and downloads every PDF, so it can't answer the question.
- Full Chromium, headless or headed, renders a PDF served with `Content-Security-Policy: sandbox`, both top-level and in an iframe. (Probably because the viewer runs as a separate component extension, outside the sandboxed document.)
- A **`sandbox` attribute on the embedding `<iframe>`** blocks the viewer entirely, even with `allow-scripts allow-same-origin`.

**What can't be concluded:** branded Google Chrome wasn't tested; it uses the same viewer, and Chrome for Testing 153 is installed but wasn't run. Firefox (pdf.js) and Safari (PDFKit) weren't tested either; only Chromium is installed here.

**Recommendation:**
- Keep TDD §8.3's `Content-Security-Policy: sandbox` on every file response, PDFs included.
- Show PDF previews in an `<iframe>` **without** the `sandbox` attribute. The sandboxing comes from the response header, not the frame attribute.
- TDD §8.3's "PDFs in a sandboxed frame" should be reworded to say exactly that (follow-up, not edited here).
- If Firefox or Safari fail in M6, the fallback is PDF.js (Apache-2.0) in an iframe from a separate path. It renders through canvas, needs no plugin, and works under any sandbox that allows scripts.

## Production probe

Some answers need a real deployment (production PBKDF2 limit, Rate Limiting semantics, Queue validation). `probe/` is a small Worker (about 62 KiB, 22 KiB gzip) that runs those checks. Every route needs a random token, which `deploy.mjs` generates, so the public URL can't be used to burn CPU.

**On your machine, with a Cloudflare account on Workers Paid:**

```sh
cd spikes/foundation
npm install --legacy-peer-deps
npx wrangler login                 # or export CLOUDFLARE_API_TOKEN=...
npm run deploy:probe               # creates the queue, deploys officebox-foundation-probe, saves URL + token
npm run check:probe                # about 40 s; prints a Markdown report and writes probe/probe-report.json
npm run destroy:probe              # delete the Worker afterwards (and: npx wrangler queues delete officebox-foundation-probe)
```

Paste the printed report into the PR. It covers:

- PBKDF2 at 100,000 / 100,001 / 600,000, the pepper, Argon2id (shimmed), scrypt, and runtime `WebAssembly.compile`, with round-trip times
- the rate limiter (separate requests, one request, the 10-second window and its reset, period 30) and the colo that served it
- queue `delaySeconds` of 43,200 / 86,400 / 86,401 (send and sendBatch).

The two 12-hour and 24-hour test messages are delivered later to the probe's consumer, which just acks them; check them with `npx wrangler tail officebox-foundation-probe` if you're curious. The token is a plain `--var`, visible in the dashboard. That's fine for a throwaway probe.

**Self-tested locally:** with `npx wrangler dev --config probe/wrangler.jsonc --port 8788 --var PROBE_TOKEN:local-probe-token` running, `node probe/check.mjs --local` produced the local equivalent of every row: PBKDF2 600k ok, scrypt 2^18 refused, `WebAssembly.compile` refused, rate limit `YYYYYnnnnnnn`, 10-second window reset, period 30 rejected, 86,401 rejected. `wrangler deploy --dry-run --config probe/wrangler.jsonc` bundles cleanly. **Not deployed:** this environment has no Cloudflare credentials.

## Dependencies

All versions are pinned exactly. Versions released at least two weeks before the spike were chosen where a newer one existed (`@simplewebauthn/server` 14.1.0 and `hash-wasm` 4.13.0 were days old).

| Package | Version | Licence | Role |
|---|---|---|---|
| `@simplewebauthn/server` | 14.0.3 | MIT | runtime (Q2); transitive deps MIT / BSD-3-Clause / Apache-2.0 / 0BSD |
| `hash-wasm` | 4.12.0 | MIT | runtime (Q1 Argon2id fallback) |
| `@simplewebauthn/browser` | 14.0.0 | MIT | dev (browser side of the e2e test) |
| `wrangler` | 4.162.0 | MIT OR Apache-2.0 | dev |
| `@cloudflare/vitest-plugin` | 1.8.2 | MIT | dev |
| `@cloudflare/workers-types` | 5.20261114.1 | MIT OR Apache-2.0 | dev |
| `vitest`, `@vitest/runner`, `@vitest/snapshot` | 4.1.12 | MIT | dev |
| `esbuild` | 0.28.2 | MIT | dev (bundles the browser client, bundle-size script) |
| `typescript` | 7.0.2 | Apache-2.0 | dev |
| Playwright | 1.63.0 (pre-installed, not a dependency) | Apache-2.0 | e2e scripts |

## Files

| Path | What |
|---|---|
| `src/index.ts` | Spike Worker: hashing benchmarks, WebAuthn routes, rate-limit and queue routes |
| `src/pbkdf2.ts` | PBKDF2 and the HMAC-pepper fallback (WebCrypto only) |
| `src/hash.ts`, `src/argon2-shim.ts`, `src/wasm/` | Argon2id via `hash-wasm` with precompiled modules; scrypt |
| `src/webauthn.ts` | SimpleWebAuthn registration and authentication, typed results, clone detection |
| `test/*.test.ts` | Vitest in workerd (23 tests) |
| `scripts/webauthn-e2e.mjs` | wrangler dev + Chromium virtual authenticator |
| `scripts/pdf-sandbox.mjs` | PDF viewer matrix; screenshots in `pdf-shots/` (git-ignored) |
| `scripts/bundle-size.mjs`, `scripts/extract-wasm.mjs` | Bundle sizes; WASM extraction from `hash-wasm` |
| `probe/` | Production probe Worker, deploy and check scripts |

## Tooling notes

- Same as `spikes/realtime`: `npm install --legacy-peer-deps`; `@cloudflare/vitest-plugin` with Vitest 4.
- Wrangler's dev server is `npx` → `wrangler` → `workerd`. Scripts that start it must signal the whole process group, or `workerd` keeps the port (`scripts/lib/dev-server.mjs`).
- A Miniflare queue validation failure logs `TypeError: Invalid statusText` from its broker while the test passes. It's noise from Miniflare's error path, not from the spike.
- Under production Workers, `Date.now()` / `performance.now()` don't advance during CPU work, so the probe reports client round-trip times. Locally the clock does advance, at 1 ms resolution.

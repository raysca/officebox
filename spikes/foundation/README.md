# Foundation spike (M0d)

Throwaway checks for the five M0 foundation-spike questions ([PLAN](../../PLAN.md) §4 M0, [TDD](../../TDD.md) §10), answered before M1 code depends on them. It is **not** production code and nothing imports it.

Each answer is labelled with its evidence level:

- **Verified locally:** a test or script in this folder shows it, in the local Workers runtime (workerd 1.20261113 via `@cloudflare/vitest-plugin` / `wrangler dev`) or in Playwright Chromium 153.
- **Documented:** quoted from Cloudflare's documentation or source, with the URL (all read on 15 November 2026).
- **Confirmed in production:** the [production probe](#production-probe) ran on 15 November 2026 (colo DFW) and settled every "needs production run" item. Results are in [Production results](#production-results).

## Summary

| # | Question | Answer | Evidence | Recommendation |
|---|---|---|---|---|
| 1 | Does production cap PBKDF2? | **Yes, at exactly 100,000.** Production refuses 100,001 and 600,000 with "iteration counts above 100000 are not supported". Local workerd accepts 600,000 only because the standalone server removes the cap. | **Confirmed in production** | M1 ships **PBKDF2-SHA256 100k + HMAC pepper** (`pbkdf2-sha256-hmac$…`). Final. Argon2id (precompiled `hash-wasm`) and scrypt also run in production, as later upgrade options. |
| 2 | Does a maintained WebAuthn library run in Workers? | **Yes.** `@simplewebauthn/server` 14.0.3 (MIT) registers and verifies passkeys in workerd, including discoverable sign-in, replay refusal and `sign_count` clone detection. | Verified locally, end to end with a CDP virtual authenticator | Use SimpleWebAuthn (~87 KiB gzip) with `requireUserVerification: false`. Compare counters ourselves after signature verification (typed `clone_detected`), with a compare-and-set update in D1. |
| 3 | Rate Limiting binding: periods, scope, consistency? | Periods **10 or 60 s only**; limits are **per Cloudflare location**; counts are **approximate**: in production a limit of 5 let **6** calls through (also within one request), and a 10-second window reset as expected. Miniflare is exact and single-location. | Documented; **confirmed in production** | Binding for abuse limits only (sign-in per IP, setup/recovery/invite, link previews, general API). Everything else stays DO or D1 as platform §8 says. [Table](#q3-rate-limiting-binding). |
| 4 | Maximum queue `delaySeconds`? | **86,400 s (24 hours)** for `send`, `sendBatch` and retries, not the 12 hours the specs assumed. Miniflare and production both reject 86,401. | Documented; **confirmed in production** | Holds of up to 24 h are queue messages; `email_release` handles longer ones (threshold now 24 h). Delays are Zod-validated (0–86,400) into typed results. Specs updated in this PR. |
| 5 | Does Chrome's PDF viewer render under `CSP: sandbox`? | **Yes**, directly and in an `<iframe>`. **But an `<iframe sandbox>` attribute blocks it** ("This page has been blocked by Chromium"), whatever tokens it allows. | Verified locally in full Chromium (new headless and headed under Xvfb); headless shell can't tell (no viewer) | Keep `Content-Security-Policy: sandbox` on file responses. Preview PDFs in a plain `<iframe>` without the `sandbox` attribute. Firefox and Safari not tested. |

## Running it

```sh
cd spikes/foundation
npm install --legacy-peer-deps
npm test                 # 30 Vitest tests in workerd: hashing, WebAuthn routes and counter rule, rate limits, queue delays
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

In the same issue, a user reported an error at 210,000 iterations "on the workers side" in January 2026 (the error text wasn't quoted). I found no changelog entry lifting the limit. **Production: confirmed capped.** The probe's `PBKDF2 100,001` and `600,000` checks failed with `Pbkdf2 failed: iteration counts above 100000 are not supported`, and 100,000 succeeded (see [Production results](#production-results)).

**CPU limits** ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/)): Workers Free "10 ms" CPU per request; Workers Paid "5 min (default: 30 seconds)"; memory "128 MB" per isolate. PBKDF2 100k already takes about 12 ms locally, so **sign-in on the Free plan would likely exceed its CPU limit**. Officebox targets Workers Paid (PRD §1), so this is fine, but the deploy docs should say so.

### Fallback A: HMAC pepper + PBKDF2 100k (`src/pbkdf2.ts`)

```
pbkdf2-sha256-hmac$<pepperId>$100000$<salt b64>$<hash b64>
input = HMAC-SHA256(PEPPER_<pepperId>, password)   -- Worker secret, never in D1
hash  = PBKDF2-SHA256(input, salt, 100000, 32 bytes)
```

- **What it buys:** a D1 dump or export on its own can't be attacked offline at all, because the pepper lives only in Worker secrets. With the secret too, the cost per guess equals plain PBKDF2 100k, 6× cheaper than OWASP's 600k.
- **Pepper size:** at least **32 random bytes** (for example `openssl rand -base64 32`); `pepperedPbkdf2` refuses shorter ones.
- **Rotation policy:** `pepperId` names the secret (`PEPPER_1`, `PEPPER_2`, …).
  1. Add the new secret and write all new hashes with it.
  2. Re-hash each account at its next successful sign-in.
  3. After a published deadline, accounts still on a retired pepper must reset their password (or use a magic link or passkey).
  4. Only then is the old secret deleted. Until the deadline, every listed pepper secret is kept.
- **Export and restore:** an export restored to another installation needs the same `PEPPER_*` secrets, or every password falls back to reset/magic link. The secrets inventory (platform §16) and the restore guide must say so.
- **No timing enumeration:** an email with no account (or a passkey-only account) must run the same derivation. `dummyVerify()` runs the full HMAC + PBKDF2 derivation at the current policy's iteration count (`POLICY.iterations`) and returns `false`. `verifyPeppered`'s own refusal paths (malformed row, out-of-range iterations, unknown, retired or too-short pepper) call it too, instead of returning early.
- **Robust verify:** `verifyPeppered` never throws. It refuses stored iteration counts that aren't plain decimal integers in 100,000–1,000,000 (so a tampered row can't make verification burn CPU), malformed base64, wrong salt or hash lengths, and pepper ids that aren't own string properties of at least 32 bytes (`__proto__`, `constructor` and the like never resolve).
- **Cost:** 0.5 KiB, no dependency, about 13 ms CPU.
- Tested: hash and verify, wrong password, wrong secret, unknown pepper id, out-of-range iteration counts, short pepper (hash and verify), malformed rows and base64, inherited-key pepper ids, and **timing parity**: the fastest of 7 runs of each refusal path and of the unknown-user path must take 0.4–3× the fastest real verify. Locally all were 12–13 ms. The ratio is loose because workerd's clock has 1 ms resolution, but it still catches an early return or a different iteration count.

### Fallback B: Argon2id in WASM (`src/hash.ts`, `src/argon2-shim.ts`)

- **`hash-wasm` (MIT, 4.12.0) does not run in Workers as published.** It embeds its WASM as base64 and calls `WebAssembly.compile(bytes)` at runtime, which Workers forbid. This is verified locally (`test/argon2-unshimmed.test.ts`), and the probe checks it in production. Per Cloudflare's [Node.js crypto docs](https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/), "`argon2` and `argon2Sync` are not supported" natively either.
- **Workaround, proven locally:** `scripts/extract-wasm.mjs` writes `hash-wasm`'s argon2 and blake2b binaries to `src/wasm/*.wasm`. Wrangler compiles imported `.wasm` files at upload time, and a small shim hands those precompiled modules to `hash-wasm`. **The shim must not ship:** it patches the global `WebAssembly.compile` and matches binaries by length. If Argon2id is ever adopted, vendor `hash-wasm`'s ~200-line argon2 wrapper (MIT) and pass the precompiled modules in directly.
- **Cost:** 40–47 ms locally at m=19 MiB, t=2; **+25 KiB** (11.6 KiB gzip JS + 13.8 KiB WASM).
- **Risk:** each hash allocates its memory (19–46 MiB) inside a 128 MB isolate. A few concurrent sign-ins in one isolate could approach the limit. Not measured.

### Also tried: native scrypt (`node:crypto`)

This works with `nodejs_compat`, but the OWASP minimum (N=2^17, r=8) sits exactly at workerd's cost cap of 2^20, takes about 300 ms CPU and needs 128 MiB of memory. Not recommended.

### Recommendation

1. **M1 default: Fallback A** (PBKDF2-SHA256 100k + HMAC pepper). It's native, tiny and fast, and works whether or not the cap exists.
2. **Run the probe.** If production accepts 600,000, M1 can use `pbkdf2-sha256$600000$…` (pepper optional) instead. Either way the versioned format allows upgrade at next sign-in.
3. **Argon2id stays the upgrade path** if a stronger KDF is wanted. It needs the vendored loader above and a concurrency check on memory.
4. **Docs updated in this PR:** Identity §4.4, TDD §8.1 and platform §16 now name the format, the `PEPPER_*` secrets, the rotation policy and the restore implication.

## Q2 WebAuthn in Workers

**Library:** `@simplewebauthn/server` **14.0.3** (MIT; npm shows 14.0.0–14.1.0 published between September and November 2026, so it is actively maintained). Its dependencies are all MIT, BSD-3-Clause, Apache-2.0 or 0BSD (`@peculiar/*`, `asn1js`, `@levischuck/tiny-cbor`, `@hexagon/base64`, `reflect-metadata`, `tsyringe`, `tslib`). It uses WebCrypto, which workerd provides. The browser side uses `@simplewebauthn/browser` 14.0.0 (MIT), dev dependency only.

**Evidence: verified locally, end to end** (`npm run test:webauthn`, passing five runs in a row). `wrangler dev` serves `src/index.ts`. Playwright Chromium 153 attaches a CDP virtual authenticator (`WebAuthn.enable`, then `WebAuthn.addVirtualAuthenticator` with `protocol: "ctap2"`, `transport: "internal"`, `hasResidentKey`, `hasUserVerification`, `isUserVerified`, `automaticPresenceSimulation`) and drives `navigator.credentials.create` / `get` through `startRegistration` / `startAuthentication`:

```
registration:  ok, fmt "none", userVerified true, counter 1, resident credential
sign-in 1:     ok, discoverable (no email typed), right userId, counter 1 -> 2, userVerified true
sign-in 2:     ok, counter 2 -> 3; stored counter = 3
replay A->B:   assertion signed for flow A, submitted against fresh flow B (counter still valid)
               -> {"error":"invalid_response","detail":"Unexpected authentication response challenge ..."}
resubmit:      sign-in 3 succeeds (counter 4), then its exact flow + assertion are resubmitted
               -> {"error":"unknown_flow"} (challenges are single-use); stored counter unchanged
cloned:        credential re-added with signCount rewound -> authenticator reports 1
               -> 403 {"error":"clone_detected","detail":"sign_count 1 is not greater than stored 5"}
               stored counter unchanged
```

`npm test` (`test/webauthn.test.ts`) covers the library loading in workerd, option shape (`residentKey: "required"`, `userVerification: "preferred"`, ES256/RS256, no `allowCredentials` for passkey sign-in), garbage responses returned as typed errors, single-use challenges, unknown credentials, and the counter rule (`isCounterRegression`). The replay checks run before the clone step, so only the challenge and flow checks can refuse them.

**Findings for M1:**

- **Counter semantics:** a sign-in fails when the new counter is **less than or equal to** the stored one, unless both are 0. Authenticators that always report 0 (most synced passkeys) pass; a counter that repeats a non-zero value counts as a clone too, slightly stricter than "goes backwards" in Identity §4.4.
- **Compare counters ourselves.** The library throws a plain `Error` on a counter regression, and matching its message would be brittle. The spike passes `counter: 0` to the library, which then verifies only the signature, challenge, origin and RP ID, and compares counters itself afterwards (`isCounterRegression`), returning a typed `clone_detected`. Doing the comparison **after** signature verification means a forged response can't trigger a `security_notice`.
- **Compare-and-set in M1.** Two concurrent sign-ins with the same passkey must not both pass against the same stored counter. Update with `UPDATE passkeys SET sign_count = ? WHERE id = ? AND sign_count = ?` and treat 0 changed rows as a conflict (re-read and re-check). The spike stores credentials in KV, which has no compare-and-set, so it just writes.
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

**Production (confirmed, see [Production results](#production-results)):** a burst gets **one call over** the limit (6 of 12 succeeded at limit 5), both across requests and inside one request; the 10-second window resets; a per-call `period: 30` is accepted without error, so it is not validated and must not be relied on. Per-colo scope is documented, not measured (one colo, DFW). Probe checks: `ratelimit` (12 separate requests, 12 calls in one request, a 10-second window and its reset, period 30).

**Proposed mechanism for each limit in platform §8.** None of the rows change mechanism; platform §8's description of the binding was corrected in this PR (below).

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

**Spec changes made in this PR:**
- Platform §8 said the binding allows "windows of **60 seconds or less**". It now says **exactly 10 or 60 seconds**, per location and approximate. Every binding row above uses 60 s, so nothing moves.
- Platform §8 and TDD §8.1 now say the Rate Limiting wrapper treats a binding result as advisory: it returns `rate_limited` with `retry-after = period`, and its tests must not assume production is as exact as Miniflare.

## Q4 Queue delays

**Documented:**

- [Queues limits](https://developers.cloudflare.com/queues/platform/limits/): *"`delaySeconds` (when sending or retrying) | 24 hours"*; *"Message retries | 100"*; *"Message retention period | Configurable up to 14 days"*; *"Maximum messages per `sendBatch` call | 100 (or 256KB in total)"*; *"Message size | 128 KB"*.
- [JavaScript APIs](https://developers.cloudflare.com/queues/configuration/javascript-apis/): `QueueSendOptions.delaySeconds` and `MessageSendRequest.delaySeconds`: *"Must be an integer between 0 and 86400 (24 hours)."* `QueueSendBatchOptions` and `QueueRetryOptions` only say *"Must be a positive integer."*, but the limits page applies 24 hours to sending and retrying alike.
- [Batching and retries](https://developers.cloudflare.com/queues/configuration/batching-retries/): *"Messages can be delayed by up to 24 hours."* `max_retries` *"defaults to 3"*.

**Local (verified, `test/platform.test.ts`):** Miniflare accepts `delaySeconds: 86400` and **rejects 86,401** on both `send` and `sendBatch`. The error is the opaque `Unknown Internal Error (15000)`; Miniflare's schema is `z.number().int().min(0).max(86400)`. A 2-second delayed message was delivered after about 3 s. **Production: confirmed.** 43,200 and 86,400 are accepted; 86,401 is rejected on `send` ("Invalid message delay: Expected a number between 0 and 86400", code 10210) and `sendBatch` (code 10202).

**Implications for platform §11 (offline email and DND holds):**

- The specs (platform §11, notifications §6, TDD) said Queues allow at most **12 hours**. **The current limit is 24 hours**, and this PR updates them. Every unread-email delay option and most DND/time-off holds fit in one delayed message.
- `email_release` in ReminderScheduler is still needed for holds over 24 hours (multi-day time off). **Decision:** its threshold moves from 12 h to 24 h.
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
- TDD §8.3 now says exactly that. Firefox, Safari and branded Chrome checks are added to the Documents acceptance criteria for M6.
- If Firefox or Safari fail in M6, the fallback is PDF.js (Apache-2.0) in an iframe from a separate path. It renders through canvas, needs no plugin, and works under any sandbox that allows scripts.

## Production probe

Some answers need a real deployment (production PBKDF2 limit, Rate Limiting semantics, Queue validation). `probe/` is a small Worker (about 62 KiB, 22 KiB gzip) that runs those checks. Every route needs a random token, which `deploy.mjs` generates and stores with `wrangler secret put`; the Worker compares it in constant time. Every cost parameter is capped (iterations ≤ 1,000,000, Argon2 memory ≤ 64 MiB, scrypt N ≤ 2^18, rate-limit calls ≤ 50 per request), so the public URL can't be used to burn CPU.

**Prerequisites:**
- **Node.js 22.12 or later** (Wrangler 4.162's minimum).
- A Cloudflare account on **Workers Paid** with **Queues** available.
- The account has a **workers.dev subdomain**. If it has never had one, register it first (dashboard → Workers & Pages → your subdomain). Otherwise the deploy may stop to ask, and the scripts can't answer prompts.
- Authentication, either way:
  - `npx wrangler login`. If the login can see **more than one account**, also `export CLOUDFLARE_ACCOUNT_ID=<id>`: the scripts run Wrangler with piped stdin, so it can't ask which account to use.
  - `export CLOUDFLARE_API_TOKEN=…` plus `CLOUDFLARE_ACCOUNT_ID`, with a token that has **Account › Workers Scripts: Edit**, **Account › Queues: Edit** and **Account › Account Settings: Read**.

**On your machine:**

```sh
cd spikes/foundation
npm install --legacy-peer-deps
npx wrangler login                 # or CLOUDFLARE_API_TOKEN (+ CLOUDFLARE_ACCOUNT_ID), see prerequisites
npm run deploy:probe               # refuses if the Worker or queue already exists; creates them, sets the token secret
npm run check:probe                # about 40 s; prints a Markdown report and writes probe/probe-report.json
npm run destroy:probe              # run it promptly: deletes only what the probe created, then probe/.probe.json
```

Paste the printed report into the PR. The account's workers.dev subdomain is redacted (`officebox-foundation-probe.<redacted>.workers.dev`), so it's safe for a public PR. The **Expected** column marks rows that are meant to fail: `WebAssembly.compile` is forbidden, scrypt N=2^18 hits the cost cap, and scrypt N=2^17 needs 128 MiB in a 128 MB isolate, so a memory-exceeded error or a non-JSON error page is a valid answer there. The report covers:

- PBKDF2 at 100,000 / 100,001 / 600,000, the pepper, Argon2id (shimmed), scrypt, and runtime `WebAssembly.compile`, with round-trip times
- the rate limiter (separate requests, one request, the 10-second window and its reset, period 30) and the colo that served it
- queue `delaySeconds` of 43,200 / 86,400 / 86,401 (send and sendBatch).

**What it creates in your account, and nothing else:**
- the Worker `officebox-foundation-probe` on workers.dev, with Workers Logs enabled. **Side effect:** if the account has never used workers.dev, the first deploy registers a `<name>.workers.dev` subdomain for the account, and that stays after the probe is deleted.
- the queue `officebox-foundation-probe`. `deploy:probe` refuses if a queue with that name already exists (and likewise refuses an existing Worker of the probe's name), so it never attaches to or deletes something it didn't create (`-- --reuse-queue` overrides; `destroy:probe` then leaves the queue alone). Any queue-creation error other than "already exists" stops the deploy.
- the `PROBE_TOKEN` secret on that Worker. The token is also kept in `probe/.probe.json` (mode 0600, git-ignored). `check:probe` reads it from there, or from the `PROBE_TOKEN` environment variable, never from a command-line argument, because arguments show in the process list. **`--url=` sends the token to whatever host you give it**, so only point it at your own probe.
- Rate Limiting namespaces `910001` and `910002`, which are only binding config, not separate resources. Namespace ids are per account; if they clash with another Worker's limiters, edit `probe/wrangler.jsonc`.

No D1, KV, R2 or Durable Objects are created.

**Run `destroy:probe` promptly.** Until the queue is deleted, the 12-hour and 24-hour test messages stay pending and will wake the probe's consumer when they come due. `destroy:probe` deletes them along with the queue.

**What `destroy:probe` deletes:** `deploy:probe` writes `probe/.probe.json` **before creating anything**, with both flags false. It sets `queueCreatedByProbe` right after the queue is created, and `workerCreatedByProbe` just before deploying (it has already checked that no Worker of that name existed; only Cloudflare's "worker not found" error, code 10007, counts as absent). `destroy:probe` deletes only what that file says the probe created. It re-checks that the exact queue name still exists before deleting it. With no state file (for example, the deploy was refused, or you're in another clone) it deletes nothing and prints the manual commands. With a state file that records nothing as created, it deletes nothing and says so. A corrupt state file stops it with a message. A queue reused with `--reuse-queue` is never deleted, and `--reuse-queue` is refused if there is no such queue.

`deploy:probe` stops with a clear message if no workers.dev URL appears in Wrangler's output, and tells you to pass `--url=` to `check:probe`.

**Self-tested locally:** with `npx wrangler dev --config probe/wrangler.jsonc --port 8788 --var PROBE_TOKEN:local-probe-token` running, `node probe/check.mjs --local` produced the local equivalent of every row (wrong token → 403; `iterations=999999999` clamped to 1,000,000): PBKDF2 600k ok, scrypt 2^18 refused, `WebAssembly.compile` refused, rate limit `YYYYYnnnnnnn`, 10-second window reset, period 30 rejected, 86,401 rejected. `wrangler deploy --dry-run --config probe/wrangler.jsonc` bundles cleanly. **Not deployed:** this environment has no Cloudflare credentials, so `deploy.mjs` and `destroy.mjs` (queue lookup, `secret put`, `delete --force`, `queues delete`) haven't been run against a real account.

## Production results

The probe ran from GitHub Actions ([Foundation probe workflow](../../.github/workflows/foundation-probe.yml), run 1) on 15 November 2026, served from colo DFW. The report, with the account's subdomain redacted:

**Q1 Password hashing** (3 runs each; round trip includes the network)

| Check | Result | Expected | Error | median rtt ms |
|---|---|---|---|---|
| PBKDF2 100,000 | ok | ok | | 48 |
| PBKDF2 100,001 | refused | refused if capped | `Pbkdf2 failed: iteration counts above 100000 are not supported (requested 100001).` | 33 |
| PBKDF2 600,000 | refused | refused if capped | `… (requested 600000).` | 18 |
| PBKDF2 100k + HMAC pepper | ok | ok | | 46 |
| Argon2id m=19 MiB t=2 p=1 (hash-wasm + shim) | ok | ok | | 85 |
| Argon2id m=46 MiB t=1 p=1 (hash-wasm + shim) | ok | ok | | 133 |
| scrypt N=2^16 r=8 p=1 (64 MiB) | ok | ok | | 139 |
| scrypt N=2^17 r=8 p=1 (128 MiB) | ok | ok, or memory exceeded | | 279 |
| scrypt N=2^18 r=8 p=1 | refused | refused (cost cap) | `Scrypt failed: cost exceeds maximum (1048576).` | 17 |
| `WebAssembly.compile(bytes)` at runtime | refused | refused (forbidden) | `Wasm code generation disallowed by embedder` | 17 |

**Q3 Rate Limiting binding**
- limit 5 / 60 s, 12 separate requests, one key: `YYYYYYnnnnnn` (6 successes)
- limit 5 / 60 s, 12 calls inside one request: `YYYYYYnnnnnn`
- limit 3 / 10 s: 6 calls `YYYYnn`, then 21 s later `YY`
- per-call `period: 30`: accepted (not validated)

**Q4 Queue `delaySeconds`**
- `send` 43,200 s (12 h): accepted; 86,400 s (24 h): accepted
- `send` 86,401 s: rejected (`Invalid message delay: Expected a number between 0 and 86400, received 86401 (10210)`)
- `sendBatch` 86,401 s: rejected (`Invalid batch delay: … (10202)`)

**What changes:** nothing in the decisions. They are now final rather than pending: PBKDF2 stays at 100k plus the HMAC pepper (the 600k switch is dropped), the rate-limit wrapper treats the binding as approximate (one extra call per window is normal), and the queue limit is 24 h.

**Clean-up note:** the first run's `destroy:probe` failed because Cloudflare refuses to delete a Worker that consumes a queue (10064) or a queue bound to a Worker (11005). `destroy.mjs` now detaches the consumer first.

## Dependencies

All versions are pinned exactly. Where a newer release existed, the newest version published at least two weeks earlier was chosen: npm lists `@simplewebauthn/server` 14.1.0 as published on 6 November 2026 and `hash-wasm` 4.13.0 on 7 November 2026, about a week before the spike.

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
| `test/*.test.ts` | Vitest in workerd (30 tests) |
| `scripts/webauthn-e2e.mjs` | wrangler dev + Chromium virtual authenticator |
| `scripts/pdf-sandbox.mjs` | PDF viewer matrix; screenshots in `pdf-shots/` (git-ignored) |
| `scripts/bundle-size.mjs`, `scripts/extract-wasm.mjs` | Bundle sizes; WASM extraction from `hash-wasm` |
| `probe/` | Production probe Worker; `deploy.mjs`, `check.mjs`, `destroy.mjs`, shared `lib.mjs` |

## Tooling notes

- Same as `spikes/realtime`: `npm install --legacy-peer-deps`; `@cloudflare/vitest-plugin` with Vitest 4.
- Wrangler's dev server is `npx` → `wrangler` → `workerd`. Scripts that start it must signal the whole process group, or `workerd` keeps the port (`scripts/lib/dev-server.mjs`).
- A Miniflare queue validation failure logs `TypeError: Invalid statusText` from its broker while the test passes. It's noise from Miniflare's error path, not from the spike.
- Under production Workers, `Date.now()` / `performance.now()` don't advance during CPU work, so the probe reports client round-trip times. Locally the clock does advance, at 1 ms resolution.

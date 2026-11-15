// Q3 / Q7 / Q10 end to end: wrangler dev (workerd, D1) + Playwright Chromium with a CDP virtual authenticator.
//   A. registration through an enrolment ticket, without a session: does verify create a session? (createSession off/on)
//   B. discoverable sign-in with UV, counter stored and increasing; options say userVerification "required"
//   C. server-side UV enforcement: an authenticator that doesn't verify the user is refused at registration and sign-in
//   D. counter regression (cloned authenticator): refused, no session, clone notice, and what the library logs
//   E. step-up: a fresh passkey assertion for the signed-in user updates fresh_auth_at without a second session;
//      another user's passkey is refused
//   F. no response body contains a session token
//   G. magic-link request timing: known vs unknown email
// Usage: npm run test:e2e
import { build } from "esbuild";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { startDevServer } from "./lib/dev-server.mjs";

const { chromium } = createRequire(import.meta.url)("playwright");

const clientBundle = (
  await build({
    stdin: { contents: `import * as w from "@simplewebauthn/browser"; window.SWA = w;`, resolveDir: process.cwd() },
    bundle: true,
    write: false,
    format: "iife",
    target: "es2022",
  })
).outputFiles[0].text;

const server = await startDevServer();
const base = server.base;
console.log("wrangler dev up at", base);
const results = {};
const bodies = []; // every JSON body the browser received, checked for session tokens at the end
const browser = await chromium.launch();
try {
  await fetch(`${base}/test/install`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ origin: base }) });

  // One browser context = one cookie jar and one virtual-authenticator environment.
  async function openPage({ uv = true, transport = "internal" } = {}) {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("console", (m) => m.type() === "error" && !m.text().includes("status of 4") && console.error("[page]", m.text()));
    await page.goto(`${base}/`); // http://localhost is a secure context; RP ID "localhost"
    await page.addScriptTag({ content: clientBundle });
    await page.exposeFunction("recordBody", (t) => bodies.push(t));
    await page.evaluate(() => {
      const H = { "content-type": "application/json", "x-officebox-request": "1" };
      window.call = async (method, path, body) => {
        const r = await fetch(path, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
        const text = await r.text();
        await window.recordBody(text);
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {}
        return { status: r.status, json };
      };
    });
    const cdp = await context.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    // Chrome allows one "internal" (platform) authenticator per environment; extra devices are security keys ("usb").
    // uv false = a security key without a PIN or biometric (no UV capability at all).
    const addAuthenticator = (isUserVerified, t = "usb") =>
      cdp.send("WebAuthn.addVirtualAuthenticator", {
        options: { protocol: "ctap2", transport: t, hasResidentKey: true, hasUserVerification: isUserVerified, isUserVerified, automaticPresenceSimulation: true },
      });
    const { authenticatorId } = await addAuthenticator(uv, transport);
    const sessionCookie = async () => (await context.cookies()).find((c) => c.name === "__Host-officebox.session_token");
    const clearSession = () => context.clearCookies({ name: "__Host-officebox.session_token" });
    // Register with whatever enrolment ticket cookie is set. `tweakUv` lowers UV client-side, to test the server.
    const register = (createSession, tweakUv) =>
      page.evaluate(
        async ({ createSession, tweakUv }) => {
          const opts = await window.call("GET", "/api/auth/passkey/generate-register-options");
          if (opts.status !== 200) return { opts };
          const optionsJSON = { ...opts.json };
          if (tweakUv) optionsJSON.authenticatorSelection = { ...optionsJSON.authenticatorSelection, userVerification: "discouraged", residentKey: "discouraged", requireResidentKey: false };
          const response = await window.SWA.startRegistration({ optionsJSON });
          const verify = await window.call("POST", "/api/auth/passkey/verify-registration", createSession ? { response, createSession: true } : { response });
          return { opts, verify, credentialId: response.id };
        },
        { createSession, tweakUv },
      );
    const signIn = (tweakUv, path = "/api/auth/passkey", optsOverride) =>
      page.evaluate(
        async ({ tweakUv, path, optsOverride }) => {
          const opts =
            path === "/api/me"
              ? await window.call("POST", "/api/me/reauth/options", {})
              : await window.call("GET", "/api/auth/passkey/generate-authenticate-options");
          const optionsJSON = { ...opts.json, ...(optsOverride ?? {}) };
          if (tweakUv) optionsJSON.userVerification = "discouraged";
          const response = await window.SWA.startAuthentication({ optionsJSON });
          const verify =
            path === "/api/me"
              ? await window.call("POST", "/api/me/reauth", { response })
              : await window.call("POST", "/api/auth/passkey/verify-authentication", { response });
          return { opts, verify, credentialId: response.id };
        },
        { tweakUv, path, optsOverride },
      );
    const me = () => page.evaluate(() => window.call("GET", "/api/me"));
    const setup = (email, name, role) => page.evaluate((b) => window.call("POST", "/api/setup", b), { email, name, role });
    const enrol = (userId) => page.evaluate((b) => window.call("POST", "/test/enrol", b), { userId });
    return { context, page, cdp, authenticatorId, addAuthenticator, sessionCookie, clearSession, register, signIn, me, setup, enrol };
  }
  const get = (path) => fetch(`${base}${path}`).then((r) => r.json());

  const P = await openPage();
  const { cdp, sessionCookie, clearSession, register, signIn, me } = P;
  const uvAuth = P.authenticatorId;

  // ---------- A. registration without a session ----------
  const ownerA = await P.setup(`owner-a-${Date.now()}@officebox.test`, "Owner A", "owner");
  assert.equal(ownerA.status, 200);
  const regA = await register(false, false);
  results.A_registration_without_createSession = { optsUv: regA.opts.json.authenticatorSelection, verifyStatus: regA.verify.status };
  assert.equal(regA.opts.json.authenticatorSelection.userVerification, "required");
  assert.equal(regA.opts.json.authenticatorSelection.residentKey, "required");
  assert.equal(regA.opts.json.rp.id, "localhost");
  assert.equal(regA.verify.status, 200, JSON.stringify(regA.verify));
  assert.equal(await sessionCookie(), undefined, "verify without createSession sets no session cookie");
  assert.equal((await me()).status, 401);
  // the enrolment ticket was consumed at verify: registering again with it fails
  const reuse = await P.page.evaluate(() => window.call("GET", "/api/auth/passkey/generate-register-options"));
  results.A_ticket_reuse = reuse;
  assert.equal(reuse.status, 401, "consumed ticket can't start another registration");

  // A second user registering on a second browser (own authenticator), asking verify to create the session.
  const PB = await openPage();
  const userB = await PB.setup(`member-b-${Date.now()}@officebox.test`, "Member B");
  const regB = await PB.register(true, false);
  results.A_registration_with_createSession = { verifyStatus: regB.verify.status, bodyKeys: Object.keys(regB.verify.json ?? {}), sessionKeys: Object.keys(regB.verify.json?.session ?? {}) };
  assert.equal(regB.verify.status, 200, JSON.stringify(regB.verify));
  assert.ok(await PB.sessionCookie(), "createSession: true sets the session cookie");
  const meB = await PB.me();
  assert.equal(meB.json.id, userB.json.userId);
  assert.equal(meB.json.freshAuthMethod, "passkey");
  assert.ok(!("token" in (regB.verify.json.session ?? {})), "filtered: no token in the registration body");
  await PB.context.close();

  // ---------- B. discoverable sign-in with UV ----------
  const s1 = await signIn(false);
  results.B_signin = { optsUv: s1.opts.json.userVerification, status: s1.verify.status, bodyKeys: Object.keys(s1.verify.json ?? {}) };
  assert.equal(s1.opts.json.userVerification, "required", "our after hook rewrote the authentication options");
  assert.equal(s1.verify.status, 200, JSON.stringify(s1.verify));
  assert.equal(s1.credentialId, regA.credentialId);
  const meA = await me();
  assert.equal(meA.json.id, ownerA.json.userId);
  assert.equal(meA.json.freshAuthMethod, "passkey");
  assert.ok(meA.json.freshAuthAt > 0);
  const c1 = (await get(`/test/passkey?credentialId=${regA.credentialId}`)).sign_count;
  await clearSession();
  const s2 = await signIn(false);
  assert.equal(s2.verify.status, 200);
  const c2 = (await get(`/test/passkey?credentialId=${regA.credentialId}`)).sign_count;
  results.B_counters = { afterFirst: c1, afterSecond: c2 };
  assert.ok(c2 > c1 && c1 > 0, "sign_count stored and increasing");
  await clearSession();

  // ---------- C. UV enforced on the server ----------
  // A browser whose only authenticator is a security key without a PIN or biometric.
  const PN = await openPage({ uv: false, transport: "usb" });
  await PN.setup(`no-uv-${Date.now()}@officebox.test`, "No UV");
  const regNoUv = await PN.register(false, true);
  results.C_registration_without_uv = regNoUv.verify;
  assert.equal(regNoUv.verify.status, 400);
  assert.equal(regNoUv.verify.json.code, "USER_VERIFICATION_REQUIRED");
  assert.equal((await get(`/test/passkey?credentialId=${regNoUv.credentialId}`)), null, "no passkey row stored");
  // sign-in without UV: copy A's credential (counter ahead) into the no-UV key
  const [credA] = (await cdp.send("WebAuthn.getCredentials", { authenticatorId: uvAuth })).credentials;
  await PN.cdp.send("WebAuthn.addCredential", { authenticatorId: PN.authenticatorId, credential: { ...credA, signCount: credA.signCount + 100 } });
  const sNoUv = await PN.signIn(true, "/api/auth/passkey", { allowCredentials: [{ id: regA.credentialId, type: "public-key" }] });
  results.C_signin_without_uv = sNoUv.verify;
  assert.equal(sNoUv.verify.status, 401);
  assert.equal(sNoUv.verify.json.code, "USER_VERIFICATION_REQUIRED");
  assert.equal(await PN.sessionCookie(), undefined);
  await PN.context.close();

  // ---------- D. counter regression ----------
  const before = (await get(`/test/passkey?credentialId=${regA.credentialId}`)).sign_count;
  const [cred] = (await cdp.send("WebAuthn.getCredentials", { authenticatorId: uvAuth })).credentials.filter((c) => c.credentialId === credA.credentialId);
  await cdp.send("WebAuthn.removeCredential", { authenticatorId: uvAuth, credentialId: cred.credentialId });
  await cdp.send("WebAuthn.addCredential", { authenticatorId: uvAuth, credential: { ...cred, signCount: 1 } });
  const cloned = await signIn(false);
  const notices = await get(`/test/notices?userId=${ownerA.json.userId}`);
  const authLog = await get("/test/authlog");
  results.D_clone = { verify: cloned.verify, storedBefore: before, storedAfter: (await get(`/test/passkey?credentialId=${regA.credentialId}`)).sign_count, notices, libraryLog: authLog.slice(-1) };
  // An APIError thrown from an after hook replaces the body, but the HTTP status stays the endpoint's (400).
  assert.equal(cloned.verify.status, 400, JSON.stringify(cloned.verify));
  assert.equal(cloned.verify.json.code, "clone_detected");
  assert.equal(await sessionCookie(), undefined, "no session left behind");
  assert.equal(results.D_clone.storedAfter, before, "stored counter unchanged");
  assert.equal(notices.filter((n) => n.kind === "passkey_clone_detected").length, 1);
  assert.match(JSON.stringify(authLog), /Response counter value 2 was lower than expected/);
  // restore a healthy counter for the rest of the run
  await cdp.send("WebAuthn.removeCredential", { authenticatorId: uvAuth, credentialId: cred.credentialId });
  await cdp.send("WebAuthn.addCredential", { authenticatorId: uvAuth, credential: { ...cred, signCount: before + 10 } });

  // ---------- E. step-up without a second session ----------
  const s3 = await signIn(false);
  assert.equal(s3.verify.status, 200);
  const sessionsBefore = await get(`/test/sessions?userId=${ownerA.json.userId}`);
  const freshBefore = (await me()).json.freshAuthAt;
  await new Promise((r) => setTimeout(r, 1100));
  const reauth = await signIn(false, "/api/me");
  const sessionsAfter = await get(`/test/sessions?userId=${ownerA.json.userId}`);
  const freshAfter = (await me()).json.freshAuthAt;
  results.E_stepup = { status: reauth.verify.status, body: reauth.verify.json, sessionsBefore: sessionsBefore.length, sessionsAfter: sessionsAfter.length, freshBefore, freshAfter };
  assert.equal(reauth.verify.status, 200, JSON.stringify(reauth.verify));
  assert.equal(sessionsAfter.length, sessionsBefore.length, "no second session row");
  assert.ok(freshAfter > freshBefore, "fresh_auth_at moved on the current session");
  assert.equal(reauth.opts.json.allowCredentials?.length, 1, "options are scoped to the signed-in user's passkeys");
  // another user's passkey can't satisfy step-up: register one for a third user, then present it
  await clearSession();
  const userC = await P.setup(`member-c-${Date.now()}@officebox.test`, "Member C");
  const regC = await register(false, false);
  assert.equal(regC.verify.status, 200);
  await clearSession();
  const s4 = await signIn(false, "/api/auth/passkey", { allowCredentials: [{ id: regA.credentialId, type: "public-key" }] });
  assert.equal(s4.verify.status, 200);
  const wrong = await signIn(false, "/api/me", { allowCredentials: [{ id: regC.credentialId, type: "public-key" }] });
  results.E_stepup_other_user = { status: wrong.verify.status, body: wrong.verify.json, userC: userC.json.userId };
  assert.equal(wrong.verify.status, 401);
  assert.equal(wrong.verify.json.detail, "other_user");
  assert.equal((await get(`/test/sessions?userId=${userC.json.userId}`)).length, 0, "no session for the other user either");

  // ---------- F. no body carried a session token ----------
  const tokens = await get("/test/session-tokens");
  const leaks = bodies.filter((b) => tokens.some((t) => b.includes(t)));
  results.F_token_exposure = { bodiesChecked: bodies.length, sessionTokens: tokens.length, leaks: leaks.length };
  assert.ok(tokens.length > 0 && bodies.length > 10);
  assert.equal(leaks.length, 0, leaks.join("\n"));

  // ---------- G. magic-link request timing ----------
  const timeOne = async (email, i) => {
    const t0 = performance.now();
    const r = await fetch(`${base}/api/auth/sign-in/magic-link`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-officebox-request": "1", origin: base, "cf-connecting-ip": `10.9.${i >> 8}.${i & 255}` },
      body: JSON.stringify({ email }),
    });
    await r.text();
    return { ms: performance.now() - t0, status: r.status };
  };
  const knownAddr = `timing-known-${Date.now()}@officebox.test`;
  await fetch(`${base}/api/setup`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-officebox-request": "1", origin: base },
    body: JSON.stringify({ email: knownAddr, name: "Known" }),
  });
  const known = [];
  const unknown = [];
  const N = 150;
  for (let i = 0; i < N; i++) {
    // interleaved, alternating which goes first
    const k = () => timeOne(knownAddr, 2 * i);
    const u = () => timeOne(`timing-unknown-${i}-${Date.now()}@officebox.test`, 2 * i + 1);
    if (i % 2) {
      known.push(await k());
      unknown.push(await u());
    } else {
      unknown.push(await u());
      known.push(await k());
    }
  }
  const q = (xs, p) => +xs.map((x) => x.ms).sort((a, b) => a - b)[Math.floor(xs.length * p)].toFixed(2);
  results.G_timing = {
    samplesEach: N,
    statuses: [...new Set([...known, ...unknown].map((x) => x.status))],
    known: { p25: q(known, 0.25), median: q(known, 0.5), p75: q(known, 0.75) },
    unknown: { p25: q(unknown, 0.25), median: q(unknown, 0.5), p75: q(unknown, 0.75) },
    note: "local wrangler dev on one machine; mail capture runs in waitUntil",
  };
  assert.deepEqual(results.G_timing.statuses, [200]);

  console.log(JSON.stringify(results, null, 2));
  console.log("\npasskey end-to-end checks passed");
} catch (e) {
  console.log(JSON.stringify(results, null, 2));
  console.error("--- wrangler log (tail) ---\n" + server.log().slice(-4000));
  process.exitCode = 1;
  console.error(e);
} finally {
  await browser.close();
  await server.stop();
}

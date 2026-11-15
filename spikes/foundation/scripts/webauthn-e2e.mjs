// Q2 end to end: wrangler dev + Playwright Chromium with a CDP virtual authenticator.
//   1. register a discoverable passkey
//   2. sign in twice: sign_count increases and the server stores it
//   3. replays (run while counters are healthy, so only the replay protection can refuse them):
//      a. an assertion made for flow A submitted against flow B -> invalid_response (challenge mismatch)
//      b. a valid assertion resubmitted to the flow it already completed -> unknown_flow (single-use challenge)
//   4. clone: rewind the authenticator's signCount -> clone_detected, stored counter unchanged
// Usage: npm run test:webauthn   (PORT=8787 to pin the port; otherwise a free port is chosen)
import { build } from "esbuild";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { startDevServer } from "./lib/dev-server.mjs";

const { chromium } = createRequire(import.meta.url)("playwright"); // the machine's Playwright 1.63.0

const clientBundle = (
  await build({
    stdin: { contents: `import * as w from "@simplewebauthn/browser"; window.SWA = w;`, resolveDir: process.cwd() },
    bundle: true,
    write: false,
    format: "iife",
    target: "es2022",
  })
).outputFiles[0].text;

const server = await startDevServer({ port: process.env.PORT ? Number(process.env.PORT) : undefined });
console.log("wrangler dev up at", server.base);
const browser = await chromium.launch();
const results = {};
try {
  const page = await browser.newPage();
  page.on("console", (m) => m.type() === "error" && console.error("[page]", m.text()));
  await page.goto(`${server.base}/`); // http://localhost is a secure context, RP ID "localhost"
  await page.addScriptTag({ content: clientBundle });
  await page.evaluate(() => {
    window.post = (p, b) => fetch(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json());
  });

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });

  const register = (username) =>
    page.evaluate(async (username) => {
      const { flowId, options } = await window.post("/webauthn/register/options", { username });
      const response = await window.SWA.startRegistration({ optionsJSON: options });
      return window.post("/webauthn/register/verify", { flowId, response });
    }, username);

  // Returns the verify result plus the flow and response, so tests can resubmit them.
  const signIn = () =>
    page.evaluate(async () => {
      const { flowId, options } = await window.post("/webauthn/login/options", {});
      const response = await window.SWA.startAuthentication({ optionsJSON: options }); // discoverable: no email typed
      return { flowId, response, result: await window.post("/webauthn/login/verify", { flowId, response }) };
    });
  const storedCounter = async (id) => (await (await fetch(`${server.base}/webauthn/credential?id=${id}`)).json()).counter;

  // 1. Registration
  const reg = await register(`alice-${Date.now()}@example.com`);
  results.registration = reg;
  assert.equal(reg.ok, true, JSON.stringify(reg));
  assert.equal(reg.value.userVerified, true);
  assert.equal(reg.value.fmt, "none");
  const credId = reg.value.credentialId;
  const { credentials } = await cdp.send("WebAuthn.getCredentials", { authenticatorId });
  assert.equal(credentials.length, 1);
  assert.equal(credentials[0].isResidentCredential, true);

  // 2. Two sign-ins
  const first = await signIn();
  const second = await signIn();
  results.signIn1 = first.result;
  results.signIn2 = second.result;
  assert.equal(first.result.ok, true, JSON.stringify(first.result));
  assert.equal(second.result.ok, true, JSON.stringify(second.result));
  assert.equal(first.result.value.userId, reg.value.userId, "discoverable sign-in resolves the right user");
  assert.equal(first.result.value.userVerified, true);
  assert.ok(second.result.value.newCounter > first.result.value.newCounter, "sign_count increases");
  assert.equal(second.result.value.oldCounter, first.result.value.newCounter, "server stored the previous sign_count");
  assert.equal(await storedCounter(credId), second.result.value.newCounter);

  // 3a. Cross-flow replay: an assertion signed for flow A, submitted against a fresh flow B. Its counter is
  // higher than the stored one (it was never accepted), so only the challenge check can refuse it.
  const crossFlow = await page.evaluate(async () => {
    const a = await window.post("/webauthn/login/options", {});
    const response = await window.SWA.startAuthentication({ optionsJSON: a.options });
    const b = await window.post("/webauthn/login/options", {});
    return window.post("/webauthn/login/verify", { flowId: b.flowId, response });
  });
  results.crossFlowReplay = crossFlow;
  assert.equal(crossFlow.ok, false);
  assert.equal(crossFlow.error, "invalid_response", JSON.stringify(crossFlow));
  assert.match(crossFlow.detail, /challenge/i);

  // 3b. Same-flow resubmission of an assertion that was already accepted: the flow is single-use.
  const third = await signIn();
  assert.equal(third.result.ok, true, JSON.stringify(third.result));
  const resubmit = await page.evaluate(({ flowId, response }) => window.post("/webauthn/login/verify", { flowId, response }), third);
  results.sameFlowResubmission = resubmit;
  assert.equal(resubmit.ok, false);
  assert.equal(resubmit.error, "unknown_flow", JSON.stringify(resubmit));
  const counterBeforeClone = await storedCounter(credId);
  assert.equal(counterBeforeClone, third.result.value.newCounter, "refused replays did not move the counter");

  // 4. Clone detection: replace the credential with a copy whose signCount is behind the server's value.
  const [cred] = (await cdp.send("WebAuthn.getCredentials", { authenticatorId })).credentials;
  results.authenticatorSignCountBeforeRewind = cred.signCount;
  await cdp.send("WebAuthn.removeCredential", { authenticatorId, credentialId: cred.credentialId });
  await cdp.send("WebAuthn.addCredential", { authenticatorId, credential: { ...cred, signCount: 0 } });
  const cloned = await signIn();
  results.clonedSignIn = cloned.result;
  assert.equal(cloned.result.ok, false);
  assert.equal(cloned.result.error, "clone_detected", JSON.stringify(cloned.result));
  assert.equal(await storedCounter(credId), counterBeforeClone, "a refused sign-in does not move the stored counter");

  console.log(JSON.stringify(results, null, 2));
  console.log("\nwebauthn end-to-end checks passed");
} catch (e) {
  console.log(JSON.stringify(results, null, 2));
  console.error("--- wrangler log (tail) ---\n" + server.log().slice(-4000));
  process.exitCode = 1;
  console.error(e);
} finally {
  await browser.close();
  await server.stop();
}

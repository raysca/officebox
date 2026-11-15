// Q2 end to end: wrangler dev + Playwright Chromium with a CDP virtual authenticator.
// Registers a passkey, signs in twice (sign_count increases and is stored), then simulates a cloned
// authenticator by rewinding the credential's signCount and checks that the Worker refuses it.
// Usage: npm run test:webauthn
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

console.log("starting wrangler dev...");
const server = await startDevServer(Number(process.env.PORT ?? 8787));
console.log("wrangler dev up at", server.base);
const browser = await chromium.launch();
console.log("chromium launched");
const results = {};
try {
  const page = await browser.newPage();
  page.on("console", (m) => m.type() === "error" && console.error("[page]", m.text()));
  await page.goto(`${server.base}/`); // http://localhost is a secure context, RP ID "localhost"
  await page.addScriptTag({ content: clientBundle });

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
      const post = (p, b) => fetch(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json());
      const { flowId, options } = await post("/webauthn/register/options", { username });
      const response = await window.SWA.startRegistration({ optionsJSON: options });
      return post("/webauthn/register/verify", { flowId, response });
    }, username);

  const signIn = () =>
    page.evaluate(async () => {
      const post = (p, b) => fetch(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json());
      const { flowId, options } = await post("/webauthn/login/options", {});
      const response = await window.SWA.startAuthentication({ optionsJSON: options }); // discoverable: no email typed
      return post("/webauthn/login/verify", { flowId, response });
    });

  console.log("virtual authenticator", authenticatorId);
  // 1. Registration
  const reg = await register(`alice-${Date.now()}@example.com`);
  results.registration = reg;
  assert.equal(reg.ok, true, JSON.stringify(reg));
  assert.equal(reg.value.userVerified, true);
  assert.equal(reg.value.fmt, "none");

  const { credentials } = await cdp.send("WebAuthn.getCredentials", { authenticatorId });
  assert.equal(credentials.length, 1);
  assert.equal(credentials[0].isResidentCredential, true);

  // 2. Two sign-ins: the counter increases and the server stores the new value.
  const first = await signIn();
  const second = await signIn();
  results.signIn1 = first;
  results.signIn2 = second;
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(first.value.userId, reg.value.userId, "discoverable sign-in resolves the right user");
  assert.equal(first.value.userVerified, true);
  assert.ok(second.value.newCounter > first.value.newCounter, "sign_count increases");
  assert.equal(second.value.oldCounter, first.value.newCounter, "server stored the previous sign_count");
  const stored = await (await fetch(`${server.base}/webauthn/credential?id=${reg.value.credentialId}`)).json();
  assert.equal(stored.counter, second.value.newCounter);

  // 3. Clone detection: replace the credential with a copy whose signCount is behind the server's value.
  const [cred] = (await cdp.send("WebAuthn.getCredentials", { authenticatorId })).credentials;
  results.authenticatorSignCountBeforeRewind = cred.signCount;
  await cdp.send("WebAuthn.removeCredential", { authenticatorId, credentialId: cred.credentialId });
  await cdp.send("WebAuthn.addCredential", { authenticatorId, credential: { ...cred, signCount: 0 } });
  const cloned = await signIn();
  results.clonedSignIn = cloned;
  assert.equal(cloned.ok, false);
  assert.equal(cloned.error, "clone_detected", JSON.stringify(cloned));
  const after = await (await fetch(`${server.base}/webauthn/credential?id=${reg.value.credentialId}`)).json();
  assert.equal(after.counter, second.value.newCounter, "a refused sign-in does not move the stored counter");

  // 4. Replaying a captured assertion: same response, fresh challenge -> refused (challenge mismatch).
  const replay = await page.evaluate(async () => {
    const post = (p, b) => fetch(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json());
    const a = await post("/webauthn/login/options", {});
    const response = await window.SWA.startAuthentication({ optionsJSON: a.options });
    const b = await post("/webauthn/login/options", {});
    return post("/webauthn/login/verify", { flowId: b.flowId, response });
  });
  results.replayedAssertion = replay;
  assert.equal(replay.ok, false);

  console.log(JSON.stringify(results, null, 2));
  console.log("\nwebauthn end-to-end checks passed");
} catch (e) {
  console.log(JSON.stringify(results, null, 2));
  console.error(server.log().slice(-4000));
  throw e;
} finally {
  await browser.close();
  await server.stop();
}

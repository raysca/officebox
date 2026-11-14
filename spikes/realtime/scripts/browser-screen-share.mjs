// Runs the screen-share client in headless Chromium with a fake capture source and checks the results.
// Usage: npm run test:browser
import { build } from "esbuild";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

// Uses the machine's pre-installed Playwright (resolved via require, which honours NODE_PATH).
const { chromium } = createRequire(import.meta.url)("playwright");

const bundle = await build({ entryPoints: ["client/harness.ts"], bundle: true, write: false, format: "iife", target: "es2022" });
const script = bundle.outputFiles[0].text;

const browser = await chromium.launch({
  args: [
    "--use-fake-ui-for-media-stream", // auto-accept the capture picker
    "--use-fake-device-for-media-stream",
    "--auto-select-desktop-capture-source=Entire screen",
    "--enable-usermedia-screen-capturing",
  ],
});
try {
  const page = await browser.newPage();
  page.on("console", (m) => m.type() === "error" && console.error("[page]", m.text()));
  // getDisplayMedia needs a secure context; about:blank on localhost-like origin is fine via setContent on https.
  await page.route("https://harness.test/", (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>harness</title>" }));
  await page.goto("https://harness.test/");
  await page.addScriptTag({ content: script });
  const r = await page.evaluate(() => window.runHarness());
  console.log(JSON.stringify(r, null, 2));

  assert.equal(r.supported, true);
  assert.equal(r.contentHint, "detail");
  assert.ok(r.settings.width <= 1280 && r.settings.height <= 720, "capture respects the resolution cap");
  assert.ok(r.settings.frameRate <= 15, "detail mode caps the frame rate");
  assert.equal(r.simulcastInOffer, true, "offer advertises simulcast f;h;q");
  assert.deepEqual(r.ridsInOffer, ["f", "h", "q"]);
  assert.deepEqual(r.encodingsBeforeAnswer, r.expectedEncodings, "sender configured with f/h/q encodings");
  assert.deepEqual(r.encodingsAfterLoopbackAnswer, ["f"], "a non-simulcast receiver collapses to one layer (expected)");
  assert.equal(r.connection, "connected");
  assert.equal(r.remoteTrackKind, "video");
  assert.ok(r.framesEncoded > 0 && r.framesDecoded > 0, "frames flowed to the receiving peer");
  assert.deepEqual(r.layers, ["f", "h", "q"]);
  assert.deepEqual(r.log.at(-2), { type: "close", detail: r.log[0].detail.map((t) => t.mid) }, "stop closes the published mids");
  assert.deepEqual(r.log.at(-1), { type: "ws", detail: { type: "screen.stopped" } }, "stop releases the presenter slot");
  console.log("\nbrowser screen-share checks passed");
} finally {
  await browser.close();
}

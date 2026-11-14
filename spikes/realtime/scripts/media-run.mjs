// Real-media run: three headless Chromium participants in a huddle, through the Cloudflare Realtime SFU.
//
//   npm run test:media -- --start          start `wrangler dev` with SFU_MODE=real, then run (needs .dev.vars)
//   npm run test:media -- --base=URL       run against an already-running or deployed spike (SFU_MODE=real)
//   npm run test:media -- --self-test      check the measurement code locally (no SFU, no credentials)
//
// Writes media-report.json and exits non-zero if a check fails. See README "Real-media run".
import { build } from "esbuild";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const { chromium } = createRequire(import.meta.url)("playwright");

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);
const PORT = Number(args.port ?? 8787);
const BASE = String(args.base ?? `http://127.0.0.1:${PORT}`).replace(/\/$/, "");
const REPORT = String(args.report ?? "media-report.json");

// Targets from TDD §9.2.
const TARGETS = { joinToAudioMs: 2000, shareStartMs: 3000, latencyP95Ms: 500, forcedStopMs: 3000 };

const CHROMIUM_ARGS = [
  "--use-fake-ui-for-media-stream",
  "--use-fake-device-for-media-stream",
  "--auto-select-desktop-capture-source=Entire screen",
  "--enable-usermedia-screen-capturing",
  "--autoplay-policy=no-user-gesture-required",
];

function readDevVars() {
  const vars = {};
  if (existsSync(".dev.vars")) {
    for (const line of readFileSync(".dev.vars", "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) vars[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  for (const k of ["REALTIME_APP_ID", "REALTIME_APP_SECRET", "TURN_KEY_ID", "TURN_KEY_API_TOKEN"]) if (process.env[k]) vars[k] = process.env[k];
  return vars;
}

async function bundle(entry) {
  const out = await build({ entryPoints: [entry], bundle: true, write: false, format: "iife", target: "es2022" });
  return out.outputFiles[0].text;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ self-test

async function selfTest() {
  const browser = await chromium.launch({ args: CHROMIUM_ARGS });
  try {
    const page = await browser.newPage();
    await page.route("https://selftest.local/", (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>self-test</title>" }));
    await page.goto("https://selftest.local/");
    await page.addScriptTag({ content: await bundle("client/media-selftest.ts") });
    const r = await page.evaluate(() => window.mediaSelfTest());
    console.log(JSON.stringify(r, null, 2));
    const ok = r.exactRoundTrips.every(Boolean) && r.wrapHandled && r.loopback.samples >= 40 && r.loopback.p95 < 500;
    console.log(ok ? "\nself-test passed: the latency probe decodes through real WebRTC compression" : "\nself-test FAILED");
    process.exitCode = ok ? 0 : 1;
  } finally {
    await browser.close();
  }
}

// ------------------------------------------------------------------ preflight

async function preflight(vars) {
  const missing = ["REALTIME_APP_ID", "REALTIME_APP_SECRET"].filter((k) => !vars[k]);
  if (missing.length) {
    console.error(`Missing ${missing.join(", ")}. Add them to .dev.vars (see .dev.vars.example) or the environment.`);
    console.error("Create them in the Cloudflare dashboard: Realtime → SFU → create an app.");
    process.exit(2);
  }
  if (process.env.HTTPS_PROXY && !process.env.NODE_USE_ENV_PROXY) {
    console.warn("Note: HTTPS_PROXY is set; set NODE_USE_ENV_PROXY=1 so Node's fetch uses it for the preflight.");
  }
  // Direct check that the credentials work and the API is reachable from this machine.
  try {
    const res = await fetch(`https://rtc.live.cloudflare.com/v1/apps/${vars.REALTIME_APP_ID}/sessions/new`, {
      method: "POST",
      headers: { Authorization: `Bearer ${vars.REALTIME_APP_SECRET}` },
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
    return { sfuApi: "ok", sampleSession: JSON.parse(body).sessionId ? "created" : "unexpected response" };
  } catch (err) {
    console.error(`Realtime SFU API check failed: ${err.message}`);
    console.error("Check the app ID and secret, and that this machine can reach rtc.live.cloudflare.com.");
    process.exit(2);
  }
}

// ------------------------------------------------------------------ dev server

function startDevServer() {
  console.log("Applying local D1 migrations…");
  execFileSync("npx", ["wrangler", "d1", "migrations", "apply", "DB", "--local"], { stdio: "inherit", env: { ...process.env, CI: "1" } });
  console.log(`Starting wrangler dev on ${BASE} with SFU_MODE=real…`);
  const child = spawn("npx", ["wrangler", "dev", "--port", String(PORT), "--ip", "127.0.0.1", "--var", "SFU_MODE:real"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
  child.stdout.on("data", (d) => args.verbose && process.stdout.write(`[wrangler] ${d}`));
  child.stderr.on("data", (d) => args.verbose && process.stderr.write(`[wrangler] ${d}`));
  return child;
}

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${BASE}/dev/sfu-status`);
      if (res.ok) return res.json();
    } catch {
      // not up yet
    }
    await sleep(1000);
  }
  throw new Error(`spike did not respond at ${BASE}`);
}

// ------------------------------------------------------------------ the run

async function cookieFor(userId) {
  const res = await fetch(`${BASE}/dev/login`, { method: "POST", body: JSON.stringify({ userId }) });
  return res.headers.get("set-cookie").split(";")[0];
}

async function run() {
  const vars = readDevVars();
  const report = { startedAt: new Date().toISOString(), base: BASE, targets: TARGETS, preflight: await preflight(vars), checks: {}, measurements: {} };
  const check = (name, pass, detail) => {
    report.checks[name] = { pass, ...detail };
    console.log(`${pass ? "PASS" : "FAIL"}  ${name}  ${JSON.stringify(detail)}`);
  };

  const server = args.start ? startDevServer() : null;
  let browser;
  try {
    const status = await waitForServer();
    report.server = status;
    if (status.sfuMode !== "real") throw new Error(`the spike at ${BASE} is in SFU_MODE=${status.sfuMode}; start it with SFU_MODE=real (or use --start)`);
    if (!status.realtimeConfigured) throw new Error("the spike has no REALTIME_APP_ID / REALTIME_APP_SECRET");
    const turn = status.turnConfigured;

    await fetch(`${BASE}/dev/seed`, { method: "POST" });
    // Alice is the host (admin of #general); Bob and Carol are members.
    const huddle = await fetch(`${BASE}/huddles`, {
      method: "POST",
      headers: { Cookie: await cookieFor("alice"), "X-Officebox-Request": "1", Origin: BASE, "Content-Type": "application/json" },
      body: JSON.stringify({ contextType: "channel", contextId: "general" }),
    }).then((r) => r.json());
    report.huddleId = huddle.huddleId;

    browser = await chromium.launch({ args: CHROMIUM_ARGS });
    const participantJs = await bundle("client/media-participant.ts");
    const people = {};
    for (const user of ["alice", "bob", "carol"]) {
      const context = await browser.newContext(); // separate cookie jar per person
      const page = await context.newPage();
      page.on("console", (m) => m.type() === "error" && console.error(`[${user}]`, m.text()));
      await page.goto(`${BASE}/dev/media-harness`);
      await page.addScriptTag({ content: participantJs });
      await page.evaluate((u) => window.participant.login(u), user);
      people[user] = page;
    }
    const { alice, bob, carol } = people;
    const call = (page, fn, arg) => page.evaluate(fn, arg);

    // 1. Join and audio: Alice publishes her mic; time Bob from "join" to hearing her.
    const aliceJoin = await call(alice, (id) => window.participant.join(id), huddle.huddleId);
    await call(alice, () => window.participant.publishMic());
    const bobStart = Date.now();
    await call(bob, (id) => window.participant.join(id), huddle.huddleId);
    await call(bob, () => window.participant.publishMic()); // creates Bob's SFU session
    const bobAudioMid = await call(bob, (c) => window.participant.subscribe(c, "audio"), aliceJoin.connId);
    const heardAt = await call(bob, (mid) => window.participant.waitForMedia(mid), bobAudioMid);
    const joinToAudio = heardAt - bobStart;
    check("join-to-audio", joinToAudio < TARGETS.joinToAudioMs, { ms: joinToAudio, target: TARGETS.joinToAudioMs });

    // Carol joins relay-only when TURN is configured (simulates a restrictive network).
    await call(carol, (o) => window.participant.join(o.id, { relayOnly: o.relay }), { id: huddle.huddleId, relay: turn });
    await call(carol, () => window.participant.publishMic());

    // 2. Screen share with real capture and simulcast; time from share start to viewers' first frame.
    const constraints = await call(alice, () => window.participant.requestShare());
    const share = await call(alice, (c) => window.participant.startShare(c), constraints);
    const [bobScreenMid, carolScreenMid] = await Promise.all([
      call(bob, (c) => window.participant.subscribe(c, "screen", "f"), aliceJoin.connId),
      call(carol, (c) => window.participant.subscribe(c, "screen", "f"), aliceJoin.connId),
    ]);
    const [bobFirst, carolFirst] = await Promise.all([
      call(bob, (mid) => window.participant.waitForMedia(mid), bobScreenMid),
      call(carol, (mid) => window.participant.waitForMedia(mid), carolScreenMid),
    ]);
    const shareStart = Math.max(bobFirst, carolFirst) - share.startedAt;
    check("share-start", shareStart < TARGETS.shareStartMs, { ms: shareStart, target: TARGETS.shareStartMs });

    // 3. Simulcast: the presenter sends three layers; switching a viewer to "q" lowers the received resolution.
    await sleep(5000);
    const layers = await call(alice, () => window.participant.outboundLayers());
    const sending = layers.filter((l) => l.framesEncoded > 0).map((l) => l.rid);
    check("simulcast-layers-sent", ["f", "h", "q"].every((r) => sending.includes(r)), { layers });
    const fullWidth = (await call(bob, (mid) => window.participant.inbound(mid), bobScreenMid)).frameWidth;
    await call(bob, (o) => window.participant.setLayer(o.mid, "q"), { mid: bobScreenMid });
    await sleep(5000);
    const after = await call(bob, (mid) => window.participant.inbound(mid), bobScreenMid);
    check("simulcast-layer-switch", after.frameWidth > 0 && after.frameWidth <= fullWidth / 2, { fullWidth, quarterLayerWidth: after.frameWidth });

    // 4. Restrictive network: Carol's media flows over a TURN relay.
    if (turn) {
      const type = await call(carol, () => window.participant.candidateType());
      const frames = (await call(carol, (mid) => window.participant.inbound(mid), carolScreenMid)).framesDecoded;
      check("turn-relay", type === "relay" && frames > 0, { candidateType: type, framesDecoded: frames });
    } else {
      report.checks["turn-relay"] = { skipped: "TURN_KEY_ID / TURN_KEY_API_TOKEN not configured" };
      console.log("SKIP  turn-relay  (no TURN key configured)");
    }

    // 5. Bandwidth over a 5 s window: audio at Bob, screen at Carol (full layer).
    const a0 = await call(bob, (mid) => window.participant.inbound(mid), bobAudioMid);
    const s0 = await call(carol, (mid) => window.participant.inbound(mid), carolScreenMid);
    await sleep(5000);
    const a1 = await call(bob, (mid) => window.participant.inbound(mid), bobAudioMid);
    const s1 = await call(carol, (mid) => window.participant.inbound(mid), carolScreenMid);
    report.measurements.bitrateKbps = {
      audio: Math.round(((a1.bytesReceived - a0.bytesReceived) * 8) / 5 / 1000),
      screenFullLayer: Math.round(((s1.bytesReceived - s0.bytesReceived) * 8) / 5 / 1000),
      screenResolution: `${s1.frameWidth}x${s1.frameHeight}`,
    };
    console.log(`INFO  bitrate  ${JSON.stringify(report.measurements.bitrateKbps)}`);

    // 6. Moderator stop: Bob takes over sharing; the host stops him; Carol's screen stream stops arriving.
    await call(alice, () => window.participant.stopShare());
    const bobConstraints = await call(bob, () => window.participant.requestShare());
    await call(bob, (c) => window.participant.startShare(c), bobConstraints);
    const bobConn = await call(bob, () => window.participant.connId);
    const carolBobMid = await call(carol, (c) => window.participant.subscribe(c, "screen", "f"), bobConn);
    await call(carol, (mid) => window.participant.waitForMedia(mid), carolBobMid);
    const stopAt = Date.now();
    await call(alice, (c) => window.participant.send({ type: "screen.stop", targetConnId: c }), bobConn);
    let stalledAfter = null;
    let last = (await call(carol, (mid) => window.participant.inbound(mid), carolBobMid)).bytesReceived;
    let stableSince = Date.now();
    while (Date.now() - stopAt < 10_000) {
      await sleep(250);
      const now = (await call(carol, (mid) => window.participant.inbound(mid), carolBobMid)).bytesReceived;
      if (now !== last) {
        last = now;
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= 1000) {
        stalledAfter = stableSince - stopAt;
        break;
      }
    }
    check("moderator-stop", stalledAfter !== null && stalledAfter < TARGETS.forcedStopMs, { stoppedWithinMs: stalledAfter, target: TARGETS.forcedStopMs });

    // 7. Glass-to-glass latency: Alice shares the timestamp probe; Bob decodes it.
    await sleep(500);
    await call(alice, () => window.participant.requestShare());
    await call(alice, () => window.participant.startProbe());
    const probeMid = await call(bob, (c) => window.participant.subscribe(c, "screen"), aliceJoin.connId);
    await call(bob, (mid) => window.participant.waitForMedia(mid), probeMid);
    await sleep(1000);
    const latency = await call(bob, (mid) => window.participant.probeDelays(mid, 100), probeMid);
    report.measurements.latencyMs = latency;
    check("screen-latency-p95", latency.count >= 50 && latency.p95 < TARGETS.latencyP95Ms, { ...latency, target: TARGETS.latencyP95Ms });

  } catch (err) {
    report.error = String(err?.stack ?? err);
    console.error(`\nRun aborted: ${err.message}`);
  } finally {
    await browser?.close();
    server?.kill("SIGTERM");
    report.finishedAt = new Date().toISOString();
    const failed = Object.entries(report.checks).filter(([, c]) => c.pass === false).map(([n]) => n);
    report.result = report.error ? "error" : failed.length ? "fail" : "pass";
    writeFileSync(REPORT, JSON.stringify(report, null, 2));
    console.log(`\nResult: ${report.result.toUpperCase()}${failed.length ? ` (failed: ${failed.join(", ")})` : ""}. Report: ${REPORT}`);
    process.exitCode = report.result === "pass" ? 0 : 1;
  }
}

if (args["self-test"]) await selfTest();
else await run();

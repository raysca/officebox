// Runs every production check against the deployed probe and prints a report to paste into the PR / README.
// Usage: npm run check:probe                       (reads probe/.probe.json written by deploy.mjs)
//        npm run check:probe -- --url=https://... --token=...
//        npm run check:probe -- --local            (self-test against `wrangler dev` of the probe, see README)
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const saved = existsSync(join(here, ".probe.json")) ? JSON.parse(readFileSync(join(here, ".probe.json"), "utf8")) : {};
const local = process.argv.includes("--local");
const base = arg("url") ?? (local ? "http://localhost:8788" : saved.url);
const token = arg("token") ?? (local ? "local-probe-token" : saved.token);
if (!base || !token) {
  console.error("No probe URL/token. Run `npm run deploy:probe` first, or pass --url= and --token=.");
  process.exit(2);
}

async function call(path) {
  const t0 = performance.now();
  try {
    const res = await fetch(`${base}${path}`, { headers: { "x-probe-token": token } });
    const rtt = performance.now() - t0;
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = { nonJson: text.slice(0, 300) }; // e.g. Cloudflare error 1102 (CPU limit exceeded) HTML page
    }
    return { status: res.status, rttMs: Math.round(rtt), body };
  } catch (e) {
    return { status: 0, rttMs: Math.round(performance.now() - t0), body: { fetchError: e.message } };
  }
}
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const report = { base: local ? "local wrangler dev" : base, at: new Date().toISOString(), hashing: [], rateLimit: {}, queue: [] };
const lines = [];
const log = (s) => {
  lines.push(s);
  console.log(s);
};

log(`# Foundation probe report (${report.base}, ${report.at})\n`);
log("## Q1 Password hashing (3 runs each; rtt = client round trip, includes network)\n");
log("| Check | Result | Error | median rtt ms | colo |");
log("|---|---|---|---|---|");
const hashChecks = [
  ["PBKDF2 100,000", "/pbkdf2?iterations=100000"],
  ["PBKDF2 100,001", "/pbkdf2?iterations=100001"],
  ["PBKDF2 600,000", "/pbkdf2?iterations=600000"],
  ["PBKDF2 100k + HMAC pepper", "/pepper"],
  ["Argon2id m=19MiB t=2 p=1 (hash-wasm + shim)", "/argon2?m=19456&t=2&p=1"],
  ["Argon2id m=46MiB t=1 p=1 (hash-wasm + shim)", "/argon2?m=47104&t=1&p=1"],
  ["scrypt N=2^17 r=8 p=1 (node:crypto)", "/scrypt?N=131072"],
  ["scrypt N=2^18 r=8 p=1 (node:crypto)", "/scrypt?N=262144"],
  ["WebAssembly.compile(bytes) at runtime", "/wasm-compile"],
];
await call("/pepper"); // warm the isolate
for (const [label, path] of hashChecks) {
  const runs = [];
  for (let i = 0; i < 3; i++) runs.push(await call(path));
  const last = runs.at(-1);
  const ok = last.status === 200 && last.body.ok === true;
  const err = last.body.error ?? last.body.nonJson ?? last.body.fetchError ?? (last.status !== 200 ? `HTTP ${last.status}` : "");
  report.hashing.push({ label, path, runs });
  log(`| ${label} | ${ok ? "ok" : "FAILED"} | ${String(err).replace(/\|/g, "/").slice(0, 120)} | ${median(runs.map((r) => r.rttMs))} | ${last.body.colo ?? ""} |`);
}

log("\n## Q3 Rate Limiting binding\n");
{
  const key = `seq-${Date.now()}`;
  const seq = [];
  for (let i = 0; i < 12; i++) seq.push((await call(`/ratelimit?period=60&key=${key}&count=1`)).body.results?.[0]);
  report.rateLimit.separateRequests60 = seq;
  log(`- limit 5 / 60 s, 12 separate requests, one key: \`${seq.map((s) => (s ? "Y" : "n")).join("")}\` (successes: ${seq.filter(Boolean).length})`);

  const one = (await call(`/ratelimit?period=60&key=one-${Date.now()}&count=12`)).body;
  report.rateLimit.oneRequest60 = one;
  log(`- limit 5 / 60 s, 12 calls inside one request: \`${(one.results ?? []).map((s) => (s ? "Y" : "n")).join("")}\` (colo ${one.colo})`);

  const k10 = `ten-${Date.now()}`;
  const first = [];
  for (let i = 0; i < 6; i++) first.push((await call(`/ratelimit?period=10&key=${k10}&count=1`)).body.results?.[0]);
  await sleep(21_000); // at least one full 10 s window later
  const after = [];
  for (let i = 0; i < 2; i++) after.push((await call(`/ratelimit?period=10&key=${k10}&count=1`)).body.results?.[0]);
  report.rateLimit.period10 = { first, after };
  log(`- limit 3 / 10 s: 6 calls \`${first.map((s) => (s ? "Y" : "n")).join("")}\`, then 21 s later \`${after.map((s) => (s ? "Y" : "n")).join("")}\``);

  const p30 = (await call("/ratelimit-period?period=30")).body;
  report.rateLimit.period30 = p30;
  log(`- per-call period 30: ${p30.accepted ? "accepted" : `rejected (${p30.error})`}`);
}

log("\n## Q4 Queue delaySeconds\n");
for (const [label, path] of [
  ["send 43,200 s (12 h)", "/queue?delay=43200"],
  ["send 86,400 s (24 h)", "/queue?delay=86400"],
  ["send 86,401 s", "/queue?delay=86401"],
  ["sendBatch 86,401 s", "/queue?delay=86401&batch=1"],
]) {
  const r = await call(path);
  report.queue.push({ label, ...r });
  log(`- ${label}: ${r.body.ok ? "accepted" : `rejected (${r.body.error ?? r.status})`}`);
}

const out = join(here, local ? "probe-report.local.json" : "probe-report.json");
writeFileSync(out, JSON.stringify(report, null, 2));
log(`\nFull JSON: ${out}. Paste the text above (and the JSON if asked) into the PR.`);

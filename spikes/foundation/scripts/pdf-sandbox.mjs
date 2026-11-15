// Q5: does Chrome's built-in PDF viewer render a PDF served with `Content-Security-Policy: sandbox`?
//
// Serves a one-page PDF from a local HTTP server under several header variants, opens each directly and inside
// an <iframe>, and classifies what Chromium did. Runs in three browser modes:
//   - headless-shell   chromium.launch() default: Playwright's chromium-headless-shell (no PDF viewer expected)
//   - new-headless     chromium.launch({ channel: "chromium" }): full Chromium in new headless mode
//   - headed           chromium.launch({ headless: false }) under xvfb-run, if a display is available
// Classification uses the browser's own signals (download event, PDF viewer extension frame / embed) plus a
// screenshot pixel check for the viewer's grey background. Screenshots go to ./pdf-shots/ (git-ignored).
//
// Usage: npm run test:pdf            (re-execs itself under xvfb-run for the headed mode when needed)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const { chromium } = createRequire(import.meta.url)("playwright");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const shots = join(root, "pdf-shots");
mkdirSync(shots, { recursive: true });

// A minimal valid one-page PDF that draws a big black box and the word "Officebox".
function makePdf() {
  const stream = "0 0 0 rg 72 400 468 300 re f BT /F1 48 Tf 1 1 1 rg 150 530 Td (Officebox) Tj ET";
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
const PDF = makePdf();

// Header variants for /file/<variant>.pdf
const VARIANTS = {
  "no-csp": {},
  "csp-sandbox": { "Content-Security-Policy": "sandbox" }, // TDD §8.3 as written
  "csp-sandbox-allow-scripts": { "Content-Security-Policy": "sandbox allow-scripts" },
  "csp-sandbox-scripts-same-origin": { "Content-Security-Policy": "sandbox allow-scripts allow-same-origin" },
  // A narrower non-sandbox CSP for comparison: blocks scripts/plugins in the document itself.
  "csp-default-none": { "Content-Security-Policy": "default-src 'none'; object-src 'none'" },
};

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const m = url.pathname.match(/^\/file\/([\w-]+)\.pdf$/);
  if (m && VARIANTS[m[1]]) {
    res.writeHead(200, {
      "Content-Type": "application/pdf",
      "Content-Length": PDF.length,
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": 'inline; filename="sample.pdf"',
      ...VARIANTS[m[1]],
    });
    return res.end(PDF);
  }
  if (url.pathname === "/frame.html") {
    const src = url.searchParams.get("src");
    const sandboxAttr = url.searchParams.get("sandbox");
    const attr = sandboxAttr === null ? "" : ` sandbox="${sandboxAttr}"`;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(
      `<!doctype html><html lang="en"><head><title>frame</title><style>body{margin:0}iframe{border:0;width:100vw;height:100vh}</style></head>` +
        `<body><iframe title="preview" src="${src}"${attr}></iframe></body></html>`,
    );
  }
  res.writeHead(404).end();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const VIEWER_EXT = "mhjfbmdgcfjbbpaeojofohoefgiehjai"; // Chrome PDF viewer component extension

// Share of pixels matching the older PDF viewer's grey background (#525659) or toolbar (#323639), and of black
// pixels (the sample PDF is mostly a black box, so black pixels mean the page content was painted).
async function viewerPixelShare(page, file) {
  const png = await page.screenshot({ path: file });
  // Decode the PNG in the page to avoid an image dependency.
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = new OffscreenCanvas(img.width, img.height);
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, img.width, img.height).data;
    let grey = 0;
    let black = 0;
    for (let i = 0; i < d.length; i += 4) {
      const [r, g, b] = [d[i], d[i + 1], d[i + 2]];
      if ((Math.abs(r - 82) < 6 && Math.abs(g - 86) < 6 && Math.abs(b - 89) < 6) || (Math.abs(r - 50) < 6 && Math.abs(g - 54) < 6 && Math.abs(b - 57) < 6)) grey++;
      if (r < 10 && g < 10 && b < 10) black++;
    }
    const n = d.length / 4;
    return { grey: grey / n, black: black / n };
  }, png.toString("base64"));
}

async function probe(browser, mode, how, variant, sandboxAttr) {
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 900, height: 700 } });
  const page = await context.newPage();
  let downloaded = false;
  page.on("download", () => (downloaded = true));
  const consoleMsgs = [];
  page.on("console", (m) => consoleMsgs.push(m.text()));
  const fileUrl = `${base}/file/${variant}.pdf`;
  const target = how === "direct" ? fileUrl : `${base}/frame.html?src=${encodeURIComponent(fileUrl)}${sandboxAttr === undefined ? "" : `&sandbox=${encodeURIComponent(sandboxAttr)}`}`;
  let navError = null;
  try {
    await page.goto(target, { waitUntil: "load", timeout: 10_000 });
  } catch (e) {
    navError = e.message.split("\n")[0];
  }
  await page.waitForTimeout(2500);
  const frames = page.frames().map((f) => f.url());
  let embed = false;
  for (const f of page.frames()) {
    try {
      if (await f.$('embed[type="application/pdf"], embed[original-url]')) embed = true;
    } catch {}
  }
  const extFrame = frames.some((u) => u.includes(VIEWER_EXT));
  const label = `${mode}__${how}${sandboxAttr === undefined ? "" : `-sandbox[${sandboxAttr || "empty"}]`}__${variant}`;
  const pixels = await viewerPixelShare(page, join(shots, `${label}.png`)).catch(() => ({ grey: 0, black: 0 }));
  const html = await page.content().catch(() => "");
  const blockedText = /blocked|ERR_BLOCKED/i.test(html) || consoleMsgs.some((m) => /blocked/i.test(m));
  // The PDF draws a big black box: if those pixels are visible, the PDF content itself was rendered.
  const rendered = pixels.black > 0.05 && (embed || extFrame || pixels.grey > 0.05);
  // A frame Chromium refused shows "This page has been blocked by Chromium" from chrome-error://chromewebdata/.
  const blocked = frames.some((u) => u.startsWith("chrome-error://"));
  const verdict =
    navError?.includes("Download is starting") || downloaded ? "download" : rendered ? "RENDERED" : blocked ? "blocked" : embed || extFrame ? "viewer-no-content" : "not-rendered";
  await context.close();
  return { mode, how, sandboxAttr, variant, verdict, downloaded, embed, extFrame, grey: +pixels.grey.toFixed(3), black: +pixels.black.toFixed(3), blockedText, navError };
}

const modes = [];
const wantHeaded = process.env.DISPLAY || process.argv.includes("--headed-only");
if (!process.argv.includes("--headed-only")) {
  modes.push(["headless-shell", {}]);
  modes.push(["new-headless", { channel: "chromium" }]);
}
if (wantHeaded) modes.push(["headed", { headless: false }]);

const results = [];
for (const [mode, opts] of modes) {
  let browser;
  try {
    browser = await chromium.launch(opts);
  } catch (e) {
    results.push({ mode, verdict: "launch-failed", error: e.message.split("\n")[0] });
    continue;
  }
  console.log(`# ${mode}: ${browser.version()}`);
  for (const variant of Object.keys(VARIANTS)) {
    results.push(await probe(browser, mode, "direct", variant));
    results.push(await probe(browser, mode, "iframe", variant));
  }
  // Sandboxed iframe attribute (the page embedding the preview sandboxes the frame), PDF with CSP sandbox.
  results.push(await probe(browser, mode, "iframe", "csp-sandbox", "allow-scripts allow-same-origin"));
  results.push(await probe(browser, mode, "iframe", "no-csp", ""));
  await browser.close();
}
server.close();

const out = join(root, "pdf-shots", process.argv.includes("--headed-only") ? "results-headed.json" : "results.json");
writeFileSync(out, JSON.stringify(results, null, 2));
for (const r of results) {
  const how = r.how + (r.sandboxAttr === undefined ? "" : ` sandbox="${r.sandboxAttr}"`);
  console.log(`${String(r.mode).padEnd(15)} ${String(how).padEnd(50)} ${String(r.variant ?? "").padEnd(32)} ${r.verdict}${r.error ? ` ${r.error}` : ""}`);
}

// Assertions: what this spike concluded (Chromium 153). Fails loudly if a Chromium update changes behaviour.
const find = (mode, how, variant, sandboxAttr) => results.find((r) => r.mode === mode && r.how === how && r.variant === variant && r.sandboxAttr === sandboxAttr);
for (const r of results.filter((r) => r.mode === "headless-shell" && r.sandboxAttr === undefined)) {
  assert.equal(r.verdict, "download", `headless shell has no PDF viewer: ${JSON.stringify(r)}`);
}
for (const mode of ["new-headless", "headed"]) {
  if (!results.some((r) => r.mode === mode && r.verdict !== "launch-failed")) continue;
  for (const how of ["direct", "iframe"]) {
    assert.equal(find(mode, how, "csp-sandbox")?.verdict, "RENDERED", `${mode} ${how} csp-sandbox`);
  }
  assert.equal(find(mode, "iframe", "csp-sandbox", "allow-scripts allow-same-origin")?.verdict, "blocked", `${mode} sandbox attribute`);
  assert.equal(find(mode, "iframe", "no-csp", "")?.verdict, "blocked", `${mode} sandbox="" attribute`);
}
console.log(`pdf checks passed (${process.argv.includes("--headed-only") ? "headed" : "headless modes"})`);

// If no display was available, run the headed mode once more under xvfb-run.
if (!wantHeaded && !process.env.PDF_NO_XVFB) {
  const r = spawnSync("xvfb-run", ["-a", process.execPath, fileURLToPath(import.meta.url), "--headed-only"], { stdio: "inherit" });
  if (r.error) console.log(`headed mode skipped: xvfb-run unavailable (${r.error.message})`);
  else if (r.status !== 0) process.exit(r.status ?? 1);
}

// Latency probe: draws the current time (Date.now()) as a grid of black/white blocks on a canvas.
// A viewer decodes the blocks from received video frames. Publisher and viewers run on the same machine
// (same clock), so `now - decoded` is the glass-to-glass delay through the SFU.

export const PROBE_WIDTH = 640;
export const PROBE_HEIGHT = 360;
const COLS = 8;
const ROWS = 4; // 32 bits: the low 32 bits of Date.now() (wraps every ~49 days; differences use modulo 2^32)
const MARGIN = 20;
const CELL_W = (PROBE_WIDTH - 2 * MARGIN) / COLS;
const CELL_H = (PROBE_HEIGHT - 2 * MARGIN) / ROWS;

export function drawProbe(ctx: CanvasRenderingContext2D, now = Date.now()): void {
  const value = now >>> 0;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, PROBE_WIDTH, PROBE_HEIGHT);
  for (let bit = 0; bit < 32; bit++) {
    if ((value >>> bit) & 1) {
      ctx.fillStyle = "#000";
      ctx.fillRect(MARGIN + (bit % COLS) * CELL_W, MARGIN + Math.floor(bit / COLS) * CELL_H, CELL_W, CELL_H);
    }
  }
}

/** Decodes a probe from RGBA pixels of a PROBE_WIDTH × PROBE_HEIGHT image. Returns the low 32 bits of the timestamp. */
export function readProbe(pixels: Uint8ClampedArray): number {
  let value = 0;
  for (let bit = 0; bit < 32; bit++) {
    const x0 = Math.round(MARGIN + (bit % COLS) * CELL_W + CELL_W * 0.3);
    const y0 = Math.round(MARGIN + Math.floor(bit / COLS) * CELL_H + CELL_H * 0.3);
    const x1 = Math.round(x0 + CELL_W * 0.4);
    const y1 = Math.round(y0 + CELL_H * 0.4);
    let sum = 0;
    let n = 0;
    for (let y = y0; y < y1; y += 2) {
      for (let x = x0; x < x1; x += 2) {
        const i = (y * PROBE_WIDTH + x) * 4;
        sum += 0.299 * pixels[i]! + 0.587 * pixels[i + 1]! + 0.114 * pixels[i + 2]!;
        n++;
      }
    }
    if (sum / n < 128) value |= 1 << bit;
  }
  return value >>> 0;
}

/** Milliseconds between a decoded probe value and now, handling 32-bit wrap. */
export function probeDelay(decoded: number, now = Date.now()): number {
  return ((now >>> 0) - decoded + 2 ** 32) % 2 ** 32;
}

/** A canvas video track that keeps drawing the probe. */
export function probeTrack(fps = 30): { track: MediaStreamTrack; stop(): void } {
  const canvas = document.createElement("canvas");
  canvas.width = PROBE_WIDTH;
  canvas.height = PROBE_HEIGHT;
  const ctx = canvas.getContext("2d")!;
  drawProbe(ctx);
  const stream = canvas.captureStream(fps);
  const timer = setInterval(() => drawProbe(ctx), 1000 / fps);
  const track = stream.getVideoTracks()[0]!;
  track.contentHint = "detail";
  return {
    track,
    stop() {
      clearInterval(timer);
      track.stop();
    },
  };
}

/** Samples probe delays from a received video track. */
export async function sampleProbe(track: MediaStreamTrack, samples: number, intervalMs = 100): Promise<number[]> {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = new MediaStream([track]);
  await video.play();
  const canvas = document.createElement("canvas");
  canvas.width = PROBE_WIDTH;
  canvas.height = PROBE_HEIGHT;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const delays: number[] = [];
  const deadline = Date.now() + samples * intervalMs * 5 + 10_000;
  while (delays.length < samples && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    if (video.videoWidth === 0) continue;
    ctx.drawImage(video, 0, 0, PROBE_WIDTH, PROBE_HEIGHT);
    const delay = probeDelay(readProbe(ctx.getImageData(0, 0, PROBE_WIDTH, PROBE_HEIGHT).data));
    // Ignore undecodable frames (e.g. keyframe smearing) rather than counting absurd values.
    if (delay < 10_000) delays.push(delay);
  }
  video.srcObject = null;
  return delays;
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

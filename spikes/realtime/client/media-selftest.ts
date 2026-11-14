// Self-test for the media run's measurement code, with no SFU: the probe goes over a local peer connection
// and is decoded on the other side. Proves the latency probe and stats helpers work before spending a real run.
import { PROBE_HEIGHT, PROBE_WIDTH, drawProbe, percentile, probeDelay, probeTrack, readProbe, sampleProbe } from "./probe";

declare global {
  interface Window {
    mediaSelfTest(): Promise<unknown>;
  }
}

window.mediaSelfTest = async () => {
  // 1. Exact round trip through a canvas (no compression).
  const canvas = document.createElement("canvas");
  canvas.width = PROBE_WIDTH;
  canvas.height = PROBE_HEIGHT;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const values = [0, 1, 0xffffffff, 0x80000001, Date.now() >>> 0];
  const roundTrips = values.map((v) => {
    drawProbe(ctx, v);
    return readProbe(ctx.getImageData(0, 0, PROBE_WIDTH, PROBE_HEIGHT).data) === v >>> 0;
  });

  // 2. Through a real (compressed) WebRTC video path on this machine.
  const a = new RTCPeerConnection();
  const b = new RTCPeerConnection();
  a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate);
  b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate);
  const received = new Promise<MediaStreamTrack>((resolve) => (b.ontrack = (e) => resolve(e.track)));
  const probe = probeTrack(30);
  a.addTransceiver(probe.track, { direction: "sendonly" });
  await a.setLocalDescription(await a.createOffer());
  await b.setRemoteDescription(a.localDescription!);
  await b.setLocalDescription(await b.createAnswer());
  await a.setRemoteDescription(b.localDescription!);
  const track = await received;
  await new Promise((r) => setTimeout(r, 1000));
  const delays = await sampleProbe(track, 50, 50);
  probe.stop();

  return {
    exactRoundTrips: roundTrips,
    wrapHandled: probeDelay(0xfffffff0, 0x10) === 0x20,
    loopback: { samples: delays.length, p50: percentile(delays, 50), p95: percentile(delays, 95), max: Math.max(...delays) },
  };
};

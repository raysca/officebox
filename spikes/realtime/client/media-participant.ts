// A scripted huddle participant for the real-media run (scripts/media-run.mjs).
// Runs in a browser page served by the spike Worker (same origin, so cookies and the Origin check work)
// and drives the real huddle routes, which talk to the Cloudflare Realtime SFU.
import { probeTrack, sampleProbe, percentile } from "./probe";
import { startScreenShare, type ScreenConstraints, type ShareHandle } from "./screen-share";

type Json = Record<string, any>;

export interface InboundStats {
  kind: string;
  packetsReceived: number;
  bytesReceived: number;
  framesDecoded: number;
  frameWidth: number;
  frameHeight: number;
}

export interface LayerStats {
  rid: string;
  frameWidth: number;
  framesEncoded: number;
  bytesSent: number;
  active: boolean;
  qualityLimitationReason: string;
}

class Participant {
  ws!: WebSocket;
  pc!: RTCPeerConnection;
  connId = "";
  welcome: Json = {};
  events: Json[] = [];
  private waiters: Array<() => void> = [];
  private chain: Promise<unknown> = Promise.resolve();
  private remoteTracks = new Map<string, MediaStreamTrack>();
  private share: ShareHandle | null = null;
  private probe: { track: MediaStreamTrack; stop(): void; mid: string } | null = null;

  async login(userId: string): Promise<void> {
    const res = await fetch("/dev/login", { method: "POST", body: JSON.stringify({ userId }) });
    if (!res.ok) throw new Error(`login failed: ${res.status}`);
  }

  private async api(path: string, body?: unknown): Promise<Json> {
    const res = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      headers: { "X-Officebox-Request": "1", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${path}: ${res.status} ${text}`);
    return text ? JSON.parse(text) : {};
  }

  /** Serialises SDP negotiations on the single peer connection. */
  private negotiate<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  async join(huddleId: string, opts: { relayOnly?: boolean } = {}): Promise<{ connId: string; turn: boolean }> {
    const { iceServers } = await this.api(`/huddles/${huddleId}/ice-servers`);
    const turn = (iceServers as Array<{ urls: string[] }>).some((s) => s.urls.some((u) => u.startsWith("turn")));
    this.pc = new RTCPeerConnection({ iceServers, bundlePolicy: "max-bundle", iceTransportPolicy: opts.relayOnly ? "relay" : "all" });
    this.pc.ontrack = (e) => this.remoteTracks.set(e.transceiver.mid!, e.track);
    this.ws = new WebSocket(`${location.origin.replace(/^http/, "ws")}/ws/huddles/${huddleId}`);
    this.ws.onmessage = (e) => {
      this.events.push(JSON.parse(e.data));
      for (const w of this.waiters.splice(0)) w();
    };
    this.welcome = await this.next((m) => m.type === "welcome", 10_000);
    this.connId = this.welcome.connId;
    return { connId: this.connId, turn };
  }

  async next(predicate: (m: Json) => boolean, timeoutMs = 5000): Promise<Json> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const i = this.events.findIndex(predicate);
      if (i >= 0) return this.events.splice(i, 1)[0]!;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timed out waiting; events: ${JSON.stringify(this.events.map((e) => e.type))}`);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, left);
        this.waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }

  send(message: Json): void {
    this.ws.send(JSON.stringify(message));
  }

  private async publish(track: MediaStreamTrack, kind: string, sendEncodings?: RTCRtpEncodingParameters[]): Promise<string> {
    return this.negotiate(async () => {
      const transceiver = this.pc.addTransceiver(track, { direction: "sendonly", ...(sendEncodings ? { sendEncodings } : {}) });
      await this.pc.setLocalDescription(await this.pc.createOffer());
      const res = await this.api(`/huddles/${this.welcome.huddleId}/tracks/publish`, {
        connId: this.connId,
        sessionDescription: this.pc.localDescription,
        tracks: [{ mid: transceiver.mid, kind }],
      });
      await this.pc.setRemoteDescription(res.sessionDescription);
      return transceiver.mid!;
    });
  }

  async publishMic(): Promise<string> {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    return this.publish(stream.getAudioTracks()[0]!, "audio");
  }

  async requestShare(): Promise<ScreenConstraints> {
    this.send({ type: "screen.start" });
    return (await this.next((m) => m.type === "screen.granted")).constraints;
  }

  /** Real getDisplayMedia capture with simulcast (fake capture source in headless Chromium). Returns Date.now() at start. */
  async startShare(constraints: ScreenConstraints): Promise<{ startedAt: number; mids: string[] }> {
    const startedAt = Date.now();
    this.share = await this.negotiate(() =>
      startScreenShare({
        pc: this.pc,
        constraints,
        mode: "detail",
        signaller: {
          publish: async (offer, tracks) =>
            (await this.api(`/huddles/${this.welcome.huddleId}/tracks/publish`, { connId: this.connId, sessionDescription: offer, tracks })).sessionDescription,
          close: async (mids) => {
            await this.api(`/huddles/${this.welcome.huddleId}/tracks/close`, { connId: this.connId, mids });
          },
          send: (m) => this.send(m),
        },
      }),
    );
    return { startedAt, mids: this.share.mids };
  }

  async stopShare(): Promise<void> {
    await this.share?.stop("user");
    this.share = null;
    if (this.probe) {
      this.probe.stop();
      await this.api(`/huddles/${this.welcome.huddleId}/tracks/close`, { connId: this.connId, mids: [this.probe.mid] });
      this.send({ type: "screen.stopped" });
      this.probe = null;
    }
  }

  /** Publishes the timestamp probe as the screen track (after a grant). */
  async startProbe(): Promise<string> {
    const probe = probeTrack(30);
    const mid = await this.publish(probe.track, "screen");
    this.probe = { ...probe, mid };
    return mid;
  }

  /** Pulls a track through the SFU: its offer is answered via renegotiate. Returns the receiving mid. */
  async subscribe(publisherConnId: string, kind: string, preferredRid?: string): Promise<string> {
    return this.negotiate(async () => {
      const res = await this.api(`/huddles/${this.welcome.huddleId}/tracks/subscribe`, {
        connId: this.connId,
        tracks: [{ connId: publisherConnId, kind, preferredRid }],
      });
      const track = res.tracks?.[0];
      if (!track || track.errorCode) throw new Error(`subscribe failed: ${JSON.stringify(res.tracks)}`);
      await this.pc.setRemoteDescription(res.sessionDescription);
      await this.pc.setLocalDescription(await this.pc.createAnswer());
      await this.api(`/huddles/${this.welcome.huddleId}/renegotiate`, { connId: this.connId, sessionDescription: this.pc.localDescription });
      return track.mid as string;
    });
  }

  async setLayer(mid: string, preferredRid: string): Promise<void> {
    await this.api(`/huddles/${this.welcome.huddleId}/tracks/layer`, { connId: this.connId, mid, preferredRid });
  }

  async inbound(mid: string): Promise<InboundStats | null> {
    let found: InboundStats | null = null;
    (await this.pc.getStats()).forEach((s: any) => {
      if (s.type === "inbound-rtp" && s.mid === mid) {
        found = {
          kind: s.kind,
          packetsReceived: s.packetsReceived ?? 0,
          bytesReceived: s.bytesReceived ?? 0,
          framesDecoded: s.framesDecoded ?? 0,
          frameWidth: s.frameWidth ?? 0,
          frameHeight: s.frameHeight ?? 0,
        };
      }
    });
    return found;
  }

  /** Waits until media arrives on a receiving mid. Returns Date.now() when it did. */
  async waitForMedia(mid: string, timeoutMs = 15_000): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const s = await this.inbound(mid);
      if (s && (s.kind === "audio" ? s.packetsReceived > 0 : s.framesDecoded > 0)) return Date.now();
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`no media on mid ${mid} within ${timeoutMs} ms: ${JSON.stringify(await this.inbound(mid))}`);
  }

  async outboundLayers(): Promise<LayerStats[]> {
    const layers: LayerStats[] = [];
    (await this.pc.getStats()).forEach((s: any) => {
      if (s.type === "outbound-rtp" && s.kind === "video" && s.rid) {
        layers.push({
          rid: s.rid,
          frameWidth: s.frameWidth ?? 0,
          framesEncoded: s.framesEncoded ?? 0,
          bytesSent: s.bytesSent ?? 0,
          active: s.active ?? true,
          qualityLimitationReason: s.qualityLimitationReason ?? "",
        });
      }
    });
    return layers.sort((a, b) => a.rid.localeCompare(b.rid));
  }

  /** The local candidate type of the selected pair: "host", "srflx" or "relay". */
  async candidateType(): Promise<string | null> {
    const stats = await this.pc.getStats();
    let pairId: string | null = null;
    stats.forEach((s: any) => s.type === "transport" && s.selectedCandidatePairId && (pairId = s.selectedCandidatePairId));
    if (!pairId) return null;
    const pair: any = stats.get(pairId);
    return (stats.get(pair?.localCandidateId) as any)?.candidateType ?? null;
  }

  async probeDelays(mid: string, samples = 100): Promise<{ count: number; p50: number; p95: number; max: number }> {
    const track = this.remoteTracks.get(mid);
    if (!track) throw new Error(`no remote track for mid ${mid}`);
    const delays = await sampleProbe(track, samples, 100);
    return { count: delays.length, p50: percentile(delays, 50), p95: percentile(delays, 95), max: Math.max(...delays) };
  }
}

declare global {
  interface Window {
    participant: Participant;
  }
}

window.participant = new Participant();

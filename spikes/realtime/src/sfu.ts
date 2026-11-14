// Cloudflare Realtime SFU client (TDD §3.6). Shapes follow the Realtime SFU HTTPS API:
//   base https://rtc.live.cloudflare.com/v1, Authorization: Bearer <app secret>, appId in the path.
// SFU_MODE=fake swaps in an in-account Durable Object fake so the huddle logic can be tested without credentials.
import type { Env } from "./env";

export interface SessionDescription {
  type: "offer" | "answer";
  sdp: string;
}

export interface SimulcastPreference {
  preferredRid: string;
  priorityOrdering?: "none" | "asciibetical";
  ridNotAvailable?: "none" | "asciibetical";
}

export interface LocalTrack {
  location: "local";
  mid: string;
  trackName: string;
}

export interface RemoteTrack {
  location: "remote";
  sessionId: string;
  trackName: string;
  simulcast?: SimulcastPreference;
}

export interface TrackResult {
  location?: "local" | "remote";
  mid?: string;
  trackName?: string;
  sessionId?: string;
  errorCode?: string;
  errorDescription?: string;
}

export interface TracksResponse {
  sessionDescription?: SessionDescription;
  tracks?: TrackResult[];
  requiresImmediateRenegotiation?: boolean;
  errorCode?: string;
  errorDescription?: string;
}

export interface SfuClient {
  newSession(): Promise<string>;
  addTracks(sessionId: string, body: { sessionDescription?: SessionDescription; tracks: Array<LocalTrack | RemoteTrack> }): Promise<TracksResponse>;
  renegotiate(sessionId: string, sessionDescription: SessionDescription): Promise<void>;
  closeTracks(sessionId: string, mids: string[], opts: { force: boolean; sessionDescription?: SessionDescription }): Promise<TracksResponse>;
  updateTracks(sessionId: string, tracks: Array<{ location: "remote"; mid: string; simulcast: SimulcastPreference }>): Promise<TracksResponse>;
}

export class SfuError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly errorCode?: string,
  ) {
    super(message);
  }
}

export const SFU_BASE = "https://rtc.live.cloudflare.com/v1";

export class CloudflareSfu implements SfuClient {
  constructor(
    private readonly appId: string,
    private readonly appSecret: string,
    private readonly fetcher: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  private async call<T>(method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<T> {
    const res = await this.fetcher(`${SFU_BASE}/apps/${this.appId}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.appSecret}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    type WithError = T & { errorCode?: string; errorDescription?: string };
    const json: WithError = text ? (JSON.parse(text) as WithError) : ({} as WithError);
    if (!res.ok) throw new SfuError(`SFU ${method} ${path} failed: ${res.status} ${text}`, res.status, json.errorCode);
    // A 2xx can still carry a top-level error.
    if (json.errorCode) throw new SfuError(`SFU ${path}: ${json.errorCode} ${json.errorDescription ?? ""}`, res.status, json.errorCode);
    return json;
  }

  async newSession(): Promise<string> {
    const res = await this.call<{ sessionId: string }>("POST", "/sessions/new");
    return res.sessionId;
  }

  addTracks(sessionId: string, body: { sessionDescription?: SessionDescription; tracks: Array<LocalTrack | RemoteTrack> }) {
    return this.call<TracksResponse>("POST", `/sessions/${sessionId}/tracks/new`, body);
  }

  async renegotiate(sessionId: string, sessionDescription: SessionDescription): Promise<void> {
    await this.call("PUT", `/sessions/${sessionId}/renegotiate`, { sessionDescription });
  }

  closeTracks(sessionId: string, mids: string[], opts: { force: boolean; sessionDescription?: SessionDescription }) {
    return this.call<TracksResponse>("PUT", `/sessions/${sessionId}/tracks/close`, {
      tracks: mids.map((mid) => ({ mid })),
      force: opts.force,
      ...(opts.sessionDescription ? { sessionDescription: opts.sessionDescription } : {}),
    });
  }

  updateTracks(sessionId: string, tracks: Array<{ location: "remote"; mid: string; simulcast: SimulcastPreference }>) {
    return this.call<TracksResponse>("PUT", `/sessions/${sessionId}/tracks/update`, { tracks });
  }
}

/** Fake SFU backed by a Durable Object, so Worker and HuddleRoom share one view of sessions and tracks. */
class FakeSfuClient implements SfuClient {
  constructor(private readonly env: Env) {}
  private get stub() {
    return this.env.FAKE_SFU.get(this.env.FAKE_SFU.idFromName("sfu"));
  }
  newSession() {
    return this.stub.newSession();
  }
  addTracks(sessionId: string, body: { sessionDescription?: SessionDescription; tracks: Array<LocalTrack | RemoteTrack> }) {
    return this.stub.addTracks(sessionId, body);
  }
  renegotiate(sessionId: string, sessionDescription: SessionDescription) {
    return this.stub.renegotiate(sessionId, sessionDescription);
  }
  closeTracks(sessionId: string, mids: string[], opts: { force: boolean; sessionDescription?: SessionDescription }) {
    return this.stub.closeTracks(sessionId, mids, opts);
  }
  updateTracks(sessionId: string, tracks: Array<{ location: "remote"; mid: string; simulcast: SimulcastPreference }>) {
    return this.stub.updateTracks(sessionId, tracks);
  }
}

export function sfuFor(env: Env): SfuClient {
  if (env.SFU_MODE === "fake") return new FakeSfuClient(env);
  if (!env.REALTIME_APP_ID || !env.REALTIME_APP_SECRET) {
    throw new SfuError("Realtime SFU is not configured (REALTIME_APP_ID / REALTIME_APP_SECRET)", 503);
  }
  return new CloudflareSfu(env.REALTIME_APP_ID, env.REALTIME_APP_SECRET);
}

export const STUN_ONLY: RTCIceServerLike[] = [{ urls: ["stun:stun.cloudflare.com:3478"] }];

export interface RTCIceServerLike {
  urls: string[];
  username?: string;
  credential?: string;
}

/** Short-lived TURN credentials (TDD §3.6). Port 53 URLs are dropped because browsers block them. */
export async function iceServers(env: Env, ttlSeconds = 4 * 60 * 60, fetcher: typeof fetch = (i, init) => fetch(i, init)): Promise<RTCIceServerLike[]> {
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) return STUN_ONLY;
  const res = await fetcher(`${SFU_BASE}/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ttl: ttlSeconds }),
  });
  if (!res.ok) throw new SfuError(`TURN credentials failed: ${res.status}`, res.status);
  const { iceServers: servers } = (await res.json()) as { iceServers: RTCIceServerLike[] };
  return servers.map((s) => ({ ...s, urls: s.urls.filter((u) => !/:53(\?|$)/.test(u)) })).filter((s) => s.urls.length > 0);
}

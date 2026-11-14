// Browser side of screen sharing (PRD §5.8, TDD §3.6): capture, encoding hints, simulcast, publish/stop.
// Signalling is injected so the same code runs against the Worker routes or a test loopback.

export interface ScreenConstraints {
  width: number;
  height: number;
  detailFrameRate: number;
  motionFrameRate: number;
}

export type ShareMode = "detail" | "motion";

/** Simulcast layers as recommended by the Realtime SFU docs: full, half and quarter resolution. */
export const SIMULCAST_LAYERS: RTCRtpEncodingParameters[] = [
  { rid: "f", scaleResolutionDownBy: 1, maxBitrate: 2_500_000 },
  { rid: "h", scaleResolutionDownBy: 2, maxBitrate: 800_000 },
  { rid: "q", scaleResolutionDownBy: 4, maxBitrate: 250_000 },
];

export function displayMediaOptions(c: ScreenConstraints, mode: ShareMode): DisplayMediaStreamOptions {
  return {
    video: {
      width: { max: c.width },
      height: { max: c.height },
      frameRate: { max: mode === "detail" ? c.detailFrameRate : c.motionFrameRate },
    },
    // Tab audio where the browser supports it; full system audio is not promised.
    audio: true,
    selfBrowserSurface: "exclude",
    surfaceSwitching: "include",
    systemAudio: "exclude",
  } as DisplayMediaStreamOptions;
}

/** Picks the simulcast layer for a viewer: the smallest layer that still fills the viewport. */
export function layerForViewport(viewportWidth: number, sourceWidth: number): "f" | "h" | "q" {
  if (viewportWidth >= sourceWidth * 0.75) return "f";
  if (viewportWidth >= sourceWidth * 0.375) return "h";
  return "q";
}

export function screenShareSupported(nav: Navigator = navigator): boolean {
  return typeof nav.mediaDevices?.getDisplayMedia === "function";
}

export interface Signaller {
  /** Sends an SDP offer for new local tracks; returns the SFU's answer. */
  publish(offer: RTCSessionDescriptionInit, tracks: Array<{ mid: string; kind: "screen" | "screen-audio" }>): Promise<RTCSessionDescriptionInit>;
  /** Closes local tracks at the SFU. */
  close(mids: string[]): Promise<void>;
  /** Huddle WebSocket message (screen.start / screen.stopped). */
  send(message: { type: string }): void;
}

export interface ShareHandle {
  stream: MediaStream;
  mids: string[];
  stop(reason?: string): Promise<void>;
}

/**
 * Starts sharing after the HuddleRoom granted the presenter slot.
 * Publishes the screen (and tab audio, if granted) on the participant's existing peer connection.
 */
export async function startScreenShare(opts: {
  pc: RTCPeerConnection;
  constraints: ScreenConstraints;
  mode?: ShareMode;
  signaller: Signaller;
  getDisplayMedia?: (o: DisplayMediaStreamOptions) => Promise<MediaStream>;
  simulcast?: boolean;
  onStopped?: (reason: string) => void;
}): Promise<ShareHandle> {
  const mode = opts.mode ?? "detail";
  const capture = opts.getDisplayMedia ?? ((o) => navigator.mediaDevices.getDisplayMedia(o));
  const stream = await capture(displayMediaOptions(opts.constraints, mode));
  const video = stream.getVideoTracks()[0];
  if (!video) throw new Error("no video track captured");
  video.contentHint = mode === "detail" ? "detail" : "motion";

  const videoTransceiver = opts.pc.addTransceiver(video, {
    direction: "sendonly",
    streams: [stream],
    ...(opts.simulcast === false ? {} : { sendEncodings: SIMULCAST_LAYERS }),
  });
  const audio = stream.getAudioTracks()[0];
  const audioTransceiver = audio ? opts.pc.addTransceiver(audio, { direction: "sendonly", streams: [stream] }) : null;

  const offer = await opts.pc.createOffer();
  await opts.pc.setLocalDescription(offer);
  const tracks: Array<{ mid: string; kind: "screen" | "screen-audio" }> = [{ mid: videoTransceiver.mid!, kind: "screen" }];
  if (audioTransceiver) tracks.push({ mid: audioTransceiver.mid!, kind: "screen-audio" });
  const answer = await opts.signaller.publish(opts.pc.localDescription!, tracks);
  await opts.pc.setRemoteDescription(answer);

  let stopped = false;
  const handle: ShareHandle = {
    stream,
    mids: tracks.map((t) => t.mid),
    async stop(reason = "user") {
      if (stopped) return;
      stopped = true;
      for (const track of stream.getTracks()) track.stop();
      videoTransceiver.stop();
      audioTransceiver?.stop();
      await opts.signaller.close(handle.mids);
      opts.signaller.send({ type: "screen.stopped" });
      opts.onStopped?.(reason);
    },
  };
  // The browser's own "Stop sharing" button ends the track: release the presenter slot.
  video.addEventListener("ended", () => void handle.stop("browser"));
  return handle;
}

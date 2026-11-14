// Browser test harness: runs startScreenShare against an in-page loopback peer that plays the SFU's role.
import { SIMULCAST_LAYERS, displayMediaOptions, layerForViewport, screenShareSupported, startScreenShare } from "./screen-share";

declare global {
  interface Window {
    runHarness(): Promise<unknown>;
  }
}

window.runHarness = async () => {
  const constraints = { width: 1280, height: 720, detailFrameRate: 15, motionFrameRate: 30 };
  const publisher = new RTCPeerConnection();
  const sfuPeer = new RTCPeerConnection();
  publisher.onicecandidate = (e) => e.candidate && sfuPeer.addIceCandidate(e.candidate);
  sfuPeer.onicecandidate = (e) => e.candidate && publisher.addIceCandidate(e.candidate);
  const received = new Promise<MediaStreamTrack>((resolve) => (sfuPeer.ontrack = (e) => e.track.kind === "video" && resolve(e.track)));

  const log: Array<{ type: string; detail?: unknown }> = [];
  let offerSdp = "";
  let encodingsBeforeAnswer: Array<string | undefined> = [];
  const handle = await startScreenShare({
    pc: publisher,
    constraints,
    mode: "detail",
    signaller: {
      async publish(offer, tracks) {
        offerSdp = offer.sdp ?? "";
        const videoSender = publisher.getSenders().find((s) => s.track?.kind === "video");
        encodingsBeforeAnswer = videoSender ? videoSender.getParameters().encodings.map((e) => e.rid) : [];
        log.push({ type: "publish", detail: tracks });
        await sfuPeer.setRemoteDescription(offer);
        const answer = await sfuPeer.createAnswer();
        await sfuPeer.setLocalDescription(answer);
        return answer;
      },
      async close(mids) {
        log.push({ type: "close", detail: mids });
      },
      send(message) {
        log.push({ type: "ws", detail: message });
      },
    },
  });

  const remoteTrack = await received;
  await new Promise((r) => setTimeout(r, 1500)); // let frames flow
  const settings = handle.stream.getVideoTracks()[0]!.getSettings();
  const contentHint = handle.stream.getVideoTracks()[0]!.contentHint;
  let framesEncoded = 0;
  let framesDecoded = 0;
  (await publisher.getStats()).forEach((s: any) => s.type === "outbound-rtp" && s.kind === "video" && (framesEncoded += s.framesEncoded ?? 0));
  (await sfuPeer.getStats()).forEach((s: any) => s.type === "inbound-rtp" && s.kind === "video" && (framesDecoded += s.framesDecoded ?? 0));
  const sender = publisher.getSenders().find((s) => s.track?.kind === "video")!;
  const encodings = sender.getParameters().encodings.map((e) => e.rid);
  const connection = publisher.connectionState;

  // Simulate the browser's "Stop sharing" button.
  handle.stream.getVideoTracks()[0]!.stop();
  handle.stream.getVideoTracks()[0]!.dispatchEvent(new Event("ended"));
  await new Promise((r) => setTimeout(r, 100));

  return {
    supported: screenShareSupported(),
    options: displayMediaOptions(constraints, "detail"),
    settings: { width: settings.width, height: settings.height, frameRate: settings.frameRate },
    contentHint,
    simulcastInOffer: /a=simulcast:send f;h;q/.test(offerSdp),
    ridsInOffer: ["f", "h", "q"].filter((rid) => new RegExp(`a=rid:${rid} send`).test(offerSdp)),
    encodingsBeforeAnswer,
    // A plain browser peer can't receive simulcast, so after its answer the sender keeps one layer.
    // The Realtime SFU accepts all three; that negotiation needs the real SFU to verify.
    encodingsAfterLoopbackAnswer: encodings,
    expectedEncodings: SIMULCAST_LAYERS.map((l) => l.rid),
    connection,
    remoteTrackKind: remoteTrack.kind,
    framesEncoded,
    framesDecoded,
    layers: [layerForViewport(1280, 1280), layerForViewport(700, 1280), layerForViewport(300, 1280)],
    log,
  };
};

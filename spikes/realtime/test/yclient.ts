// Minimal Yjs client speaking the standard y-websocket protocol (the same y-protocols code y-websocket uses).
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as authProtocol from "y-protocols/auth";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { login, upgrade } from "./helpers";

export class YClient {
  readonly doc = new Y.Doc();
  readonly awareness = new awarenessProtocol.Awareness(this.doc);
  synced = false;
  denied: string[] = [];
  closed: { code: number; reason: string } | null = null;

  constructor(readonly ws: WebSocket) {
    ws.accept();
    ws.binaryType = "arraybuffer";
    // The Awareness class starts a timer; tests stop it on close.
    ws.addEventListener("message", (ev) => this.onMessage(new Uint8Array(ev.data as ArrayBuffer)));
    ws.addEventListener("close", (ev) => (this.closed = { code: ev.code, reason: ev.reason }));
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === this) return;
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, 0);
      syncProtocol.writeUpdate(e, update);
      this.send(e);
    });
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, 0);
    syncProtocol.writeSyncStep1(e, this.doc);
    this.send(e);
  }

  static async connect(docId: string, user: string): Promise<YClient> {
    const res = await upgrade(`/ws/docs/${docId}`, { cookie: await login(user) });
    if (res.status !== 101 || !res.webSocket) throw new Error(`upgrade failed: ${res.status}`);
    const client = new YClient(res.webSocket);
    await client.until(() => client.synced);
    return client;
  }

  get text(): string {
    return this.doc.getText("body").toString();
  }

  setCursor(name: string): void {
    this.awareness.setLocalStateField("user", { name });
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, 1);
    encoding.writeVarUint8Array(e, awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID]));
    this.send(e);
  }

  private send(e: encoding.Encoder): void {
    try {
      this.ws.send(encoding.toUint8Array(e));
    } catch {
      // Closed.
    }
  }

  private onMessage(data: Uint8Array): void {
    const decoder = decoding.createDecoder(data);
    const type = decoding.readVarUint(decoder);
    if (type === 0) {
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, 0);
      const syncType = syncProtocol.readSyncMessage(decoder, e, this.doc, this);
      if (syncType === syncProtocol.messageYjsSyncStep2) this.synced = true;
      if (encoding.length(e) > 1) this.send(e);
    } else if (type === 1) {
      awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), this);
    } else if (type === 2) {
      authProtocol.readAuthMessage(decoder, this.doc, (_doc, reason) => this.denied.push(reason));
    }
  }

  async until(condition: () => boolean, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error(`condition not met; text=${JSON.stringify(this.text)}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  close(): void {
    this.awareness.destroy();
    try {
      this.ws.close(1000, "done");
    } catch {
      // Already closed.
    }
  }
}

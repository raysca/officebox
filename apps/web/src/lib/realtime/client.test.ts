import { MAX_SOCKETS_PER_TAB, WS_CLOSE_ACCESS_REMOVED, WS_CLOSE_SESSION_REVOKED } from "@officebox/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RealtimeClient, type BroadcastChannelLike, type SocketLike } from "./client";

class MockSocket implements SocketLike {
  readonly url: string;
  readyState = 0;
  readonly sent: string[] = [];
  closedWith: { code?: number; reason?: string } | null = null;
  private readonly listeners = {
    open: new Set<(e: { data?: unknown; code?: number; reason?: string }) => void>(),
    message: new Set<(e: { data?: unknown; code?: number; reason?: string }) => void>(),
    close: new Set<(e: { data?: unknown; code?: number; reason?: string }) => void>(),
    error: new Set<(e: { data?: unknown; code?: number; reason?: string }) => void>(),
  };

  constructor(url: string) {
    this.url = url;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closedWith = { code, reason };
  }

  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: { data?: unknown; code?: number; reason?: string }) => void,
  ): void {
    this.listeners[type].add(listener);
  }

  serverOpen(): void {
    this.readyState = 1;
    for (const fn of this.listeners.open) fn({});
  }

  serverMessage(data: unknown): void {
    const payload = typeof data === "string" ? data : JSON.stringify(data);
    for (const fn of this.listeners.message) fn({ data: payload });
  }

  serverClose(code: number, reason = ""): void {
    this.readyState = 3;
    this.closedWith = { code, reason };
    for (const fn of this.listeners.close) fn({ code, reason });
  }
}

class MockBroadcastBus {
  private readonly channels = new Map<string, Set<MockBroadcastChannel>>();

  create = (name: string): BroadcastChannelLike => {
    let group = this.channels.get(name);
    if (!group) {
      group = new Set();
      this.channels.set(name, group);
    }
    const ch = new MockBroadcastChannel(group);
    group.add(ch);
    return ch;
  };
}

class MockBroadcastChannel implements BroadcastChannelLike {
  private readonly listeners = new Set<(event: { data: unknown }) => void>();
  private closed = false;

  constructor(private readonly group: Set<MockBroadcastChannel>) {}

  postMessage(message: unknown): void {
    if (this.closed) return;
    const cloned = JSON.parse(JSON.stringify(message)) as unknown;
    for (const peer of [...this.group]) {
      if (peer === this || peer.closed) continue;
      for (const fn of peer.listeners) {
        fn({ data: cloned });
      }
    }
  }

  close(): void {
    this.closed = true;
    this.group.delete(this);
    this.listeners.clear();
  }

  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void {
    if (type === "message") {
      this.listeners.add(listener);
    }
  }
}

const USER_1 = "01J00000000000000000000001";
const USER_2 = "01J00000000000000000000002";
const CONN_1 = "01J00000000000000000000099";

describe("RealtimeClient (M2a)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("elects a single BroadcastChannel leader across two tabs and relays hub state to the follower", () => {
    const bus = new MockBroadcastBus();
    const hubSockets: MockSocket[] = [];
    let clock = 1_700_000_000_000;

    const tabA = new RealtimeClient({
      userId: USER_1,
      tabId: "tab-a",
      now: () => clock,
      createBroadcastChannel: bus.create,
      createWebSocket: (url) => {
        const ws = new MockSocket(url);
        hubSockets.push(ws);
        return ws;
      },
      electionDelayMs: 50,
      leaderHeartbeatMs: 500,
      leaderLeaseMs: 1500,
    });

    const tabB = new RealtimeClient({
      userId: USER_1,
      tabId: "tab-b",
      now: () => clock,
      createBroadcastChannel: bus.create,
      createWebSocket: (url) => {
        const ws = new MockSocket(url);
        hubSockets.push(ws);
        return ws;
      },
      electionDelayMs: 50,
      leaderHeartbeatMs: 500,
      leaderLeaseMs: 1500,
    });

    tabA.start();
    tabB.start();

    clock += 60;
    vi.advanceTimersByTime(60);

    // Only one physical `/api/ws/hub` WebSocket is opened, by `tab-a` (lowest lexical tabId).
    expect(hubSockets).toHaveLength(1);
    expect(tabA.getSnapshot().isLeader).toBe(true);
    expect(tabB.getSnapshot().isLeader).toBe(false);

    const ws = hubSockets[0]!;
    ws.serverOpen();
    ws.serverMessage({
      type: "hub.welcome",
      userId: USER_1,
      sessionId: "sess-1",
      connectionId: CONN_1,
      presence: "online",
      availability: {
        state: "online",
        label: "Online",
        until: null,
        source: "presence",
      },
      online: [
        {
          userId: USER_1,
          state: "online",
          lastSeenAt: clock,
          statusText: null,
        },
      ],
    });

    // Both leader and follower tabs receive the welcome state.
    expect(tabA.getSnapshot().connected).toBe(true);
    expect(tabA.getSnapshot().myPresence).toBe("online");
    expect(tabB.getSnapshot().myPresence).toBe("online");
    expect(tabB.getSnapshot().online.has(USER_1)).toBe(true);

    // Presence change on another member relays to the follower tab.
    ws.serverMessage({
      type: "presence.changed",
      userId: USER_2,
      state: "idle",
      lastSeenAt: clock,
      statusText: "In a review",
    });
    expect(tabA.getSnapshot().online.get(USER_2)?.state).toBe("idle");
    expect(tabB.getSnapshot().online.get(USER_2)?.state).toBe("idle");

    // Follower reports input after 30 s throttle; leader aggregates and sends `tab.state` over the single hub socket.
    clock += 35_000;
    tabA.reportTabState(false, clock - 10_000);
    tabB.reportTabState(true, clock);

    const lastSent = JSON.parse(ws.sent[ws.sent.length - 1]!) as {
      type: string;
      visible: boolean;
      lastInputAt: number;
    };
    expect(lastSent).toEqual({
      type: "tab.state",
      visible: true,
      lastInputAt: clock,
    });

    // Periodic follower heartbeats while idle do NOT send extra `tab.state` frames (allows DO hibernation).
    const sentCountBeforeIdle = ws.sent.length;
    for (let i = 0; i < 10; i++) {
      clock += 500;
      vi.advanceTimersByTime(500);
    }
    expect(ws.sent.length).toBe(sentCountBeforeIdle);

    tabA.stop();
    tabB.stop();
  });

  it("hands leadership over to the remaining tab when the leading tab closes", () => {
    const bus = new MockBroadcastBus();
    const openedByTab: { tabId: string; ws: MockSocket }[] = [];
    let clock = 1_700_000_000_000;

    const makeClient = (tabId: string) =>
      new RealtimeClient({
        userId: USER_1,
        tabId,
        now: () => clock,
        createBroadcastChannel: bus.create,
        createWebSocket: (url) => {
          const ws = new MockSocket(url);
          openedByTab.push({ tabId, ws });
          return ws;
        },
        electionDelayMs: 40,
        leaderHeartbeatMs: 400,
        leaderLeaseMs: 1200,
      });

    const tabA = makeClient("tab-a");
    const tabB = makeClient("tab-b");
    tabA.start();
    tabB.start();

    clock += 50;
    vi.advanceTimersByTime(50);
    expect(openedByTab).toHaveLength(1);
    expect(openedByTab[0]!.tabId).toBe("tab-a");
    openedByTab[0]!.ws.serverOpen();

    // Closing tabA broadcasts `leader.resign`; tabB claims leadership and opens the hub socket.
    tabA.stop();
    clock += 50;
    vi.advanceTimersByTime(50);

    expect(openedByTab).toHaveLength(2);
    expect(openedByTab[1]!.tabId).toBe("tab-b");
    expect(tabB.getSnapshot().isLeader).toBe(true);

    tabB.stop();
  });

  it("enforces the 6-socket per-tab cap and evicts the LRU embedded board first", () => {
    const sockets: MockSocket[] = [];
    let clock = 1_700_000_000_000;

    const client = new RealtimeClient({
      userId: USER_1,
      tabId: "tab-solo",
      now: () => clock,
      createBroadcastChannel: () => null,
      createWebSocket: (url) => {
        const ws = new MockSocket(url);
        sockets.push(ws);
        return ws;
      },
    });

    client.start();
    // 1 socket is used by the hub (`/api/ws/hub`).
    expect(client.getSnapshot().openSocketCount).toBe(1);

    // Open 3 channels and 2 embedded boards → total 6 sockets (at MAX_SOCKETS_PER_TAB).
    clock += 100;
    const ch1 = client.openRoom({ kind: "channel", roomId: "01J00000000000000000000101" });
    clock += 100;
    const boardOldest = client.openRoom({
      kind: "board",
      roomId: "01J00000000000000000000201",
      embedded: true,
    });
    clock += 100;
    const boardNewer = client.openRoom({
      kind: "board",
      roomId: "01J00000000000000000000202",
      embedded: true,
    });
    clock += 100;
    const ch2 = client.openRoom({ kind: "channel", roomId: "01J00000000000000000000102" });
    clock += 100;
    const doc1 = client.openRoom({ kind: "doc", roomId: "01J00000000000000000000301" });

    expect(ch1).not.toBeNull();
    expect(boardOldest).not.toBeNull();
    expect(boardNewer).not.toBeNull();
    expect(ch2).not.toBeNull();
    expect(doc1).not.toBeNull();
    expect(client.getSnapshot().openSocketCount).toBe(MAX_SOCKETS_PER_TAB);

    // Opening a 7th socket evicts `boardOldest` (least-recently-used embedded board).
    clock += 100;
    const ch3 = client.openRoom({ kind: "channel", roomId: "01J00000000000000000000103" });
    expect(ch3).not.toBeNull();
    expect(client.getSnapshot().openSocketCount).toBe(MAX_SOCKETS_PER_TAB);
    // Socket index 2 was `boardOldest`.
    expect(sockets[2]!.closedWith?.code).toBe(1000);

    // Opening another socket evicts `boardNewer` (the remaining embedded board).
    clock += 100;
    const ch4 = client.openRoom({ kind: "channel", roomId: "01J00000000000000000000104" });
    expect(ch4).not.toBeNull();
    expect(client.getSnapshot().openSocketCount).toBe(MAX_SOCKETS_PER_TAB);
    expect(sockets[3]!.closedWith?.code).toBe(1000);

    // Now all 5 room sockets are non-embedded; opening another socket is refused (`null`).
    clock += 100;
    const refused = client.openRoom({ kind: "channel", roomId: "01J00000000000000000000105" });
    expect(refused).toBeNull();
    expect(client.getSnapshot().openSocketCount).toBe(MAX_SOCKETS_PER_TAB);

    client.stop();
  });

  it("wipes state, notifies follower tabs, and does not reconnect on 4401 revocation", () => {
    const bus = new MockBroadcastBus();
    const hubSockets: MockSocket[] = [];
    const revokedReasonsA: string[] = [];
    const revokedReasonsB: string[] = [];

    const tabA = new RealtimeClient({
      userId: USER_1,
      tabId: "tab-a",
      createBroadcastChannel: bus.create,
      createWebSocket: (url) => {
        const ws = new MockSocket(url);
        hubSockets.push(ws);
        return ws;
      },
      onSessionRevoked: (reason) => revokedReasonsA.push(reason),
      electionDelayMs: 20,
      reconnectBaseMs: 100,
    });

    const tabB = new RealtimeClient({
      userId: USER_1,
      tabId: "tab-b",
      createBroadcastChannel: bus.create,
      createWebSocket: (url) => {
        const ws = new MockSocket(url);
        hubSockets.push(ws);
        return ws;
      },
      onSessionRevoked: (reason) => revokedReasonsB.push(reason),
      electionDelayMs: 20,
      reconnectBaseMs: 100,
    });

    tabA.start();
    tabB.start();
    vi.advanceTimersByTime(30);

    expect(hubSockets).toHaveLength(1);
    hubSockets[0]!.serverOpen();

    // Server closes the hub socket with 4401 (session revoked).
    hubSockets[0]!.serverClose(WS_CLOSE_SESSION_REVOKED, "session_revoked");

    expect(revokedReasonsA).toEqual(["session_revoked"]);
    expect(revokedReasonsB).toEqual(["session_revoked"]);

    // Advance timers well past reconnect backoff — neither tab attempts to reconnect.
    vi.advanceTimersByTime(60_000);
    expect(hubSockets).toHaveLength(1);
  });

  it("fires onAccessRemoved when a room socket closes with 4403 or receives access.changed role=null", () => {
    const sockets: MockSocket[] = [];
    const accessChanges: { roomKind: string; roomId: string; role: string | null }[] = [];
    let removedCount = 0;

    const client = new RealtimeClient({
      userId: USER_1,
      tabId: "tab-solo",
      createBroadcastChannel: () => null,
      createWebSocket: (url) => {
        const ws = new MockSocket(url);
        sockets.push(ws);
        return ws;
      },
      onAccessChanged: (change) => accessChanges.push(change),
    });

    client.start();
    const hubWs = sockets[0]!;
    hubWs.serverOpen();

    const roomId = "01J00000000000000000000401";
    client.openRoom({
      kind: "channel",
      roomId,
      onAccessRemoved: () => {
        removedCount += 1;
      },
    });
    expect(sockets).toHaveLength(2);
    const roomWs = sockets[1]!;
    roomWs.serverOpen();

    // Closing the room socket with 4403 fires `onAccessRemoved`.
    roomWs.serverClose(WS_CLOSE_ACCESS_REMOVED, "access_removed");
    expect(removedCount).toBe(1);

    // Hub `access.changed` message is forwarded to `onAccessChanged`.
    hubWs.serverMessage({
      type: "access.changed",
      roomKind: "channel",
      roomId,
      role: null,
    });
    expect(accessChanges).toEqual([{ roomKind: "channel", roomId, role: null }]);

    client.stop();
  });
});

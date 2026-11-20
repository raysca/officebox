import {
  hubServerMessages,
  MAX_SOCKETS_PER_TAB,
  WS_CLOSE_ACCESS_REMOVED,
  WS_CLOSE_SESSION_REVOKED,
  type DerivedAvailability,
  type HubActivityEvent,
  type HubClientMessage,
  type HubServerMessage,
  type PresenceEntry,
  type PresenceState,
  type RoomKind,
} from "@officebox/shared";

/**
 * Browser realtime client (M2a; TDD §2.2, §3.1, §3.5; Notifications §5.5–5.7; Platform §11–12; AGENTS §4.3).
 *
 * Features subscribe through this client, never by opening raw WebSockets (`AGENTS.md` §4.3).
 *
 * - **`BroadcastChannel` leader election:** tabs in the same browser profile share one `/api/ws/hub`
 *   WebSocket via a `BroadcastChannel` (`officebox:realtime:<userId>`). One tab is elected leader,
 *   maintains the physical `UserHub` WebSocket, aggregates `tab.state` across all open tabs (visible if
 *   any tab is visible; `lastInputAt` = max across visible tabs), and relays `HubServerMessage`s to
 *   follower tabs. When the leader tab closes or stops heartbeating, the remaining tab with the lowest
 *   `tabId` takes over within the election window and opens the hub WebSocket.
 * - **Keepalive & reconnect:** sends `"ping"` every 30 s (`CoreDurableObject`'s auto-response answers
 *   `"pong"` without waking the DO) and reconnects with exponential backoff on network drops.
 * - **Revocation (`4401`):** when the hub or a room socket closes with `4401`, broadcasts the
 *   revocation across tabs, closes all open sockets, invokes `onSessionRevoked` (which clears
 *   `queryClient` and redirects to `/sign-in?reason=expired`), and does NOT reconnect.
 * - **6-socket per-tab budget (Platform §12):** tracks direct room sockets opened in this tab alongside
 *   the hub socket. Hard cap of `MAX_SOCKETS_PER_TAB` (6). Before opening a 7th socket, evicts the
 *   least-recently-used embedded board socket (`kind === "board"` and `embedded === true`) first, or
 *   refuses with a typed budget error if none is evictable.
 */

export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: { data?: unknown; code?: number; reason?: string }) => void,
  ): void;
}

export type WebSocketFactory = (url: string) => SocketLike;

export interface BroadcastChannelLike {
  postMessage(message: unknown): void;
  close(): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
}

export type BroadcastChannelFactory = (name: string) => BroadcastChannelLike | null;

export interface RealtimeSnapshot {
  connected: boolean;
  isLeader: boolean;
  myPresence: PresenceState;
  myAvailability: DerivedAvailability | null;
  online: ReadonlyMap<string, PresenceEntry>;
  openSocketCount: number;
}

export interface RoomSubscriptionOptions {
  kind: RoomKind;
  roomId: string;
  url?: string;
  embedded?: boolean;
  onMessage?: (data: string) => void;
  onAccessRemoved?: () => void;
  onClose?: (code: number, reason: string) => void;
}

export interface RoomHandle {
  readonly kind: RoomKind;
  readonly roomId: string;
  send(data: string): void;
  touch(): void;
  close(): void;
}

type ChannelWireMessage =
  | {
      type: "leader.claim";
      tabId: string;
      at: number;
    }
  | {
      type: "leader.heartbeat";
      tabId: string;
      at: number;
      snapshot: {
        connected: boolean;
        myPresence: PresenceState;
        myAvailability: DerivedAvailability | null;
        online: PresenceEntry[];
      };
    }
  | {
      type: "leader.resign";
      tabId: string;
    }
  | {
      type: "follower.tab_state";
      tabId: string;
      visible: boolean;
      lastInputAt: number;
      at: number;
    }
  | {
      type: "hub.message";
      fromTabId: string;
      message: HubServerMessage;
    }
  | {
      type: "session.revoked";
      fromTabId: string;
      reason: string;
    };

export interface RealtimeClientOptions {
  userId: string;
  hubUrl?: string;
  tabId?: string;
  createWebSocket?: WebSocketFactory;
  createBroadcastChannel?: BroadcastChannelFactory;
  now?: () => number;
  onSessionRevoked?: (reason: string) => void;
  onActivity?: (events: readonly HubActivityEvent[]) => void;
  onAccessChanged?: (change: { roomKind: RoomKind; roomId: string; role: string | null }) => void;
  /** Interval for BroadcastChannel leader heartbeats (default 1500 ms). */
  leaderHeartbeatMs?: number;
  /** Timeout after which a silent leader is considered dead (default 3500 ms). */
  leaderLeaseMs?: number;
  /** Initial election settle delay (default 60 ms). */
  electionDelayMs?: number;
  /** Ping interval on the hub WebSocket (default 30_000 ms). */
  pingIntervalMs?: number;
  /** Base reconnect delay in ms (default 500 ms). */
  reconnectBaseMs?: number;
}

interface PeerTabState {
  visible: boolean;
  lastInputAt: number;
  updatedAt: number;
}

interface ManagedRoomSocket {
  kind: RoomKind;
  roomId: string;
  embedded: boolean;
  lastUsedAt: number;
  socket: SocketLike;
  close: () => void;
}

function defaultWebSocketFactory(url: string): SocketLike {
  if (typeof WebSocket === "undefined") {
    throw new Error("WebSocket is not available in this environment");
  }
  const resolved =
    url.startsWith("ws://") || url.startsWith("wss://")
      ? url
      : `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}${url}`;
  return new WebSocket(resolved);
}

function defaultBroadcastChannelFactory(name: string): BroadcastChannelLike | null {
  if (typeof BroadcastChannel === "undefined") return null;
  try {
    return new BroadcastChannel(name);
  } catch {
    return null;
  }
}

export class RealtimeClient {
  readonly userId: string;
  readonly tabId: string;
  private readonly hubUrl: string;
  private readonly createWebSocket: WebSocketFactory;
  private readonly createBroadcastChannel: BroadcastChannelFactory;
  private readonly now: () => number;
  private readonly onSessionRevoked?: (reason: string) => void;
  private readonly onActivity?: (events: readonly HubActivityEvent[]) => void;
  private readonly onAccessChanged?: (change: { roomKind: RoomKind; roomId: string; role: string | null }) => void;
  private readonly leaderHeartbeatMs: number;
  private readonly leaderLeaseMs: number;
  private readonly electionDelayMs: number;
  private readonly pingIntervalMs: number;
  private readonly reconnectBaseMs: number;

  private channel: BroadcastChannelLike | null = null;
  private hubSocket: SocketLike | null = null;
  private leaderTabId: string | null = null;
  private leaderLastSeenAt = 0;
  private started = false;
  private stopped = false;
  private revoked = false;
  private reconnectAttempts = 0;

  private electionTimer: ReturnType<typeof setTimeout> | null = null;
  private leaderInterval: ReturnType<typeof setInterval> | null = null;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private localVisible: boolean;
  private localLastInputAt: number;
  private lastSentVisible: boolean | null = null;
  private lastSentInputAt = 0;
  private lastSentTabStateAt = 0;
  private readonly peerTabs = new Map<string, PeerTabState>();
  private readonly roomSockets = new Map<string, ManagedRoomSocket>();

  private connected = false;
  private myPresence: PresenceState = "offline";
  private myAvailability: DerivedAvailability | null = null;
  private readonly onlineMap = new Map<string, PresenceEntry>();
  private readonly listeners = new Set<() => void>();
  private cachedSnapshot: RealtimeSnapshot;

  constructor(options: RealtimeClientOptions) {
    this.userId = options.userId;
    this.tabId = options.tabId ?? `tab-${Math.random().toString(36).slice(2, 10)}-${Date.now()}`;
    this.hubUrl = options.hubUrl ?? "/api/ws/hub";
    this.createWebSocket = options.createWebSocket ?? defaultWebSocketFactory;
    this.createBroadcastChannel = options.createBroadcastChannel ?? defaultBroadcastChannelFactory;
    this.now = options.now ?? Date.now;
    this.onSessionRevoked = options.onSessionRevoked;
    this.onActivity = options.onActivity;
    this.onAccessChanged = options.onAccessChanged;
    this.leaderHeartbeatMs = options.leaderHeartbeatMs ?? 1500;
    this.leaderLeaseMs = options.leaderLeaseMs ?? 3500;
    this.electionDelayMs = options.electionDelayMs ?? 60;
    this.pingIntervalMs = options.pingIntervalMs ?? 30_000;
    this.reconnectBaseMs = options.reconnectBaseMs ?? 500;
    this.localVisible = typeof document !== "undefined" ? document.visibilityState === "visible" : true;
    this.localLastInputAt = this.now();
    this.cachedSnapshot = this.buildSnapshot();
  }

  private buildSnapshot(): RealtimeSnapshot {
    return {
      connected: this.connected,
      isLeader: this.isLeader(),
      myPresence: this.myPresence,
      myAvailability: this.myAvailability,
      online: new Map(this.onlineMap),
      openSocketCount: (this.hubSocket ? 1 : 0) + this.roomSockets.size,
    };
  }

  private emitChange(): void {
    this.cachedSnapshot = this.buildSnapshot();
    for (const listener of this.listeners) listener();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getSnapshot(): RealtimeSnapshot {
    return this.cachedSnapshot;
  }

  isLeader(): boolean {
    return this.leaderTabId === this.tabId;
  }

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;

    this.channel = this.createBroadcastChannel(`officebox:realtime:${this.userId}`);
    if (this.channel) {
      this.channel.addEventListener("message", (event) => {
        this.onChannelMessage(event.data as ChannelWireMessage);
      });
    }

    this.leaderInterval = setInterval(() => this.onLeaderTick(), this.leaderHeartbeatMs);
    if (!this.channel) {
      this.becomeLeader();
      return;
    }

    // Announce our claim and wait `electionDelayMs` so an existing leader or lower-ID tab can win.
    this.postChannel({ type: "leader.claim", tabId: this.tabId, at: this.now() });
    this.scheduleElection(this.electionDelayMs);
  }

  stop(): void {
    if (this.stopped) return;
    const wasLeader = this.isLeader();
    this.stopped = true;
    this.started = false;
    this.leaderTabId = null;
    if (wasLeader && this.channel) {
      try {
        this.channel.postMessage({ type: "leader.resign", tabId: this.tabId } satisfies ChannelWireMessage);
      } catch {
        // Ignore postMessage failure on closed channel.
      }
    }

    if (this.electionTimer) clearTimeout(this.electionTimer);
    if (this.leaderInterval) clearInterval(this.leaderInterval);
    if (this.pingInterval) clearInterval(this.pingInterval);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.electionTimer = null;
    this.leaderInterval = null;
    this.pingInterval = null;
    this.reconnectTimer = null;

    this.closeHubSocket();
    for (const room of [...this.roomSockets.values()]) {
      room.close();
    }
    this.roomSockets.clear();
    if (this.channel) {
      try {
        this.channel.close();
      } catch {
        // Ignore close errors.
      }
      this.channel = null;
    }
    this.connected = false;
    this.leaderTabId = null;
    this.emitChange();
  }

  /** Reports this tab's visibility and latest input timestamp. */
  reportTabState(visible: boolean, lastInputAt = this.now()): void {
    this.localVisible = visible;
    this.localLastInputAt = lastInputAt;
    if (this.stopped || this.revoked) return;

    if (this.isLeader()) {
      this.sendAggregatedTabState();
    } else {
      this.postChannel({
        type: "follower.tab_state",
        tabId: this.tabId,
        visible,
        lastInputAt,
        at: this.now(),
      });
    }
  }

  /** Optimistically updates local availability (e.g. after `PUT /api/me/dnd`). */
  setLocalAvailability(availability: DerivedAvailability): void {
    this.myAvailability = availability;
    this.emitChange();
  }

  // ------------------------------------------------------------------ Leader election

  private postChannel(message: ChannelWireMessage): void {
    if (!this.channel || this.stopped) return;
    try {
      this.channel.postMessage(message);
    } catch {
      // Ignore postMessage failure on closed channel.
    }
  }

  private scheduleElection(delayMs: number): void {
    if (this.stopped || this.revoked) return;
    if (this.electionTimer) clearTimeout(this.electionTimer);
    this.electionTimer = setTimeout(() => {
      this.electionTimer = null;
      if (this.stopped || this.revoked) return;
      const now = this.now();
      if (!this.leaderTabId || now - this.leaderLastSeenAt > this.leaderLeaseMs) {
        this.becomeLeader();
      }
    }, delayMs);
  }

  private onChannelMessage(msg: ChannelWireMessage | null | undefined): void {
    if (!msg || typeof msg !== "object" || this.stopped) return;
    const now = this.now();

    switch (msg.type) {
      case "leader.claim": {
        if (msg.tabId === this.tabId) return;
        if (this.isLeader()) {
          // An already-elected leader stays leader and notifies the newcomer (split-brain is
          // still resolved deterministically on `leader.heartbeat`).
          this.broadcastLeaderHeartbeat();
        } else if (msg.tabId < this.tabId && (!this.leaderTabId || msg.tabId < this.leaderTabId)) {
          this.leaderTabId = msg.tabId;
          this.leaderLastSeenAt = now;
        } else if (!this.leaderTabId && this.tabId < msg.tabId) {
          this.postChannel({ type: "leader.claim", tabId: this.tabId, at: now });
        }
        break;
      }
      case "leader.heartbeat": {
        if (msg.tabId === this.tabId) return;
        if (this.isLeader() && msg.tabId < this.tabId) {
          this.stepDownTo(msg.tabId, now);
        } else if (!this.isLeader()) {
          this.leaderTabId = msg.tabId;
          this.leaderLastSeenAt = now;
          this.connected = msg.snapshot.connected;
          this.myPresence = msg.snapshot.myPresence;
          this.myAvailability = msg.snapshot.myAvailability;
          this.onlineMap.clear();
          for (const entry of msg.snapshot.online) {
            this.onlineMap.set(entry.userId, entry);
          }
          this.emitChange();
        }
        break;
      }
      case "leader.resign": {
        if (this.leaderTabId === msg.tabId) {
          this.leaderTabId = null;
          this.leaderLastSeenAt = 0;
          this.postChannel({ type: "leader.claim", tabId: this.tabId, at: now });
          this.scheduleElection(this.electionDelayMs);
        }
        break;
      }
      case "follower.tab_state": {
        this.peerTabs.set(msg.tabId, {
          visible: msg.visible,
          lastInputAt: msg.lastInputAt,
          updatedAt: now,
        });
        if (this.isLeader()) {
          this.sendAggregatedTabState();
        }
        break;
      }
      case "hub.message": {
        if (msg.fromTabId === this.tabId) return;
        this.applyHubServerMessage(msg.message);
        break;
      }
      case "session.revoked": {
        if (msg.fromTabId === this.tabId) return;
        this.handleSessionRevocation(msg.reason, false);
        break;
      }
    }
  }

  private onLeaderTick(): void {
    if (this.stopped || this.revoked) return;
    const now = this.now();

    // Prune stale peer tab states.
    let pruned = false;
    for (const [id, peer] of this.peerTabs) {
      if (now - peer.updatedAt > this.leaderLeaseMs * 2) {
        this.peerTabs.delete(id);
        pruned = true;
      }
    }

    if (this.isLeader()) {
      if (pruned) this.sendAggregatedTabState(false);
      this.broadcastLeaderHeartbeat();
      return;
    }

    // Follower: check if the leader's lease expired.
    if (!this.leaderTabId || now - this.leaderLastSeenAt > this.leaderLeaseMs) {
      this.leaderTabId = null;
      this.postChannel({ type: "leader.claim", tabId: this.tabId, at: now });
      this.scheduleElection(this.electionDelayMs);
    } else {
      this.postChannel({
        type: "follower.tab_state",
        tabId: this.tabId,
        visible: this.localVisible,
        lastInputAt: this.localLastInputAt,
        at: now,
      });
    }
  }

  private becomeLeader(): void {
    if (this.stopped || this.revoked || this.isLeader()) return;
    this.leaderTabId = this.tabId;
    this.leaderLastSeenAt = this.now();
    this.ensureSocketBudgetForNewConnection();
    this.openHubSocket();
    this.broadcastLeaderHeartbeat();
    this.emitChange();
  }

  private stepDownTo(newLeaderTabId: string, now: number): void {
    this.leaderTabId = newLeaderTabId;
    this.leaderLastSeenAt = now;
    this.closeHubSocket();
    this.emitChange();
  }

  private broadcastLeaderHeartbeat(): void {
    if (!this.isLeader()) return;
    this.postChannel({
      type: "leader.heartbeat",
      tabId: this.tabId,
      at: this.now(),
      snapshot: {
        connected: this.connected,
        myPresence: this.myPresence,
        myAvailability: this.myAvailability,
        online: [...this.onlineMap.values()],
      },
    });
  }

  // ------------------------------------------------------------------ Hub WebSocket

  private openHubSocket(): void {
    if (this.stopped || this.revoked || !this.isLeader() || this.hubSocket) return;
    let ws: SocketLike;
    try {
      ws = this.createWebSocket(this.hubUrl);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.hubSocket = ws;

    ws.addEventListener("open", () => {
      if (this.hubSocket !== ws) return;
      this.reconnectAttempts = 0;
      this.connected = true;
      this.lastSentVisible = null;
      this.lastSentInputAt = 0;
      this.lastSentTabStateAt = 0;
      this.sendAggregatedTabState(true);
      this.startPing();
      this.broadcastLeaderHeartbeat();
      this.emitChange();
    });

    ws.addEventListener("message", (event) => {
      if (this.hubSocket !== ws || typeof event.data !== "string") return;
      if (event.data === "pong") return;
      let raw: unknown;
      try {
        raw = JSON.parse(event.data);
      } catch {
        return;
      }
      const parsed = hubServerMessages.parse(raw);
      if (!parsed.ok) return;
      this.applyHubServerMessage(parsed.value);
      this.postChannel({
        type: "hub.message",
        fromTabId: this.tabId,
        message: parsed.value,
      });
    });

    ws.addEventListener("close", (event) => {
      if (this.hubSocket !== ws) return;
      this.hubSocket = null;
      this.stopPing();
      this.connected = false;
      const code = event.code ?? 1006;
      const reason = event.reason ?? "";
      if (code === WS_CLOSE_SESSION_REVOKED) {
        this.handleSessionRevocation(reason || "session_revoked", true);
        return;
      }
      this.emitChange();
      if (this.isLeader() && !this.stopped && !this.revoked) {
        this.scheduleReconnect();
      }
    });

    ws.addEventListener("error", () => {
      // The close handler drives reconnect logic.
    });
  }

  private closeHubSocket(): void {
    this.stopPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const ws = this.hubSocket;
    this.hubSocket = null;
    if (ws) {
      try {
        ws.close(1000, "client_closing");
      } catch {
        // Ignore close errors.
      }
    }
    this.connected = false;
  }

  private startPing(): void {
    this.stopPing();
    this.pingInterval = setInterval(() => {
      if (this.hubSocket && this.hubSocket.readyState === 1) {
        try {
          this.hubSocket.send("ping");
        } catch {
          // Ignore send errors.
        }
      }
    }, this.pingIntervalMs);
  }

  private stopPing(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.revoked || !this.isLeader() || this.reconnectTimer) return;
    const delay = Math.min(30_000, this.reconnectBaseMs * Math.pow(2, this.reconnectAttempts));
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openHubSocket();
    }, delay);
  }

  private sendAggregatedTabState(force = false): void {
    if (!this.hubSocket || this.hubSocket.readyState !== 1) return;
    let anyVisible = this.localVisible;
    let maxInputAt = this.localVisible ? this.localLastInputAt : 0;

    for (const peer of this.peerTabs.values()) {
      if (peer.visible) {
        anyVisible = true;
        if (peer.lastInputAt > maxInputAt) maxInputAt = peer.lastInputAt;
      }
    }
    if (!anyVisible) {
      maxInputAt = this.localLastInputAt;
      for (const peer of this.peerTabs.values()) {
        if (peer.lastInputAt > maxInputAt) maxInputAt = peer.lastInputAt;
      }
    }

    const now = this.now();
    if (!force && this.lastSentVisible !== null) {
      const visibilityChanged = anyVisible !== this.lastSentVisible;
      const inputAdvanced = maxInputAt > this.lastSentInputAt;
      if (!visibilityChanged) {
        if (!inputAdvanced || now - this.lastSentTabStateAt < 30_000) {
          return;
        }
      }
    }

    this.lastSentVisible = anyVisible;
    this.lastSentInputAt = maxInputAt;
    this.lastSentTabStateAt = now;

    const msg: HubClientMessage = {
      type: "tab.state",
      visible: anyVisible,
      lastInputAt: maxInputAt,
    };
    try {
      this.hubSocket.send(JSON.stringify(msg));
    } catch {
      // Socket closing.
    }
  }

  private applyHubServerMessage(msg: HubServerMessage): void {
    switch (msg.type) {
      case "hub.welcome": {
        this.connected = true;
        this.myPresence = msg.presence;
        this.myAvailability = msg.availability;
        this.onlineMap.clear();
        for (const entry of msg.online) {
          this.onlineMap.set(entry.userId, entry);
        }
        this.emitChange();
        break;
      }
      case "presence.changed": {
        if (msg.userId === this.userId) {
          this.myPresence = msg.state;
        }
        if (msg.state === "offline") {
          this.onlineMap.delete(msg.userId);
        } else {
          const prev = this.onlineMap.get(msg.userId);
          this.onlineMap.set(msg.userId, {
            userId: msg.userId,
            state: msg.state,
            lastSeenAt: msg.lastSeenAt,
            statusText: msg.statusText,
            ...(prev?.availability ? { availability: prev.availability } : {}),
          });
        }
        this.emitChange();
        break;
      }
      case "status.changed": {
        if (msg.userId === this.userId) {
          this.myAvailability = msg.availability;
        }
        const prev = this.onlineMap.get(msg.userId);
        if (prev) {
          this.onlineMap.set(msg.userId, {
            ...prev,
            availability: msg.availability,
          });
        }
        this.emitChange();
        break;
      }
      case "access.changed": {
        if (msg.role === null) {
          const key = `${msg.roomKind}:${msg.roomId}`;
          const room = this.roomSockets.get(key);
          if (room) room.close();
        }
        this.onAccessChanged?.({
          roomKind: msg.roomKind,
          roomId: msg.roomId,
          role: msg.role,
        });
        break;
      }
      case "hub.activity": {
        this.onActivity?.(msg.events);
        break;
      }
    }
  }

  private handleSessionRevocation(reason: string, broadcastToPeers: boolean): void {
    if (this.revoked) return;
    this.revoked = true;
    if (broadcastToPeers) {
      this.postChannel({
        type: "session.revoked",
        fromTabId: this.tabId,
        reason,
      });
    }
    this.stop();
    this.onSessionRevoked?.(reason);
  }

  // ------------------------------------------------------------------ 6-socket per-tab room multiplexer

  private currentSocketCount(): number {
    return (this.hubSocket ? 1 : 0) + this.roomSockets.size;
  }

  private ensureSocketBudgetForNewConnection(): boolean {
    if (this.currentSocketCount() < MAX_SOCKETS_PER_TAB) return true;
    // Evict the least-recently-used embedded board socket first (Platform §12).
    let lruKey: string | null = null;
    let lruTime = Infinity;
    for (const [key, room] of this.roomSockets) {
      if (room.kind === "board" && room.embedded && room.lastUsedAt < lruTime) {
        lruTime = room.lastUsedAt;
        lruKey = key;
      }
    }
    if (lruKey) {
      const target = this.roomSockets.get(lruKey);
      target?.close();
      return this.currentSocketCount() < MAX_SOCKETS_PER_TAB;
    }
    return false;
  }

  /**
   * Opens a room WebSocket under the per-tab 6-socket cap (Platform §12).
   * Evicts the LRU embedded board socket when at the limit, or returns `null` if the cap is full and
   * no embedded board can be evicted.
   */
  openRoom(options: RoomSubscriptionOptions): RoomHandle | null {
    if (this.stopped || this.revoked) return null;
    const key = `${options.kind}:${options.roomId}`;
    const existing = this.roomSockets.get(key);
    if (existing) {
      existing.lastUsedAt = this.now();
      return {
        kind: options.kind,
        roomId: options.roomId,
        send: (data) => existing.socket.send(data),
        touch: () => {
          existing.lastUsedAt = this.now();
        },
        close: () => existing.close(),
      };
    }

    if (!this.ensureSocketBudgetForNewConnection()) {
      return null;
    }

    const url = options.url ?? `/api/ws/${options.kind}/${encodeURIComponent(options.roomId)}`;
    const socket = this.createWebSocket(url);
    const cleanup = () => {
      if (!this.roomSockets.has(key)) return;
      this.roomSockets.delete(key);
      try {
        socket.close(1000, "room_closed");
      } catch {
        // Ignore close errors.
      }
      this.emitChange();
    };

    const managed: ManagedRoomSocket = {
      kind: options.kind,
      roomId: options.roomId,
      embedded: Boolean(options.embedded),
      lastUsedAt: this.now(),
      socket,
      close: cleanup,
    };
    this.roomSockets.set(key, managed);
    this.emitChange();

    socket.addEventListener("message", (event) => {
      managed.lastUsedAt = this.now();
      if (typeof event.data === "string") {
        options.onMessage?.(event.data);
      }
    });

    socket.addEventListener("close", (event) => {
      this.roomSockets.delete(key);
      this.emitChange();
      const code = event.code ?? 1000;
      const reason = event.reason ?? "";
      if (code === WS_CLOSE_SESSION_REVOKED) {
        this.handleSessionRevocation(reason || "session_revoked", true);
        return;
      }
      if (code === WS_CLOSE_ACCESS_REMOVED) {
        options.onAccessRemoved?.();
      }
      options.onClose?.(code, reason);
    });

    return {
      kind: options.kind,
      roomId: options.roomId,
      send: (data) => {
        managed.lastUsedAt = this.now();
        socket.send(data);
      },
      touch: () => {
        managed.lastUsedAt = this.now();
      },
      close: cleanup,
    };
  }
}

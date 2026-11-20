import type { DerivedAvailability, PresenceEntry, PresenceState } from "@officebox/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { createContext, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { memberAvailabilityQueryKey, workspacePresenceQueryKey } from "../api/realtime";
import { RealtimeClient, type RealtimeSnapshot } from "./client";

/**
 * React context and hooks for the browser realtime client (`apps/web/src/lib/realtime/`).
 *
 * Mounted inside `AppShell` once the signed-in member (`GET /api/me`) is known.
 * - Starts one `RealtimeClient` per signed-in `userId`.
 * - Tracks `document.visibilityState` and throttled user input (`keydown`, `pointerdown`, `focus`)
 *   to report `tab.state` for the 2-minute active presence rule (Notifications §5.5).
 * - On `4401` (`WS_CLOSE_SESSION_REVOKED`), wipes `queryClient` and navigates to
 *   `/sign-in?reason=expired` without reconnecting (TDD §3.5, Identity §4.5).
 */

const DEFAULT_SNAPSHOT: RealtimeSnapshot = {
  connected: false,
  isLeader: false,
  myPresence: "offline",
  myAvailability: null,
  online: new Map(),
  openSocketCount: 0,
};

const RealtimeContext = createContext<RealtimeClient | null>(null);

function canOpenDefaultWebSocket(): boolean {
  if (typeof WebSocket === "undefined") return false;
  // In jsdom unit tests (unless a test stubs WebSocket or passes a custom factory), avoid noisy
  // localhost connection errors.
  if (typeof navigator !== "undefined" && /jsdom/i.test(navigator.userAgent)) {
    const ws = WebSocket as unknown as { mock?: unknown; isMock?: boolean };
    return Boolean(ws.mock || ws.isMock);
  }
  return true;
}

export function RealtimeProvider({ userId, children }: { userId: string; children: ReactNode }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const client = useMemo(() => {
    if (!canOpenDefaultWebSocket()) return null;
    return new RealtimeClient({
      userId,
      onSessionRevoked: () => {
        queryClient.clear();
        void navigate({
          to: "/sign-in",
          search: { reason: "expired", redirect: window.location.pathname },
          replace: true,
        });
      },
    });
  }, [userId, queryClient, navigate]);

  useEffect(() => {
    if (!client) return;
    client.start();

    let lastReportedAt = 0;
    const reportInput = () => {
      const now = Date.now();
      if (now - lastReportedAt < 30_000) return;
      lastReportedAt = now;
      client.reportTabState(document.visibilityState === "visible", now);
    };
    const onVisibilityChange = () => {
      const now = Date.now();
      lastReportedAt = now;
      client.reportTabState(document.visibilityState === "visible", now);
    };
    const onPageHide = () => {
      client.stop();
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("keydown", reportInput, { passive: true });
    window.addEventListener("pointerdown", reportInput, { passive: true });
    window.addEventListener("scroll", reportInput, { passive: true });
    window.addEventListener("focus", onVisibilityChange);
    window.addEventListener("pagehide", onPageHide);

    const unsubscribe = client.subscribe(() => {
      const snap = client.getSnapshot();
      queryClient.setQueryData(workspacePresenceQueryKey, [...snap.online.values()]);
      if (snap.myAvailability) {
        queryClient.setQueryData(memberAvailabilityQueryKey(userId), {
          presence: snap.myPresence,
          availability: snap.myAvailability,
        });
      }
    });

    return () => {
      unsubscribe();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("keydown", reportInput);
      window.removeEventListener("pointerdown", reportInput);
      window.removeEventListener("scroll", reportInput);
      window.removeEventListener("focus", onVisibilityChange);
      window.removeEventListener("pagehide", onPageHide);
      client.stop();
    };
  }, [client, userId, queryClient]);

  return <RealtimeContext.Provider value={client}>{children}</RealtimeContext.Provider>;
}

export function useRealtimeClient(): RealtimeClient | null {
  return useContext(RealtimeContext);
}

export function useRealtimeSnapshot(): RealtimeSnapshot {
  const client = useContext(RealtimeContext);
  return useSyncExternalStore(
    (onStoreChange) => (client ? client.subscribe(onStoreChange) : () => {}),
    () => (client ? client.getSnapshot() : DEFAULT_SNAPSHOT),
    () => DEFAULT_SNAPSHOT,
  );
}

export function useOnlineMembers(): ReadonlyMap<string, PresenceEntry> {
  return useRealtimeSnapshot().online;
}

export function useMyPresenceAndAvailability(): {
  connected: boolean;
  presence: PresenceState;
  availability: DerivedAvailability | null;
} {
  const snap = useRealtimeSnapshot();
  return {
    connected: snap.connected,
    presence: snap.myPresence,
    availability: snap.myAvailability,
  };
}

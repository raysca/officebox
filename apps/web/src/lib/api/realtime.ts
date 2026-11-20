import {
  derivedAvailabilitySchema,
  presenceEntrySchema,
  presenceStateSchema,
  wsTicketResponseSchema,
  type DerivedAvailability,
  type DndSchedule,
  type PresenceEntry,
  type PresenceState,
  type WsTicketResponse,
} from "@officebox/shared";
import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import { apiRequest, unwrap } from "./client";

/**
 * Realtime & availability API helpers (M2a; TDD §3.1, §4.2; Notifications §5.5–5.7, §10).
 */

export const memberAvailabilityResponseSchema = z.object({
  userId: z.string(),
  presence: presenceStateSchema,
  availability: derivedAvailabilitySchema,
});
export type MemberAvailabilityResponse = z.infer<typeof memberAvailabilityResponseSchema>;

export const workspacePresenceResponseSchema = z.object({
  online: z.array(presenceEntrySchema),
});

export const setDndResponseSchema = z.object({
  availability: derivedAvailabilitySchema,
});

export const updatePreferencesResponseSchema = z.object({
  timezone: z.string(),
  availability: derivedAvailabilitySchema,
});

export const memberAvailabilityQueryKey = (userId: string) => ["members", userId, "availability"] as const;

export const memberAvailabilityQuery = (userId: string) =>
  queryOptions({
    queryKey: memberAvailabilityQueryKey(userId),
    queryFn: async ({ signal }): Promise<{ presence: PresenceState; availability: DerivedAvailability }> =>
      unwrap(
        await apiRequest(`/api/members/${encodeURIComponent(userId)}/availability`, {
          schema: memberAvailabilityResponseSchema,
          signal,
        }),
      ),
    staleTime: 60_000,
  });

export const workspacePresenceQueryKey = ["realtime", "presence"] as const;

export const workspacePresenceQuery = queryOptions({
  queryKey: workspacePresenceQueryKey,
  queryFn: async ({ signal }): Promise<PresenceEntry[]> =>
    unwrap(await apiRequest("/api/realtime/presence", { schema: workspacePresenceResponseSchema, signal })).online,
  staleTime: 30_000,
});

export async function issueWsTicket(target: string): Promise<WsTicketResponse> {
  return unwrap(
    await apiRequest("/api/auth/ws-ticket", {
      method: "POST",
      body: { target },
      schema: wsTicketResponseSchema,
    }),
  );
}

export async function setMyDnd(until: number | null): Promise<DerivedAvailability> {
  return unwrap(
    await apiRequest("/api/me/dnd", {
      method: "PUT",
      body: { until },
      schema: setDndResponseSchema,
    }),
  ).availability;
}

export async function updateMyRealtimePreferences(body: {
  timezone?: string;
  dndSchedule?: DndSchedule | null;
}): Promise<{ timezone: string; availability: DerivedAvailability }> {
  return unwrap(
    await apiRequest("/api/me/preferences", {
      method: "PATCH",
      body,
      schema: updatePreferencesResponseSchema,
    }),
  );
}

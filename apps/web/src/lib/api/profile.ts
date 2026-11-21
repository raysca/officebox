import {
  avatarResultSchema,
  directoryPageSchema,
  handleAvailabilitySchema,
  memberProfileSchema,
  myProfileSchema,
  statusResultSchema,
  type AvatarContentType,
  type DirectoryFilter,
  type SetStatusBody,
  type UpdateProfileBody,
} from "@officebox/shared";
import { infiniteQueryOptions, keepPreviousData, queryOptions } from "@tanstack/react-query";
import { apiRequest, unwrap } from "./client";

/**
 * Profiles, status, avatars, handles and the member directory (M1d; Identity §4.7, §4.8, §4.10, §6).
 * The server validates everything again with the same shared schemas.
 */

export const myProfileQueryKey = ["me", "profile"] as const;

export const myProfileQuery = queryOptions({
  queryKey: myProfileQueryKey,
  queryFn: async ({ signal }) => unwrap(await apiRequest("/api/me/profile", { schema: myProfileSchema, signal })),
});

/** The input form of a profile edit (before the shared schema's transforms). */
export type ProfileEdit = { [K in keyof UpdateProfileBody]?: unknown };

export async function updateProfile(body: ProfileEdit) {
  return unwrap(await apiRequest("/api/me/profile", { method: "PATCH", body, schema: myProfileSchema }));
}

export async function setStatus(body: SetStatusBody) {
  return unwrap(await apiRequest("/api/me/status", { method: "PUT", body, schema: statusResultSchema }));
}

export async function clearStatus() {
  return unwrap(await apiRequest("/api/me/status", { method: "DELETE", schema: statusResultSchema }));
}

export async function uploadAvatar(image: Blob, contentType: AvatarContentType) {
  return unwrap(
    await apiRequest("/api/me/avatar", {
      method: "PUT",
      rawBody: image,
      contentType,
      schema: avatarResultSchema,
      timeoutMs: 60_000,
    }),
  );
}

export async function removeAvatar() {
  return unwrap(await apiRequest("/api/me/avatar", { method: "DELETE", schema: avatarResultSchema }));
}

export async function checkHandle(handle: string, signal?: AbortSignal) {
  return unwrap(
    await apiRequest(`/api/handles/${encodeURIComponent(handle)}/available`, {
      schema: handleAvailabilitySchema,
      signal,
    }),
  );
}

export const directoryQueryKey = ["members", "directory"] as const;

export function directoryQuery(q: string, filter: DirectoryFilter, group = "") {
  return infiniteQueryOptions({
    queryKey: [...directoryQueryKey, filter, q, group] as const,
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }) => {
      const params = new URLSearchParams({ filter });
      if (q.trim() !== "") params.set("q", q.trim());
      // M1e: members of one group (Identity §4.10).
      if (group !== "") params.set("group", group);
      if (pageParam) params.set("cursor", pageParam);
      return unwrap(await apiRequest(`/api/members?${params.toString()}`, { schema: directoryPageSchema, signal }));
    },
    getNextPageParam: (last) => last.nextCursor,
    // Keep the current list on screen while the next search loads.
    placeholderData: keepPreviousData,
  });
}

export function memberQuery(id: string) {
  return queryOptions({
    queryKey: ["members", "profile", id] as const,
    queryFn: async ({ signal }) =>
      unwrap(await apiRequest(`/api/members/${encodeURIComponent(id)}`, { schema: memberProfileSchema, signal })),
  });
}

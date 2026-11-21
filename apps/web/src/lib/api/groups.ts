import {
  groupDetailSchema,
  groupListSchema,
  groupMembershipResultSchema,
  type CreateGroupBody,
  type GroupMemberRole,
  type UpdateGroupBody,
} from "@officebox/shared";
import { queryOptions } from "@tanstack/react-query";
import { apiRequest, unwrap } from "./client";

/**
 * Groups (Identity §4.9, §6; M1e). Everyone can list groups and see who is in them; admins create,
 * rename and delete groups and appoint managers; managers add and remove members of their own group.
 * The Worker asks the permission engine on every call.
 */

export const groupsQueryKey = ["groups"] as const;

export const groupsQuery = queryOptions({
  queryKey: [...groupsQueryKey, "list"] as const,
  queryFn: async ({ signal }) => unwrap(await apiRequest("/api/groups", { schema: groupListSchema, signal })).groups,
});

export function groupQuery(id: string) {
  return queryOptions({
    queryKey: [...groupsQueryKey, "detail", id] as const,
    queryFn: async ({ signal }) =>
      unwrap(await apiRequest(`/api/groups/${encodeURIComponent(id)}`, { schema: groupDetailSchema, signal })),
  });
}

export async function createGroup(body: CreateGroupBody) {
  return unwrap(await apiRequest("/api/groups", { method: "POST", body, schema: groupDetailSchema }));
}

export async function updateGroup({ id, ...body }: UpdateGroupBody & { id: string }) {
  return unwrap(
    await apiRequest(`/api/groups/${encodeURIComponent(id)}`, { method: "PATCH", body, schema: groupDetailSchema }),
  );
}

export async function deleteGroup(id: string) {
  return unwrap(await apiRequest(`/api/groups/${encodeURIComponent(id)}`, { method: "DELETE" }));
}

const memberPath = (groupId: string, userId: string) =>
  `/api/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}`;

/** Adds someone (as a member by default), or appoints or removes a manager. */
export async function putGroupMember({
  groupId,
  userId,
  role,
}: {
  groupId: string;
  userId: string;
  role: GroupMemberRole;
}) {
  return unwrap(
    await apiRequest(memberPath(groupId, userId), {
      method: "PUT",
      body: { role },
      schema: groupMembershipResultSchema,
    }),
  );
}

export async function removeGroupMember({ groupId, userId }: { groupId: string; userId: string }) {
  return unwrap(await apiRequest(memberPath(groupId, userId), { method: "DELETE" }));
}

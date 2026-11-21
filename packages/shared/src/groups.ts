import { z } from "zod";
import { ulidSchema } from "./ids";
import { normaliseHandle } from "./profile";

/**
 * Groups (Identity §4.9, §6; Permissions §3.2, §4.6; Admin §3; M1e). Admins create, rename and delete
 * groups and appoint group managers; managers add and remove members of their own group. Every member
 * can see groups and who is in them (the directory shows groups, Identity §4.10).
 */

/** Group name length **(default)**, like a display name. */
export const MAX_GROUP_NAME_LENGTH = 64;
/** Group description length **(default)**. */
export const MAX_GROUP_DESCRIPTION_LENGTH = 500;
/** Managers that can be named when a group is created **(default)**. */
export const MAX_GROUP_MANAGERS_AT_CREATE = 20;

export const GROUP_MEMBER_ROLES = ["manager", "member"] as const;
export const groupMemberRoleSchema = z.enum(GROUP_MEMBER_ROLES);
export type GroupMemberRole = z.infer<typeof groupMemberRoleSchema>;

const length = (value: string) => [...value].length;

export const groupNameSchema = z
  .string()
  .trim()
  .min(1)
  .refine((v) => length(v) <= MAX_GROUP_NAME_LENGTH, { message: `At most ${MAX_GROUP_NAME_LENGTH} characters.` });

export const groupDescriptionSchema = z
  .string()
  .trim()
  .refine((v) => length(v) <= MAX_GROUP_DESCRIPTION_LENGTH, {
    message: `At most ${MAX_GROUP_DESCRIPTION_LENGTH} characters.`,
  });

/** A handle as typed: normalised here, its shape and availability checked by the Worker. */
const groupHandleInput = z.string().max(64).transform(normaliseHandle);

/** `POST /api/groups`. The handle shares one namespace with people (Identity §4.8). */
export const createGroupBodySchema = z.strictObject({
  name: groupNameSchema,
  handle: groupHandleInput,
  description: groupDescriptionSchema.nullable().optional(),
  /** Appointed as managers (and members) at once; each is checked as an add (Permissions §6). */
  managerIds: z.array(ulidSchema).max(MAX_GROUP_MANAGERS_AT_CREATE).optional(),
});
export type CreateGroupBody = z.infer<typeof createGroupBodySchema>;

/** `PATCH /api/groups/:id`: rename, change the handle or the description. At least one field. */
export const updateGroupBodySchema = z
  .strictObject({
    name: groupNameSchema.optional(),
    handle: groupHandleInput.optional(),
    description: groupDescriptionSchema.nullable().optional(),
  })
  .refine((body) => body.name !== undefined || body.handle !== undefined || body.description !== undefined, {
    message: "Nothing to change.",
  });
export type UpdateGroupBody = z.infer<typeof updateGroupBodySchema>;

/**
 * `PUT /api/groups/:id/members/:userId`: add someone (as a member by default) or change their group
 * role. Appointing or removing a manager is an admin action (Identity §4.9).
 */
export const putGroupMemberBodySchema = z.strictObject({ role: groupMemberRoleSchema.default("member") });
export type PutGroupMemberBody = z.infer<typeof putGroupMemberBodySchema>;

export const groupSummarySchema = z.object({
  id: ulidSchema,
  name: z.string(),
  handle: z.string().nullable(),
  description: z.string().nullable(),
  memberCount: z.number().int().nonnegative(),
  managerCount: z.number().int().nonnegative(),
  /** The caller manages this group (an affordance; every change asks the engine again). */
  youManage: z.boolean(),
  /** The caller is in this group. */
  youAreMember: z.boolean(),
  createdAt: z.number().int(),
});
export type GroupSummary = z.infer<typeof groupSummarySchema>;

export const groupListSchema = z.object({ groups: z.array(groupSummarySchema) });
export type GroupList = z.infer<typeof groupListSchema>;

export const groupMemberSchema = z.object({
  id: ulidSchema,
  displayName: z.string(),
  handle: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  role: groupMemberRoleSchema,
  /** A disabled member stays in their groups (Platform §3), shown as deactivated. */
  deactivated: z.boolean(),
  addedAt: z.number().int(),
});
export type GroupMember = z.infer<typeof groupMemberSchema>;

export const groupDetailSchema = groupSummarySchema.extend({ members: z.array(groupMemberSchema) });
export type GroupDetail = z.infer<typeof groupDetailSchema>;

/** `PUT /api/groups/:id/members/:userId` answers with the membership as now stored. */
export const groupMembershipResultSchema = z.object({
  groupId: ulidSchema,
  userId: ulidSchema,
  role: groupMemberRoleSchema,
  /** False when the person was already in the group with that role. */
  changed: z.boolean(),
});
export type GroupMembershipResult = z.infer<typeof groupMembershipResultSchema>;

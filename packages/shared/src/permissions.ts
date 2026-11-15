import { z } from "zod";

/**
 * The permission engine (specs/permissions.md). One pure function, `decide`, answers every "can this
 * person do this?" question; the Worker wraps it (`apps/worker/src/core/permissions.ts`) and the web
 * app uses it for affordances only. The Worker loads the facts (the actor's role and status, the
 * target's role, the number of active owners) and passes them in, so the engine itself does no I/O
 * and is exhaustively testable (the permission matrix test).
 *
 * ## Scope in M1a and how it grows
 *
 * M1a implements **workspace roles** (§3.1) and the **admin-power limits** that depend only on roles
 * (§4.6, §6): admins act on members only; owners act on anyone, except that the last active owner
 * can't be disabled, deleted or demoted; only owners invite or promote admins.
 *
 * Later milestones add object types as new members of the `PermissionCheck` union, each with its own
 * context and a rule function dispatched from `decide`:
 * - **M1e groups:** `group.add_member` with `{ group: { managerIds } , target }` (an admin adding
 *   themselves needs an owner).
 * - **M3a channels**, **M5a calendars**, **M6a documents, folders and drives:** checks that carry the
 *   object's context (membership, grants, general access). Resource roles combine with the **union
 *   rule** (§5.1) through `highestResourceRole`, already defined here.
 *
 * Denials are typed reasons, never exceptions (AGENTS §4.1).
 */

// ---- Roles and statuses ------------------------------------------------------------------------

/** `users.role` (permissions §9). `guest` is reserved for Phase 2 and is never assignable. */
export const WORKSPACE_ROLES = ["owner", "admin", "member", "guest"] as const;
export const workspaceRoleSchema = z.enum(WORKSPACE_ROLES);
export type WorkspaceRole = z.infer<typeof workspaceRoleSchema>;

/** Roles that can be given to someone today (setup, invitations, role changes). */
export const ASSIGNABLE_WORKSPACE_ROLES = ["owner", "admin", "member"] as const satisfies readonly WorkspaceRole[];

/** `users.status`. */
export const USER_STATUSES = ["active", "disabled", "deleted"] as const;
export const userStatusSchema = z.enum(USER_STATUSES);
export type UserStatus = z.infer<typeof userStatusSchema>;

/** Resource roles, highest first (permissions §3.2 role ranking). */
export const RESOURCE_ROLES = ["owner", "manager", "editor", "commenter", "viewer", "freebusy"] as const;
export type ResourceRole = (typeof RESOURCE_ROLES)[number];

/**
 * The union rule's combining step (permissions §5.1): the highest of the roles a person holds on an
 * item through any path, or null when they hold none. There is no deny.
 */
export function highestResourceRole(roles: Iterable<ResourceRole | null | undefined>): ResourceRole | null {
  let best: number | null = null;
  for (const role of roles) {
    if (!role) continue;
    const rank = RESOURCE_ROLES.indexOf(role);
    if (best === null || rank < best) best = rank;
  }
  return best === null ? null : (RESOURCE_ROLES[best] ?? null);
}

// ---- Checks ------------------------------------------------------------------------------------

/** The person asking. Loaded from D1 by the Worker for every request (Identity §4.5). */
export interface Actor {
  userId: string;
  role: WorkspaceRole;
  status: UserStatus;
}

/** Someone an admin action is aimed at. */
export interface PersonRef {
  userId: string;
  role: WorkspaceRole;
  status: UserStatus;
}

/** Workspace-wide actions decided by role alone. */
export const WORKSPACE_ACTIONS = [
  "directory.view", // the member directory and profiles (§4.6)
  "admin.open", // the admin area
  "audit.view", // the audit log (§4.6)
  "groups.manage", // create, rename and delete groups; appoint managers (§4.6)
] as const;
export type WorkspaceAction = (typeof WORKSPACE_ACTIONS)[number];

/** Admin actions on a person (§4.6, §6): members only for admins, anyone for owners. */
export const MEMBER_ADMIN_ACTIONS = [
  "member.change_email",
  "member.issue_recovery_link",
  "member.disable",
  "member.enable",
  "member.delete",
  "member.sign_out_all",
] as const;
export type MemberAdminAction = (typeof MEMBER_ADMIN_ACTIONS)[number];

/** Actions on a person's own things: only that person (§4.6 "Edit own profile, ..., devices"). */
export const SELF_ACTIONS = [
  "profile.edit",
  "devices.view", // list own sessions
  "devices.sign_out", // sign out one of own sessions, all other devices, or everywhere
] as const;
export type SelfAction = (typeof SELF_ACTIONS)[number];

/** Who may change an admin setting (platform §7 "Who can change"). */
export type SettingChanger = "admin" | "owner";

export type PermissionCheck =
  | { action: WorkspaceAction }
  | { action: "invitation.create"; role: WorkspaceRole }
  | {
      action: MemberAdminAction;
      target: PersonRef;
      /** Active owners in the workspace, for the last-owner rule. */
      activeOwnerCount: number;
    }
  | { action: "member.change_role"; target: PersonRef; newRole: WorkspaceRole; activeOwnerCount: number }
  | { action: SelfAction; ownerId: string }
  | { action: "setting.change"; changeableBy: SettingChanger };

export type PermissionAction = PermissionCheck["action"];

/** Why a check was denied. Routes map these to `forbidden` errors (or `not_found` to hide existence). */
export type DenialReason =
  /** The actor is disabled or deleted. */
  | "inactive"
  /** The actor's role never allows this. */
  | "not_permitted"
  /** An admin acting on an admin or owner, or on an owner-only setting or role (Identity §8). */
  | "owner_required"
  /** It would leave the workspace without an active owner. */
  | "last_owner"
  /** Someone else's profile, devices or sign-in methods. */
  | "not_own"
  /** A role that can't be given (guest, or owner by invitation). */
  | "role_not_assignable";

export type Decision = { allowed: true } | { allowed: false; reason: DenialReason };

const ALLOW: Decision = { allowed: true };
const deny = (reason: DenialReason): Decision => ({ allowed: false, reason });

const isManager = (role: WorkspaceRole): boolean => role === "owner" || role === "admin";
const isPrivileged = isManager;

/** Would losing `target` as an active owner leave none? */
function isLastOwner(target: PersonRef, activeOwnerCount: number): boolean {
  return target.role === "owner" && target.status === "active" && activeOwnerCount <= 1;
}

function workspaceRule(actor: Actor, action: WorkspaceAction): Decision {
  switch (action) {
    case "directory.view":
      // Guests (Phase 2) get their own rules then; until then they see nothing (default).
      return actor.role === "guest" ? deny("not_permitted") : ALLOW;
    case "admin.open":
    case "audit.view":
    case "groups.manage":
      return isManager(actor.role) ? ALLOW : deny("not_permitted");
  }
}

function invitationRule(actor: Actor, role: WorkspaceRole): Decision {
  if (!isManager(actor.role)) return deny("not_permitted");
  if (role !== "member" && role !== "admin") return deny("role_not_assignable");
  if (role === "admin" && actor.role !== "owner") return deny("owner_required");
  return ALLOW;
}

function memberAdminRule(actor: Actor, action: MemberAdminAction, target: PersonRef, owners: number): Decision {
  if (!isManager(actor.role)) return deny("not_permitted");
  if (actor.role === "admin" && isPrivileged(target.role)) return deny("owner_required");
  if ((action === "member.disable" || action === "member.delete") && isLastOwner(target, owners)) {
    return deny("last_owner");
  }
  return ALLOW;
}

function changeRoleRule(actor: Actor, target: PersonRef, newRole: WorkspaceRole, owners: number): Decision {
  if (!isManager(actor.role)) return deny("not_permitted");
  // Admins can't promote or demote anyone (§4.6 "Change role to member or admin: —" for admins).
  if (actor.role !== "owner") return deny("owner_required");
  if (!(ASSIGNABLE_WORKSPACE_ROLES as readonly string[]).includes(newRole)) return deny("role_not_assignable");
  if (newRole !== "owner" && isLastOwner(target, owners)) return deny("last_owner");
  return ALLOW;
}

function settingRule(actor: Actor, changeableBy: SettingChanger): Decision {
  if (!isManager(actor.role)) return deny("not_permitted");
  if (changeableBy === "owner" && actor.role !== "owner") return deny("owner_required");
  return ALLOW;
}

/** Decides one check. Pure: the caller supplies every fact. */
export function decide(actor: Actor, check: PermissionCheck): Decision {
  if (actor.status !== "active") return deny("inactive");
  switch (check.action) {
    case "directory.view":
    case "admin.open":
    case "audit.view":
    case "groups.manage":
      return workspaceRule(actor, check.action);
    case "invitation.create":
      return invitationRule(actor, check.role);
    case "member.change_email":
    case "member.issue_recovery_link":
    case "member.disable":
    case "member.enable":
    case "member.delete":
    case "member.sign_out_all":
      return memberAdminRule(actor, check.action, check.target, check.activeOwnerCount);
    case "member.change_role":
      return changeRoleRule(actor, check.target, check.newRole, check.activeOwnerCount);
    case "profile.edit":
    case "devices.view":
    case "devices.sign_out":
      return actor.userId === check.ownerId ? ALLOW : deny("not_own");
    case "setting.change":
      return settingRule(actor, check.changeableBy);
  }
}

/** Convenience for UI affordances: whether `decide` allows the check. */
export function can(actor: Actor, check: PermissionCheck): boolean {
  return decide(actor, check).allowed;
}

/** The message for a denial (Identity §8: "An owner must do this."). Clients map codes to their own copy. */
export function denialMessage(reason: DenialReason): string {
  switch (reason) {
    case "inactive":
      return "This account can't do that.";
    case "not_permitted":
    case "not_own":
      return "You don't have permission to do that.";
    case "owner_required":
      return "An owner must do this.";
    case "last_owner":
      return "The workspace must keep at least one active owner.";
    case "role_not_assignable":
      return "That role can't be given.";
  }
}

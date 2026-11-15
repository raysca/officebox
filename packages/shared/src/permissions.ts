import { z } from "zod";
import { err, ok, type Result } from "./result";

/**
 * # The permission engine (specs/permissions.md)
 *
 * One pure function, {@link decide}, answers every "may this person do this?" question. The Worker
 * wraps it (`apps/worker/src/core/permissions.ts`, `authorize`), loading the facts each check needs;
 * the web app may call it for affordances only (never as the enforcement point). The engine does no
 * I/O and reads no clock: every fact arrives as an input, so it is exhaustively testable (the
 * permission matrix test, `packages/shared/test/permissions.test.ts`).
 *
 * Denials are typed results, never exceptions (AGENTS §4.1).
 *
 * ## The order of a decision
 *
 * 1. **Actor status.** Only `active` people act. `disabled` and `deleted` give `inactive`; the reserved
 *    `system` rows (system sender, assistant) give `system_actor` and are never actors or principals
 *    (Identity §4.8, Permissions §3.3, TDD §2.1 "Permission resolution" step 1).
 * 2. **The action's rule:** workspace role, target, and the facts the rule needs (admin-power limits,
 *    Permissions §4.6 and §6; Identity §2, §3, §4.11).
 * 3. **Step-up** (Permissions §6, Identity §4.5): for the sensitive actions in {@link STEP_UP_ACTIONS},
 *    a passkey assertion on this session within the last {@link STEP_UP_WINDOW_MS}. The engine first
 *    decides *whether* the actor may act, then *whether this session may act now*, so a denial for
 *    role always wins over `reauth_required` (the UI must not ask for a passkey for something the
 *    person can't do anyway).
 *
 * ## Facts
 *
 * - **On the actor:** role, status, and the acting session's step-up facts (`fresh_auth_at`,
 *   `fresh_auth_method`, Identity §5), loaded with the session.
 * - **On the check:** everything about the target and the workspace that the one rule needs: the
 *   target's role and status, the number of active owners, passkey counts, whether `RECOVERY_TOKEN` is
 *   set and unconsumed, whether magic links work. The Worker's fact loaders fill these in.
 * - **`now`:** passed in, so step-up boundaries are testable with an exact clock.
 *
 * ## Extending the engine (later milestones)
 *
 * Each feature adds its object types as **new members of the {@link PermissionCheck} union**, never as
 * ad-hoc checks in routes (AGENTS §4.1):
 *
 * 1. Add the action name(s) and a check type carrying the facts the rule needs (for example a
 *    channel's type and the actor's membership, or the actor's **effective resource role** on a
 *    document). Facts are plain values: IDs, roles, counts, booleans. No functions, no I/O.
 * 2. Write a small rule function returning {@link Decision} and dispatch it from `rule` below. The
 *    `switch` is exhaustive, so TypeScript fails the build until the new action is handled.
 * 3. If the action is sensitive, add it to {@link STEP_UP_ACTIONS}.
 * 4. Add a fact loader for each new fact to the Worker wrapper (`PermissionFacts` in
 *    `apps/worker/src/core/permissions.ts`) and map the route-facing request to the check there.
 * 5. Extend the matrix test with a **literal** expected table transcribed from the spec (never derived
 *    from the engine), covering allowed and denied cases for every role and target.
 *
 * **Resource roles** (documents, whiteboards, files, folders, drives, calendars; M5a, M6a) are resolved
 * with the **union rule** (Permissions §5.1): the loader collects every role the person holds through
 * any path (item grants, each ancestor folder, the drive and its built-in roles, the channel-folder rule,
 * general access along the chain, and for calendars the built-in kind rules), each already
 * expanded for the user's groups and channels, and {@link effectiveResourceRole} combines them. The
 * rule function then compares with {@link resourceRoleAtLeast}. There is no deny: sharing can only
 * widen. Event visibility (Permissions §4.4) is a filter applied after the calendar role.
 *
 * **Groups (M1e)** are already here ({@link GROUP_MEMBER_ACTIONS}); M1e adds the routes and loaders.
 * The admin self-grant rule on group drives and folders (Permissions §6, "needs an owner") belongs to
 * the M6a sharing check and follows the same pattern as `group.add_member`.
 */

// ---- Roles and statuses ------------------------------------------------------------------------

/** `users.role` (Permissions §9). `guest` is reserved for Phase 2 and is never assignable. */
export const WORKSPACE_ROLES = ["owner", "admin", "member", "guest"] as const;
export const workspaceRoleSchema = z.enum(WORKSPACE_ROLES);
export type WorkspaceRole = z.infer<typeof workspaceRoleSchema>;

/** Roles that can be given to someone today (setup, invitations, role changes). */
export const ASSIGNABLE_WORKSPACE_ROLES = ["owner", "admin", "member"] as const satisfies readonly WorkspaceRole[];

/** Roles an invitation can carry (Identity §2 "Who can invite"): never `owner` or `guest`. */
export const INVITABLE_WORKSPACE_ROLES = ["admin", "member"] as const satisfies readonly WorkspaceRole[];

/**
 * `users.status`. `system` marks the reserved non-user rows (`'system'` and `'assistant'`): never an
 * actor, never a principal, never signs in (Identity §4.8, Permissions §3.3).
 */
export const USER_STATUSES = ["active", "disabled", "deleted", "system"] as const;
export const userStatusSchema = z.enum(USER_STATUSES);
export type UserStatus = z.infer<typeof userStatusSchema>;

/** How the acting session last authenticated (`sessions.fresh_auth_method`, Identity §5). */
export const FRESH_AUTH_METHODS = ["passkey", "magic_link"] as const;
export type FreshAuthMethod = (typeof FRESH_AUTH_METHODS)[number];

// ---- Resource roles and the union rule (Permissions §3.2, §5.1) -------------------------------

/** Resource roles, highest first (Permissions §3.2 role ranking). */
export const RESOURCE_ROLES = ["owner", "manager", "editor", "commenter", "viewer", "freebusy"] as const;
export const resourceRoleSchema = z.enum(RESOURCE_ROLES);
export type ResourceRole = z.infer<typeof resourceRoleSchema>;

/** `resource_grants.resource_type` (Permissions §9). */
export const RESOURCE_TYPES = ["document", "whiteboard", "folder", "file", "drive", "calendar", "project"] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];

/** `general_access` levels (Permissions §9). `workspace_freebusy` is valid on calendars only. */
export const GENERAL_ACCESS_LEVELS = [
  "restricted",
  "workspace_freebusy",
  "workspace_view",
  "workspace_comment",
  "workspace_edit",
] as const;
export type GeneralAccess = (typeof GENERAL_ACCESS_LEVELS)[number];

/**
 * Whether `role` may be granted on `type` (Permissions §9: `manager` is valid only for drives and
 * `freebusy` only for calendars; enforced by the engine and Zod, not a CHECK).
 */
export function isResourceRoleValidFor(type: ResourceType, role: ResourceRole): boolean {
  if (role === "manager") return type === "drive";
  if (role === "freebusy") return type === "calendar";
  return true;
}

/** The role that a general-access level gives every active member, or null for `restricted`. */
export function generalAccessRole(level: GeneralAccess): ResourceRole | null {
  switch (level) {
    case "restricted":
      return null;
    case "workspace_freebusy":
      return "freebusy";
    case "workspace_view":
      return "viewer";
    case "workspace_comment":
      return "commenter";
    case "workspace_edit":
      return "editor";
  }
}

const resourceRank = (role: ResourceRole): number => RESOURCE_ROLES.indexOf(role);

/**
 * The union rule's combining step (Permissions §5.1): the highest of the roles a person holds on an
 * item through any path, or null when they hold none. There is no deny.
 */
export function highestResourceRole(roles: Iterable<ResourceRole | null | undefined>): ResourceRole | null {
  let best: ResourceRole | null = null;
  for (const role of roles) {
    if (!role) continue;
    if (best === null || resourceRank(role) < resourceRank(best)) best = role;
  }
  return best;
}

/**
 * Where a role on a resource comes from (Permissions §5.1). Loaders produce one entry per path they
 * found, each already expanded for the user's groups and channels; `role` is null when the path gives
 * nothing (for example `restricted` general access).
 */
export type ResourceRoleSource =
  | { via: "grant"; on: "item" | "folder" | "drive" | "calendar"; role: ResourceRole }
  | {
      via: "builtin";
      rule: "my_files_owner" | "group_drive_member" | "channel_folder" | "calendar_kind";
      role: ResourceRole;
    }
  | { via: "general_access"; on: "item" | "folder" | "drive" | "calendar"; level: GeneralAccess };

/** The effective role from every path (union rule). Sources only widen access; none narrows it. */
export function effectiveResourceRole(sources: Iterable<ResourceRoleSource>): ResourceRole | null {
  const roles: (ResourceRole | null)[] = [];
  for (const source of sources) {
    roles.push(source.via === "general_access" ? generalAccessRole(source.level) : source.role);
  }
  return highestResourceRole(roles);
}

/** Whether `role` is at least `minimum` in the ranking (null, no role, never is). */
export function resourceRoleAtLeast(role: ResourceRole | null, minimum: ResourceRole): boolean {
  return role !== null && resourceRank(role) <= resourceRank(minimum);
}

// ---- Actors, targets and facts -----------------------------------------------------------------

/** The acting session's step-up facts (`sessions.fresh_auth_at`, `fresh_auth_method`; Identity §5). */
export interface SessionFacts {
  /** When this session last authenticated, epoch ms; null when never. */
  freshAuthAt: number | null;
  /** How: only `passkey` satisfies step-up (Identity §4.5). */
  freshAuthMethod: FreshAuthMethod | null;
}

/** The person asking. Loaded by the Worker for every request (Identity §4.5). */
export interface Actor {
  userId: string;
  role: WorkspaceRole;
  status: UserStatus;
  /** The acting session; null outside a session (queue consumers, jobs), which never passes step-up. */
  session: SessionFacts | null;
}

/** Someone an action is aimed at, as stored now (roles are re-read on every check). */
export const personRefSchema = z.object({
  userId: z.string().min(1),
  role: workspaceRoleSchema,
  status: userStatusSchema,
});
export type PersonRef = z.infer<typeof personRefSchema>;

// ---- Actions -----------------------------------------------------------------------------------

/**
 * Workspace actions decided by role alone, with the roles that may take them. The admin area pages
 * and endpoints are Admin §3 and §17; profile and group rows are Permissions §4.6.
 * - `everyone`: owners, admins and members (guests: none until Phase 2 defines them, default)
 * - `admin`: owners and admins
 * - `owner`: owners only (Admin §2 "Owner and admin split")
 */
export const WORKSPACE_ACTION_AUDIENCE = {
  "directory.view": "everyone", // the member directory and profiles (Permissions §4.6)
  "admin.open": "admin", // the admin area (Admin §3)
  "admin.overview.view": "admin",
  "admin.alerts.dismiss": "admin", // info and warning alerts (Admin §17)
  "admin.members.view": "admin", // the member list (Admin §5)
  "admin.invitations.view": "admin", // pending invitations (Admin §3)
  "admin.groups.view": "admin",
  "admin.settings.view": "admin", // owner-only keys shown aria-disabled (Admin §6)
  "admin.health.view": "admin", // detailed health (Admin §8)
  "admin.storage.view": "admin", // budgets are owner-only settings (Admin §9)
  "admin.assistant.view": "admin", // usage aggregates and metadata log (Assistant §10-§11)
  "admin.data.view": "admin", // export list and status (Admin §11, §12)
  "admin.exports.manage": "admin", // cancel and delete exports (Admin §17)
  "admin.maintenance.view": "admin", // admins: view only (Admin §13)
  "admin.updates.view": "admin", // admins: view only (Admin §14)
  "admin.jobs.view": "admin", // bulk-job progress; admins see their own (Admin §17, see admin.job.view)
  "audit.view": "admin", // the audit log viewer (Permissions §4.6, Admin §7)
  "groups.manage": "admin", // create, rename, delete groups; appoint managers (Permissions §4.6)
  "members.bulk": "admin", // bulk preview and execute; each member is re-checked by its own action (Admin §5)
  "invitations.bulk": "admin", // CSV invite; each row is re-checked by invitation.create (Admin §5.1)
  "content.transfer": "admin", // transfer leavers' content (Permissions §6)
  "members.csv.download": "admin", // step-up (Admin §5.4, §11.3)
  "audit.csv.download": "admin", // step-up (Admin §7, §11.3)
  "admin.usage.view": "owner", // Admin §10
  "admin.checklist.manage": "owner", // view and mark (Admin §15)
  "admin.telemetry.view": "owner", // payload preview (Admin §8.4)
  "admin.diagnostics.download": "owner", // support bundle (Admin §8.3)
  "admin.restore_report.dismiss": "owner", // Admin §11.4
  "maintenance.manage": "owner", // schedule, start, reschedule, cancel, end (Admin §13)
  "domain.move_start": "owner", // step-up (Identity §4.4, Permissions §6)
  "domain.move_commit": "owner", // committed by a passkey registration on the new origin, no step-up
  "domain.move_cancel": "owner",
} as const satisfies Record<string, "everyone" | "admin" | "owner">;

export type WorkspaceAction = keyof typeof WORKSPACE_ACTION_AUDIENCE;
export const WORKSPACE_ACTIONS = Object.keys(WORKSPACE_ACTION_AUDIENCE) as WorkspaceAction[];

/** Admin actions on a person (Permissions §4.6, §6): members only for admins, anyone for owners. */
export const MEMBER_ADMIN_ACTIONS = [
  "member.change_email", // step-up
  "member.issue_recovery_link", // step-up
  "member.disable",
  "member.enable",
  "member.delete",
  "member.sign_out_all",
] as const;
export type MemberAdminAction = (typeof MEMBER_ADMIN_ACTIONS)[number];

/** Adding or removing someone from a group (Permissions §4.6, Identity §4.9). */
export const GROUP_MEMBER_ACTIONS = ["group.add_member", "group.remove_member"] as const;
export type GroupMemberAction = (typeof GROUP_MEMBER_ACTIONS)[number];

/** Actions on a person's own things: only that person (Permissions §4.6 "Edit own profile, ..."). */
export const SELF_ACTIONS = [
  "profile.edit",
  "devices.view", // list own sessions
  "devices.sign_out", // sign out one own session, all other devices, or everywhere
  "passkey.rename",
] as const;
export type SelfAction = (typeof SELF_ACTIONS)[number];

/** Who may change an admin setting (Platform §7 "Who can change"). */
export type SettingChanger = "admin" | "owner";

/** The two phases of an export the engine checks (Admin §11.1, §11.3, §12). */
export type ExportPhase = "start" | "download";

export type PermissionCheck =
  | { action: WorkspaceAction }
  | { action: "admin.job.view"; startedBy: string }
  | {
      action: "invitation.create";
      role: WorkspaceRole;
      /** The acting owner's passkeys, for the owners' invite gate (Identity §2). */
      actorPasskeyCount: number;
      /** `RECOVERY_TOKEN` set and not yet consumed (Identity §4.6). */
      recoveryTokenUnconsumed: boolean;
    }
  | {
      action: MemberAdminAction;
      target: PersonRef;
      /** Active owners in the workspace, for the last-owner rule. */
      activeOwnerCount: number;
    }
  | {
      action: "member.change_role";
      target: PersonRef;
      newRole: WorkspaceRole;
      activeOwnerCount: number;
      /** The target's passkeys, for the promotion rule (Identity §2 "Promotion"). */
      targetPasskeyCount: number;
      recoveryTokenUnconsumed: boolean;
    }
  | { action: "member.export"; subject: PersonRef; phase: ExportPhase }
  | { action: "workspace.export"; phase: ExportPhase; inMaintenance: boolean }
  | { action: GroupMemberAction; group: { managerIds: readonly string[] }; target: PersonRef }
  | { action: SelfAction; ownerId: string }
  | { action: "passkey.add"; ownerId: string; ownerPasskeyCount: number }
  | {
      action: "passkey.remove";
      ownerId: string;
      ownerPasskeyCount: number;
      /** Email configured and `magic_link_enabled` on (Identity §2 "Removing the last passkey"). */
      magicLinksAvailable: boolean;
    }
  | { action: "setting.change"; changeableBy: SettingChanger };

export type PermissionAction = PermissionCheck["action"];

// ---- Step-up -----------------------------------------------------------------------------------

/** Step-up window: a passkey assertion within the last 10 minutes; exactly 10 minutes passes (Admin §18). */
export const STEP_UP_WINDOW_MS = 10 * 60 * 1000;

/**
 * How far in the future a stored `fresh_auth_at` may be and still count, for clock differences between
 * Cloudflare machines **(default)**. A later timestamp is treated as not fresh. The cost: a stamp
 * written by a machine whose clock runs up to 60 s fast stays valid for up to 11 minutes of real time.
 */
export const STEP_UP_CLOCK_SKEW_MS = 60 * 1000;

/** Actions that need step-up (Identity §4.5, Permissions §6, Admin §11.3). Exports: downloads only. */
export const STEP_UP_ACTIONS = [
  "member.change_role",
  "member.change_email",
  "member.issue_recovery_link",
  "domain.move_start",
  "passkey.add",
  "passkey.remove",
  "members.csv.download",
  "audit.csv.download",
  "workspace.export", // phase "download"
  "member.export", // phase "download"
] as const satisfies readonly PermissionAction[];

/** Whether `freshAuthAt` (any method) lies within the step-up window at `now`. */
export function isWithinStepUpWindow(freshAuthAt: number | null, now: number): boolean {
  if (freshAuthAt === null) return false;
  const age = now - freshAuthAt;
  return age <= STEP_UP_WINDOW_MS && age >= -STEP_UP_CLOCK_SKEW_MS;
}

/** Whether the session has a passkey assertion within the step-up window. */
export function hasFreshPasskeyAuth(session: SessionFacts | null, now: number): boolean {
  return session !== null && session.freshAuthMethod === "passkey" && isWithinStepUpWindow(session.freshAuthAt, now);
}

function needsStepUp(check: PermissionCheck): boolean {
  switch (check.action) {
    case "workspace.export":
    case "member.export":
      return check.phase === "download";
    default:
      return (STEP_UP_ACTIONS as readonly string[]).includes(check.action);
  }
}

// ---- Decisions ---------------------------------------------------------------------------------

/** Why a check was denied. The Worker maps `reauth_required` to that error code, the rest to `forbidden`. */
export const DENIAL_REASONS = [
  "inactive", // the actor is disabled or deleted
  "system_actor", // a reserved system row (system sender, assistant): never an actor
  "not_permitted", // the actor's role never allows this
  "owner_required", // an admin acting on an admin or owner, or an owner-only action (Identity §8)
  "last_owner", // it would leave the workspace without an active owner
  "not_own", // someone else's profile, devices or passkeys
  "role_not_assignable", // guest, or owner by invitation
  "invalid_target", // the target is a reserved system row or a deleted (anonymised) member (default)
  "self_target", // disabling or deleting yourself (default, after Admin §5.3)
  "owner_invite_gate", // an owner needs a second passkey or an unconsumed RECOVERY_TOKEN to invite
  "promotion_passkeys", // the person lacks the passkeys a promotion needs
  "last_passkey", // removing the last passkey when no other sign-in method works
  "reauth_required", // step-up: no passkey assertion on this session within 10 minutes
] as const;
export const denialReasonSchema = z.enum(DENIAL_REASONS);
export type DenialReason = z.infer<typeof denialReasonSchema>;

/** `ok` to go ahead; `err` with the reason otherwise. */
export type Decision = Result<void, DenialReason>;

const ALLOW: Decision = ok();
const deny = (reason: DenialReason): Decision => err(reason);

const isManager = (role: WorkspaceRole): boolean => role === "owner" || role === "admin";

/**
 * Facts arrive from storage and requests, so the engine never trusts that a role, status or action is
 * one it knows: anything unknown is denied, never allowed by falling through (fail closed).
 */
const isOneOf = (list: readonly string[], value: unknown): boolean => typeof value === "string" && list.includes(value);
const isKnownRole = (role: unknown): role is WorkspaceRole => isOneOf(WORKSPACE_ROLES, role);
const isKnownStatus = (status: unknown): status is UserStatus => isOneOf(USER_STATUSES, status);

/** The audience of a workspace action, or null when `action` isn't one (own keys only, no prototype). */
export function audienceOf(action: string): "everyone" | "admin" | "owner" | null {
  return Object.hasOwn(WORKSPACE_ACTION_AUDIENCE, action) ? WORKSPACE_ACTION_AUDIENCE[action as WorkspaceAction] : null;
}

/** Would losing `target` as an active owner leave none? */
function isLastOwner(target: PersonRef, activeOwnerCount: number): boolean {
  return target.role === "owner" && target.status === "active" && activeOwnerCount <= 1;
}

/** A target whose role or status isn't a known value; never acted on. */
const isUnknownPerson = (target: PersonRef): boolean => !isKnownRole(target.role) || !isKnownStatus(target.status);

/**
 * Reserved rows, anonymised (deleted) members and unknown values aren't people an action can be
 * aimed at **(default)**.
 */
const isInvalidTarget = (target: PersonRef): boolean =>
  isUnknownPerson(target) || target.status === "system" || target.status === "deleted";

function workspaceRule(actor: Actor, audience: "everyone" | "admin" | "owner"): Decision {
  switch (audience) {
    case "everyone":
      return actor.role === "owner" || actor.role === "admin" || actor.role === "member"
        ? ALLOW
        : deny("not_permitted");
    case "admin":
      return isManager(actor.role) ? ALLOW : deny("not_permitted");
    case "owner":
      if (!isManager(actor.role)) return deny("not_permitted");
      return actor.role === "owner" ? ALLOW : deny("owner_required");
    default:
      return deny("not_permitted");
  }
}

function jobViewRule(actor: Actor, startedBy: string): Decision {
  if (!isManager(actor.role)) return deny("not_permitted");
  // Admins see the jobs they started; owners see any (Admin §17).
  if (actor.role === "admin" && startedBy !== actor.userId) return deny("owner_required");
  return ALLOW;
}

function invitationRule(actor: Actor, check: Extract<PermissionCheck, { action: "invitation.create" }>): Decision {
  if (!isManager(actor.role)) return deny("not_permitted");
  if (!(INVITABLE_WORKSPACE_ROLES as readonly string[]).includes(check.role)) return deny("role_not_assignable");
  if (check.role === "admin" && actor.role !== "owner") return deny("owner_required");
  // The owners' gate, on every owner invite; admins inviting members are never gated (Identity §2).
  if (actor.role === "owner" && check.actorPasskeyCount < 2 && !check.recoveryTokenUnconsumed) {
    return deny("owner_invite_gate");
  }
  return ALLOW;
}

function memberAdminRule(actor: Actor, check: Extract<PermissionCheck, { action: MemberAdminAction }>): Decision {
  const { action, target, activeOwnerCount } = check;
  if (!isManager(actor.role)) return deny("not_permitted");
  if (isInvalidTarget(target)) return deny("invalid_target");
  if (actor.role === "admin" && isManager(target.role)) return deny("owner_required");
  const removes = action === "member.disable" || action === "member.delete";
  if (removes && target.userId === actor.userId) return deny("self_target");
  if (removes && isLastOwner(target, activeOwnerCount)) return deny("last_owner");
  return ALLOW;
}

const ROLE_ORDER: Record<WorkspaceRole, number> = { guest: 0, member: 1, admin: 2, owner: 3 };

function changeRoleRule(actor: Actor, check: Extract<PermissionCheck, { action: "member.change_role" }>): Decision {
  const { target, newRole } = check;
  if (!isManager(actor.role)) return deny("not_permitted");
  // Only owners change roles: admins can't promote or demote anyone (Permissions §4.6).
  if (actor.role !== "owner") return deny("owner_required");
  if (isInvalidTarget(target)) return deny("invalid_target");
  if (!(ASSIGNABLE_WORKSPACE_ROLES as readonly string[]).includes(newRole)) return deny("role_not_assignable");
  if (newRole !== "owner" && isLastOwner(target, check.activeOwnerCount)) return deny("last_owner");
  const promotes = ROLE_ORDER[newRole] > ROLE_ORDER[target.role];
  // A disabled member can be demoted but not promoted (default): re-enable them first.
  if (promotes && target.status === "disabled") return deny("invalid_target");
  // Promotion rule (Identity §2): to admin, at least one passkey; to owner, two passkeys or an
  // unconsumed RECOVERY_TOKEN. Only a move up is a promotion; keeping or lowering a role isn't gated.
  // Every promotion also needs at least one passkey (default): owners and admins sign in with
  // passkeys only, so a member promoted with none (signed in by magic link) would be locked out.
  if (promotes) {
    if (check.targetPasskeyCount < 1) return deny("promotion_passkeys");
    if (newRole === "owner" && check.targetPasskeyCount < 2 && !check.recoveryTokenUnconsumed) {
      return deny("promotion_passkeys");
    }
  }
  return ALLOW;
}

function memberExportRule(actor: Actor, subject: PersonRef): Decision {
  if (!isManager(actor.role)) return deny("not_permitted");
  // Deleted subjects stay exportable (default): an export of someone deleted since it started can
  // still be downloaded until it expires (Admin §11.2). Reserved rows and unknown values can't.
  if (isUnknownPerson(subject) || subject.status === "system") return deny("invalid_target");
  // A subject who is, or has since become, an admin or owner needs an owner (Admin §12). The
  // Worker passes the subject's role as stored now, at start and at every download.
  if (actor.role === "admin" && isManager(subject.role)) return deny("owner_required");
  return ALLOW;
}

function workspaceExportRule(actor: Actor, phase: ExportPhase, inMaintenance: boolean): Decision {
  if (!isManager(actor.role)) return deny("not_permitted");
  // The maintenance option on a workspace export is owner-only (Admin §13.4, §17).
  if (phase === "start" && inMaintenance && actor.role !== "owner") return deny("owner_required");
  return ALLOW;
}

function groupMemberRule(actor: Actor, check: Extract<PermissionCheck, { action: GroupMemberAction }>): Decision {
  const { action, group, target } = check;
  const managesGroup = group.managerIds.includes(actor.userId);
  if (!isManager(actor.role) && !managesGroup) return deny("not_permitted");
  if (isInvalidTarget(target)) return deny("invalid_target");
  // Disabled members can be removed from groups but not added (default).
  if (action === "group.add_member" && target.status === "disabled") return deny("invalid_target");
  // An admin adding themselves needs an owner (Permissions §2, §6), even if they manage the group:
  // it would give them everything shared with the group (default for the manager case).
  if (action === "group.add_member" && actor.role === "admin" && target.userId === actor.userId) {
    return deny("owner_required");
  }
  return ALLOW;
}

function ownRule(actor: Actor, ownerId: string): Decision {
  return actor.userId === ownerId ? ALLOW : deny("not_own");
}

function passkeyRemoveRule(actor: Actor, check: Extract<PermissionCheck, { action: "passkey.remove" }>): Decision {
  if (actor.userId !== check.ownerId) return deny("not_own");
  // The last passkey: only a member for whom magic links work may remove it (Identity §2).
  if (check.ownerPasskeyCount <= 1 && !(actor.role === "member" && check.magicLinksAvailable)) {
    return deny("last_passkey");
  }
  return ALLOW;
}

function settingRule(actor: Actor, changeableBy: SettingChanger): Decision {
  if (!isManager(actor.role)) return deny("not_permitted");
  if (changeableBy === "owner" && actor.role !== "owner") return deny("owner_required");
  return ALLOW;
}

/** Step 2: the action's own rule. */
function rule(actor: Actor, check: PermissionCheck): Decision {
  switch (check.action) {
    case "admin.job.view":
      return jobViewRule(actor, check.startedBy);
    case "invitation.create":
      return invitationRule(actor, check);
    case "member.change_email":
    case "member.issue_recovery_link":
    case "member.disable":
    case "member.enable":
    case "member.delete":
    case "member.sign_out_all":
      return memberAdminRule(actor, check);
    case "member.change_role":
      return changeRoleRule(actor, check);
    case "member.export":
      return memberExportRule(actor, check.subject);
    case "workspace.export":
      return workspaceExportRule(actor, check.phase, check.inMaintenance);
    case "group.add_member":
    case "group.remove_member":
      return groupMemberRule(actor, check);
    case "profile.edit":
    case "devices.view":
    case "devices.sign_out":
    case "passkey.rename":
    case "passkey.add":
      return ownRule(actor, check.ownerId);
    case "passkey.remove":
      return passkeyRemoveRule(actor, check);
    case "setting.change":
      return settingRule(actor, check.changeableBy);
    default: {
      // An action that reaches here at runtime may be any string: look it up as an own key only.
      const audience = audienceOf((check as { action: string }).action);
      return audience ? workspaceRule(actor, audience) : deny("not_permitted");
    }
  }
}

/** Step 3: whether this session may take a sensitive action now. */
function stepUp(actor: Actor, check: PermissionCheck, now: number): Decision {
  if (!needsStepUp(check)) return ALLOW;
  if (hasFreshPasskeyAuth(actor.session, now)) return ALLOW;
  // One exception (Identity §4.5): a member with no passkeys may add their first within 10 minutes of
  // a magic-link sign-in, or they'd have no way back to passkeys.
  if (
    check.action === "passkey.add" &&
    check.ownerPasskeyCount === 0 &&
    actor.role === "member" &&
    actor.session?.freshAuthMethod === "magic_link" &&
    isWithinStepUpWindow(actor.session.freshAuthAt, now)
  ) {
    return ALLOW;
  }
  return deny("reauth_required");
}

/**
 * Why this actor can't act at all, or null: a non-active status (unknown statuses included), an
 * unknown role, or a guest. Guests are refused everything, own account included, **(default)** until
 * Phase 2 defines them (Permissions §3.1).
 */
export function actorDenial(actor: Pick<Actor, "status" | "role">): DenialReason | null {
  if (actor.status === "system") return "system_actor";
  if (actor.status !== "active") return "inactive";
  if (!isKnownRole(actor.role) || actor.role === "guest") return "not_permitted";
  return null;
}

/**
 * Step 1 and the role part of step 2, with no facts: a denial when the actor can't take `action`
 * whatever the facts, `ok` when the answer depends on facts. `decide` runs it first, so the two always
 * agree; the Worker runs it **before loading facts**, so a request that's about to be denied costs no
 * queries and can't learn whether its target exists.
 */
export function decideWithoutFacts(actor: Actor, action: string): Decision {
  const refused = actorDenial(actor);
  if (refused) return deny(refused);
  const audience = audienceOf(action);
  if (audience) return workspaceRule(actor, audience);
  switch (action) {
    case "admin.job.view":
    case "invitation.create":
    case "member.change_email":
    case "member.issue_recovery_link":
    case "member.disable":
    case "member.enable":
    case "member.delete":
    case "member.sign_out_all":
    case "member.export":
    case "workspace.export":
    case "setting.change":
      return isManager(actor.role) ? ALLOW : deny("not_permitted");
    case "member.change_role":
      if (!isManager(actor.role)) return deny("not_permitted");
      return actor.role === "owner" ? ALLOW : deny("owner_required");
    case "group.add_member":
    case "group.remove_member": // a group manager may be a member: the answer needs the group's managers
    case "profile.edit":
    case "devices.view":
    case "devices.sign_out":
    case "passkey.rename":
    case "passkey.add":
    case "passkey.remove":
      return ALLOW;
    default:
      return deny("not_permitted");
  }
}

/**
 * Decides one check at time `now` (epoch ms). Pure: the caller supplies every fact.
 */
export function decide(actor: Actor, check: PermissionCheck, now: number): Decision {
  const pre = decideWithoutFacts(actor, check.action);
  if (!pre.ok) return pre;
  const decision = rule(actor, check);
  if (!decision.ok) return decision;
  return stepUp(actor, check, now);
}

/** Convenience for UI affordances: whether `decide` allows the check. Never an enforcement point. */
export function can(actor: Actor, check: PermissionCheck, now: number): boolean {
  return decide(actor, check, now).ok;
}

/**
 * A developer-facing description of a denial, for the `message` of the API error and for logs. Clients
 * show their own copy, keyed by the error's `reason` (apps/web messages).
 */
export function denialMessage(reason: DenialReason): string {
  switch (reason) {
    case "inactive":
    case "system_actor":
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
    case "invalid_target":
      return "That person can't be changed.";
    case "self_target":
      return "You can't do that to your own account.";
    case "owner_invite_gate":
      return "Add a second passkey, or set a recovery token, before inviting people.";
    case "promotion_passkeys":
      return "This person needs more passkeys before they can have that role.";
    case "last_passkey":
      return "You can't remove your last passkey.";
    case "reauth_required":
      return "Confirm it's you with a passkey to continue.";
  }
}

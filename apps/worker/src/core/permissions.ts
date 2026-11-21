import {
  apiError,
  decide,
  decideWithoutFacts,
  denialMessage,
  err,
  ok,
  type Actor,
  type ApiError,
  type DenialReason,
  type ExportPhase,
  type GroupMemberAction,
  type MemberAdminAction,
  type PermissionCheck,
  personRefSchema,
  type PersonRef,
  type Result,
  type SelfAction,
  type SettingChanger,
  type WorkspaceAction,
  type WorkspaceRole,
} from "@officebox/shared";
import type { Logger } from "./log";

/**
 * The Worker side of the permission engine (Permissions §8: every route that reads or writes user
 * content calls the engine; no ad-hoc checks in routes, AGENTS §4.1).
 *
 * Routes describe **what** is being attempted as a {@link PermissionRequest} (an action and IDs).
 * `authorize` loads the facts that action's rule needs through injectable {@link PermissionFacts}
 * loaders, builds the engine's `PermissionCheck`, runs the pure `decide` from `packages/shared`, and
 * returns a typed result:
 * - allowed: `ok()`
 * - a step-up denial: `reauth_required` (HTTP 403), so the UI asks for a passkey and retries
 * - any other denial: `forbidden` (HTTP 403), or `not_found` with `hideAs404` where the route mustn't
 *   reveal that the object exists
 * - a target that doesn't exist: `not_found`.
 *
 * Both error kinds carry the engine's `reason`, so the web app can show specific copy. Denials are
 * logged at info level with the action, reason and actor ID, never names, emails or other personal
 * data. Loader failures are real failures and throw (AGENTS §4.1).
 *
 * The loaders are injected so this module needs no identity tables: M1a/M1b/M1e wire D1-backed
 * loaders (users, passkeys, `recovery_token_uses`, settings, groups); tests pass stubs.
 *
 * **Order:** the fact-free part of the decision (`decideWithoutFacts`: status, role, the action's
 * audience) runs **before any fact is loaded**. A request that's about to be denied costs no queries,
 * and an actor who couldn't act on a target anyway gets `forbidden`, never a `not_found` that would
 * tell them whether the target exists. Facts from loaders are parsed with the shared Zod schemas: a
 * person with an unknown role or status is refused (`invalid_target`), never acted on.
 *
 * **Bulk jobs** (Admin §5) must rebuild the `Actor` from storage for **each item** they process and
 * call `authorize` per item, so a demotion or sign-out mid-job takes effect at once.
 *
 * **Extending:** a feature adding a check type to the engine adds the route-facing request here, a
 * loader for each new fact, and a case in `buildCheck`. Features whose facts are already in hand (for
 * example a Durable Object that knows channel membership) can call {@link authorizeCheck} directly
 * with a complete `PermissionCheck`.
 */

/** What a route asks, by ID. `authorize` loads the facts. */
export type PermissionRequest =
  | { action: WorkspaceAction }
  | { action: "admin.job.view"; startedBy: string }
  | { action: "invitation.create"; role: WorkspaceRole }
  | { action: "invitation.revoke"; role: WorkspaceRole }
  | { action: MemberAdminAction; targetId: string }
  | { action: "member.change_role"; targetId: string; newRole: WorkspaceRole }
  | { action: "member.export"; subjectId: string; phase: ExportPhase }
  | { action: "workspace.export"; phase: ExportPhase; inMaintenance: boolean }
  | { action: GroupMemberAction; groupId: string; memberId: string }
  | { action: SelfAction; ownerId: string }
  | { action: "profile.view"; targetId: string }
  | { action: "passkey.add" | "passkey.remove"; ownerId: string }
  | { action: "setting.change"; changeableBy: SettingChanger };

/**
 * Fact loaders. Each reads current state (roles are re-read on every check, never cached across
 * requests) and returns plain values. Implementations must read the D1 primary (or with a Sessions
 * bookmark) so a just-committed change counts (Identity §4.5).
 */
export interface PermissionFacts {
  /** A person's current role and status, or null when no such user exists. */
  person(userId: string): Promise<PersonRef | null>;
  /**
   * Users with role `owner` and status `active`. The engine's last-owner decision is never the last
   * line of defence: the count can change between this read and the write, so the write that
   * disables, deletes or demotes an owner must also be conditional (Admin §5.3:
   * `UPDATE … WHERE (SELECT count(*) …) >= 1`), and the route treats a no-op write as `last_owner`.
   */
  activeOwnerCount(): Promise<number>;
  /** Registered passkeys of a user. */
  passkeyCount(userId: string): Promise<number>;
  /** `RECOVERY_TOKEN` is set and its hash isn't in `recovery_token_uses` (Identity §4.6). */
  recoveryTokenUnconsumed(): Promise<boolean>;
  /** Email is configured and `magic_link_enabled` is on (Identity §2). */
  magicLinksAvailable(): Promise<boolean>;
  /** The managers of a group, or null when no such group exists. */
  groupManagerIds(groupId: string): Promise<readonly string[] | null>;
}

/** What `authorize` needs from its caller: the actor (from the session), a clock, a logger, the loaders. */
export interface PermissionContext {
  log: Logger;
  /** Epoch ms; injectable for tests. */
  now: () => number;
  actor: Actor;
  facts: PermissionFacts;
}

export interface AuthorizeOptions {
  /** Answer `not_found` instead of `forbidden`, so the caller can't tell the object exists. */
  hideAs404?: boolean;
}

const NOT_FOUND: ApiError = apiError("not_found", "Not found.");

/**
 * The typed error for a denial. `reauth_required` is never hidden as a 404: the actor may act once
 * they confirm with a passkey, so the object's existence isn't a secret from them.
 */
export function denialError(reason: DenialReason, options: AuthorizeOptions = {}): ApiError {
  if (reason === "reauth_required") return apiError("reauth_required", denialMessage(reason), { reason });
  if (options.hideAs404) return NOT_FOUND;
  return apiError("forbidden", denialMessage(reason), { reason });
}

function refuse(
  ctx: Pick<PermissionContext, "log" | "actor">,
  action: string,
  reason: DenialReason,
  options: AuthorizeOptions,
) {
  ctx.log.info("permission denied", { action, reason, actorId: ctx.actor.userId });
  return err(denialError(reason, options));
}

/** Decides a complete check (facts already loaded). Synchronous; never throws for a denial. */
export function authorizeCheck(
  ctx: Pick<PermissionContext, "log" | "now" | "actor">,
  check: PermissionCheck,
  options: AuthorizeOptions = {},
): Result<void, ApiError> {
  const decision = decide(ctx.actor, check, ctx.now());
  if (decision.ok) return ok();
  return refuse(ctx, check.action, decision.error, options);
}

type Built = Result<PermissionCheck, "not_found" | DenialReason>;

/** Loads a person and parses them: null when missing, `invalid_target` when a value is unknown. */
async function loadPerson(
  facts: PermissionFacts,
  userId: string,
): Promise<Result<PersonRef, "not_found" | DenialReason>> {
  const loaded = await facts.person(userId);
  if (!loaded) return err("not_found");
  const parsed = personRefSchema.safeParse(loaded);
  return parsed.success ? ok(parsed.data) : err("invalid_target");
}

/** Loads the facts a request's rule needs and builds the engine's check. */
async function buildCheck(actor: Actor, request: PermissionRequest, facts: PermissionFacts): Promise<Built> {
  switch (request.action) {
    case "admin.job.view":
    case "workspace.export":
    case "setting.change":
    case "invitation.revoke":
    case "profile.edit":
    case "status.edit":
    case "handle.change":
    case "avatar.edit":
    case "devices.view":
    case "devices.sign_out":
    case "passkey.rename":
    case "dnd.edit":
    case "preferences.edit":
    case "ws_ticket.create":
    case "security_notice.ack":
      return ok(request);
    case "invitation.create": {
      const [actorPasskeyCount, recoveryTokenUnconsumed] = await Promise.all([
        facts.passkeyCount(actor.userId),
        facts.recoveryTokenUnconsumed(),
      ]);
      return ok({ action: request.action, role: request.role, actorPasskeyCount, recoveryTokenUnconsumed });
    }
    case "member.change_email":
    case "member.issue_recovery_link":
    case "member.disable":
    case "member.enable":
    case "member.delete":
    case "member.sign_out_all": {
      const [target, activeOwnerCount] = await Promise.all([
        loadPerson(facts, request.targetId),
        facts.activeOwnerCount(),
      ]);
      if (!target.ok) return target;
      return ok({ action: request.action, target: target.value, activeOwnerCount });
    }
    case "member.change_role": {
      const [target, activeOwnerCount, targetPasskeyCount, recoveryTokenUnconsumed] = await Promise.all([
        loadPerson(facts, request.targetId),
        facts.activeOwnerCount(),
        facts.passkeyCount(request.targetId),
        facts.recoveryTokenUnconsumed(),
      ]);
      if (!target.ok) return target;
      return ok({
        action: request.action,
        target: target.value,
        newRole: request.newRole,
        activeOwnerCount,
        targetPasskeyCount,
        recoveryTokenUnconsumed,
      });
    }
    case "profile.view": {
      const target = await loadPerson(facts, request.targetId);
      if (!target.ok) return target;
      return ok({ action: request.action, target: target.value });
    }
    case "member.export": {
      // The subject's role as stored now, at start and at every download (Admin §12).
      const subject = await loadPerson(facts, request.subjectId);
      if (!subject.ok) return subject;
      return ok({ action: request.action, subject: subject.value, phase: request.phase });
    }
    case "group.add_member":
    case "group.remove_member": {
      // Owners and admins may act on any group, so a missing group is not_found for them. Anyone else
      // acts only as the group's manager: load the managers first, and refuse (never not_found) when
      // the group is missing or they don't manage it, before looking up the member.
      const managesAny = actor.role === "owner" || actor.role === "admin";
      const managerIds = await facts.groupManagerIds(request.groupId);
      if (!managesAny && !managerIds?.includes(actor.userId)) return err("not_permitted");
      if (!managerIds) return err("not_found");
      const target = await loadPerson(facts, request.memberId);
      if (!target.ok) return target;
      return ok({ action: request.action, group: { managerIds }, target: target.value });
    }
    case "passkey.add": {
      // Someone else's passkeys are refused as not_own by the engine; their count isn't loaded.
      const ownerPasskeyCount = request.ownerId === actor.userId ? await facts.passkeyCount(actor.userId) : 0;
      return ok({ action: request.action, ownerId: request.ownerId, ownerPasskeyCount });
    }
    case "passkey.remove": {
      if (request.ownerId !== actor.userId) {
        return ok({
          action: request.action,
          ownerId: request.ownerId,
          ownerPasskeyCount: 0,
          magicLinksAvailable: false,
        });
      }
      const [ownerPasskeyCount, magicLinksAvailable] = await Promise.all([
        facts.passkeyCount(actor.userId),
        facts.magicLinksAvailable(),
      ]);
      return ok({ action: request.action, ownerId: request.ownerId, ownerPasskeyCount, magicLinksAvailable });
    }
    default:
      return ok({ action: request.action });
  }
}

/**
 * Authorizes a request: `ok()` to go ahead, otherwise the typed error for the route to return. An
 * actor the fact-free check refuses (inactive, system, unknown role, guest, or a role that can't take
 * the action) is refused before any fact is loaded.
 */
export async function authorize(
  ctx: PermissionContext,
  request: PermissionRequest,
  options: AuthorizeOptions = {},
): Promise<Result<void, ApiError>> {
  const pre = decideWithoutFacts(ctx.actor, request.action);
  if (!pre.ok) return refuse(ctx, request.action, pre.error, options);
  const check = await buildCheck(ctx.actor, request, ctx.facts);
  if (!check.ok) {
    if (check.error !== "not_found") return refuse(ctx, request.action, check.error, options);
    ctx.log.info("permission target not found", { action: request.action, actorId: ctx.actor.userId });
    return err(NOT_FOUND);
  }
  return authorizeCheck(ctx, check.value, options);
}

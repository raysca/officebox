import {
  actorDenial,
  apiError,
  decide,
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
  | { action: MemberAdminAction; targetId: string }
  | { action: "member.change_role"; targetId: string; newRole: WorkspaceRole }
  | { action: "member.export"; subjectId: string; phase: ExportPhase }
  | { action: "workspace.export"; phase: ExportPhase; inMaintenance: boolean }
  | { action: GroupMemberAction; groupId: string; memberId: string }
  | { action: SelfAction; ownerId: string }
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
  /** Users with role `owner` and status `active`. */
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

type Built = Result<PermissionCheck, "not_found">;

/** Loads the facts a request's rule needs and builds the engine's check. */
async function buildCheck(actor: Actor, request: PermissionRequest, facts: PermissionFacts): Promise<Built> {
  switch (request.action) {
    case "admin.job.view":
    case "workspace.export":
    case "setting.change":
    case "profile.edit":
    case "devices.view":
    case "devices.sign_out":
    case "passkey.rename":
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
      const [target, activeOwnerCount] = await Promise.all([facts.person(request.targetId), facts.activeOwnerCount()]);
      if (!target) return err("not_found");
      return ok({ action: request.action, target, activeOwnerCount });
    }
    case "member.change_role": {
      const [target, activeOwnerCount, targetPasskeyCount, recoveryTokenUnconsumed] = await Promise.all([
        facts.person(request.targetId),
        facts.activeOwnerCount(),
        facts.passkeyCount(request.targetId),
        facts.recoveryTokenUnconsumed(),
      ]);
      if (!target) return err("not_found");
      return ok({
        action: request.action,
        target,
        newRole: request.newRole,
        activeOwnerCount,
        targetPasskeyCount,
        recoveryTokenUnconsumed,
      });
    }
    case "member.export": {
      // The subject's role as stored now, at start and at every download (Admin §12).
      const subject = await facts.person(request.subjectId);
      if (!subject) return err("not_found");
      return ok({ action: request.action, subject, phase: request.phase });
    }
    case "group.add_member":
    case "group.remove_member": {
      const [managerIds, target] = await Promise.all([
        facts.groupManagerIds(request.groupId),
        facts.person(request.memberId),
      ]);
      if (!managerIds || !target) return err("not_found");
      return ok({ action: request.action, group: { managerIds }, target });
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
 * inactive or system actor is refused before any fact is loaded.
 */
export async function authorize(
  ctx: PermissionContext,
  request: PermissionRequest,
  options: AuthorizeOptions = {},
): Promise<Result<void, ApiError>> {
  const refused = actorDenial(ctx.actor);
  if (refused) return refuse(ctx, request.action, refused, options);
  const check = await buildCheck(ctx.actor, request, ctx.facts);
  if (!check.ok) return err(NOT_FOUND);
  return authorizeCheck(ctx, check.value, options);
}

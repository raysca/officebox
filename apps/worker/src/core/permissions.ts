import {
  apiError,
  decide,
  denialMessage,
  err,
  ok,
  type Actor,
  type ApiError,
  type DenialReason,
  type PermissionCheck,
  type Result,
} from "@officebox/shared";
import type { AuthContext, CoreContext } from "./context";

/**
 * The Worker side of the permission engine (permissions §8: every route that reads or writes user
 * content calls the engine; no ad-hoc checks in routes, AGENTS §4.1).
 *
 * `authorize` runs the pure engine from `packages/shared` on facts the Worker has loaded and turns a
 * denial into a typed `forbidden` error (or `not_found` where the route mustn't reveal that the object
 * exists). Denials are logged at info level with the action and reason, never with personal data.
 *
 * Fact loaders for checks that need them (for example the active-owner count for the last-owner rule,
 * from M1e) belong here too, so routes don't query for permission facts themselves.
 */

export interface AuthorizeOptions {
  /** Answer `not_found` instead of `forbidden`, so the caller can't tell the object exists. */
  hideAs404?: boolean;
}

export function denialError(reason: DenialReason, options: AuthorizeOptions = {}): ApiError {
  if (options.hideAs404) return apiError("not_found", "Not found.");
  return apiError("forbidden", denialMessage(reason));
}

/** The engine's view of the signed-in person. */
export function actorOf(auth: AuthContext): Actor {
  return { userId: auth.userId, role: auth.role, status: auth.status };
}

/** Decides `check` for `actor`. `Ok` to go ahead; `Err` with the typed error to return otherwise. */
export function authorize(
  ctx: Pick<CoreContext, "log">,
  actor: Actor,
  check: PermissionCheck,
  options: AuthorizeOptions = {},
): Result<void, ApiError> {
  const decision = decide(actor, check);
  if (decision.allowed) return ok();
  ctx.log.info("permission denied", { action: check.action, reason: decision.reason, actorId: actor.userId });
  return err(denialError(decision.reason, options));
}

import { apiError } from "@officebox/shared";
import type { MiddlewareHandler } from "hono";
import { coreContext, type AppEnv } from "../../core/context";
import { errorResponse } from "../../core/errors";
import { readAccessCookie } from "./cookies";
import { identitySecrets } from "./secrets";
import { authenticate } from "./sessions";
import { isSetupComplete } from "./setup-state";

/**
 * Requires a signed-in person (Identity §4.5): a valid access token whose session, `session_epoch`
 * and user status still check out. Sets `c.var.auth`. Before first-run setup, answers
 * `setup_required` so the web app can go to /setup (TDD §6.8); otherwise `unauthenticated`.
 *
 * Every feature route that reads or writes user content sits behind this middleware and then asks
 * the permission engine (`core/permissions.ts`).
 */
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const ctx = coreContext(c);
  const secrets = identitySecrets(c.env, c.var.log);
  if (!secrets.ok) return errorResponse(c, secrets.error);
  const token = readAccessCookie(c);
  const result = token ? await authenticate(ctx, secrets.value, token) : null;
  if (!result?.ok) {
    if (!(await isSetupComplete(ctx))) {
      return errorResponse(c, apiError("setup_required", "This workspace hasn't been set up yet."));
    }
    return errorResponse(c, result?.error ?? apiError("unauthenticated", "Sign in to continue."));
  }
  c.set("auth", result.value);
  await next();
};

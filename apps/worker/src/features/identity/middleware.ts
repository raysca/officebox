import {
  apiError,
  err,
  FRESH_AUTH_METHODS,
  ok,
  userStatusSchema,
  workspaceRoleSchema,
  type ApiError,
  type FreshAuthMethod,
  type Result,
} from "@officebox/shared";
import type { MiddlewareHandler } from "hono";
import { coreContext, type AppContext, type AppEnv } from "../../core/context";
import { errorResponse } from "../../core/errors";
import { authFor, type Auth } from "./auth";
import { claimed, loadInstallation, type ClaimedInstallation, type Installation } from "./installation";
import { currentStore, runWithStore, type RequestStore } from "./request-store";
import { identitySecrets, type IdentitySecrets } from "./secrets";
import { isSetupComplete } from "./setup-state";

/**
 * Identity middleware (Identity §4.4, §4.5; TDD §8.1).
 *
 * **`identityApiMiddleware`** runs first on every `/api/*` request (passed to `createApp`):
 * - opens the request's AsyncLocalStorage store (server-set markers, `request-store.ts`);
 * - loads the installation row and enforces the **canonical origin**: a request on another allowed
 *   host gets a 302 (GET/HEAD) or 307 to the same path and query on the canonical origin, built from
 *   the record (never from the request's host), with `Cache-Control: no-store`, never a 301; any other
 *   host is refused (404). Before setup is claimed there is no canonical origin and every host passes.
 * - sets `c.var.canonicalOrigin` for the CSRF check that follows.
 *
 * **`requireAuth`** guards every signed-in route: it reads the session through better-auth
 * (`auth.api.getSession`, no cookie cache, so the row is read on every request, from the D1 primary:
 * the Worker never opens a D1 Sessions API session, so there's no replica to lag), checks the user is
 * `active`, and **forwards better-auth's `Set-Cookie`** (the daily sliding refresh; workaround 12).
 */

const installations = new WeakMap<RequestStore, Installation | null>();

export const identityApiMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  let waitUntil: ((p: Promise<unknown>) => void) | undefined;
  try {
    const executionCtx = c.executionCtx;
    waitUntil = (p) => executionCtx.waitUntil(p);
  } catch {
    // No ExecutionContext (app.request in tests).
  }
  const store: RequestStore = {
    log: c.var.log,
    waitUntil,
    cf: c.req.raw.cf as RequestStore["cf"],
  };
  return runWithStore(store, async () => {
    const installation = await loadInstallation(c.env.DB);
    installations.set(store, installation);
    const canonical = installation?.canonicalOrigin;
    if (canonical) {
      const url = new URL(c.req.url);
      if (url.origin !== canonical) {
        if (installation.allowedHosts.includes(url.host)) {
          const target = new URL(url.pathname + url.search, canonical).toString();
          const status = c.req.method === "GET" || c.req.method === "HEAD" ? 302 : 307;
          return new Response(null, { status, headers: { Location: target, "Cache-Control": "no-store" } });
        }
        c.var.log.warn("request on an unknown host refused");
        return errorResponse(c, apiError("not_found", "No such endpoint."));
      }
      c.set("canonicalOrigin", canonical);
    }
    await next();
  });
};

/** The installation loaded for this request by `identityApiMiddleware`. */
export async function requestInstallation(c: AppContext): Promise<Installation | null> {
  const store = currentStore();
  if (store && installations.has(store)) return installations.get(store) ?? null;
  return loadInstallation(c.env.DB);
}

export interface IdentityServices {
  secrets: IdentitySecrets;
  installation: ClaimedInstallation;
  auth: Auth;
}

/** Secrets, the claimed installation and its better-auth instance; or the error to return. */
export async function identityServices(c: AppContext): Promise<Result<IdentityServices, ApiError>> {
  const secrets = identitySecrets(c.env, c.var.log);
  if (!secrets.ok) return secrets;
  const installation = claimed(await requestInstallation(c));
  if (!installation) return err(apiError("setup_required", "This workspace hasn't been set up yet."));
  return ok({ secrets: secrets.value, installation, auth: authFor(c.env, secrets.value, installation) });
}

/** Appends every `Set-Cookie` in `from` to the response being built. */
export function forwardSetCookies(c: AppContext, from: Headers | null | undefined): void {
  for (const cookie of from?.getSetCookie() ?? []) c.header("Set-Cookie", cookie, { append: true });
}

function freshMethod(value: unknown): FreshAuthMethod | null {
  return typeof value === "string" && (FRESH_AUTH_METHODS as readonly string[]).includes(value)
    ? (value as FreshAuthMethod)
    : null;
}

const UNAUTHENTICATED: ApiError = apiError("unauthenticated", "Sign in to continue.");

/**
 * Reads and checks the session; sets `c.var.auth` on success. better-auth's `Set-Cookie` (the daily
 * sliding refresh) is forwarded onto the route's response, or, with `forward: false`, handed to the
 * caller in `setCookies` (for routes that return a raw `Response`, which Hono doesn't merge).
 */
export async function loadSession(
  c: AppContext,
  options: { forward?: boolean; setCookies?: string[] } = {},
): Promise<Result<IdentityServices, ApiError>> {
  const services = await identityServices(c);
  if (!services.ok) return services;
  const { headers, response } = await services.value.auth.api.getSession({
    headers: c.req.raw.headers,
    returnHeaders: true,
  });
  if (options.forward === false) options.setCookies?.push(...(headers?.getSetCookie() ?? []));
  else forwardSetCookies(c, headers);
  if (!response) return err(UNAUTHENTICATED);
  const user = response.user as typeof response.user & { role?: unknown; status?: unknown };
  const session = response.session as typeof response.session & { freshAuthAt?: unknown; freshAuthMethod?: unknown };
  const role = workspaceRoleSchema.safeParse(user.role);
  const status = userStatusSchema.safeParse(user.status);
  if (!role.success || !status.success || status.data !== "active") return err(UNAUTHENTICATED);
  c.set("auth", {
    userId: user.id,
    sessionId: session.id,
    role: role.data,
    status: status.data,
    freshAuthAt: typeof session.freshAuthAt === "number" ? session.freshAuthAt : null,
    freshAuthMethod: freshMethod(session.freshAuthMethod),
  });
  return services;
}

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const loaded = await loadSession(c);
  if (!loaded.ok) {
    // Before setup completes, nobody signed out has anywhere to go but /setup (TDD §6.8).
    if (loaded.error.code === "unauthenticated" && !(await isSetupComplete(coreContext(c)))) {
      return errorResponse(c, apiError("setup_required", "This workspace hasn't been set up yet."));
    }
    return errorResponse(c, loaded.error);
  }
  await next();
};

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
import {
  activePendingMove,
  claimed,
  loadInstallation,
  loadInstallationForPages,
  type ClaimedInstallation,
  type Installation,
} from "./installation";
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
 * - on a **pending domain move's new origin** (M1c), answers only the move-completion routes, marks the
 *   request's store (`pendingMove`, so `identityServices` builds a better-auth instance for that origin)
 *   and uses that origin for CSRF;
 * - sets `c.var.canonicalOrigin` for the CSRF check that follows.
 *
 * **`requireAuth`** guards every signed-in route: it reads the session through better-auth
 * (`auth.api.getSession`, no cookie cache, so the row is read on every request, from the D1 primary:
 * the Worker never opens a D1 Sessions API session, so there's no replica to lag), checks the user is
 * `active`, and **forwards better-auth's `Set-Cookie`** (the daily sliding refresh; workaround 12).
 */

const installations = new WeakMap<RequestStore, Installation | null>();

function isSetupPath(path: string): boolean {
  return path === "/api/setup";
}

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
    let installation: Installation | null;
    try {
      installation = await loadInstallation(c.env.DB);
    } catch (error) {
      // Setup must still answer while D1 is down or unmigrated, so its required-services checklist
      // can say so (M1b-1). Setup's own routes refuse every claim until D1 passes. Everything else
      // fails as before.
      if (!isSetupPath(new URL(c.req.url).pathname)) throw error;
      c.var.log.error("installation unreadable; setup will report it", { error });
      installation = null;
    }
    installations.set(store, installation);
    const canonical = installation?.canonicalOrigin;
    if (canonical) {
      const url = new URL(c.req.url);
      if (url.origin !== canonical) {
        // A pending domain move's new origin answers only the move-completion routes (M1c; TDD §8.1),
        // with that origin as the CSRF origin and a better-auth instance built for it.
        const pending = activePendingMove(installation, c.var.now());
        if (pending && url.origin === pending.origin) {
          if (!PENDING_ORIGIN_ROUTES.has(`${c.req.method} ${url.pathname}`)) {
            return errorResponse(c, apiError("not_found", "No such endpoint."));
          }
          store.pendingMove = { origin: pending.origin };
          c.set("canonicalOrigin", pending.origin);
          await next();
          return;
        }
        if (installation?.allowedHosts.includes(url.host)) return canonicalRedirect(c.req.method, url, canonical);
        c.var.log.warn("request on an unknown host refused");
        return errorResponse(c, apiError("not_found", "No such endpoint."));
      }
      c.set("canonicalOrigin", canonical);
    }
    await next();
  });
};

/** The only routes a pending domain move's new origin answers (exact method and path; Identity §4.4). */
const PENDING_ORIGIN_ROUTES: ReadonlySet<string> = new Set([
  "POST /api/admin/domain/complete",
  "GET /api/auth/passkey/generate-register-options",
  "POST /api/auth/passkey/verify-registration",
]);

/**
 * The old host's redirect after a domain move (and any other allowed host's): 302 for GET and HEAD,
 * otherwise 307, to the same path and query on the canonical origin built from the installation record,
 * never from the request's host; `no-store`, never a cacheable 301. Browsers keep the fragment.
 */
export function canonicalRedirect(method: string, url: URL, canonical: string): Response {
  return new Response(null, {
    status: method === "GET" || method === "HEAD" ? 302 : 307,
    headers: { Location: canonicalTarget(url, canonical), "Cache-Control": "no-store" },
  });
}

/**
 * The redirect target: the canonical origin with only the request's path and query copied in. The path
 * is assigned to a URL parsed from the canonical origin (never resolved as a relative reference, which
 * would turn `//evil.example/x` or `/\evil.example` into another host), with any run of leading slashes
 * or backslashes collapsed to one `/`. So the target's origin is always the canonical origin.
 */
export function canonicalTarget(url: URL, canonical: string): string {
  const target = new URL(canonical);
  target.pathname = `/${url.pathname.replace(/^[/\\]+/, "")}`;
  target.search = url.search;
  return target.toString();
}

/**
 * The same redirect for page navigations (M1c): requests outside `/api`, `/ws` and `/health` reach the
 * Worker first (`run_worker_first` in wrangler.jsonc; hashed build assets excepted), so after a domain
 * move the old host's pages redirect too. Pages on the canonical host, on a pending move's origin and on
 * hosts the installation doesn't know are served as before. When the installation can't be read (before
 * migrations, or D1 is down) the page is served: the API reports the problem.
 */
export const identityPageMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  let installation: Installation | null;
  try {
    // Cached per isolate for 30 s (pages only; a commit clears it): page loads don't each cost a D1 read.
    installation = await loadInstallationForPages(c.env.DB, c.var.now());
  } catch (error) {
    // Fail open for pages (the API reports the problem), but say so.
    c.var.log.warn("installation unreadable for a page request; serving the page", { error });
    await next();
    return;
  }
  const canonical = installation?.canonicalOrigin;
  if (canonical) {
    const url = new URL(c.req.url);
    const pending = activePendingMove(installation, c.var.now());
    if (url.origin !== canonical && url.origin !== pending?.origin && installation?.allowedHosts.includes(url.host)) {
      return canonicalRedirect(c.req.method, url, canonical);
    }
  }
  await next();
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
  const secrets = await identitySecrets(c.env, c.var.log);
  if (!secrets.ok) return secrets;
  const record = claimed(await requestInstallation(c));
  if (!record) return err(apiError("setup_required", "This workspace hasn't been set up yet."));
  // On a pending domain move's new origin: a second better-auth instance, for that origin (TDD §8.1).
  const pending = currentStore()?.pendingMove;
  const installation = pending ? { ...record, canonicalOrigin: pending.origin } : record;
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

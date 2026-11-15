import { apiError, err, ok, passwordSignInBodySchema, setupBodySchema } from "@officebox/shared";
import { Hono } from "hono";
import { defineFeature } from "../../core/app";
import { authOf, coreContext, type AppEnv } from "../../core/context";
import { readJson, respond } from "../../core/errors";
import { actorOf, authorize } from "../../core/permissions";
import {
  clearSessionCookies,
  readAccessCookie,
  readKnownDeviceCookie,
  readRefreshCookie,
  setKnownDeviceCookie,
  setSessionCookies,
} from "./cookies";
import { getMe } from "./me";
import { requireAuth } from "./middleware";
import { identitySecrets } from "./secrets";
import {
  activeSessionOwner,
  authenticate,
  listSessions,
  refreshSession,
  revokeSession,
  sessionOfRefreshCookie,
  signOutEverywhere,
  signOutDevice,
  signOutOtherSessions,
} from "./sessions";
import { completeSetup, setupStatus } from "./setup";
import { isSetupComplete } from "./setup-state";
import { signInWithPassword } from "./sign-in";

/**
 * Identity routes for M1a (Identity §6). Paths in the spec are relative to `/api`.
 *
 * | Route | Who |
 * |---|---|
 * | `GET /api/setup`, `POST /api/setup` | Setup token (404 after setup) |
 * | `POST /api/auth/password` | Public |
 * | `POST /api/auth/refresh`, `POST /api/auth/sign-out` | Session (refresh cookie) |
 * | `POST /api/auth/sign-out-everywhere` | Member (own sessions) |
 * | `GET /api/me` | Member |
 * | `GET /api/me/sessions`, `DELETE /api/me/sessions/:id`, `POST /api/me/sessions/sign-out-others` | Member (own sessions) |
 *
 * State-changing requests pass the core CSRF check first (`core/csrf.ts`).
 */

const SMALL_BODY = 16 * 1024;
const NOT_FOUND = apiError("not_found", "No such endpoint.");

// ---- /api/setup --------------------------------------------------------------------------------

const setupRoutes = new Hono<AppEnv>()
  .get("/", async (c) => respond(c, await setupStatus(coreContext(c))))
  .post("/", async (c) => {
    const ctx = coreContext(c);
    if (await isSetupComplete(ctx)) return respond(c, err(NOT_FOUND));
    const secrets = identitySecrets(c.env, c.var.log);
    if (!secrets.ok) return respond(c, secrets);
    const body = await readJson(c, setupBodySchema, SMALL_BODY);
    if (!body.ok) return respond(c, body);
    return respond(c, await completeSetup(ctx, secrets.value, body.value, c.req.raw), 201);
  });

// ---- /api/auth ---------------------------------------------------------------------------------

const authRoutes = new Hono<AppEnv>()
  .post("/password", async (c) => {
    const ctx = coreContext(c);
    const secrets = identitySecrets(c.env, c.var.log);
    if (!secrets.ok) return respond(c, secrets);
    const body = await readJson(c, passwordSignInBodySchema, SMALL_BODY);
    if (!body.ok) return respond(c, body);
    const signedIn = await signInWithPassword(ctx, secrets.value, body.value, c.req.raw, readKnownDeviceCookie(c));
    if (!signedIn.ok) return respond(c, signedIn);
    setSessionCookies(c, signedIn.value.session);
    setKnownDeviceCookie(c, signedIn.value.knownDevice);
    return respond(c, await getMe(ctx, signedIn.value.session.userId));
  })
  .post("/refresh", async (c) => {
    const secrets = identitySecrets(c.env, c.var.log);
    if (!secrets.ok) return respond(c, secrets);
    const cookie = readRefreshCookie(c);
    const result = cookie ? await refreshSession(coreContext(c), secrets.value, cookie) : null;
    if (!result?.ok) {
      clearSessionCookies(c);
      return respond(c, result ?? err(apiError("unauthenticated", "Sign in to continue.")));
    }
    setSessionCookies(c, result.value);
    return respond(c, ok(null));
  })
  .post("/sign-out", async (c) => {
    // Works with a valid access token, or with just the refresh cookie once the access token expired.
    const ctx = coreContext(c);
    const secrets = identitySecrets(c.env, c.var.log);
    if (!secrets.ok) return respond(c, secrets);
    const access = readAccessCookie(c);
    const auth = access ? await authenticate(ctx, secrets.value, access) : null;
    const sessionId = auth?.ok
      ? auth.value.sessionId
      : await sessionOfRefreshCookie(ctx, secrets.value, readRefreshCookie(c));
    if (sessionId) await revokeSession(ctx, sessionId);
    clearSessionCookies(c);
    return respond(c, ok(null));
  })
  .post("/sign-out-everywhere", requireAuth, async (c) => {
    const ctx = coreContext(c);
    const auth = authOf(c);
    const allowed = authorize(ctx, actorOf(auth), { action: "devices.sign_out", ownerId: auth.userId });
    if (!allowed.ok) return respond(c, allowed);
    await signOutEverywhere(ctx, auth.userId, auth.userId);
    clearSessionCookies(c);
    return respond(c, ok(null));
  });

// ---- /api/me -----------------------------------------------------------------------------------

const meRoutes = new Hono<AppEnv>()
  .use(requireAuth)
  .get("/", async (c) => respond(c, await getMe(coreContext(c), authOf(c).userId)))
  .get("/sessions", async (c) => {
    const ctx = coreContext(c);
    const auth = authOf(c);
    const allowed = authorize(ctx, actorOf(auth), { action: "devices.view", ownerId: auth.userId });
    if (!allowed.ok) return respond(c, allowed);
    return respond(c, ok({ sessions: await listSessions(ctx, auth.userId, auth.sessionId) }));
  })
  .post("/sessions/sign-out-others", async (c) => {
    const ctx = coreContext(c);
    const auth = authOf(c);
    const allowed = authorize(ctx, actorOf(auth), { action: "devices.sign_out", ownerId: auth.userId });
    if (!allowed.ok) return respond(c, allowed);
    return respond(c, ok({ signedOut: await signOutOtherSessions(ctx, auth.userId, auth.sessionId) }));
  })
  .delete("/sessions/:id", async (c) => {
    const ctx = coreContext(c);
    const auth = authOf(c);
    const sessionId = c.req.param("id");
    const ownerId = await activeSessionOwner(ctx, sessionId);
    if (ownerId === null) return respond(c, err(apiError("not_found", "No such session.")));
    // Someone else's session answers 404 too, so session IDs can't be probed.
    const allowed = authorize(ctx, actorOf(auth), { action: "devices.sign_out", ownerId }, { hideAs404: true });
    if (!allowed.ok) return respond(c, allowed);
    await signOutDevice(ctx, sessionId, ownerId, auth.userId);
    if (sessionId === auth.sessionId) clearSessionCookies(c);
    return respond(c, ok(null));
  });

export const setupFeature = defineFeature("setup", setupRoutes);
export const authFeature = defineFeature("auth", authRoutes);
export const meFeature = defineFeature("me", meRoutes);

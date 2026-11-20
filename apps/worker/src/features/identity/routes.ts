import {
  acceptInvitationBodySchema,
  ackSecurityNoticesBodySchema,
  apiError,
  emailChangeConfirmBodySchema,
  err,
  invitationLookupBodySchema,
  magicLinkConfirmBodySchema,
  magicLinkRequestBodySchema,
  ok,
  ownerRecoveryBodySchema,
  reauthBodySchema,
  recoveryLinkBodySchema,
  renamePasskeyBodySchema,
  setupBodySchema,
  setupResumeBodySchema,
  ulidSchema,
  type ApiError,
  type PublicStatus,
} from "@officebox/shared";
import { Hono } from "hono";
import { defineFeature } from "../../core/app";
import { authOf, coreContext, type AppContext, type AppEnv } from "../../core/context";
import { csrfError, requireCsrfHeader } from "../../core/csrf";
import { errorResponse, readBodyText, readJson, respond } from "../../core/errors";
import { authorize } from "../../core/permissions";
import { checkLimit } from "../../core/rate-limit";
import { magicLinksAvailable } from "../email/config";
import {
  isAllowedAuthRoute,
  isMagicLinkRequestRoute,
  isPasskeyOptionsRoute,
  isPasskeyRoute,
  isRegistrationRoute,
} from "./allowlist";
import { acceptInvitation, lookupInvitation } from "./invitations";
import { recordSignInDevice } from "./known-devices";
import { confirmMagicLink, lookupMagicLink, MAGIC_LINK_LIMITS, prepareMagicLinkRequest } from "./magic-link";
import { SESSION_COOKIE } from "./auth";
import { tokenHash } from "./crypto";
import { listDevices, signOutDevice, signOutEverywhere, signOutOthers } from "./devices";
import { CLEAR_TICKET_COOKIE, readTicketCookie, ticketCookie } from "./enrolment";
import { permissionContext, recoveryTokenState } from "./facts";
import { getMe } from "./me";
import { forwardSetCookies, identityServices, loadSession, requireAuth } from "./middleware";
import { acknowledgeNotices, listNotices } from "./notices";
import { listPasskeys, removePasskey, renamePasskey } from "./passkeys";
import {
  ipKey,
  limitEmailConfirm,
  limitInvitation,
  limitOwnerRecovery,
  limitPasskeyIp,
  limitPublicStatus,
  limitReauth,
  limitRecovery,
  limitSetup,
  limitSetupStatus,
} from "./rate-limits";
import { reauthenticate, reauthOptions } from "./reauth";
import {
  lookupRecoveryLink,
  RECOVERY_TOKEN_NOT_SET,
  recoverOwner,
  recoveryTokenSet,
  signInRecoveryNotice,
  useRecoveryLink,
  type RecoveryEnrolmentOutcome,
} from "./recovery";
import { confirmEmailChange, lookupEmailChange } from "./email-change";
import { currentStore } from "./request-store";
import { filterAuthResponse } from "./token-filter";
import { identitySecrets } from "./secrets";
import { checkSetupServices } from "./services";
import { claimSetup, resumeSetup, SETUP_SERVICES_FAILING, setupStatus, type SetupEnrolmentResult } from "./setup";
import { isSetupComplete } from "./setup-state";
import { handleIssueWsTicket, handleSetMyDnd, handleUpdateMyPreferences } from "../realtime/routes";

/**
 * Identity routes for M1a and M1b (Identity §6). Paths are relative to `/api`.
 *
 * | Route | Who |
 * |---|---|
 * | `GET /setup` · `POST /setup` · `POST /setup/resume` | Setup token (404 after setup) |
 * | better-auth at `/auth/*`: `POST /auth/sign-out`, `GET /auth/passkey/generate-authenticate-options`, `POST /auth/passkey/verify-authentication`, `GET /auth/passkey/generate-register-options`, `POST /auth/passkey/verify-registration` | Public; registration needs a session (with step-up) or an enrolment ticket |
 * | `GET /me` | Member |
 * | `GET /me/sessions` · `DELETE /me/sessions/:id` · `POST /me/sessions/sign-out-others` · `POST /me/sessions/sign-out-everywhere` | Member (own) |
 * | `GET /me/passkeys` · `PATCH /me/passkeys/:id` · `DELETE /me/passkeys/:id` | Member (own); removal needs step-up |
 * | `POST /me/reauth/options` · `POST /me/reauth` | Member |
 * | `GET /me/security-notices` · `POST /me/security-notices/ack` | Member; ack needs a fresh passkey assertion |
 * | better-auth `POST /auth/sign-in/magic-link` (M1b) | Public; our availability check and limits first |
 * | `POST /sign-in/link/lookup` · `POST /sign-in/link` (M1b) | Magic-link token: show the email; consume and sign in |
 * | `POST /invitations/lookup` · `POST /invitations/accept` (M1b) | Invitation token |
 * | `GET /status/public` (M1b) | Anyone: whether magic links are offered |
 *
 * Every state change passes the core CSRF check first; every route that touches user content asks
 * the permission engine. No route returns a session token.
 */

const SMALL_BODY = 16 * 1024;
/** WebAuthn responses are a few KB; anything larger is refused before better-auth parses it. */
const WEBAUTHN_BODY = 64 * 1024;
const NOT_FOUND: ApiError = apiError("not_found", "No such endpoint.");

const CLEAR_SESSION_COOKIE = `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`;

// ---- /api/setup --------------------------------------------------------------------------------

function enrolmentResponse(c: AppContext, result: SetupEnrolmentResult) {
  const now = c.var.now();
  c.header("Set-Cookie", ticketCookie(result.ticket, now), { append: true });
  return respond(
    c,
    ok({
      ownerEmail: result.ownerEmail,
      enrolmentExpiresInSeconds: Math.max(1, Math.floor((result.ticket.expiresAt - now) / 1000)),
      // Shown once on the page (M1b-1); only an open-window claim has one.
      ...(result.resumeCode ? { resumeCode: result.resumeCode } : {}),
    }),
    201,
  );
}

/** Whether setup is complete; false when D1 can't say (the required-services check reports why). */
async function setupDone(c: AppContext): Promise<boolean> {
  try {
    return await isSetupComplete(coreContext(c));
  } catch {
    return false;
  }
}

const setupRoutes = new Hono<AppEnv>()
  .get("/", async (c) => {
    const ctx = coreContext(c);
    if (await setupDone(c)) return respond(c, err(NOT_FOUND));
    const limited = await limitSetupStatus(ctx, c.req.raw);
    if (!limited.ok) return respond(c, limited);
    // The required services first (M1b-1): the window starts only once they all pass.
    const report = await checkSetupServices(c.env, c.var.log);
    return respond(c, await setupStatus(ctx, report));
  })
  .post("/", async (c) => {
    const ctx = coreContext(c);
    if (await setupDone(c)) return respond(c, err(NOT_FOUND));
    const limited = await limitSetup(ctx, c.req.raw);
    if (!limited.ok) return respond(c, limited);
    // While any required service fails, no claim (M1b-1).
    const report = await checkSetupServices(c.env, c.var.log);
    if (!report.allOk) return respond(c, err(SETUP_SERVICES_FAILING));
    const secrets = await identitySecrets(c.env, c.var.log);
    if (!secrets.ok) return respond(c, secrets);
    const body = await readJson(c, setupBodySchema, SMALL_BODY);
    if (!body.ok) return respond(c, body);
    // The origin setup runs on becomes the canonical origin (Identity §4.1).
    const result = await claimSetup(ctx, secrets.value, body.value, new URL(c.req.url).origin);
    return result.ok ? enrolmentResponse(c, result.value) : respond(c, result);
  })
  .post("/resume", async (c) => {
    const ctx = coreContext(c);
    if (await isSetupComplete(ctx)) return respond(c, err(NOT_FOUND));
    const secrets = await identitySecrets(c.env, c.var.log);
    if (!secrets.ok) return respond(c, secrets);
    const limited = await limitSetup(ctx, c.req.raw);
    if (!limited.ok) return respond(c, limited);
    const body = await readJson(c, setupResumeBodySchema, SMALL_BODY);
    if (!body.ok) return respond(c, body);
    const result = await resumeSetup(ctx, secrets.value, body.value.token);
    return result.ok ? enrolmentResponse(c, result.value) : respond(c, result);
  });

// ---- /api/auth: the better-auth mount ----------------------------------------------------------

/** Buffers a request body up to the WebAuthn bound, so better-auth never parses more than that. */
async function boundedBody(request: Request): Promise<Request | ApiError> {
  const text = await readBodyText(request, WEBAUTHN_BODY);
  if (!text.ok) return text.error;
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  return new Request(request.url, { method: request.method, headers, body: text.value });
}

/** Rebuilds a JSON request with a changed body (the registration verify's `createSession`). */
async function withBody(
  request: Request,
  change: (body: Record<string, unknown>) => void,
): Promise<Request | ApiError> {
  const text = await readBodyText(request, WEBAUTHN_BODY);
  if (!text.ok) return text.error;
  let body: unknown;
  try {
    body = JSON.parse(text.value);
  } catch {
    return apiError("validation_failed", "The request body is not valid JSON.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return apiError("validation_failed", "The request body must be a JSON object.");
  }
  const copy = { ...(body as Record<string, unknown>) };
  change(copy);
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  return new Request(request.url, { method: request.method, headers, body: JSON.stringify(copy) });
}

/** An enrolment ticket cookie and the answer for the passkey step that follows (recovery, owner recovery). */
function recoveryEnrolmentResponse(c: AppContext, outcome: RecoveryEnrolmentOutcome) {
  const now = c.var.now();
  c.header("Set-Cookie", ticketCookie(outcome.ticket, now), { append: true });
  return respond(
    c,
    ok({
      email: outcome.email,
      enrolmentExpiresInSeconds: Math.max(1, Math.floor((outcome.ticket.expiresAt - now) / 1000)),
    }),
    201,
  );
}

const authRoutes = new Hono<AppEnv>()
  .post("/ws-ticket", requireAuth, (c) => handleIssueWsTicket(c))
  // Recovery links (M1c; Identity §4.6): ours, registered ahead of the better-auth mount.
  .post("/recover/lookup", async (c) => {
    const ctx = coreContext(c);
    const limited = await limitRecovery(ctx, c.req.raw);
    if (!limited.ok) return respond(c, limited);
    const body = await readJson(c, recoveryLinkBodySchema, SMALL_BODY);
    if (!body.ok) return respond(c, body);
    const services = await identityServices(c);
    if (!services.ok) return respond(c, services);
    const { secrets, installation } = services.value;
    return respond(c, await lookupRecoveryLink(ctx, secrets, installation, body.value.token));
  })
  .post("/recover", async (c) => {
    const ctx = coreContext(c);
    const limited = await limitRecovery(ctx, c.req.raw);
    if (!limited.ok) return respond(c, limited);
    const body = await readJson(c, recoveryLinkBodySchema, SMALL_BODY);
    if (!body.ok) return respond(c, body);
    const services = await identityServices(c);
    if (!services.ok) return respond(c, services);
    const result = await useRecoveryLink(ctx, services.value.secrets, body.value.token);
    return result.ok ? recoveryEnrolmentResponse(c, result.value) : respond(c, result);
  })
  .all("/*", async (c) => {
    const url = new URL(c.req.url);
    const path = url.pathname;
    // Default-deny on the exact normalised method and path (allowlist.ts).
    if (!isAllowedAuthRoute(c.req.method, path)) return errorResponse(c, NOT_FOUND);
    // Workaround 9: the options routes are GETs with side effects.
    if (isPasskeyOptionsRoute(path)) {
      const failure = requireCsrfHeader(c.req.raw);
      if (failure) return errorResponse(c, csrfError(failure));
    }
    const services = await identityServices(c);
    if (!services.ok) return respond(c, services);
    const { auth, secrets } = services.value;
    const ctx = coreContext(c);
    if (isPasskeyRoute(path)) {
      const limited = await limitPasskeyIp(ctx, c.req.raw);
      if (!limited.ok) return respond(c, limited);
    }

    let request = c.req.raw;
    if (isMagicLinkRequestRoute(path)) {
      // Our middleware first (Identity §4.4): only the email is accepted (no callback URLs), magic links
      // must be available, the per-IP limit refuses, and the per-email limit suppresses mail without
      // changing the answer. better-auth then gets a body we built.
      const body = await readJson(c, magicLinkRequestBodySchema, SMALL_BODY);
      if (!body.ok) return respond(c, body);
      const prepared = await prepareMagicLinkRequest(
        ctx,
        secrets,
        c.req.raw,
        body.value.email,
        await magicLinksAvailable(ctx),
      );
      if (!prepared.ok) return respond(c, prepared);
      const headers = new Headers(request.headers);
      headers.delete("content-length");
      headers.set("content-type", "application/json");
      request = new Request(request.url, {
        method: "POST",
        headers,
        body: JSON.stringify({ email: prepared.value.email }),
      });
    } else if (request.method === "POST" && !isRegistrationRoute(path)) {
      // Sign-out and verify-authentication: a size bound before better-auth reads the body.
      const bounded = await boundedBody(request);
      if (!(bounded instanceof Request)) return respond(c, err(bounded));
      request = bounded;
    }
    const extraCookies: string[] = [];
    const store = currentStore();
    if (isRegistrationRoute(path)) {
      const isVerify = path.endsWith("/verify-registration");
      // On a pending domain move's new origin only an enrolment ticket registers (M1c): no session there.
      const session = store?.pendingMove
        ? err(apiError("unauthenticated", "Sign in to continue."))
        : await loadSession(c, { forward: false, setCookies: extraCookies });
      if (session.ok) {
        // A signed-in member adding a passkey: step-up, through the engine (Identity §4.5).
        const me = authOf(c);
        const allowed = await authorize(permissionContext(c, me), { action: "passkey.add", ownerId: me.userId });
        if (!allowed.ok) return respond(c, allowed);
        if (store) store.registration = { kind: "signed_in", userId: me.userId, sessionId: me.sessionId };
        // Workaround 5: never let a signed-in registration create a second session.
        if (isVerify) {
          const rebuilt = await withBody(request, (body) => delete body.createSession);
          if (rebuilt instanceof Request) request = rebuilt;
          else return respond(c, err(rebuilt));
        }
      } else {
        const raw = readTicketCookie(c.req.raw.headers);
        if (raw && store)
          store.registration = { kind: "ticket", ticketHash: await tokenHash(secrets.tokenHashKey, raw) };
        if (isVerify) {
          if (!raw) {
            return respond(
              c,
              err(apiError("forbidden", "An enrolment ticket is required.", { reason: "ENROLMENT_TICKET_REQUIRED" })),
            );
          }
          // Workaround 5: a ticket registration always signs the person in.
          const rebuilt = await withBody(request, (body) => {
            body.createSession = true;
          });
          if (rebuilt instanceof Request) request = rebuilt;
          else return respond(c, err(rebuilt));
        }
      }
    }

    // On a pending move's new origin better-auth never sees a session cookie (M1c): only the move's
    // enrolment ticket registers there, so a session can't stand in for it.
    if (store?.pendingMove) request = withoutSessionCookie(request);
    const response = await auth.handler(request);
    if (store?.consumedTicket && response.ok) extraCookies.push(CLEAR_TICKET_COOKIE);
    // The known-device cookie is set on every sign-in, passkey ones included (Identity §4.4), so a later
    // magic-link sign-in from this browser isn't reported as a new device.
    if (store?.sessionCreated && response.ok) {
      const device = await recordSignInDevice(
        c.env.DB,
        secrets.tokenHashKey,
        store.sessionCreated.userId,
        c.req.raw.headers,
        c.var.now(),
      );
      extraCookies.push(device.setCookie);
    }
    const ticket = store?.consumedTicket;
    if (ticket && response.status >= 500 && !(await userExists(c, ticket.userId))) {
      // The setup claim expired (and its owner was deleted) between the ticket's consume and the passkey
      // insert: a typed answer, not a 500.
      return respond(
        c,
        err(
          apiError("gone", "This setup expired before the passkey was saved. Start setup again.", {
            reason: "setup_expired",
          }),
        ),
      );
    }
    const filtered = await filterAuthResponse(response, c.var.requestId);
    if (extraCookies.length === 0) return filtered;
    // This route returns a raw Response, which Hono doesn't merge with c.header(): append here, including
    // any cookie better-auth set while the session was read (workaround 12).
    const headers = new Headers(filtered.headers);
    for (const cookie of extraCookies) headers.append("Set-Cookie", cookie);
    return new Response(filtered.body, { status: filtered.status, headers });
  });

/** The request without the session cookie (every other cookie kept). */
function withoutSessionCookie(request: Request): Request {
  const cookie = request.headers.get("cookie");
  if (!cookie) return request;
  const kept = cookie
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part !== "" && part.split("=")[0] !== SESSION_COOKIE);
  const headers = new Headers(request.headers);
  if (kept.length > 0) headers.set("cookie", kept.join("; "));
  else headers.delete("cookie");
  return new Request(request, { headers });
}

async function userExists(c: AppContext, userId: string): Promise<boolean> {
  return (await c.env.DB.prepare("SELECT 1 AS one FROM users WHERE id = ?").bind(userId).first()) !== null;
}

// ---- /api/me -----------------------------------------------------------------------------------

function services(c: AppContext) {
  return identityServices(c).then((r) => {
    if (!r.ok) throw new Error("identity services vanished after requireAuth");
    return r.value;
  });
}

const meRoutes = new Hono<AppEnv>()
  // The email-change confirmation page's POSTs (M1c; Identity §4.11): public, the token is the proof.
  // Registered before `requireAuth`, which applies only to the routes after it.
  .post("/email/confirm/lookup", async (c) => {
    const ctx = coreContext(c);
    const limited = await limitEmailConfirm(ctx, c.req.raw);
    if (!limited.ok) return respond(c, limited);
    const body = await readJson(c, emailChangeConfirmBodySchema, SMALL_BODY);
    if (!body.ok) return respond(c, body);
    const services = await identityServices(c);
    if (!services.ok) return respond(c, services);
    const { secrets, installation } = services.value;
    return respond(c, await lookupEmailChange(ctx, secrets, installation, body.value.token));
  })
  .post("/email/confirm", async (c) => {
    const ctx = coreContext(c);
    const limited = await limitEmailConfirm(ctx, c.req.raw);
    if (!limited.ok) return respond(c, limited);
    const body = await readJson(c, emailChangeConfirmBodySchema, SMALL_BODY);
    if (!body.ok) return respond(c, body);
    const services = await identityServices(c);
    if (!services.ok) return respond(c, services);
    return respond(c, await confirmEmailChange(ctx, services.value.secrets, body.value.token));
  })
  .use(requireAuth)
  .get("/", async (c) => {
    const { installation } = await services(c);
    const me = authOf(c);
    const result = await getMe(coreContext(c), me, installation);
    if (!result.ok || me.role !== "owner") return respond(c, result);
    // Owners see a banner while a used RECOVERY_TOKEN is still set (Identity §4.6).
    return respond(c, ok({ ...result.value, ownerRecoveryUsed: (await recoveryTokenState(c.env)) === "consumed" }));
  })
  .get("/sessions", async (c) => {
    const me = authOf(c);
    const { auth } = await services(c);
    const result = await listDevices(permissionContext(c, me), auth, c.req.raw.headers, me);
    return respond(c, result.ok ? ok({ sessions: result.value }) : result);
  })
  .delete("/sessions/:id", async (c) => {
    const me = authOf(c);
    const id = c.req.param("id");
    if (!ulidSchema.safeParse(id).success) return respond(c, err(apiError("not_found", "No such session.")));
    const { auth } = await services(c);
    const result = await signOutDevice(coreContext(c), permissionContext(c, me), auth, c.req.raw.headers, me, id);
    if (result.ok && id === me.sessionId) c.header("Set-Cookie", CLEAR_SESSION_COOKIE, { append: true });
    return respond(c, result);
  })
  .post("/sessions/sign-out-others", async (c) => {
    const me = authOf(c);
    const { auth } = await services(c);
    return respond(c, await signOutOthers(coreContext(c), permissionContext(c, me), auth, c.req.raw.headers, me));
  })
  .post("/sessions/sign-out-everywhere", async (c) => {
    const me = authOf(c);
    const { auth } = await services(c);
    const result = await signOutEverywhere(coreContext(c), permissionContext(c, me), auth, c.req.raw.headers, me);
    if (!result.ok) return respond(c, result);
    forwardSetCookies(c, result.value.headers);
    c.header("Set-Cookie", CLEAR_SESSION_COOKIE, { append: true });
    return respond(c, ok(null));
  })
  .get("/passkeys", async (c) => {
    const me = authOf(c);
    // Listing is reading one's own sign-in methods: the engine's "own account" rule.
    const allowed = await authorize(permissionContext(c, me), { action: "devices.view", ownerId: me.userId });
    if (!allowed.ok) return respond(c, allowed);
    return respond(c, ok({ passkeys: await listPasskeys(coreContext(c), me.userId) }));
  })
  .patch("/passkeys/:id", async (c) => {
    const me = authOf(c);
    const id = c.req.param("id");
    if (!ulidSchema.safeParse(id).success) return respond(c, err(apiError("not_found", "No such passkey.")));
    const body = await readJson(c, renamePasskeyBodySchema, SMALL_BODY);
    if (!body.ok) return respond(c, body);
    return respond(c, await renamePasskey(coreContext(c), permissionContext(c, me), id, body.value.name));
  })
  .delete("/passkeys/:id", async (c) => {
    const me = authOf(c);
    const id = c.req.param("id");
    if (!ulidSchema.safeParse(id).success) return respond(c, err(apiError("not_found", "No such passkey.")));
    return respond(c, await removePasskey(coreContext(c), permissionContext(c, me), id));
  })
  .post("/reauth/options", async (c) => {
    const ctx = coreContext(c);
    const limited = await limitPasskeyIp(ctx, c.req.raw);
    if (!limited.ok) return respond(c, limited);
    const { auth } = await services(c);
    const result = await reauthOptions(auth, c.req.raw.headers);
    forwardSetCookies(c, result.headers);
    return respond(c, ok({ ...result.options, userVerification: "required" }));
  })
  .post("/reauth", async (c) => {
    const ctx = coreContext(c);
    const me = authOf(c);
    const perSession = await limitReauth(ctx, me.sessionId);
    if (!perSession.ok) return respond(c, perSession);
    // Every attempt also counts toward the per-IP passkey limit (Identity §4.5).
    const perIp = await limitPasskeyIp(ctx, c.req.raw);
    if (!perIp.ok) return respond(c, perIp);
    const body = await readJson(c, reauthBodySchema, WEBAUTHN_BODY);
    if (!body.ok) return respond(c, body);
    const { auth } = await services(c);
    return respond(c, await reauthenticate(ctx, auth, c.req.raw.headers, me, body.value));
  })
  .get("/security-notices", async (c) => {
    const me = authOf(c);
    return respond(c, ok({ notices: await listNotices(c.env.DB, me.userId) }));
  })
  .post("/security-notices/ack", async (c) => {
    const me = authOf(c);
    const body = await readJson(c, ackSecurityNoticesBodySchema, SMALL_BODY);
    if (!body.ok) return respond(c, body);
    // Only a fresh passkey assertion on this session may dismiss the banner (Identity §4.6a).
    const allowed = await authorize(permissionContext(c, me), { action: "security_notice.ack", ownerId: me.userId });
    if (!allowed.ok) return respond(c, allowed);
    return respond(c, ok({ acknowledged: await acknowledgeNotices(c.env.DB, me.userId, body.value.ids) }));
  })
  .put("/dnd", (c) => handleSetMyDnd(c))
  .patch("/preferences", (c) => handleUpdateMyPreferences(c));

// ---- /api/invitations: the invitee's side (Identity §4.3) ---------------------------------------

const invitationRoutes = new Hono<AppEnv>()
  .post("/lookup", async (c) => {
    const ctx = coreContext(c);
    const limited = await limitInvitation(ctx, c.req.raw);
    if (!limited.ok) return respond(c, limited);
    const body = await readJson(c, invitationLookupBodySchema, SMALL_BODY);
    if (!body.ok) return respond(c, body);
    const services = await identityServices(c);
    if (!services.ok) return respond(c, services);
    const { secrets, installation } = services.value;
    return respond(c, await lookupInvitation(ctx, secrets, installation, body.value.token));
  })
  .post("/accept", async (c) => {
    const ctx = coreContext(c);
    const limited = await limitInvitation(ctx, c.req.raw);
    if (!limited.ok) return respond(c, limited);
    const body = await readJson(c, acceptInvitationBodySchema, SMALL_BODY);
    if (!body.ok) return respond(c, body);
    const services = await identityServices(c);
    if (!services.ok) return respond(c, services);
    const { secrets, installation } = services.value;
    const result = await acceptInvitation(ctx, secrets, installation, body.value);
    if (!result.ok) return respond(c, result);
    const now = c.var.now();
    c.header("Set-Cookie", ticketCookie(result.value.ticket, now), { append: true });
    return respond(
      c,
      ok({
        email: result.value.email,
        enrolmentExpiresInSeconds: Math.max(1, Math.floor((result.value.ticket.expiresAt - now) / 1000)),
        resumed: result.value.resumed,
      }),
      201,
    );
  });

// ---- /api/sign-in: the magic-link confirmation page's POST (Identity §4.4) -----------------------

const signInRoutes = new Hono<AppEnv>()
  .post("/link/lookup", async (c) => {
    const ctx = coreContext(c);
    const limited = await checkLimit(ctx, MAGIC_LINK_LIMITS.confirmIp, ipKey(c.req.raw));
    if (!limited.ok) return respond(c, limited);
    const body = await readJson(c, magicLinkConfirmBodySchema, SMALL_BODY);
    if (!body.ok) return respond(c, body);
    const services = await identityServices(c);
    if (!services.ok) return respond(c, services);
    const { secrets, installation } = services.value;
    return respond(c, await lookupMagicLink(ctx, secrets, installation, body.value.token));
  })
  .post("/link", async (c) => {
    const ctx = coreContext(c);
    const limited = await checkLimit(ctx, MAGIC_LINK_LIMITS.confirmIp, ipKey(c.req.raw));
    if (!limited.ok) return respond(c, limited);
    const body = await readJson(c, magicLinkConfirmBodySchema, SMALL_BODY);
    if (!body.ok) return respond(c, body);
    const services = await identityServices(c);
    if (!services.ok) return respond(c, services);
    const { secrets, auth } = services.value;
    const result = await confirmMagicLink(ctx, secrets, auth, c.req.raw, body.value.token);
    if (!result.ok) return respond(c, result);
    for (const cookie of result.value.setCookies) c.header("Set-Cookie", cookie, { append: true });
    // better-auth's verify body holds the session token: never passed through (workaround 7).
    return respond(c, ok({ signedIn: true as const }));
  });

// ---- /api/status: what signed-out pages may know (Platform §15, Admin §8.2) -----------------------

const statusRoutes = new Hono<AppEnv>().get("/public", async (c) => {
  const ctx = coreContext(c);
  const limited = await limitPublicStatus(ctx, c.req.raw);
  if (!limited.ok) return respond(c, limited);
  const status: PublicStatus = { magicLinks: await magicLinksAvailable(ctx) };
  // The sign-in page's "An admin reset your account" notice, for this browser's member (M1c; §4.6).
  const services = await identityServices(c);
  if (services.ok) {
    const notice = await signInRecoveryNotice(c.env.DB, services.value.secrets.tokenHashKey, c.req.raw.headers);
    if (notice) status.recoveryNotice = notice;
  }
  // Cacheable for 30 seconds by the browser only (TDD §8.2 keeps API responses out of shared caches).
  return c.json(status, 200, { "Cache-Control": "private, max-age=30" });
});

// ---- /api/recover: owner recovery with RECOVERY_TOKEN (Identity §4.6, M1c) ------------------------

const recoverRoutes = new Hono<AppEnv>().post("/", async (c) => {
  // Without the secret there's nothing here (Identity §9: 404).
  if (!recoveryTokenSet(c.env)) return respond(c, err(RECOVERY_TOKEN_NOT_SET));
  const ctx = coreContext(c);
  // Per IP, before the secret is compared (Platform §8: 5 a minute).
  const limited = await limitOwnerRecovery(ctx, c.req.raw);
  if (!limited.ok) return respond(c, limited);
  const body = await readJson(c, ownerRecoveryBodySchema, SMALL_BODY);
  if (!body.ok) return respond(c, body);
  const services = await identityServices(c);
  if (!services.ok) return respond(c, services);
  const result = await recoverOwner(ctx, services.value.secrets, body.value);
  return result.ok ? recoveryEnrolmentResponse(c, result.value) : respond(c, result);
});

export const recoverFeature = defineFeature("recover", recoverRoutes);
export const invitationsFeature = defineFeature("invitations", invitationRoutes);
export const signInFeature = defineFeature("sign-in", signInRoutes);
export const statusFeature = defineFeature("status", statusRoutes);
export const setupFeature = defineFeature("setup", setupRoutes);
export const authFeature = defineFeature("auth", authRoutes);
export const meFeature = defineFeature("me", meRoutes);

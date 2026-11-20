import { passkey } from "@better-auth/passkey";
import { MAGIC_LINK_TTL_SECONDS, normaliseEmail, type PasskeyCreatedVia } from "@officebox/shared";
import { verifyAuthenticationResponse, type AuthenticationResponseJSON } from "@simplewebauthn/server";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { magicLink } from "better-auth/plugins";
import { audit, auditStatement } from "../../core/audit";
import type { CoreContext } from "../../core/context";
import { Database, expectOk } from "../../core/db";
import { ulid } from "../../core/ids";
import { rootLogger, type Logger } from "../../core/log";
import type { Env } from "../../env";
import { fromBase64url, tokenHash } from "./crypto";
import { counterAtChallenge, recordCounterMove, settleCounter } from "./counters";
import { createKysely } from "./d1-kysely";
import { approxLocation, deviceLabel } from "./device";
import { bindChallenge, consumeTicket, findValidTicket, readTicketCookie } from "./enrolment";
import type { ClaimedInstallation } from "./installation";
import { issueMagicLink } from "./magic-link";
import { emailSecurityNotices, type RaisedNotice } from "./notice-email";
import { noticeStatement } from "./notices";
import { consumeRateLimit } from "./rate-limits";
import { currentStore } from "./request-store";
import { closeSessionConnections } from "./revocation";
import type { IdentitySecrets } from "./secrets";
import { completeSetupClaim } from "./setup-state";

/**
 * The better-auth configuration (TDD §8.1 "Configuration"), built **per installation origin**: the
 * canonical origin from `installation` gives `baseURL`, `trustedOrigins`, the passkey `rpID` and
 * `origin`; the workspace name gives `rpName`. One instance per origin is cached per isolate
 * ({@link authFor}) and rebuilt only when the record (or a secret) changes.
 *
 * It carries every workaround the M1a-0 spike found necessary (spikes/better-auth/README.md, "16
 * workarounds"); each is numbered below and has its own test in `test/identity/workarounds.test.ts`
 * or the e2e run, so an upgrade can't silently break one:
 *
 * 1. epoch-ms dates: our own Kysely with `EpochMsPlugin` (`d1-kysely.ts`)
 * 2. user verification: both `afterVerification` hooks refuse `userVerified === false`; registration
 *    options require UV and resident keys; an after hook rewrites the authentication options' UV
 * 3. the passkey `origin` and `rpID` set explicitly from the installation record
 * 4. clone detection: a before hook captures the challenge, when it was issued and the counter before;
 *    each accepted assertion records its counter move; on `AUTHENTICATION_FAILED` the after hook
 *    re-verifies the assertion with the stored counter set aside and raises `clone_detected` only if
 *    the counter is at or below its value at challenge time (otherwise a race, refused quietly)
 * 5. `createSession` on registration verify: forced on for ticket registrations, stripped when signed
 *    in (in the mount, `routes.ts`)
 * 6. the enrolment ticket: read in `resolveUser`, bound to the challenge after options, consumed by
 *    compare-and-set in `registration.afterVerification` before any write
 * 7. the token filter on the mount (`token-filter.ts`)
 * 8. `__Host-` cookies: `useSecureCookies: false`, `cookiePrefix: "__Host-officebox"`, Secure forced
 * 9. the CSRF header on the two GET options routes (in the mount)
 * 10. server-set markers through AsyncLocalStorage (`request-store.ts`); users are created only with
 *     `internalAdapter.createUser` inside a marker
 * 11. step-up: the session-create hook vetoes the session while in a `reauth` context
 * 12. `getSession` Set-Cookie forwarded by every caller (`session.ts`)
 * 13. users created with `emailVerified: true`
 * 14. explicit options: rate limiting on with D1 `consume` storage, telemetry off, joins on,
 *     `nodejs_compat` in `wrangler.jsonc`
 * 15. secret rotation signs everyone out (documented in Platform §16; tested)
 * 16. upgrade checks: the tests above plus the creation-path scan (`test/identity/creation-paths.test.ts`)
 */

export const SESSION_COOKIE = "__Host-officebox.session_token";
export const COOKIE_PREFIX = "__Host-officebox";
export const BASE_PATH = "/api/auth";
export const SESSION_EXPIRES_IN_SECONDS = 30 * 24 * 60 * 60;
export const SESSION_UPDATE_AGE_SECONDS = 24 * 60 * 60;

const PATH_VERIFY_AUTHENTICATION = "/passkey/verify-authentication";
const PATH_VERIFY_REGISTRATION = "/passkey/verify-registration";
const PATH_AUTHENTICATE_OPTIONS = "/passkey/generate-authenticate-options";
const PATH_REGISTER_OPTIONS = "/passkey/generate-register-options";
const PATH_MAGIC_LINK_VERIFY = "/magic-link/verify";

/** Logs from inside better-auth go to the request's logger (redacted), or the root logger. */
function logger(): Logger {
  return currentStore()?.log ?? rootLogger;
}

function hookContext(env: Env): CoreContext {
  return { env, log: logger(), now: Date.now };
}

function apiError(status: "BAD_REQUEST" | "UNAUTHORIZED" | "FORBIDDEN", code: string, message: string): APIError {
  return new APIError(status, { code, message });
}

/** Decodes the challenge a client signed (the verifier has already checked it equals the expected one). */
function clientChallenge(clientDataJSON: unknown): string | null {
  if (typeof clientDataJSON !== "string") return null;
  const bytes = fromBase64url(clientDataJSON);
  if (!bytes) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { challenge?: unknown };
    return typeof parsed.challenge === "string" ? parsed.challenge : null;
  } catch {
    return null;
  }
}

function returnedObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || value instanceof APIError || value instanceof Response) return null;
  return value as Record<string, unknown>;
}

function errorCode(value: unknown): string | undefined {
  if (!(value instanceof APIError)) return undefined;
  const body = value.body as { code?: unknown } | undefined;
  return typeof body?.code === "string" ? body.code : undefined;
}

type RefusalVerdict = { kind: "clone"; passkeyId: string; userId: string } | { kind: "race" } | null;

/**
 * Workaround 4: re-verify a refused assertion with the stored counter set aside. A genuine assertion
 * is a **clone** only if its counter is at or below the counter as it was when its challenge was
 * issued (not both 0); above that but at or below the stored value, it lost a **race** with a newer
 * legitimate sign-in (counters.ts). Anything that doesn't verify is an ordinary failure (null).
 */
async function judgeRefusal(
  env: Env,
  origin: string,
  rpID: string,
  response: AuthenticationResponseJSON,
  challenge: string,
  challengeIssuedAt: number,
): Promise<RefusalVerdict> {
  const row = expectOk(
    await new Database(env.DB).first<{ id: string; user_id: string; public_key: string; sign_count: number }>(
      "SELECT id, user_id, public_key, sign_count FROM passkeys WHERE credential_id = ?",
      response.id,
    ),
  );
  if (!row) return null;
  const publicKey = fromBase64url(row.public_key);
  if (!publicKey) return null;
  let presented: number;
  try {
    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: { id: response.id, publicKey, counter: 0 },
      requireUserVerification: true,
    });
    if (!verification.verified) return null;
    presented = verification.authenticationInfo.newCounter;
  } catch {
    // Not a genuine assertion (bad signature, origin, RP ID or UV): an ordinary failure.
    return null;
  }
  const atChallenge = await counterAtChallenge(env.DB, row.id, challengeIssuedAt, row.sign_count);
  if ((presented > 0 || atChallenge > 0) && presented <= atChallenge) {
    return { kind: "clone", passkeyId: row.id, userId: row.user_id };
  }
  return presented <= row.sign_count ? { kind: "race" } : null;
}

/** Notices and audit for a detected clone: the member and every active owner (Identity §4.4). */
async function raiseClone(env: Env, clone: { passkeyId: string; userId: string }): Promise<void> {
  const ctx = hookContext(env);
  const now = ctx.now();
  const database = new Database(env.DB);
  const person = expectOk(
    await database.first<{ display_name: string }>("SELECT display_name FROM users WHERE id = ?", clone.userId),
  );
  const owners = expectOk(
    await database.all<{ id: string }>(
      "SELECT id FROM users WHERE role = 'owner' AND status = 'active' AND id != ?",
      clone.userId,
    ),
  );
  const raised: RaisedNotice[] = [
    { userId: clone.userId, kind: "passkey_clone_detected", details: {}, at: now },
    ...owners.map((o): RaisedNotice => ({
      userId: o.id,
      kind: "passkey_clone_detected",
      details: { subjectName: person?.display_name ?? "" },
      at: now,
    })),
  ];
  const statements = [
    ...raised.map((n) => noticeStatement(database, n.userId, n.kind, n.details, n.at)),
    await auditStatement(ctx, {
      action: "auth.passkey_clone_detected",
      actor: null,
      target: { type: "passkey", id: clone.passkeyId },
      metadata: { userId: clone.userId },
    }),
  ];
  expectOk(await database.batchRun(statements));
  ctx.log.warn("passkey clone detected", { userId: clone.userId, passkeyId: clone.passkeyId });
  // Banner and, when email is configured, email (Identity §4.6a).
  await emailSecurityNotices(ctx, raised);
}

/** How a passkey added while signed in was enabled: after a magic-link sign-in, or ordinarily. */
async function signedInVia(env: Env, sessionId: string | undefined): Promise<PasskeyCreatedVia> {
  if (!sessionId) return "signed_in";
  const row = expectOk(
    await new Database(env.DB).first<{ fresh_auth_method: string | null }>(
      "SELECT fresh_auth_method FROM sessions WHERE id = ?",
      sessionId,
    ),
  );
  return row?.fresh_auth_method === "magic_link" ? "magic_link" : "signed_in";
}

/** After a successful registration: label the passkey, complete setup, raise the notice, audit. */
async function afterRegistration(env: Env, passkeyId: string, userId: string, name: string | null): Promise<void> {
  const ctx = hookContext(env);
  const store = currentStore();
  const ticket = store?.consumedTicket;
  const mode = store?.registration;
  // A member's first passkey after a magic-link sign-in is labelled "magic link" (Identity §4.4).
  const via: PasskeyCreatedVia = ticket
    ? ticket.via
    : await signedInVia(env, mode?.kind === "signed_in" ? mode.sessionId : undefined);
  const database = new Database(env.DB);
  const now = ctx.now();
  const statements = [
    database.statement("UPDATE passkeys SET created_via = ? WHERE id = ? AND user_id = ?", via, passkeyId, userId),
    await auditStatement(ctx, {
      action: "passkey.added",
      actor: userId,
      target: { type: "passkey", id: passkeyId },
      metadata: { createdVia: via },
    }),
  ];
  // Every addition raises a notice, except the first passkey at setup or acceptance (Identity §4.4).
  const raised: RaisedNotice[] = [];
  if (via !== "setup" && via !== "invitation") {
    raised.push({ userId, kind: "passkey_added", details: { passkeyName: name, createdVia: via }, at: now });
  }
  statements.push(...raised.map((n) => noticeStatement(database, n.userId, n.kind, n.details, n.at)));
  expectOk(await database.batchRun(statements));
  await emailSecurityNotices(ctx, raised);
  if (ticket?.via === "setup" && ticket.claim) await completeSetupClaim(ctx, ticket.claim, userId);
}

export function buildAuthOptions(env: Env, secrets: IdentitySecrets, installation: ClaimedInstallation) {
  const origin = installation.canonicalOrigin;
  const rpID = new URL(origin).hostname;

  return {
    appName: installation.workspaceName,
    baseURL: origin,
    basePath: BASE_PATH,
    trustedOrigins: [origin],
    // Always an explicit list, so better-auth never reads BETTER_AUTH_SECRETS from process.env itself.
    secrets: secrets.betterAuth,
    // Workaround 1.
    database: { db: createKysely(env.DB), type: "sqlite" as const },
    // Workaround 14.
    telemetry: { enabled: false },
    logger: {
      level: "warn" as const,
      log: (level: string, message: string, ...args: unknown[]) => {
        const detail = args.map((a) => (a instanceof Error ? a.message : String(a)));
        const log = logger();
        if (level === "error") log.error(`better-auth: ${message}`, { detail });
        else log.warn(`better-auth: ${message}`, { detail });
      },
    },
    emailAndPassword: { enabled: false },
    user: {
      modelName: "users",
      fields: {
        name: "display_name",
        emailVerified: "email_verified",
        image: "avatar_key",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
      additionalFields: {
        role: { type: "string", input: false, required: false, defaultValue: "member", fieldName: "role" },
        status: { type: "string", input: false, required: false, defaultValue: "active", fieldName: "status" },
        handle: { type: "string", input: false, required: false, fieldName: "handle" },
        emailNormalised: { type: "string", input: false, required: false, fieldName: "email_normalised" },
        firstSignedInAt: { type: "number", input: false, required: false, fieldName: "first_signed_in_at" },
        createdAttemptId: { type: "string", input: false, required: false, fieldName: "created_attempt_id" },
      },
    },
    session: {
      modelName: "sessions",
      fields: {
        userId: "user_id",
        expiresAt: "expires_at",
        ipAddress: "ip_address",
        userAgent: "user_agent",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
      expiresIn: SESSION_EXPIRES_IN_SECONDS,
      updateAge: SESSION_UPDATE_AGE_SECONDS,
      // Off: every request reads the session row, so a revocation takes effect on the next request.
      cookieCache: { enabled: false },
      additionalFields: {
        deviceLabel: { type: "string", input: false, required: false, fieldName: "device_label" },
        approxLocation: { type: "string", input: false, required: false, fieldName: "approx_location" },
        freshAuthAt: { type: "number", input: false, required: false, fieldName: "fresh_auth_at" },
        freshAuthMethod: { type: "string", input: false, required: false, fieldName: "fresh_auth_method" },
      },
    },
    account: {
      modelName: "auth_accounts",
      fields: {
        userId: "user_id",
        accountId: "account_id",
        providerId: "provider_id",
        accessToken: "access_token",
        refreshToken: "refresh_token",
        idToken: "id_token",
        accessTokenExpiresAt: "access_token_expires_at",
        refreshTokenExpiresAt: "refresh_token_expires_at",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
    },
    verification: {
      modelName: "auth_verifications",
      fields: { expiresAt: "expires_at", createdAt: "created_at", updatedAt: "updated_at" },
    },
    advanced: {
      database: { generateId: () => ulid(), joins: true },
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"], ipv6Subnet: 64 as const },
      // Workaround 8: better-auth prepends "__Secure-" itself when secure cookies are on, which would
      // make "__Secure-__Host-…". So its prefixing is off, the cookies are named __Host-…, and Secure is
      // forced through the default attributes. No Domain attribute: host-only, Path=/.
      useSecureCookies: false,
      cookiePrefix: COOKIE_PREFIX,
      defaultCookieAttributes: { secure: true, httpOnly: true, sameSite: "lax" as const, path: "/" },
    },
    // Workaround 14: a backstop only; our middleware enforces the real limits (rate-limits.ts).
    rateLimit: {
      enabled: true,
      window: 60,
      max: 100,
      customStorage: {
        consume: (key: string, rule: { window: number; max: number }) => consumeRateLimit(env.DB, key, rule),
      },
    },
    plugins: [
      // Magic links, members only (Identity §4.4). better-auth's GET verify isn't reachable from
      // outside (allowlist); our confirm route calls it on the server after our compare-and-set.
      magicLink({
        expiresIn: MAGIC_LINK_TTL_SECONDS,
        disableSignUp: true,
        storeToken: "hashed",
        // A backstop only; our middleware enforces the real per-IP and per-email limits.
        rateLimit: { window: 60, max: 100 },
        sendMagicLink: ({ email, token }) => issueMagicLink(env, secrets, installation, { email, token }),
      }),
      passkey({
        rpID,
        rpName: installation.workspaceName,
        // Workaround 3: when unset the plugin trusts the request's Origin header.
        origin,
        // Workaround 2 (registration options).
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
        registration: {
          requireSession: false,
          // Workaround 6: without a session, only a valid enrolment ticket names the user.
          resolveUser: async ({ ctx }) => {
            const raw = readTicketCookie(ctx.headers ?? ctx.request?.headers);
            if (!raw) throw apiError("UNAUTHORIZED", "ENROLMENT_TICKET_REQUIRED", "An enrolment ticket is required.");
            const key = secrets.tokenHashKey;
            const ticket = await findValidTicket(env.DB, await tokenHash(key, raw), Date.now());
            if (!ticket)
              throw apiError("UNAUTHORIZED", "ENROLMENT_TICKET_INVALID", "The enrolment ticket isn't valid.");
            return { id: ticket.userId, name: ticket.email, displayName: ticket.displayName };
          },
          afterVerification: async ({ verification, user, clientData }) => {
            // Workaround 2: the plugin verifies with requireUserVerification: false.
            if (!verification.registrationInfo?.userVerified) {
              throw apiError("BAD_REQUEST", "USER_VERIFICATION_REQUIRED", "User verification is required.");
            }
            const store = currentStore();
            const mode = store?.registration;
            if (!store || !mode)
              throw apiError("UNAUTHORIZED", "REGISTRATION_REFUSED", "Registration isn't allowed here.");
            if (mode.kind === "signed_in") {
              if (mode.userId !== user.id) throw apiError("UNAUTHORIZED", "REGISTRATION_REFUSED", "Wrong user.");
              return;
            }
            // Workaround 6: consume the ticket at verify, by compare-and-set, before any write.
            const challenge = clientChallenge(clientData.response.clientDataJSON);
            const payload = challenge
              ? await consumeTicket(env.DB, mode.ticketHash, user.id, challenge, Date.now())
              : null;
            if (!payload)
              throw apiError("UNAUTHORIZED", "ENROLMENT_TICKET_INVALID", "The enrolment ticket isn't valid.");
            store.consumedTicket = { userId: user.id, via: payload.via, claim: payload.claim };
          },
        },
        authentication: {
          afterVerification: async ({ verification }) => {
            // Workaround 2.
            if (!verification.authenticationInfo.userVerified) {
              throw apiError("UNAUTHORIZED", "USER_VERIFICATION_REQUIRED", "User verification is required.");
            }
            // Accepted: record the counter move before better-auth stores it (clone versus race).
            const before = currentStore()?.passkeyBefore;
            if (before) {
              await recordCounterMove(
                env.DB,
                before.id,
                before.count,
                verification.authenticationInfo.newCounter,
                Date.now(),
              );
            }
          },
        },
        schema: {
          passkey: {
            modelName: "passkeys",
            fields: {
              publicKey: "public_key",
              userId: "user_id",
              credentialID: "credential_id",
              counter: "sign_count",
              deviceType: "device_type",
              backedUp: "backed_up",
              createdAt: "created_at",
            },
          },
        },
      }),
    ],
    databaseHooks: {
      user: {
        create: {
          // Workaround 10: invite-only. Refuse unless our setup or accept route set the marker.
          before: (user) => {
            const marker = currentStore()?.create;
            if (!marker) {
              logger().warn("user creation refused: no server-set marker");
              return Promise.resolve(false);
            }
            return Promise.resolve({
              data: {
                ...user,
                emailNormalised: normaliseEmail(user.email),
                createdAttemptId: marker.attemptId,
                role: marker.role,
                handle: marker.handle,
                status: "active",
              },
            });
          },
        },
      },
      session: {
        create: {
          before: async (session, ctx) => {
            const store = currentStore();
            // Workaround 11: step-up never keeps a second session. Record who verified, then veto.
            if (store?.reauth) {
              store.reauth.verifiedUserId = session.userId;
              return false;
            }
            // No better-auth path signs in anyone who isn't active (Identity §4.4).
            const user = expectOk(
              await new Database(env.DB).first<{ status: string; role: string }>(
                "SELECT status, role FROM users WHERE id = ?",
                session.userId,
              ),
            );
            if (user?.status !== "active") return false;
            const path = ctx?.path;
            const viaPasskey = path === PATH_VERIFY_AUTHENTICATION || path === PATH_VERIFY_REGISTRATION;
            const viaMagicLink = path === PATH_MAGIC_LINK_VERIFY;
            // A magic-link session only through our confirm route, for the member its row named, and
            // only for role member (Identity §2: owners and admins never sign in by magic link).
            if (viaMagicLink) {
              const confirm = store?.magicLinkConfirm;
              if (!confirm || confirm.userId !== session.userId || user.role !== "member") {
                logger().warn("magic-link session refused outside our confirm route or for a non-member");
                return false;
              }
            }
            const userAgent = session.userAgent ?? null;
            return {
              data: {
                ...session,
                deviceLabel: deviceLabel(userAgent),
                approxLocation: approxLocation(store?.cf),
                // Both record the time; only `passkey` satisfies step-up. `magic_link` lets a member with
                // no passkeys add their first within 10 minutes (Identity §4.5; the engine's exception).
                freshAuthAt: viaPasskey || viaMagicLink ? Date.now() : null,
                freshAuthMethod: viaPasskey ? "passkey" : viaMagicLink ? "magic_link" : null,
              },
            };
          },
          after: async (session) => {
            expectOk(
              await new Database(env.DB).run(
                "UPDATE users SET first_signed_in_at = ? WHERE id = ? AND first_signed_in_at IS NULL",
                Date.now(),
                session.userId,
              ),
            );
            // The mount sets the known-device cookie on every sign-in (Identity §4.4).
            const store = currentStore();
            if (store) store.sessionCreated = { userId: session.userId, sessionId: session.id };
          },
        },
        delete: {
          // Every deleted session row closes its sockets (TDD §3.5; revocation.ts).
          after: async (session) => {
            await closeSessionConnections(logger(), session.userId, session.id, env);
          },
        },
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        // Workaround 4: read the challenge before better-auth consumes it.
        if (ctx.path !== PATH_VERIFY_AUTHENTICATION) return;
        const store = currentStore();
        if (!store) return;
        const name = ctx.context.createAuthCookie("better-auth-passkey").name;
        const token = await ctx.getSignedCookie(name, ctx.context.secret);
        if (!token) return;
        const value = await ctx.context.internalAdapter.findVerificationValue(token);
        if (!value) return;
        try {
          const parsed = JSON.parse(value.value) as { expectedChallenge?: unknown };
          if (typeof parsed.expectedChallenge === "string") store.passkeyChallenge = parsed.expectedChallenge;
        } catch {
          // Not ours to judge: better-auth refuses a bad challenge itself.
        }
        store.passkeyChallengeIssuedAt = new Date(value.createdAt).getTime();
        // The counter before this assertion, for the counter move recorded if it's accepted.
        const response = (ctx.body as { response?: { id?: unknown } } | undefined)?.response;
        if (typeof response?.id === "string") {
          const row = expectOk(
            await new Database(env.DB).first<{ id: string; sign_count: number }>(
              "SELECT id, sign_count FROM passkeys WHERE credential_id = ?",
              response.id,
            ),
          );
          if (row) store.passkeyBefore = { id: row.id, count: row.sign_count };
        }
      }),
      after: createAuthMiddleware(async (ctx) => {
        const returned = ctx.context.returned;
        if (ctx.path === PATH_AUTHENTICATE_OPTIONS) {
          // Workaround 2: the plugin hardcodes "preferred" in the authentication options.
          const options = returnedObject(returned);
          if (options && "challenge" in options) return ctx.json({ ...options, userVerification: "required" });
          return;
        }
        if (ctx.path === PATH_REGISTER_OPTIONS) {
          // Workaround 6: bind the ticket to the challenge just issued.
          const options = returnedObject(returned);
          const mode = currentStore()?.registration;
          if (options && typeof options.challenge === "string" && mode?.kind === "ticket") {
            await bindChallenge(env.DB, mode.ticketHash, options.challenge, Date.now());
          }
          return;
        }
        if (ctx.path === PATH_VERIFY_REGISTRATION) {
          const result = returnedObject(returned);
          if (result && typeof result.id === "string" && typeof result.userId === "string") {
            await afterRegistration(
              env,
              result.id,
              result.userId,
              typeof result.name === "string" ? result.name : null,
            );
          }
          return;
        }
        if (ctx.path !== PATH_VERIFY_AUTHENTICATION) return;
        const body = ctx.body as { response?: AuthenticationResponseJSON } | undefined;
        const response = body?.response;
        if (!response || typeof response.id !== "string") return;
        if (returnedObject(returned)) {
          await settleCounter(env.DB, response.id, Date.now());
          return;
        }
        // Workaround 4: on the library's generic failure, tell a clone from a race and from any other failure.
        const store = currentStore();
        if (errorCode(returned) !== "AUTHENTICATION_FAILED" || !store?.passkeyChallenge) return;
        const verdict = await judgeRefusal(
          env,
          origin,
          rpID,
          response,
          store.passkeyChallenge,
          store.passkeyChallengeIssuedAt ?? Date.now(),
        );
        if (verdict?.kind === "race") {
          // A newer legitimate sign-in got there first: refused quietly, the person just tries again.
          logger().info("passkey assertion lost a counter race; refused without a clone alert");
          return;
        }
        if (verdict?.kind !== "clone") return;
        const clone = { passkeyId: verdict.passkeyId, userId: verdict.userId };
        store.cloneDetected = clone;
        await raiseClone(env, clone);
        throw apiError("UNAUTHORIZED", "clone_detected", "This passkey looks like a copy and was refused.");
      }),
    },
  } satisfies BetterAuthOptions;
}

export function createAuth(env: Env, secrets: IdentitySecrets, installation: ClaimedInstallation) {
  return betterAuth(buildAuthOptions(env, secrets, installation));
}
export type Auth = ReturnType<typeof createAuth>;

const instances = new Map<string, Auth>();

/** One instance per installation origin (and secret set), rebuilt only when either changes (TDD §8.1). */
export function authFor(env: Env, secrets: IdentitySecrets, installation: ClaimedInstallation): Auth {
  const key = JSON.stringify([
    installation.canonicalOrigin,
    installation.workspaceName,
    secrets.betterAuth,
    secrets.tokenHashKey,
  ]);
  let auth = instances.get(key);
  if (!auth) {
    // Bounded: an installation has one origin; tests make more.
    if (instances.size >= 16) instances.clear();
    auth = createAuth(env, secrets, installation);
    instances.set(key, auth);
  }
  return auth;
}

/** Audit helper for routes that use better-auth on the server. */
export async function auditAuth(ctx: CoreContext, action: string, actor: string | null, targetId: string) {
  await audit(ctx, { action, actor, target: { type: "user", id: targetId } });
}

// The better-auth configuration under test (TDD §8.1 "Configuration (summary)"), built per installation origin.
import { passkey } from "@better-auth/passkey";
import { verifyAuthenticationResponse } from "@simplewebauthn/server";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { magicLink } from "better-auth/plugins/magic-link";
import { ulid } from "ulid";
import { store } from "./context";
import { createKysely } from "./d1-kysely";

export interface Env {
  DB: D1Database;
  BETTER_AUTH_SECRET: string;
  TOKEN_HASH_KEY: string;
  SPIKE_TEST_ROUTES?: string;
}

/** Per-installation state (TDD §2.1 `installation`): workspace data, not deployment configuration. */
export interface Installation {
  workspaceName: string;
  canonicalOrigin: string;
}

export interface AuthVariant {
  /** "binding": `database: env.DB` (better-auth's built-in D1 detection). "kysely-iso" / "kysely-epoch": our Kysely. */
  db?: "binding" | "kysely-iso" | "kysely-epoch";
  /** Overrides BETTER_AUTH_SECRET with a versioned list (BETTER_AUTH_SECRETS semantics). */
  secrets?: { version: number; value: string }[];
  secret?: string;
  /** "officebox": __Host- prefixed cookies. "default": better-auth's defaults. */
  cookies?: "officebox" | "default";
  /** Leave the passkey plugin's `origin` unset (it then trusts the request's Origin header). */
  passkeyOriginFromRequest?: boolean;
  /** Override the magic-link plugin's disableSignUp (Q4 checks the create hook still refuses). */
  magicLinkDisableSignUp?: boolean;
}

/** Log lines better-auth emits; tests read them (Q3: is the library's counter error visible?). */
export const authLog: { level: string; message: string; args: unknown[] }[] = [];

export const SESSION_COOKIE = "__Host-officebox.session_token";
export const ENROL_COOKIE = "__Host-officebox-enrol";

async function hmac(key: string, value: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(value)));
  return btoa(String.fromCharCode(...sig)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
export const tokenHash = hmac;

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase().normalize("NFKC");
}

function readCookie(headers: Headers | undefined, name: string): string | undefined {
  const raw = headers?.get("cookie");
  if (!raw) return undefined;
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

/** better-auth's rate-limit customStorage: one atomic upsert in D1 (Q8). */
export function d1RateLimitStorage(db: D1Database) {
  return {
    async consume(key: string, rule: { window: number; max: number }) {
      const now = Date.now();
      const windowStartCutoff = now - rule.window * 1000;
      const row = await db
        .prepare(
          `INSERT INTO rate_counters (key, count, window_start) VALUES (?1, 1, ?2)
           ON CONFLICT(key) DO UPDATE SET
             count = CASE WHEN window_start <= ?3 THEN 1 ELSE count + 1 END,
             window_start = CASE WHEN window_start <= ?3 THEN ?2 ELSE window_start END
           RETURNING count, window_start`,
        )
        .bind(`ba:${key}`, now, windowStartCutoff)
        .first<{ count: number; window_start: number }>();
      const count = row?.count ?? 1;
      const start = row?.window_start ?? now;
      const allowed = count <= rule.max;
      return { allowed, retryAfter: allowed ? null : Math.max(1, Math.ceil((start + rule.window * 1000 - now) / 1000)) };
    },
  };
}

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const b = atob(s.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((s.length + 3) % 4));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}
function b64ToBytes(s: string): Uint8Array<ArrayBuffer> {
  return b64urlToBytes(s.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, ""));
}

export function buildAuthOptions(env: Env, inst: Installation, variant: AuthVariant = {}) {
  const origin = inst.canonicalOrigin;
  const rpID = new URL(origin).hostname;
  const dbMode = variant.db ?? "kysely-epoch";
  const database =
    dbMode === "binding" ? env.DB : { db: createKysely(env.DB, { epochMs: dbMode === "kysely-epoch" }), type: "sqlite" as const };
  const cookies = variant.cookies ?? "officebox";

  const options = {
    appName: inst.workspaceName,
    baseURL: origin,
    basePath: "/api/auth",
    trustedOrigins: [origin],
    ...(variant.secrets ? { secrets: variant.secrets } : { secret: variant.secret ?? env.BETTER_AUTH_SECRET }),
    database,
    telemetry: { enabled: false },
    logger: {
      level: "debug",
      log: (level, message, ...args) => {
        authLog.push({ level, message, args });
      },
    },
    emailAndPassword: { enabled: false },
    user: {
      modelName: "users",
      fields: { name: "display_name", emailVerified: "email_verified", image: "avatar_key", createdAt: "created_at", updatedAt: "updated_at" },
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
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
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
      database: { generateId: () => ulid() },
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"], ipv6Subnet: 64 },
      ...(cookies === "officebox"
        ? {
            // better-auth prepends "__Secure-" itself when useSecureCookies is on, which would make "__Secure-__Host-…".
            // So: turn its prefixing off, name the cookies __Host-…, and force Secure through the default attributes.
            useSecureCookies: false,
            cookiePrefix: "__Host-officebox",
            defaultCookieAttributes: { secure: true, httpOnly: true, sameSite: "lax", path: "/" },
          }
        : {}),
    },
    rateLimit: { enabled: true, window: 60, max: 100, customStorage: d1RateLimitStorage(env.DB) },
    plugins: [
      magicLink({
        expiresIn: 900,
        disableSignUp: variant.magicLinkDisableSignUp ?? true,
        storeToken: "hashed",
        // Same work for every address: normalise, look up, write one row; mail only to active members with role member.
        sendMagicLink: async ({ email, token, url }) => {
          const norm = normaliseEmail(email);
          const user = await env.DB.prepare("SELECT id, role, status FROM users WHERE email_normalised = ?")
            .bind(norm)
            .first<{ id: string; role: string; status: string }>();
          const eligible = !!user && user.role === "member" && user.status === "active";
          const now = Date.now();
          await env.DB.prepare(
            "INSERT INTO magic_link_issues (token_hash, email_normalised, user_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
          )
            .bind(await hmac(env.TOKEN_HASH_KEY, token), norm, eligible ? user.id : null, now + 900_000, now)
            .run();
          if (eligible) {
            // "Sending" (here: capturing) runs in waitUntil, so the response doesn't wait for it.
            // better-auth's own `url` (a GET that signs in) is never emailed; our link carries the token in the fragment.
            const send = env.DB.prepare("INSERT INTO spike_outbox (email, token, better_auth_url, our_link, created_at) VALUES (?, ?, ?, ?, ?)")
              .bind(norm, token, url, `${origin}/sign-in/link#t=${token}`, now)
              .run();
            const wu = store()?.waitUntil;
            if (wu) wu(send);
            else await send;
          }
        },
      }),
      passkey({
        rpID,
        rpName: inst.workspaceName,
        ...(variant.passkeyOriginFromRequest ? {} : { origin }),
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
        registration: {
          requireSession: false,
          // First passkey without a session: only an enrolment ticket cookie names the user (Identity §4.4).
          resolveUser: async ({ ctx }) => {
            const raw = readCookie(ctx.headers ?? ctx.request?.headers, ENROL_COOKIE);
            if (!raw) throw new APIError("UNAUTHORIZED", { code: "ENROLMENT_TICKET_REQUIRED", message: "enrolment ticket required" });
            const row = await env.DB.prepare(
              `SELECT t.user_id, u.email, u.display_name FROM auth_tokens t JOIN users u ON u.id = t.user_id
                WHERE t.token_hash = ? AND t.kind = 'passkey_enrol' AND t.used_at IS NULL AND t.revoked_at IS NULL AND t.expires_at > ?`,
            )
              .bind(await hmac(env.TOKEN_HASH_KEY, raw), Date.now())
              .first<{ user_id: string; email: string; display_name: string }>();
            if (!row) throw new APIError("UNAUTHORIZED", { code: "ENROLMENT_TICKET_INVALID", message: "enrolment ticket invalid" });
            return { id: row.user_id, name: row.email, displayName: row.display_name };
          },
          afterVerification: async ({ ctx, verification, user }) => {
            // UV can't be required through config (the plugin passes requireUserVerification: false), so refuse here.
            if (!verification.registrationInfo?.userVerified) {
              throw new APIError("BAD_REQUEST", { code: "USER_VERIFICATION_REQUIRED", message: "user verification required" });
            }
            // Consume the enrolment ticket at verify, by compare-and-set (only when registering without a session).
            const raw = readCookie(ctx.headers ?? ctx.request?.headers, ENROL_COOKIE);
            if (raw) {
              const res = await env.DB.prepare(
                `UPDATE auth_tokens SET used_at = ?1 WHERE token_hash = ?2 AND user_id = ?3 AND kind = 'passkey_enrol'
                   AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?1`,
              )
                .bind(Date.now(), await hmac(env.TOKEN_HASH_KEY, raw), user.id)
                .run();
              if (res.meta.changes !== 1) throw new APIError("UNAUTHORIZED", { code: "ENROLMENT_TICKET_INVALID", message: "ticket used" });
            }
          },
        },
        authentication: {
          afterVerification: async ({ verification }) => {
            if (!verification.authenticationInfo.userVerified) {
              throw new APIError("UNAUTHORIZED", { code: "USER_VERIFICATION_REQUIRED", message: "user verification required" });
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
          // Invite-only: refuse unless our setup or accept route set the marker (Identity §4.4).
          before: async (user) => {
            const marker = store()?.create;
            if (!marker) return false;
            return { data: { ...user, emailNormalised: normaliseEmail(user.email), createdAttemptId: marker.attemptId } };
          },
        },
      },
      session: {
        create: {
          before: async (session, ctx) => {
            const s = store();
            // Step-up: never keep a second session. Record who verified, then veto the row.
            if (s?.reauth) {
              s.reauth.verifiedUserId = session.userId;
              return false;
            }
            const user = await env.DB.prepare("SELECT status FROM users WHERE id = ?").bind(session.userId).first<{ status: string }>();
            if (!user || user.status !== "active") return false;
            const path = ctx?.path;
            const viaPasskey = path === "/passkey/verify-authentication" || path === "/passkey/verify-registration";
            return {
              data: {
                ...session,
                deviceLabel: (session.userAgent || "").slice(0, 64) || null,
                freshAuthAt: viaPasskey ? Date.now() : null,
                freshAuthMethod: viaPasskey ? "passkey" : path === "/magic-link/verify" ? "magic_link" : null,
              },
            };
          },
          after: async (session) => {
            await env.DB.prepare("UPDATE users SET first_signed_in_at = ? WHERE id = ? AND first_signed_in_at IS NULL")
              .bind(Date.now(), session.userId)
              .run();
          },
        },
        delete: {
          after: async (session) => {
            // Q4: a session-delete hook exists. The app would close this session's sockets here (TDD §3.5).
            await env.DB.prepare("INSERT INTO security_notices (user_id, kind, details, created_at) VALUES (?, 'spike_session_deleted', ?, ?)")
              .bind(session.userId, session.id, Date.now())
              .run();
          },
        },
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path === "/passkey/verify-authentication") {
          // Read the challenge before better-auth consumes it, so the after hook can re-verify a refused assertion.
          const name = ctx.context.createAuthCookie("better-auth-passkey").name;
          const token = await ctx.getSignedCookie(name, ctx.context.secret);
          if (token) {
            const v = await ctx.context.internalAdapter.findVerificationValue(token);
            const s = store();
            if (v && s) s.passkeyChallenge = (JSON.parse(v.value) as { expectedChallenge: string }).expectedChallenge;
          }
        }
      }),
      after: createAuthMiddleware(async (ctx) => {
        // UV required in the authentication options too: the plugin hardcodes "preferred" there.
        if (ctx.path === "/passkey/generate-authenticate-options") {
          const returned = ctx.context.returned;
          if (returned && typeof returned === "object" && !(returned instanceof APIError) && "challenge" in returned) {
            return ctx.json({ ...(returned as Record<string, unknown>), userVerification: "required" });
          }
        }
        // Counter rule on the library's error path: re-verify the refused assertion (signature, origin, RP ID, UV)
        // with the stored counter set aside; if it is genuine and its counter is at or below the stored one, it's a clone.
        if (ctx.path === "/passkey/verify-authentication") {
          const returned = ctx.context.returned;
          const s = store();
          if (returned instanceof APIError && (returned.body as { code?: string } | undefined)?.code === "AUTHENTICATION_FAILED" && s?.passkeyChallenge) {
            const resp = (ctx.body as { response: { id: string } }).response;
            const pk = await env.DB.prepare("SELECT id, user_id, public_key, sign_count, transports FROM passkeys WHERE credential_id = ?")
              .bind(resp.id)
              .first<{ id: string; user_id: string; public_key: string; sign_count: number; transports: string | null }>();
            if (!pk) return;
            try {
              const v = await verifyAuthenticationResponse({
                response: resp as never,
                expectedChallenge: s.passkeyChallenge,
                expectedOrigin: origin,
                expectedRPID: rpID,
                credential: { id: resp.id, publicKey: b64ToBytes(pk.public_key), counter: 0 },
                requireUserVerification: true,
              });
              const presented = v.authenticationInfo.newCounter;
              if (v.verified && (presented > 0 || pk.sign_count > 0) && presented <= pk.sign_count) {
                s.cloneDetected = { passkeyId: pk.id, userId: pk.user_id, stored: pk.sign_count, presented };
                await env.DB.prepare("INSERT INTO security_notices (user_id, kind, details, created_at) VALUES (?, 'passkey_clone_detected', ?, ?)")
                  .bind(pk.user_id, JSON.stringify({ passkeyId: pk.id, stored: pk.sign_count, presented }), Date.now())
                  .run();
                throw new APIError("UNAUTHORIZED", { code: "clone_detected", message: "clone_detected" });
              }
            } catch (e) {
              if (e instanceof APIError) throw e;
              // Not a genuine assertion: leave better-auth's AUTHENTICATION_FAILED as it is.
            }
          }
        }
      }),
    },
  } satisfies BetterAuthOptions;
  return options;
}

export function createAuth(env: Env, inst: Installation, variant: AuthVariant = {}) {
  return betterAuth(buildAuthOptions(env, inst, variant));
}
export type Auth = ReturnType<typeof createAuth>;

/** One instance per installation origin, rebuilt only when the record changes (TDD §8.1). */
const instances = new Map<string, Auth>();
export let instancesBuilt = 0;
export function authFor(env: Env, inst: Installation): Auth {
  const key = `${inst.canonicalOrigin}|${inst.workspaceName}`;
  let a = instances.get(key);
  if (!a) {
    a = createAuth(env, inst);
    instancesBuilt++;
    instances.set(key, a);
  }
  return a;
}
export function clearInstances(): void {
  instances.clear();
}

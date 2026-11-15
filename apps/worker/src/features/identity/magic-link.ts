import {
  apiError,
  err,
  MAGIC_LINK_TTL_SECONDS,
  normaliseEmail,
  ok,
  type ApiError,
  type Result,
} from "@officebox/shared";
import { APIError } from "better-auth/api";
import type { CoreContext } from "../../core/context";
import { Database, expectOk } from "../../core/db";
import { rootLogger } from "../../core/log";
import { checkLimit, defineLimit } from "../../core/rate-limit";
import type { Env } from "../../env";
import { enqueueEmail } from "../email/delivery";
import { magicLinkEmail } from "../email/templates";
import type { Auth } from "./auth";
import { tokenHash } from "./crypto";
import { approxLocation, deviceLabel } from "./device";
import type { ClaimedInstallation } from "./installation";
import { recordSignInDevice } from "./known-devices";
import { emailSecurityNotices } from "./notice-email";
import { noticeStatement } from "./notices";
import { ipKey } from "./rate-limits";
import { currentStore, runWithStore } from "./request-store";
import type { IdentitySecrets } from "./secrets";

/**
 * Magic links, **members only** (Identity §2, §4.4; TDD §8.1; Platform §10), on better-auth's
 * `magicLink` plugin with `storeToken: "hashed"`, `disableSignUp` and `expiresIn: 900`.
 *
 * **Request** (`POST /api/auth/sign-in/magic-link`, better-auth's route behind our middleware,
 * {@link prepareMagicLinkRequest}): magic links must be available (email configured and
 * `magic_link_enabled`), then the per-IP limit (20 an hour) refuses with `rate_limited`, and the
 * per-email limit (3 per fixed 15-minute window, keyed by an HMAC of the normalised address, unknown
 * addresses counted the same) marks the request **suppressed**: it still runs, does the same work and
 * answers the same, but sends no mail. Windows are fixed, so a flood never extends one.
 *
 * **Issue** (better-auth's `sendMagicLink`, {@link issueMagicLink}): the **same work for every
 * address**: normalise, look up, write one `magic_link_issues` row (with the user only when they get
 * mail), render the email; then mail goes out from `waitUntil`, deferred to a later task, only for an
 * active user whose role is `member` and whose request wasn't suppressed. better-auth's own `url` (a GET
 * that signs in) is never sent: the link is our confirmation page, `/sign-in/link#t=…`, on the
 * canonical origin.
 *
 * **Confirm** (`POST /api/sign-in/link`, {@link confirmMagicLink}): our compare-and-set consumes the row,
 * re-checking role `member` and status `active`, and only the winner calls better-auth's verify
 * (`auth.api.magicLinkVerify`) on the server; its session cookie is forwarded and its body (which holds
 * the session token) is dropped. Two concurrent POSTs with one token sign in at most once.
 */

export const MAGIC_LINK_LIMITS = {
  /** 3 emails per fixed 15-minute window per normalised address (Platform §8). */
  perEmail: defineLimit({
    mechanism: "d1",
    name: "magic_link_email",
    limit: 3,
    window: { kind: "fixed", seconds: 900 },
  }),
  /** 20 requests per hour per IP (Platform §8). */
  perIp: defineLimit({ mechanism: "d1", name: "magic_link_ip", limit: 20, window: { kind: "fixed", seconds: 3600 } }),
  /** Confirmation POSTs: 10 per minute per IP (Platform §8). */
  confirmIp: defineLimit({
    mechanism: "binding",
    name: "magic_link_confirm",
    binding: "MAGIC_LINK_RATE_LIMITER",
    periodSeconds: 60,
  }),
};

const TTL_MS = MAGIC_LINK_TTL_SECONDS * 1000;

/** The confirmation link: our page, token in the fragment, canonical origin (Identity §2). */
export function magicLinkUrl(canonicalOrigin: string, token: string): string {
  return `${new URL("/sign-in/link", canonicalOrigin).toString()}#t=${token}`;
}

interface UserRow {
  id: string;
  email: string | null;
  role: string;
  status: string;
}

async function findByEmail(db: D1Database, normalised: string): Promise<UserRow | null> {
  return expectOk(
    await new Database(db).first<UserRow>(
      "SELECT id, email, role, status FROM users WHERE email_normalised = ?",
      normalised,
    ),
  );
}

export interface PreparedRequest {
  /** The address to hand better-auth: the account's stored email, or the normalised input. */
  email: string;
}

/**
 * Our middleware before better-auth's request route: availability, then the limits. A per-IP refusal
 * is an error; a per-email refusal only marks the request suppressed (same answer, no mail).
 */
export async function prepareMagicLinkRequest(
  ctx: CoreContext,
  secrets: IdentitySecrets,
  request: Request,
  rawEmail: string,
  available: boolean,
): Promise<Result<PreparedRequest, ApiError>> {
  if (!available) return err(apiError("unavailable", "Email sign-in links aren't available. Use your passkey."));
  const perIp = await checkLimit(ctx, MAGIC_LINK_LIMITS.perIp, ipKey(request));
  if (!perIp.ok) return perIp;
  const normalised = normaliseEmail(rawEmail);
  const emailKey = await tokenHash(secrets.tokenHashKey, `magic-link-email:${normalised}`);
  const perEmail = await checkLimit(ctx, MAGIC_LINK_LIMITS.perEmail, emailKey);
  const store = currentStore();
  if (store) store.magicLink = { suppressed: !perEmail.ok };
  // better-auth finds the user by its own (lower-cased) email column: give it the stored address, so an
  // address typed in another Unicode form still signs the member in. Same lookup for every address.
  const user = await findByEmail(ctx.env.DB, normalised);
  return ok({ email: user?.email ?? normalised });
}

/** Runs `work` after the response, in a later task, so neither branch does more before answering. */
function afterResponse(work: () => Promise<unknown>): void {
  const deferred = new Promise<void>((resolve) => setTimeout(resolve, 0)).then(work);
  const waitUntil = currentStore()?.waitUntil;
  if (waitUntil) waitUntil(deferred.catch(() => undefined));
  else void deferred.catch(() => undefined);
}

/** better-auth's `sendMagicLink`: equal work for every address; mail only to active members. */
export async function issueMagicLink(
  env: Env,
  secrets: IdentitySecrets,
  installation: ClaimedInstallation,
  input: { email: string; token: string },
): Promise<void> {
  const store = currentStore();
  const log = store?.log;
  const now = Date.now();
  const normalised = normaliseEmail(input.email);
  const user = await findByEmail(env.DB, normalised);
  const suppressed = store?.magicLink?.suppressed ?? false;
  const eligible = user !== null && user.role === "member" && user.status === "active" && user.email !== null;
  const sends = eligible && !suppressed;
  expectOk(
    await new Database(env.DB).run(
      `INSERT INTO magic_link_issues (token_hash, email_normalised, user_id, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      await tokenHash(secrets.tokenHashKey, input.token),
      normalised,
      sends ? user.id : null,
      now + TTL_MS,
      now,
    ),
  );
  const rendered = magicLinkEmail({
    workspace: installation.workspaceName,
    email: user?.email ?? input.email,
    link: magicLinkUrl(installation.canonicalOrigin, input.token),
  });
  const to = user?.email ?? input.email;
  afterResponse(async () => {
    if (!sends) return;
    const ctx: CoreContext = { env, log: log ?? rootLogger, now: Date.now };
    const queued = await enqueueEmail(ctx, { kind: "magic_link", to, ...rendered });
    if (!queued.ok) ctx.log.warn("magic link email not queued");
  });
}

const INVALID_LINK: ApiError = apiError("gone", "This sign-in link isn't valid any more. Ask for a new one.", {
  reason: "magic_link_invalid",
});

export interface ConfirmedSignIn {
  userId: string;
  /** Set-Cookie values to forward: the session cookie, and the device cookie. */
  setCookies: string[];
}

/** `POST /api/sign-in/link`: our compare-and-set, then better-auth's verify on the server. */
export async function confirmMagicLink(
  ctx: CoreContext,
  secrets: IdentitySecrets,
  auth: Auth,
  request: Request,
  token: string,
): Promise<Result<ConfirmedSignIn, ApiError>> {
  const now = ctx.now();
  const hash = await tokenHash(secrets.tokenHashKey, token);
  // Re-checked at consume time: a member promoted or disabled since the link was sent can't use it.
  const row = expectOk(
    await new Database(ctx.env.DB).first<{ user_id: string }>(
      `UPDATE magic_link_issues SET consumed_at = ?1
        WHERE token_hash = ?2 AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > ?1
          AND user_id IN (SELECT id FROM users
                           WHERE role = 'member' AND status = 'active'
                             AND email_normalised = magic_link_issues.email_normalised)
        RETURNING user_id`,
      now,
      hash,
    ),
  );
  if (!row) return err(INVALID_LINK);

  const store = currentStore() ?? {};
  let headers: Headers | null;
  let userId: string | null;
  try {
    const result = await runWithStore({ ...store, magicLinkConfirm: { userId: row.user_id } }, () =>
      auth.api.magicLinkVerify({ query: { token }, headers: request.headers, returnHeaders: true }),
    );
    headers = result.headers;
    const response = result.response as { user?: { id?: unknown } } | null;
    userId = typeof response?.user?.id === "string" ? response.user.id : null;
  } catch (error) {
    if (!(error instanceof APIError)) throw error;
    ctx.log.warn("magic link verify refused after our consume", { status: error.status });
    return err(INVALID_LINK);
  }
  const sessionCookies = headers?.getSetCookie() ?? [];
  if (userId !== row.user_id || sessionCookies.length === 0) {
    ctx.log.error("magic link verify signed in someone unexpected; refusing", { expected: row.user_id });
    if (userId) await auth.api.revokeSessions({ headers: new Headers({ cookie: cookiePairs(sessionCookies) }) });
    return err(INVALID_LINK);
  }

  // Known devices: a sign-in from a browser this member hasn't used raises a security notice (§4.4).
  const device = await recordSignInDevice(ctx.env.DB, secrets.tokenHashKey, userId, request.headers, now);
  if (device.isNew) {
    const details = {
      deviceLabel: deviceLabel(request.headers.get("User-Agent")),
      approxLocation: approxLocation(request.cf as { city?: unknown; country?: unknown } | undefined),
    };
    const database = new Database(ctx.env.DB);
    expectOk(await database.batchRun([noticeStatement(database, userId, "magic_link_new_device", details, now)]));
    await emailSecurityNotices(ctx, [{ userId, kind: "magic_link_new_device", details, at: now }]);
  }
  ctx.log.info("signed in with a magic link", { userId, newDevice: device.isNew });
  return ok({ userId, setCookies: [...sessionCookies, device.setCookie] });
}

/** `name=value` pairs from Set-Cookie headers, as a Cookie header. */
function cookiePairs(setCookies: readonly string[]): string {
  return setCookies.map((c) => c.split(";")[0] ?? "").join("; ");
}

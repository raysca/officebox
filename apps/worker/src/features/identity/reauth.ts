import { apiError, err, ok, type ApiError, type ReauthBody, type Result } from "@officebox/shared";
import { APIError } from "better-auth/api";
import { audit } from "../../core/audit";
import type { AuthContext, CoreContext } from "../../core/context";
import { Database, expectOk } from "../../core/db";
import type { Auth } from "./auth";
import { currentStore, runWithStore } from "./request-store";

/**
 * Step-up re-authentication (Identity §4.5; M1a-0 spike Q10, workaround 11).
 *
 * `POST /me/reauth/options` asks better-auth for passkey authentication options scoped to the signed-in
 * user's passkeys and forwards the challenge cookie. `POST /me/reauth` runs better-auth's full passkey
 * verification (signature, canonical origin and RP ID, UV through our hook, the counter) inside a
 * `reauth` context: the session-create hook records the verified user and **vetoes the new session**,
 * so better-auth answers `UNABLE_TO_CREATE_SESSION` after verifying. We then check the verified user
 * is the session's user and set `fresh_auth_at` / `fresh_auth_method = 'passkey'` on the **current**
 * session. No second session is ever created.
 *
 * Failures are audited (`auth.reauth_failed`). The limits (5 per 10 minutes per session, and the
 * per-IP passkey limit) run in the route before this.
 */

export interface ReauthOptions {
  options: Record<string, unknown>;
  headers: Headers;
}

export async function reauthOptions(auth: Auth, headers: Headers): Promise<ReauthOptions> {
  const result = await auth.api.generatePasskeyAuthenticationOptions({ headers, returnHeaders: true });
  return { options: result.response as unknown as Record<string, unknown>, headers: result.headers };
}

const FAILED = (reason: string): ApiError =>
  apiError("forbidden", "That passkey couldn't confirm it's you.", { reason });

export async function reauthenticate(
  ctx: CoreContext,
  auth: Auth,
  headers: Headers,
  me: AuthContext,
  body: ReauthBody,
): Promise<Result<{ freshAuthAt: number }, ApiError>> {
  const store = { ...(currentStore() ?? {}), reauth: { userId: me.userId } as { userId: string; verifiedUserId?: string } };
  let refusal: string | null = null;
  await runWithStore(store, async () => {
    try {
      // The body is the browser's WebAuthn JSON; better-auth's own schema and the verifier check it.
      await auth.api.verifyPasskeyAuthentication({ body: body as never, headers });
      refusal = "unexpected_session"; // unreachable: the session-create hook vetoes
    } catch (error) {
      if (!(error instanceof APIError)) throw error;
      const code = (error.body as { code?: string } | undefined)?.code;
      if (code !== "UNABLE_TO_CREATE_SESSION" || !store.reauth.verifiedUserId) refusal = code ?? "reauth_failed";
    }
  });
  if (!refusal && store.reauth.verifiedUserId !== me.userId) refusal = "other_user";
  if (refusal) {
    await audit(ctx, {
      action: "auth.reauth_failed",
      actor: me.userId,
      target: { type: "session", id: me.sessionId },
      metadata: { failure: refusal },
    });
    return err(FAILED(refusal === "clone_detected" ? "clone_detected" : "reauth_failed"));
  }
  const now = ctx.now();
  expectOk(
    await new Database(ctx.env.DB).run(
      "UPDATE sessions SET fresh_auth_at = ?, fresh_auth_method = 'passkey' WHERE id = ? AND user_id = ?",
      now,
      me.sessionId,
      me.userId,
    ),
  );
  return ok({ freshAuthAt: now });
}

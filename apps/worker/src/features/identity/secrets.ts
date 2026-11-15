import { apiError, err, ok, type ApiError, type Result } from "@officebox/shared";
import type { Env } from "../../env";
import type { Logger } from "../../core/log";
import { byteLength } from "./crypto";
import { peppersFromEnv, type PepperSet } from "./password";

/**
 * The Worker secrets identity needs (Platform §16), checked on use. A missing or too-short secret
 * makes setup and sign-in answer `unavailable` and logs the secret's **name** (never its value), so
 * a fresh deploy without them fails visibly instead of signing people in with weak keys.
 */

export const MIN_SECRET_BYTES = 32;

export interface IdentitySecrets {
  peppers: PepperSet;
  /** Current signing key first, then the previous one during a rotation. */
  sessionKeys: readonly string[];
  tokenHashKey: string;
}

const UNAVAILABLE: ApiError = apiError(
  "unavailable",
  "Sign-in isn't configured yet. An owner must set the Worker secrets.",
);

export function identitySecrets(env: Env, log: Logger): Result<IdentitySecrets, ApiError> {
  const problems: string[] = [];
  const strong = (name: string, value: string | undefined): value is string => {
    if (value === undefined || value === "") {
      problems.push(`${name} is not set`);
      return false;
    }
    if (byteLength(value) < MIN_SECRET_BYTES) {
      problems.push(`${name} is shorter than ${MIN_SECRET_BYTES} bytes`);
      return false;
    }
    return true;
  };

  const signing = env.SESSION_SIGNING_KEY;
  const hashKey = env.TOKEN_HASH_KEY;
  const signingOk = strong("SESSION_SIGNING_KEY", signing);
  const hashKeyOk = strong("TOKEN_HASH_KEY", hashKey);
  const previous = env.SESSION_SIGNING_KEY_PREVIOUS;
  const previousOk = previous !== undefined && previous !== "" && byteLength(previous) >= MIN_SECRET_BYTES;
  if (previous && !previousOk) problems.push(`SESSION_SIGNING_KEY_PREVIOUS is shorter than ${MIN_SECRET_BYTES} bytes`);

  const { set, invalid } = peppersFromEnv(env);
  for (const name of invalid) problems.push(`${name} is shorter than ${MIN_SECRET_BYTES} bytes`);
  if (!set) problems.push("no PEPPER_<n> secret is set");

  if (!signingOk || !hashKeyOk || !set) {
    log.error("identity secrets are missing or too short", { problems });
    return err(UNAVAILABLE);
  }
  if (problems.length > 0) log.warn("some identity secrets are ignored", { problems });
  return ok({
    peppers: set,
    sessionKeys: previousOk ? [signing, previous] : [signing],
    tokenHashKey: hashKey,
  });
}

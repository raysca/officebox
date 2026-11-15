import { apiError, err, ok, type ApiError, type Result } from "@officebox/shared";
import type { Logger } from "../../core/log";
import type { Env } from "../../env";
import { byteLength } from "./crypto";

/**
 * The Worker secrets identity needs (Platform §16), checked on use. A missing or too-short secret
 * makes setup and sign-in answer `unavailable` (the web app shows `/not-configured`) and logs the
 * secret's **name**, never its value, so a deploy without them fails visibly instead of signing people
 * in with weak keys. The deploy step creates both if missing (`scripts/ensure-secrets.mjs`).
 *
 * `BETTER_AUTH_SECRETS` (`<version>:<secret>,…`, newest first) is better-auth's rotation list. We
 * parse it ourselves and always pass better-auth an explicit `secrets` array, so it never falls back
 * to reading `process.env`. **Rotating signs everyone out** (M1a-0 spike, workaround 15): better-auth
 * signs the session cookie with the newest secret only (Platform §16).
 */

export const MIN_SECRET_BYTES = 32;

export interface VersionedSecret {
  version: number;
  value: string;
}

export interface IdentitySecrets {
  /** Newest first; better-auth signs with the first. */
  betterAuth: VersionedSecret[];
  tokenHashKey: string;
}

const UNAVAILABLE: ApiError = apiError("unavailable", "Sign-in isn't configured yet. An owner must set the Worker secrets.");

/** The same problems are logged at most once a minute per isolate, not on every request. */
export const SECRETS_LOG_INTERVAL_MS = 60_000;
let lastLogged: { signature: string; at: number } | null = null;

function shouldLog(problems: string[], now = Date.now()): boolean {
  const signature = problems.join("|");
  if (lastLogged && lastLogged.signature === signature && now - lastLogged.at < SECRETS_LOG_INTERVAL_MS) return false;
  lastLogged = { signature, at: now };
  return true;
}

/** Forgets when problems were last logged (tests). */
export function resetSecretsLogThrottle(): void {
  lastLogged = null;
}

/** Parses `BETTER_AUTH_SECRETS`; null when malformed (a duplicate or invalid version, an empty value). */
export function parseSecretList(raw: string): VersionedSecret[] | null {
  const out: VersionedSecret[] = [];
  const seen = new Set<number>();
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (trimmed === "") continue;
    const colon = trimmed.indexOf(":");
    if (colon < 1) return null;
    const versionText = trimmed.slice(0, colon).trim();
    const value = trimmed.slice(colon + 1).trim();
    if (!/^\d{1,9}$/.test(versionText) || value === "") return null;
    const version = Number(versionText);
    if (seen.has(version)) return null;
    seen.add(version);
    out.push({ version, value });
  }
  return out.length > 0 ? out : null;
}

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

  const hashKey = env.TOKEN_HASH_KEY;
  const hashKeyOk = strong("TOKEN_HASH_KEY", hashKey);

  let betterAuth: VersionedSecret[] | null = null;
  if (env.BETTER_AUTH_SECRETS !== undefined && env.BETTER_AUTH_SECRETS !== "") {
    const list = parseSecretList(env.BETTER_AUTH_SECRETS);
    if (!list) problems.push("BETTER_AUTH_SECRETS is not a valid <version>:<secret> list");
    else if (list.some((s) => byteLength(s.value) < MIN_SECRET_BYTES)) {
      problems.push(`a BETTER_AUTH_SECRETS entry is shorter than ${MIN_SECRET_BYTES} bytes`);
    } else betterAuth = list;
  } else if (strong("BETTER_AUTH_SECRET", env.BETTER_AUTH_SECRET)) {
    betterAuth = [{ version: 1, value: env.BETTER_AUTH_SECRET }];
  }

  if (!hashKeyOk || !betterAuth || hashKey === undefined) {
    if (shouldLog(problems)) log.error("identity secrets are missing or too short", { problems });
    return err(UNAVAILABLE);
  }
  return ok({ betterAuth, tokenHashKey: hashKey });
}

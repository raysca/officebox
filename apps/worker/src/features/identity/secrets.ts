import {
  apiError,
  err,
  ok,
  type ApiError,
  type Result,
  type SetupServiceProblem,
  type SignInKeySource,
} from "@officebox/shared";
import { generatedKey, KEY_UNREACHABLE, secretIsSet } from "../../core/keys";
import type { Logger } from "../../core/log";
import type { Env } from "../../env";
import { byteLength } from "./crypto";

/**
 * The sign-in keys identity needs (Platform §16; TDD §8.1), resolved on use.
 *
 * Per key, **a Worker secret always wins**: `BETTER_AUTH_SECRETS` or `BETTER_AUTH_SECRET` for
 * better-auth, `TOKEN_HASH_KEY` for our token hashes. A secret that is unset or empty is no longer an
 * error (M1b-1): the Worker uses the key the SystemObject generated (`core/keys.ts`). A secret that is
 * **set but invalid** (shorter than 32 bytes, or a malformed `BETTER_AUTH_SECRETS` list) makes setup
 * and sign-in answer `unavailable` (the web app shows `/not-configured`) and logs the secret's
 * **name**, never its value or length, at most once a minute; it is never a reason to fall back.
 * If the SystemObject can't be reached for a generated key, the answer is `unavailable` too, with the
 * reason `keys_unreachable`; an isolate never makes up a key of its own.
 *
 * `BETTER_AUTH_SECRETS` (`<version>:<secret>,…`, newest first) is better-auth's rotation list, for
 * Worker secrets only. We parse it ourselves and always pass better-auth an explicit `secrets` array,
 * so it never falls back to reading `process.env`. **Rotating signs everyone out** (M1a-0 spike,
 * workaround 15): better-auth signs the session cookie with the newest secret only (Platform §16).
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
  sources: { betterAuthSecret: SignInKeySource; tokenHashKey: SignInKeySource };
}

const NOT_CONFIGURED: ApiError = apiError(
  "unavailable",
  "Sign-in isn't configured correctly. An owner must fix the Worker secrets.",
);

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

/** Why a key couldn't be resolved: a set-but-invalid Worker secret, or the SystemObject unreachable. */
export type KeyProblem = Extract<SetupServiceProblem, "invalid_secret" | "unreachable">;

export interface ResolvedKey<T> {
  value: T;
  source: SignInKeySource;
}

type SecretEnv = Pick<Env, "BETTER_AUTH_SECRET" | "BETTER_AUTH_SECRETS" | "TOKEN_HASH_KEY" | "SYSTEM">;

/** The problem with a set Worker secret, by name only (logged; never its value or length). */
function secretProblem(env: SecretEnv, which: "betterAuth" | "tokenHash"): string | null {
  if (which === "tokenHash") {
    return byteLength(env.TOKEN_HASH_KEY ?? "") < MIN_SECRET_BYTES ? "TOKEN_HASH_KEY is set but too short" : null;
  }
  if (secretIsSet(env.BETTER_AUTH_SECRETS)) {
    const list = parseSecretList(env.BETTER_AUTH_SECRETS);
    if (!list) return "BETTER_AUTH_SECRETS is not a valid <version>:<secret> list";
    if (list.some((s) => byteLength(s.value) < MIN_SECRET_BYTES)) return "a BETTER_AUTH_SECRETS entry is too short";
    return null;
  }
  return byteLength(env.BETTER_AUTH_SECRET ?? "") < MIN_SECRET_BYTES ? "BETTER_AUTH_SECRET is set but too short" : null;
}

/** better-auth's secret list: the Worker secret(s) when set, otherwise the generated key as version 1. */
export async function resolveBetterAuthSecret(
  env: SecretEnv,
  log: Logger,
  problems: string[] = [],
): Promise<Result<ResolvedKey<VersionedSecret[]>, KeyProblem>> {
  if (secretIsSet(env.BETTER_AUTH_SECRETS) || secretIsSet(env.BETTER_AUTH_SECRET)) {
    const problem = secretProblem(env, "betterAuth");
    if (problem) {
      problems.push(problem);
      return err("invalid_secret");
    }
    const list = secretIsSet(env.BETTER_AUTH_SECRETS)
      ? (parseSecretList(env.BETTER_AUTH_SECRETS) ?? [])
      : [{ version: 1, value: env.BETTER_AUTH_SECRET ?? "" }];
    return ok({ value: list, source: "worker_secret" });
  }
  const key = await generatedKey(env, "better_auth_secret", log);
  return key.ok ? ok({ value: [{ version: 1, value: key.value }], source: "generated" }) : err("unreachable");
}

/** `TOKEN_HASH_KEY`: the Worker secret when set, otherwise the generated key. */
export async function resolveTokenHashKey(
  env: SecretEnv,
  log: Logger,
  problems: string[] = [],
): Promise<Result<ResolvedKey<string>, KeyProblem>> {
  if (secretIsSet(env.TOKEN_HASH_KEY)) {
    const problem = secretProblem(env, "tokenHash");
    if (problem) {
      problems.push(problem);
      return err("invalid_secret");
    }
    return ok({ value: env.TOKEN_HASH_KEY, source: "worker_secret" });
  }
  const key = await generatedKey(env, "token_hash_key", log);
  return key.ok ? ok({ value: key.value, source: "generated" }) : err("unreachable");
}

/** Both keys, or the error the route returns (`unavailable`). */
export async function identitySecrets(env: SecretEnv, log: Logger): Promise<Result<IdentitySecrets, ApiError>> {
  const problems: string[] = [];
  const [betterAuth, tokenHashKey] = await Promise.all([
    resolveBetterAuthSecret(env, log, problems),
    resolveTokenHashKey(env, log, problems),
  ]);
  if (problems.length > 0 && shouldLog(problems)) log.error("identity secrets are set but invalid", { problems });
  if (!betterAuth.ok || !tokenHashKey.ok) {
    const invalid =
      (!betterAuth.ok && betterAuth.error === "invalid_secret") ||
      (!tokenHashKey.ok && tokenHashKey.error === "invalid_secret");
    return err(invalid ? NOT_CONFIGURED : KEY_UNREACHABLE);
  }
  return ok({
    betterAuth: betterAuth.value.value,
    tokenHashKey: tokenHashKey.value.value,
    sources: { betterAuthSecret: betterAuth.value.source, tokenHashKey: tokenHashKey.value.source },
  });
}

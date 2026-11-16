// Pure helpers for the "ensure secrets" deploy step (scripts/deploy-ci.mjs, TDD §6.5). Kept free of
// I/O so scripts/ensure-secrets.test.mjs can test them with node:test.
import { randomBytes } from "node:crypto";

/**
 * Required Worker secrets that are safe to generate as random values on the first deploy
 * (Platform §16). Not here, on purpose:
 * - SETUP_TOKEN: optional; without it the Worker generates a one-time token into Workers Logs.
 * - BETTER_AUTH_SECRETS: only an owner rotating the better-auth secret sets it.
 * - RECOVERY_TOKEN: set by hand, for one owner recovery at a time.
 * There are no passwords, so no PEPPER_<n>, and better-auth signs the session cookie, so no
 * SESSION_SIGNING_KEY (Platform §16, removed 15 Nov 2026).
 */
export const GENERATED_SECRETS = ["BETTER_AUTH_SECRET", "TOKEN_HASH_KEY"];

/**
 * Parses `wrangler secret list --format json` output: a JSON array of `{ name, type }`. Returns the
 * secret names, or null if the output isn't that shape (the caller fails the deploy).
 */
export function parseSecretList(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const names = [];
  for (const entry of parsed) {
    if (!entry || typeof entry.name !== "string") return null;
    names.push(entry.name);
  }
  return names;
}

/** The generated secrets missing from `existing`, in a fixed order. Existing ones are never touched. */
export function secretsToCreate(existing) {
  const present = new Set(existing);
  return GENERATED_SECRETS.filter((name) => !present.has(name));
}

/** A new secret value: 32 random bytes, base64url (43 characters). */
export function generateSecretValue() {
  return randomBytes(32).toString("base64url");
}

/** Cloudflare API error codes meaning "no such Worker" (the same codes wrangler checks). */
export const WORKER_NOT_FOUND_CODES = new Set([10007, 10090]);

/**
 * Whether a Cloudflare API response body says the Worker doesn't exist. Decided by structured error
 * code, never by message text.
 */
export function isWorkerNotFound(body) {
  return Boolean(
    body &&
    body.success === false &&
    Array.isArray(body.errors) &&
    body.errors.some((e) => WORKER_NOT_FOUND_CODES.has(e?.code)),
  );
}

/**
 * The warning logged when the step creates a secret (Platform §16, M1b-1). On a fresh deploy nobody has
 * signed in yet, so nothing changes; on a workspace that has been running on keys the Worker generated
 * (a Deploy-button copy moved to GitHub Actions, say), the new Worker secret takes precedence: creating
 * `BETTER_AUTH_SECRET` signs everyone out, and creating `TOKEN_HASH_KEY` invalidates outstanding links.
 */
export function createdSecretWarning(name) {
  const effect =
    name === "BETTER_AUTH_SECRET"
      ? "everyone will be signed out once and must sign in again"
      : "outstanding invitation, sign-in and recovery links and enrolment tickets stop working";
  return (
    `deploy: warning: ${name} was created as a Worker secret and now takes precedence. If this workspace was ` +
    `already running on a key the Worker generated, ${effect}. On a fresh deploy nothing changes.`
  );
}

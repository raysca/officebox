// Pure helpers for the "ensure secrets" deploy step (scripts/deploy-ci.mjs, TDD §6.5). Kept free of
// I/O so scripts/ensure-secrets.test.mjs can test them with node:test.
import { randomBytes } from "node:crypto";

/**
 * Required Worker secrets that are safe to generate as random values on the first deploy
 * (Platform §16). Not here, on purpose:
 * - SETUP_TOKEN: optional; without it the Worker generates a one-time token into Workers Logs.
 * - SESSION_SIGNING_KEY_PREVIOUS and PEPPER_2+: only an owner rotating keys sets these.
 */
export const GENERATED_SECRETS = ["SESSION_SIGNING_KEY", "TOKEN_HASH_KEY", "PEPPER_1"];

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

/**
 * The generated secrets missing from `existing`, in a fixed order. Existing ones are never touched,
 * and PEPPER_1 isn't created when any PEPPER_<n> exists (the owner already chose their peppers; a new
 * PEPPER_1 would be ignored at best).
 */
export function secretsToCreate(existing) {
  const present = new Set(existing);
  const hasPepper = existing.some((name) => /^PEPPER_[1-9]\d*$/.test(name));
  return GENERATED_SECRETS.filter((name) => !present.has(name) && !(name === "PEPPER_1" && hasPepper));
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

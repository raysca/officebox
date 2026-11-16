// Unit tests for the deploy step's pure helpers. Run with `node --test scripts/ensure-secrets.test.mjs` (part of `npm test`).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GENERATED_SECRETS,
  createdSecretWarning,
  generateSecretValue,
  isWorkerNotFound,
  parseSecretList,
  secretsToCreate,
} from "./ensure-secrets.mjs";

test("creates only the generated secrets that are missing, never others", () => {
  assert.deepEqual(secretsToCreate([]), ["BETTER_AUTH_SECRET", "TOKEN_HASH_KEY"]);
  assert.deepEqual(secretsToCreate(["TOKEN_HASH_KEY", "SETUP_TOKEN"]), ["BETTER_AUTH_SECRET"]);
  assert.deepEqual(secretsToCreate(["BETTER_AUTH_SECRET"]), ["TOKEN_HASH_KEY"]);
  assert.deepEqual(secretsToCreate(GENERATED_SECRETS), []);
  // The password-era secrets are gone: never generated, and their presence changes nothing.
  assert.deepEqual(secretsToCreate(["PEPPER_1", "SESSION_SIGNING_KEY"]), ["BETTER_AUTH_SECRET", "TOKEN_HASH_KEY"]);
  for (const name of [
    "SETUP_TOKEN",
    "RECOVERY_TOKEN",
    "BETTER_AUTH_SECRETS",
    "SESSION_SIGNING_KEY",
    "SESSION_SIGNING_KEY_PREVIOUS",
    "PEPPER_1",
  ]) {
    assert.ok(!GENERATED_SECRETS.includes(name), `${name} must never be generated`);
  }
});

test("parses wrangler's JSON secret list and refuses anything else", () => {
  const out = JSON.stringify([
    { name: "TOKEN_HASH_KEY", type: "secret_text" },
    { name: "SETUP_TOKEN", type: "secret_text" },
  ]);
  assert.deepEqual(parseSecretList(out), ["TOKEN_HASH_KEY", "SETUP_TOKEN"]);
  assert.deepEqual(parseSecretList("[]"), []);
  assert.equal(parseSecretList("Secret Name: TOKEN_HASH_KEY"), null);
  assert.equal(parseSecretList("{}"), null);
  assert.equal(parseSecretList('[{"type":"secret_text"}]'), null);
});

test("generates 32 random bytes as base64url", () => {
  const a = generateSecretValue();
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(a, "base64url").length, 32);
  assert.notEqual(a, generateSecretValue());
});

test("recognises a missing Worker by API error code only", () => {
  assert.equal(
    isWorkerNotFound({ success: false, errors: [{ code: 10007, message: "workers.api.error.script_not_found" }] }),
    true,
  );
  assert.equal(isWorkerNotFound({ success: false, errors: [{ code: 10090 }] }), true);
  assert.equal(isWorkerNotFound({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }), false);
  assert.equal(isWorkerNotFound({ success: true, result: [] }), false);
  assert.equal(isWorkerNotFound(null), false);
});

test("warns that creating a secret signs people out or invalidates links, naming only the secret", () => {
  const auth = createdSecretWarning("BETTER_AUTH_SECRET");
  assert.match(auth, /BETTER_AUTH_SECRET/);
  assert.match(auth, /signed out/);
  const hash = createdSecretWarning("TOKEN_HASH_KEY");
  assert.match(hash, /TOKEN_HASH_KEY/);
  assert.match(hash, /links/);
  // Never a value: the message is the same whatever was generated.
  assert.equal(createdSecretWarning("TOKEN_HASH_KEY"), hash);
});

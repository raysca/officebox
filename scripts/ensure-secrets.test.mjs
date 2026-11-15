// Unit tests for the deploy step's pure helpers. Run with `node --test scripts/ensure-secrets.test.mjs` (part of `npm test`).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GENERATED_SECRETS,
  generateSecretValue,
  isWorkerNotFound,
  parseSecretList,
  secretsToCreate,
} from "./ensure-secrets.mjs";

test("creates only the generated secrets that are missing, never others", () => {
  assert.deepEqual(secretsToCreate([]), ["SESSION_SIGNING_KEY", "TOKEN_HASH_KEY", "PEPPER_1"]);
  assert.deepEqual(secretsToCreate(["TOKEN_HASH_KEY", "SETUP_TOKEN"]), ["SESSION_SIGNING_KEY", "PEPPER_1"]);
  assert.deepEqual(secretsToCreate(GENERATED_SECRETS), []);
  for (const name of ["SETUP_TOKEN", "SESSION_SIGNING_KEY_PREVIOUS", "PEPPER_2"]) {
    assert.ok(!GENERATED_SECRETS.includes(name), `${name} must never be generated`);
  }
});

test("parses wrangler's JSON secret list and refuses anything else", () => {
  const out = JSON.stringify([
    { name: "PEPPER_1", type: "secret_text" },
    { name: "SETUP_TOKEN", type: "secret_text" },
  ]);
  assert.deepEqual(parseSecretList(out), ["PEPPER_1", "SETUP_TOKEN"]);
  assert.deepEqual(parseSecretList("[]"), []);
  assert.equal(parseSecretList("Secret Name: PEPPER_1"), null);
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

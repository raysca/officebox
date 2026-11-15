// Passkey registration and sign-in with @simplewebauthn/server in workerd (Identity §4.4).
// Spike storage: KV. Production would use D1 `passkeys` rows and a short-lived challenge row or signed cookie.
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { b64, fromB64 } from "./hash";

export interface WebAuthnEnv {
  WEBAUTHN_KV: KVNamespace;
  RP_ID: string;
  RP_ORIGIN: string;
}

interface StoredCredential {
  id: string; // base64url credential id
  userId: string;
  publicKey: string; // base64 COSE key
  counter: number;
  transports: string[];
}

interface Flow {
  kind: "register" | "login";
  challenge: string;
  userId?: string;
  username?: string;
}

export type WebAuthnResult<T> = { ok: true; value: T } | { ok: false; error: string; detail?: string };

const CHALLENGE_TTL_S = 300;

async function putFlow(env: WebAuthnEnv, flow: Flow): Promise<string> {
  const flowId = crypto.randomUUID();
  await env.WEBAUTHN_KV.put(`flow:${flowId}`, JSON.stringify(flow), { expirationTtl: CHALLENGE_TTL_S });
  return flowId;
}

/** Single-use: the flow is deleted as soon as it is read, so a challenge can't be replayed. */
async function takeFlow(env: WebAuthnEnv, flowId: string, kind: Flow["kind"]): Promise<Flow | null> {
  const raw = await env.WEBAUTHN_KV.get(`flow:${flowId}`);
  if (!raw) return null;
  await env.WEBAUTHN_KV.delete(`flow:${flowId}`);
  const flow = JSON.parse(raw) as Flow;
  return flow.kind === kind ? flow : null;
}

async function getCredential(env: WebAuthnEnv, id: string): Promise<StoredCredential | null> {
  return env.WEBAUTHN_KV.get<StoredCredential>(`cred:${id}`, "json");
}

export async function registrationOptions(env: WebAuthnEnv, username: string) {
  const userId = crypto.randomUUID();
  const options = await generateRegistrationOptions({
    rpName: "Officebox spike",
    rpID: env.RP_ID,
    userName: username,
    userID: new Uint8Array(new TextEncoder().encode(userId)),
    attestationType: "none",
    // Discoverable credentials so sign-in works without typing an email; UV "preferred" (Identity §4.4).
    authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
    supportedAlgorithmIDs: [-7, -257], // ES256, RS256
  });
  const flowId = await putFlow(env, { kind: "register", challenge: options.challenge, userId, username });
  return { flowId, options };
}

export async function verifyRegistration(
  env: WebAuthnEnv,
  flowId: string,
  response: RegistrationResponseJSON,
): Promise<WebAuthnResult<{ credentialId: string; userId: string; counter: number; userVerified: boolean; fmt: string }>> {
  const flow = await takeFlow(env, flowId, "register");
  if (!flow || !flow.userId) return { ok: false, error: "unknown_flow" };
  try {
    const v = await verifyRegistrationResponse({
      response,
      expectedChallenge: flow.challenge,
      expectedOrigin: env.RP_ORIGIN,
      expectedRPID: env.RP_ID,
      requireUserVerification: false, // "preferred"
    });
    if (!v.verified) return { ok: false, error: "not_verified" };
    const { credential, userVerified, fmt } = v.registrationInfo;
    const stored: StoredCredential = {
      id: credential.id,
      userId: flow.userId,
      publicKey: b64(credential.publicKey),
      counter: credential.counter,
      transports: credential.transports ?? [],
    };
    await env.WEBAUTHN_KV.put(`cred:${credential.id}`, JSON.stringify(stored));
    return { ok: true, value: { credentialId: credential.id, userId: flow.userId, counter: credential.counter, userVerified, fmt } };
  } catch (e) {
    return { ok: false, error: "invalid_response", detail: (e as Error).message };
  }
}

export async function authenticationOptions(env: WebAuthnEnv) {
  // No allowCredentials: discoverable-credential ("passkey") sign-in.
  const options = await generateAuthenticationOptions({ rpID: env.RP_ID, userVerification: "preferred" });
  const flowId = await putFlow(env, { kind: "login", challenge: options.challenge });
  return { flowId, options };
}

export async function verifyAuthentication(
  env: WebAuthnEnv,
  flowId: string,
  response: AuthenticationResponseJSON,
): Promise<WebAuthnResult<{ userId: string; credentialId: string; oldCounter: number; newCounter: number; userVerified: boolean }>> {
  const flow = await takeFlow(env, flowId, "login");
  if (!flow) return { ok: false, error: "unknown_flow" };
  const cred = await getCredential(env, response.id);
  if (!cred) return { ok: false, error: "unknown_credential" };
  // The userHandle of a discoverable credential must match the credential's owner.
  const handle = response.response.userHandle;
  if (handle && new TextDecoder().decode(fromB64url(handle)) !== cred.userId) return { ok: false, error: "user_mismatch" };
  let verified: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    verified = await verifyAuthenticationResponse({
      response,
      expectedChallenge: flow.challenge,
      expectedOrigin: env.RP_ORIGIN,
      expectedRPID: env.RP_ID,
      // counter: 0 disables the library's own counter check, so the library only verifies the signature, challenge,
      // origin and RP ID. We compare counters ourselves below, after the signature is known to be valid: clone
      // detection then never depends on the library's error text, and forged responses can't trigger a
      // clone_detected security notice.
      credential: { id: cred.id, publicKey: fromB64(cred.publicKey), counter: 0, transports: cred.transports },
      // Identity §4.4: user verification "preferred". The library's default is true, so pass false explicitly.
      requireUserVerification: false,
    });
  } catch (e) {
    return { ok: false, error: "invalid_response", detail: (e as Error).message };
  }
  if (!verified.verified) return { ok: false, error: "not_verified" };
  const oldCounter = cred.counter;
  const newCounter = verified.authenticationInfo.newCounter;
  if (isCounterRegression(newCounter, oldCounter)) {
    // Identity §4.4: reject, and (in M1) send the member and admins a security_notice.
    return { ok: false, error: "clone_detected", detail: `sign_count ${newCounter} is not greater than stored ${oldCounter}` };
  }
  // M1 must make this a compare-and-set in D1: UPDATE passkeys SET sign_count = ? WHERE id = ? AND sign_count = ?,
  // treating 0 changed rows as a concurrent sign-in (retry or reject). KV has no compare-and-set, so the spike
  // just writes.
  cred.counter = newCounter;
  await env.WEBAUTHN_KV.put(`cred:${cred.id}`, JSON.stringify(cred));
  return {
    ok: true,
    value: { userId: cred.userId, credentialId: cred.id, oldCounter, newCounter, userVerified: verified.authenticationInfo.userVerified },
  };
}

/**
 * WebAuthn §6.1.1 signature-counter rule as SimpleWebAuthn applies it: when either value is non-zero, the new
 * counter must be strictly greater than the stored one. Authenticators that always report 0 (most synced
 * passkeys) never trip it.
 */
export function isCounterRegression(newCounter: number, storedCounter: number): boolean {
  return (newCounter > 0 || storedCounter > 0) && newCounter <= storedCounter;
}

function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return fromB64(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
}

export async function credentialCounter(env: WebAuthnEnv, id: string): Promise<number | null> {
  return (await getCredential(env, id))?.counter ?? null;
}

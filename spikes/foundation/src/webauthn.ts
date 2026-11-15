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
  try {
    const v = await verifyAuthenticationResponse({
      response,
      expectedChallenge: flow.challenge,
      expectedOrigin: env.RP_ORIGIN,
      expectedRPID: env.RP_ID,
      credential: { id: cred.id, publicKey: fromB64(cred.publicKey), counter: cred.counter, transports: cred.transports },
      requireUserVerification: false,
    });
    if (!v.verified) return { ok: false, error: "not_verified" };
    const oldCounter = cred.counter;
    cred.counter = v.authenticationInfo.newCounter;
    await env.WEBAUTHN_KV.put(`cred:${cred.id}`, JSON.stringify(cred));
    return {
      ok: true,
      value: { userId: cred.userId, credentialId: cred.id, oldCounter, newCounter: cred.counter, userVerified: v.authenticationInfo.userVerified },
    };
  } catch (e) {
    const msg = (e as Error).message;
    // The library throws when the counter didn't increase (both non-zero). Identity §4.4: reject + security_notice.
    if (/counter value/i.test(msg)) return { ok: false, error: "clone_detected", detail: msg };
    return { ok: false, error: "invalid_response", detail: msg };
  }
}

function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return fromB64(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
}

export async function credentialCounter(env: WebAuthnEnv, id: string): Promise<number | null> {
  return (await getCredential(env, id))?.counter ?? null;
}

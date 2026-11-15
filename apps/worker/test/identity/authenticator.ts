/**
 * A software WebAuthn authenticator for Worker integration tests: ES256 (P-256) keys from WebCrypto,
 * "none" attestation, and the flags and counter under the test's control. It produces exactly the
 * JSON a browser hands SimpleWebAuthn, so better-auth verifies it as it would a real one.
 *
 * The end-to-end tests use Chromium's virtual authenticator instead (e2e/); this one lets the Worker
 * tests cover user verification, clones, origins and relying-party IDs precisely.
 */

const encoder = new TextEncoder();

export function b64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(value: string): Uint8Array {
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

// ---- Minimal CBOR (major types 0, 1, 2, 3, 5) ---------------------------------------------------

type Cbor = number | string | Uint8Array | Map<Cbor, Cbor>;

function head(major: number, length: number): Uint8Array {
  if (length < 24) return Uint8Array.of((major << 5) | length);
  if (length < 256) return Uint8Array.of((major << 5) | 24, length);
  if (length < 65536) return Uint8Array.of((major << 5) | 25, length >> 8, length & 255);
  throw new Error("CBOR value too long for this encoder");
}

function cbor(value: Cbor): Uint8Array {
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === "string") {
    const bytes = encoder.encode(value);
    return concat(head(3, bytes.length), bytes);
  }
  if (value instanceof Uint8Array) return concat(head(2, value.length), value);
  const parts: Uint8Array[] = [head(5, value.size)];
  for (const [k, v] of value) parts.push(cbor(k), cbor(v));
  return concat(...parts);
}

/** WebCrypto's ECDSA signature is r||s; WebAuthn wants DER. */
function derSignature(raw: Uint8Array): Uint8Array {
  const integer = (bytes: Uint8Array) => {
    let i = 0;
    while (i < bytes.length - 1 && bytes[i] === 0) i++;
    let trimmed = bytes.slice(i);
    if ((trimmed[0] ?? 0) & 0x80) trimmed = concat(Uint8Array.of(0), trimmed);
    return concat(Uint8Array.of(0x02, trimmed.length), trimmed);
  };
  const body = concat(integer(raw.slice(0, 32)), integer(raw.slice(32)));
  return concat(Uint8Array.of(0x30, body.length), body);
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

export interface Credential {
  id: Uint8Array;
  keys: CryptoKeyPair;
  rpId: string;
  userHandle: string;
  counter: number;
}

export interface AuthenticatorOptions {
  /** Whether the authenticator verifies the user (PIN or biometric). Default true. */
  uv?: boolean;
  /**
   * How the counter moves: "increment" (default), or "zero" (synced passkeys that always report 0).
   */
  counter?: "increment" | "zero";
}

export interface CeremonyOverrides {
  origin?: string;
  rpId?: string;
  uv?: boolean;
  /** Present this counter instead of the next one (clone tests). */
  counter?: number;
  /** Use this credential instead of the first one. */
  credential?: Credential;
}

interface RegistrationOptions {
  challenge: string;
  rp: { id?: string; name: string };
  user: { id: string; name: string };
}

interface AuthenticationOptions {
  challenge: string;
  rpId?: string;
  allowCredentials?: { id: string }[];
}

export class SoftAuthenticator {
  readonly credentials: Credential[] = [];
  private readonly uv: boolean;
  private readonly counterMode: "increment" | "zero";

  constructor(options: AuthenticatorOptions = {}) {
    this.uv = options.uv ?? true;
    this.counterMode = options.counter ?? "increment";
  }

  /** Answers `navigator.credentials.create()` for registration options from better-auth. */
  async register(options: RegistrationOptions, origin: string, overrides: CeremonyOverrides = {}) {
    const rpId = overrides.rpId ?? options.rp.id ?? new URL(origin).hostname;
    const keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const jwk = (await crypto.subtle.exportKey("jwk", keys.publicKey)) as JsonWebKey;
    const id = crypto.getRandomValues(new Uint8Array(32));
    const credential: Credential = { id, keys, rpId, userHandle: options.user.id, counter: 0 };
    const cose = cbor(
      new Map<Cbor, Cbor>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, fromB64url(jwk.x ?? "")],
        [-3, fromB64url(jwk.y ?? "")],
      ]),
    );
    const uv = overrides.uv ?? this.uv;
    const flags = FLAG_UP | FLAG_AT | (uv ? FLAG_UV : 0);
    const counter = this.counterMode === "zero" ? 0 : 0;
    const authData = concat(
      await sha256(encoder.encode(rpId)),
      Uint8Array.of(flags),
      Uint8Array.of(counter >>> 24, (counter >>> 16) & 255, (counter >>> 8) & 255, counter & 255),
      new Uint8Array(16),
      Uint8Array.of(id.length >> 8, id.length & 255),
      id,
      cose,
    );
    const clientData = encoder.encode(
      JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin: overrides.origin ?? origin, crossOrigin: false }),
    );
    const attestationObject = cbor(
      new Map<Cbor, Cbor>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", authData],
      ]),
    );
    this.credentials.push(credential);
    return {
      credential,
      response: {
        id: b64url(id),
        rawId: b64url(id),
        type: "public-key",
        response: {
          clientDataJSON: b64url(clientData),
          attestationObject: b64url(attestationObject),
          transports: ["internal"],
        },
        clientExtensionResults: {},
        authenticatorAttachment: "platform",
      },
    };
  }

  /** Answers `navigator.credentials.get()` for authentication options from better-auth. */
  async authenticate(options: AuthenticationOptions, origin: string, overrides: CeremonyOverrides = {}) {
    const allowed = options.allowCredentials?.map((c) => c.id);
    const credential =
      overrides.credential ??
      this.credentials.find((c) => !allowed || allowed.length === 0 || allowed.includes(b64url(c.id)));
    if (!credential) throw new Error("no matching credential");
    const rpId = overrides.rpId ?? options.rpId ?? credential.rpId;
    if (overrides.counter === undefined && this.counterMode === "increment") credential.counter += 1;
    const counter = overrides.counter ?? (this.counterMode === "zero" ? 0 : credential.counter);
    const uv = overrides.uv ?? this.uv;
    const authData = concat(
      await sha256(encoder.encode(rpId)),
      Uint8Array.of(FLAG_UP | (uv ? FLAG_UV : 0)),
      Uint8Array.of(counter >>> 24, (counter >>> 16) & 255, (counter >>> 8) & 255, counter & 255),
    );
    const clientData = encoder.encode(
      JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin: overrides.origin ?? origin, crossOrigin: false }),
    );
    const signed = concat(authData, await sha256(clientData));
    const raw = new Uint8Array(
      await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, credential.keys.privateKey, signed),
    );
    return {
      id: b64url(credential.id),
      rawId: b64url(credential.id),
      type: "public-key",
      response: {
        clientDataJSON: b64url(clientData),
        authenticatorData: b64url(authData),
        signature: b64url(derSignature(raw)),
        userHandle: credential.userHandle,
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }
}

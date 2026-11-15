import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";
import { err, ok, type Result } from "@officebox/shared";

/**
 * The browser side of passkey ceremonies (Identity §4.4), through `@simplewebauthn/browser` (MIT):
 * it converts better-auth's JSON options to `navigator.credentials` calls and the result back to
 * JSON. Nothing here sees a session token; the server sets the cookie.
 */

/** WebAuthn preflight (Identity §4.1): `PublicKeyCredential` feature detection. */
export function supportsPasskeys(): boolean {
  try {
    return browserSupportsWebAuthn();
  } catch {
    return false;
  }
}

export type CeremonyError =
  /** The person cancelled, or the browser timed out waiting. */
  | "cancelled"
  /** The authenticator already holds a passkey for this account. */
  | "already_registered"
  /** No WebAuthn, or another failure from the browser. */
  | "failed";

function classify(error: unknown): CeremonyError {
  const name = error instanceof Error ? error.name : "";
  const code = (error as { code?: string } | null)?.code ?? "";
  if (name === "NotAllowedError" || name === "AbortError" || code === "ERROR_CEREMONY_ABORTED") return "cancelled";
  if (name === "InvalidStateError" || code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED") return "already_registered";
  return "failed";
}

export async function createPasskey(options: unknown): Promise<Result<unknown, CeremonyError>> {
  try {
    return ok(await startRegistration({ optionsJSON: options as PublicKeyCredentialCreationOptionsJSON }));
  } catch (error) {
    return err(classify(error));
  }
}

export async function assertPasskey(options: unknown): Promise<Result<unknown, CeremonyError>> {
  try {
    return ok(await startAuthentication({ optionsJSON: options as PublicKeyCredentialRequestOptionsJSON }));
  } catch (error) {
    return err(classify(error));
  }
}

import { apiError, type ApiErrorBody, type ErrorCode } from "@officebox/shared";
import { SESSION_COOKIE } from "./auth";

/**
 * The response filter on better-auth's mount (Identity §4.5; TDD §8.1; M1a-0 spike, workaround 7).
 *
 * No session token may ever reach JavaScript. better-auth puts the session row, token included, in
 * the JSON of passkey `verify-authentication` and of `verify-registration` with `createSession` (and
 * get-session, which isn't exposed). The filter:
 * - drops every `token` key at any depth, and
 * - drops any string equal to a session token named in the response's own `Set-Cookie` (the cookie
 *   value is `<token>.<signature>`), wherever it appears.
 *
 * It also turns better-auth's error bodies (`{ code, message }`) into our standard error body, so the
 * web app handles every API error the same way. better-auth's own code (for example
 * `USER_VERIFICATION_REQUIRED`, `ENROLMENT_TICKET_INVALID` or `clone_detected`) is kept as `reason`.
 */

/** Removes `token` fields and any string in `tokens`, at any depth. */
export function stripTokens(value: unknown, tokens: ReadonlySet<string>): unknown {
  if (Array.isArray(value))
    return value.filter((v) => !(typeof v === "string" && tokens.has(v))).map((v) => stripTokens(v, tokens));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (key.toLowerCase() === "token") continue;
      if (typeof entry === "string" && tokens.has(entry)) continue;
      out[key] = stripTokens(entry, tokens);
    }
    return out;
  }
  return value;
}

/** Session tokens named by a response's Set-Cookie headers. */
export function sessionTokensIn(headers: Headers): Set<string> {
  const out = new Set<string>();
  for (const cookie of headers.getSetCookie()) {
    const [pair] = cookie.split(";");
    const [name, ...rest] = (pair ?? "").split("=");
    if (name?.trim() !== SESSION_COOKIE) continue;
    let value = rest.join("=");
    try {
      value = decodeURIComponent(value);
    } catch {
      // keep the raw value
    }
    if (value) out.add(value.slice(0, Math.max(0, value.lastIndexOf("."))) || value);
  }
  return out;
}

function codeForStatus(status: number): ErrorCode {
  if (status === 401) return "unauthenticated";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "internal";
  return "validation_failed";
}

/** A refused passkey ceremony is a refusal, not a lost session: these codes map to `forbidden`. */
const FORBIDDEN_REASONS = new Set([
  "clone_detected",
  "USER_VERIFICATION_REQUIRED",
  "REGISTRATION_REFUSED",
  "ENROLMENT_TICKET_REQUIRED",
  "ENROLMENT_TICKET_INVALID",
]);

export async function filterAuthResponse(response: Response, requestId: string): Promise<Response> {
  const type = response.headers.get("content-type") ?? "";
  if (!type.includes("application/json")) return response;
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  if (!response.ok) {
    const raw = (body && typeof body === "object" ? body : {}) as { code?: unknown; message?: unknown };
    const reason = typeof raw.code === "string" ? raw.code : undefined;
    const code = reason && FORBIDDEN_REASONS.has(reason) ? "forbidden" : codeForStatus(response.status);
    const status = code === "forbidden" ? 403 : response.status;
    const error: ApiErrorBody = {
      error: apiError(
        code,
        typeof raw.message === "string" ? raw.message : "The request was refused.",
        reason ? { reason } : {},
      ),
      requestId,
    };
    return new Response(JSON.stringify(error), { status, headers });
  }
  if (body === null) return new Response(text, { status: response.status, headers });
  return new Response(JSON.stringify(stripTokens(body, sessionTokensIn(response.headers))), {
    status: response.status,
    headers,
  });
}

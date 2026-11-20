import { env } from "cloudflare:workers";
import { clearSettingsCache } from "../../src/core/settings";
import type { SoftAuthenticator } from "./authenticator";
import { callWorker, ORIGIN, type Browser } from "./helpers";

/** Helpers for the M1c tests (recovery, email change, domain move). */

/** Turns email off (no driver configured). */
export async function disableEmail(): Promise<void> {
  await env.DB.prepare(
    "UPDATE installation SET settings = json_remove(settings, '$.email_provider') WHERE id = 1",
  ).run();
  clearSettingsCache(env.DB);
}

export const count = async (sql: string, ...params: unknown[]) =>
  (await env.DB.prepare(sql)
    .bind(...params)
    .first<{ n: number }>())!.n;

export const auditCount = (action: string, targetId?: string) =>
  targetId === undefined
    ? count("SELECT count(*) AS n FROM audit_log WHERE action = ?", action)
    : count("SELECT count(*) AS n FROM audit_log WHERE action = ? AND target_id = ?", action, targetId);

export async function noticeKinds(userId: string): Promise<string[]> {
  const row = await env.DB.prepare("SELECT pending_security_notice AS n FROM users WHERE id = ?")
    .bind(userId)
    .first<{ n: string | null }>();
  return row?.n ? (JSON.parse(row.n) as { kind: string }[]).map((n) => n.kind) : [];
}

export async function sessionsOf(userId: string): Promise<number> {
  return count("SELECT count(*) AS n FROM sessions WHERE user_id = ?", userId);
}

/** Registration on any origin: options, the authenticator's answer for that origin, and verify. */
export async function registerAt(
  browser: Browser,
  authenticator: SoftAuthenticator,
  origin: string = ORIGIN,
  overrides: Parameters<SoftAuthenticator["register"]>[2] = {},
) {
  const options = await browser.json<{
    challenge: string;
    rp: { id: string; name: string };
    user: { id: string; name: string };
  }>("/api/auth/passkey/generate-register-options", { baseUrl: origin, origin });
  if (options.status !== 200) return { options, verify: null };
  const { response } = await authenticator.register(options.body, origin, overrides);
  const verify = await browser.json("/api/auth/passkey/verify-registration", {
    body: { response },
    baseUrl: origin,
    origin,
  });
  return { options, verify };
}

/** A hub WebSocket for a signed-in browser, to see revocations close it (TDD §3.5). */
export async function openHub(browser: Browser): Promise<{ closed: Promise<number> } | null> {
  const headers: Record<string, string> = {
    Upgrade: "websocket",
    "cf-connecting-ip": browser.ip,
    "user-agent": browser.userAgent,
    Origin: ORIGIN,
    Cookie: browser.cookieHeader(),
  };
  const res = await callWorker(new Request(`${ORIGIN}/api/ws/hub`, { headers }));
  const ws = res.webSocket;
  if (res.status !== 101 || !ws) return null;
  ws.accept();
  const closed = new Promise<number>((resolve) => ws.addEventListener("close", (event) => resolve(event.code)));
  return { closed };
}

/** Resolves with the value, or rejects after `ms`. */
export function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`not within ${ms} ms`)), ms)),
  ]);
}

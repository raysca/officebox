import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SoftAuthenticator } from "./authenticator";
import {
  addMember,
  Browser,
  configureEmail,
  failingDb,
  fragmentToken,
  joinByInvitation,
  meetInviteGate,
  ORIGIN,
  outbox,
  registerPasskey,
  sessionTokens,
  setSetting,
  setupWorkspace,
  signInWithPasskey,
  uniqueEmail,
  type Workspace,
} from "./helpers";

let ws: Workspace;
beforeAll(async () => {
  ws = await setupWorkspace();
  await meetInviteGate(ws);
  await configureEmail();
});
beforeEach(async () => {
  // Each test starts with email on and magic links enabled.
  await configureEmail();
  await setSetting("magic_link_enabled", true);
});

const count = async (sql: string, ...params: unknown[]) =>
  (await env.DB.prepare(sql)
    .bind(...params)
    .first<{ n: number }>())!.n;

function requestLink(browser: Browser, email: string, extra: Record<string, unknown> = {}) {
  return browser.call("/api/auth/sign-in/magic-link", { body: { email, ...extra } });
}

function linkFor(email: string): string {
  const messages = outbox.to(email).filter((m) => m.kind === "magic_link");
  const last = messages[messages.length - 1];
  if (!last) throw new Error(`no magic link for ${email}`);
  return fragmentToken(last.text)!;
}

/** Status, body and the headers that should be equal for every email (not request ID or cookies). */
async function shape(response: Response) {
  const headers = [...response.headers]
    .filter(([name]) => !["x-request-id", "set-cookie", "date"].includes(name.toLowerCase()))
    .sort(([a], [b]) => a.localeCompare(b));
  // Error bodies carry their own request ID; everything else must match.
  const body = (await response.text()).replace(/"requestId":"[0-9A-Z]{26}"/, '"requestId":"…"');
  return { status: response.status, body, headers };
}

describe("requesting a magic link (Identity §4.4)", () => {
  it("emails an active member a link to our confirmation page on the canonical origin, token in the fragment", async () => {
    const member = await joinByInvitation(ws);
    const response = await requestLink(new Browser(), member.email);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: true });
    const [message] = outbox.to(member.email).filter((m) => m.kind === "magic_link");
    expect(message).toBeDefined();
    const link = /https?:\/\/\S+#t=[A-Za-z0-9_-]+/.exec(message!.text)![0];
    const url = new URL(link);
    expect(url.origin).toBe(ORIGIN);
    expect(url.pathname).toBe("/sign-in/link");
    expect(url.search).toBe("");
    // better-auth's own GET verify URL is never emailed.
    expect(message!.text).not.toContain("magic-link/verify");
    expect(message!.html).not.toContain("magic-link/verify");
    expect(message!.text).toContain(member.email);
    // Stored hashed: better-auth's identifier is a hash; our row too.
    const token = fragmentToken(link)!;
    expect(await count("SELECT count(*) AS n FROM auth_verifications WHERE identifier LIKE ?", `%${token}%`)).toBe(0);
    expect(await count("SELECT count(*) AS n FROM magic_link_issues WHERE token_hash = ?", token)).toBe(0);
    expect(await count("SELECT count(*) AS n FROM magic_link_issues WHERE user_id = ?", member.id)).toBe(1);
  });

  it("no enumeration: members, owners, admins, unknown, disabled and system addresses get identical responses and equal work; only the member gets mail", async () => {
    const member = await joinByInvitation(ws);
    const admin = await addMember("admin");
    const disabled = await addMember("member");
    await env.DB.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").bind(disabled.id).run();
    const unknown = uniqueEmail("nobody");
    const cases = [member.email, ws.owner.email, admin.email, disabled.email, unknown];
    const shapes = [];
    for (const email of cases) {
      const issuesBefore = await count("SELECT count(*) AS n FROM magic_link_issues");
      const verificationsBefore = await count(
        "SELECT count(*) AS n FROM auth_verifications WHERE identifier LIKE 'magic-link:%'",
      );
      const counters = await count(
        "SELECT coalesce(sum(count), 0) AS n FROM rate_counters WHERE scope IN ('magic_link_email', 'magic_link_ip')",
      );
      shapes.push(await shape(await requestLink(new Browser(), email)));
      // The same writes for every address: one issue row, one verification row, both counters.
      expect(await count("SELECT count(*) AS n FROM magic_link_issues")).toBe(issuesBefore + 1);
      expect(await count("SELECT count(*) AS n FROM auth_verifications WHERE identifier LIKE 'magic-link:%'")).toBe(
        verificationsBefore + 1,
      );
      expect(
        await count(
          "SELECT coalesce(sum(count), 0) AS n FROM rate_counters WHERE scope IN ('magic_link_email', 'magic_link_ip')",
        ),
      ).toBe(counters + 2);
    }
    for (const s of shapes) expect(s).toEqual(shapes[0]);
    expect(outbox.to(member.email).filter((m) => m.kind === "magic_link")).toHaveLength(1);
    for (const email of [ws.owner.email, admin.email, disabled.email, unknown]) {
      expect(outbox.to(email).filter((m) => m.kind === "magic_link")).toHaveLength(0);
    }
    // Rows for addresses that get no mail can never be consumed (no user).
    expect(
      await count(
        "SELECT count(*) AS n FROM magic_link_issues WHERE email_normalised = ? AND user_id IS NOT NULL",
        ws.owner.email,
      ),
    ).toBe(0);
  });

  it("emails differing only in case or Unicode form are one address", async () => {
    const member = await joinByInvitation(ws);
    const response = await requestLink(new Browser(), `  ${member.email.toUpperCase()} `);
    expect(response.status).toBe(200);
    expect(outbox.to(member.email).filter((m) => m.kind === "magic_link")).toHaveLength(1);
  });

  it("refuses callback URLs and other fields better-auth would accept", async () => {
    const member = await joinByInvitation(ws);
    const response = await requestLink(new Browser(), member.email, { callbackURL: "https://evil.test/" });
    expect(response.status).toBe(400);
  });

  it("is unavailable when email isn't configured or magic links are off, the same for every address", async () => {
    const member = await joinByInvitation(ws);
    await configureEmail({ driver: "none" });
    const off = await requestLink(new Browser(), member.email);
    expect(off.status).toBe(503);
    expect(await shape(off)).toEqual(await shape(await requestLink(new Browser(), uniqueEmail("x"))));
    await configureEmail();
    await setSetting("magic_link_enabled", false);
    expect((await requestLink(new Browser(), member.email)).status).toBe(503);
    expect((await new Browser().json("/api/status/public")).body).toEqual({ magicLinks: false });
    await setSetting("magic_link_enabled", true);
    expect((await new Browser().json("/api/status/public")).body).toEqual({ magicLinks: true });
  });

  it("CSRF: the request needs the header and the canonical Origin", async () => {
    const missing = await new Browser().json("/api/auth/sign-in/magic-link", {
      body: { email: uniqueEmail() },
      noCsrf: true,
      headers: { origin: ORIGIN },
    });
    expect(missing.body).toMatchObject({ error: { code: "csrf_failed" } });
  });
});

describe("magic-link rate limits (Platform §8; Identity §4.4 'no lockout')", () => {
  it("the 4th request for one email in the window sends nothing, answers the same, and doesn't extend the window", async () => {
    const member = await joinByInvitation(ws);
    const responses = [];
    for (let i = 0; i < 5; i++) responses.push(await shape(await requestLink(new Browser(), member.email)));
    for (const r of responses) expect(r).toEqual(responses[0]);
    expect(outbox.to(member.email).filter((m) => m.kind === "magic_link")).toHaveLength(3);
    // The counter stopped at the limit in one fixed window: flooding never moves or extends it.
    const { tokenHash } = await import("../../src/features/identity/crypto");
    const key = await tokenHash(env.TOKEN_HASH_KEY!, `magic-link-email:${member.email}`);
    const rows = await env.DB.prepare(
      "SELECT window_start, count FROM rate_counters WHERE scope = 'magic_link_email' AND key = ?",
    )
      .bind(key)
      .all<{ window_start: number; count: number }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]!.count).toBe(3);
    const windowStart = rows.results[0]!.window_start;
    expect(windowStart % (15 * 60 * 1000)).toBe(0);
    expect(windowStart + 15 * 60 * 1000).toBeGreaterThan(Date.now());
    // Suppressed links can't be used: their rows name no user.
    expect(
      await count(
        "SELECT count(*) AS n FROM magic_link_issues WHERE email_normalised = ? AND user_id IS NULL",
        member.email,
      ),
    ).toBe(2);
    // Once the window has passed (simulated by moving it back), the member's own request sends again.
    await env.DB.prepare(
      "UPDATE rate_counters SET window_start = window_start - 900000 WHERE scope = 'magic_link_email' AND key = ?",
    )
      .bind(key)
      .run();
    await requestLink(new Browser(), member.email);
    expect(outbox.to(member.email).filter((m) => m.kind === "magic_link")).toHaveLength(4);
  });

  it("unknown emails count the same as real ones", async () => {
    const unknown = uniqueEmail("ghost");
    for (let i = 0; i < 4; i++) await requestLink(new Browser(), unknown);
    const { tokenHash } = await import("../../src/features/identity/crypto");
    const key = await tokenHash(env.TOKEN_HASH_KEY!, `magic-link-email:${unknown}`);
    expect(
      await count(
        "SELECT coalesce(sum(count), 0) AS n FROM rate_counters WHERE scope = 'magic_link_email' AND key = ?",
        key,
      ),
    ).toBe(3);
  });

  it("per IP: the 21st request in an hour is rate_limited", async () => {
    const browser = new Browser();
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) statuses.push((await requestLink(browser, uniqueEmail("ip"))).status);
    expect(statuses.slice(0, 20).every((s) => s === 200)).toBe(true);
    expect(statuses[20]).toBe(429);
  });
});

describe("confirming a magic link (Identity §4.4; Platform §10)", () => {
  async function freshLink() {
    const member = await joinByInvitation(ws);
    await requestLink(new Browser(), member.email);
    return { member, token: linkFor(member.email) };
  }

  it("the confirm POST signs the member in; the body has no token; the session is a magic-link one", async () => {
    const { member, token } = await freshLink();
    const browser = new Browser();
    const confirm = await browser.json("/api/sign-in/link", { body: { token } });
    expect(confirm.status).toBe(200);
    expect(confirm.body).toEqual({ signedIn: true });
    expect(browser.sessionCookie).toBeDefined();
    const me = await browser.json<{ user: { id: string }; session: { freshAuthMethod: string; freshAuthAt: number } }>(
      "/api/me",
    );
    expect(me.body.user.id).toBe(member.id);
    expect(me.body.session.freshAuthMethod).toBe("magic_link");
    expect(me.body.session.freshAuthAt).toBeGreaterThan(Date.now() - 60_000);
    // A magic-link sign-in never satisfies step-up.
    const reauthNeeded = await browser.json(`/api/me/passkeys/${"0".repeat(26)}`, { method: "DELETE", body: {} });
    expect([403, 404]).toContain(reauthNeeded.status);
    // It can be used once.
    expect((await new Browser().json("/api/sign-in/link", { body: { token } })).status).toBe(410);
  });

  it("lookup shows the account email and workspace without using the link", async () => {
    const { member, token } = await freshLink();
    const lookup = await new Browser().json("/api/sign-in/link/lookup", { body: { token } });
    expect(lookup.body).toEqual({ email: member.email, workspaceName: "Acme Studio" });
    expect((await new Browser().json("/api/sign-in/link", { body: { token } })).status).toBe(200);
    expect((await new Browser().json("/api/sign-in/link/lookup", { body: { token } })).status).toBe(410);
    expect((await new Browser().json("/api/sign-in/link/lookup", { body: { token: "F".repeat(43) } })).status).toBe(
      410,
    );
  });

  it("opening the link page with GET uses nothing; better-auth's GET verify answers 404", async () => {
    const { token } = await freshLink();
    await new Browser().call("/sign-in/link", { noCsrf: true });
    expect((await new Browser().call(`/api/auth/magic-link/verify?token=${token}`, { noCsrf: true })).status).toBe(404);
    expect((await new Browser().json("/api/sign-in/link", { body: { token } })).status).toBe(200);
  });

  it("two concurrent confirm POSTs with one token sign in at most once", async () => {
    const { member, token } = await freshLink();
    const before = await count("SELECT count(*) AS n FROM sessions WHERE user_id = ?", member.id);
    const results = await Promise.all(
      [1, 2, 3].map(() => new Browser().json("/api/sign-in/link", { body: { token } })),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    for (const r of results) expect([200, 410]).toContain(r.status);
    expect(await count("SELECT count(*) AS n FROM sessions WHERE user_id = ?", member.id)).toBe(before + 1);
  });

  it("an expired link is refused", async () => {
    const { token } = await freshLink();
    await env.DB.prepare("UPDATE magic_link_issues SET expires_at = ? WHERE expires_at > ?")
      .bind(Date.now() - 1, Date.now())
      .run();
    expect((await new Browser().json("/api/sign-in/link", { body: { token } })).status).toBe(410);
  });

  it("the link lasts 15 minutes", async () => {
    const { member } = await freshLink();
    const row = await env.DB.prepare(
      "SELECT created_at, expires_at FROM magic_link_issues WHERE user_id = ? ORDER BY created_at DESC",
    )
      .bind(member.id)
      .first<{ created_at: number; expires_at: number }>();
    expect(row!.expires_at - row!.created_at).toBe(15 * 60 * 1000);
  });

  it("a member promoted or disabled after the link was sent can't use it", async () => {
    const promoted = await freshLink();
    await env.DB.prepare("UPDATE users SET role = 'admin' WHERE id = ?").bind(promoted.member.id).run();
    expect((await new Browser().json("/api/sign-in/link", { body: { token: promoted.token } })).status).toBe(410);
    const disabled = await freshLink();
    await env.DB.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").bind(disabled.member.id).run();
    expect((await new Browser().json("/api/sign-in/link", { body: { token: disabled.token } })).status).toBe(410);
  });

  it("a revoked link is refused", async () => {
    const { member, token } = await freshLink();
    await env.DB.prepare("UPDATE magic_link_issues SET revoked_at = ? WHERE email_normalised = ?")
      .bind(Date.now(), member.email)
      .run();
    expect((await new Browser().json("/api/sign-in/link", { body: { token } })).status).toBe(410);
  });

  it("invalid tokens are refused without a session", async () => {
    const browser = new Browser();
    expect((await browser.json("/api/sign-in/link", { body: { token: "C".repeat(43) } })).status).toBe(410);
    expect((await browser.json("/api/sign-in/link", { body: { token: "bad token" } })).status).toBe(400);
    expect(browser.sessionCookie).toBeUndefined();
  });

  it("confirm POSTs are rate-limited per IP (10 per minute)", async () => {
    const browser = new Browser();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++)
      statuses.push((await browser.json("/api/sign-in/link", { body: { token: "D".repeat(43) } })).status);
    expect(statuses[10]).toBe(429);
  });
});

describe("failures after the link is consumed (second review 5; review L7)", () => {
  it("if the new-device notice can't be written, the sign-in stands, the device isn't remembered, and the next sign-in raises it", async () => {
    const member = await joinByInvitation(ws);
    const browser = new Browser();
    await requestLink(browser, member.email);
    const devicesBefore = await count("SELECT count(*) AS n FROM user_devices WHERE user_id = ?", member.id);
    const noticeFails = failingDb((sql) => sql.includes("json_insert("));
    const confirm = await browser.call("/api/sign-in/link", {
      body: { token: linkFor(member.email) },
      env: { DB: noticeFails },
    });
    expect(confirm.status).toBe(200);
    expect(browser.sessionCookie).toBeDefined();
    expect(browser.cookies.get("__Host-officebox-device")).toBeUndefined();
    expect(await count("SELECT count(*) AS n FROM user_devices WHERE user_id = ?", member.id)).toBe(devicesBefore);
    const notices = async () =>
      JSON.parse(
        (await env.DB.prepare("SELECT coalesce(pending_security_notice, '[]') AS p FROM users WHERE id = ?")
          .bind(member.id)
          .first<{ p: string }>())!.p,
      ) as { kind: string }[];
    expect((await notices()).filter((n) => n.kind === "magic_link_new_device")).toHaveLength(0);
    // The next magic-link sign-in from the same browser is still "new", so the notice isn't lost.
    await requestLink(browser, member.email);
    await browser.json("/api/sign-in/link", { body: { token: linkFor(member.email) } });
    expect((await notices()).filter((n) => n.kind === "magic_link_new_device")).toHaveLength(1);
    expect(browser.cookies.get("__Host-officebox-device")).toBeDefined();
  });

  it("a real failure inside better-auth's verify after our consume is a typed error that says to ask for a new link", async () => {
    const member = await joinByInvitation(ws);
    await requestLink(new Browser(), member.email);
    const token = linkFor(member.email);
    // better-auth's instance is cached per origin and secrets, so the route uses this same object.
    const { authFor } = await import("../../src/features/identity/auth");
    const { identitySecrets } = await import("../../src/features/identity/secrets");
    const secrets = identitySecrets(env, {
      error() {},
      warn() {},
      info() {},
      debug() {},
      child() {
        return this;
      },
    });
    if (!secrets.ok) throw new Error("secrets");
    const auth = authFor(env, secrets.value, { canonicalOrigin: ORIGIN, workspaceName: "Acme Studio" });
    const spy = vi.spyOn(auth.api, "magicLinkVerify").mockRejectedValueOnce(new Error("D1 unavailable"));
    const browser = new Browser();
    const failed = await browser.json("/api/sign-in/link", { body: { token } });
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    expect(failed.status).toBe(503);
    expect(failed.body).toMatchObject({ error: { code: "unavailable", reason: "magic_link_failed" } });
    expect(browser.sessionCookie).toBeUndefined();
    // The link was used up by our consume.
    expect((await new Browser().json("/api/sign-in/link", { body: { token } })).status).toBe(410);
  });
});

describe("new-device notices and the known-device cookie (Identity §4.4, §4.6a)", () => {
  it("a sign-in from a new device raises a security notice, by banner and email; a known device doesn't", async () => {
    const member = await joinByInvitation(ws);
    const notices = async () =>
      JSON.parse(
        (await env.DB.prepare("SELECT coalesce(pending_security_notice, '[]') AS p FROM users WHERE id = ?")
          .bind(member.id)
          .first<{ p: string }>())!.p,
      ) as { kind: string }[];
    const fresh = new Browser();
    await requestLink(fresh, member.email);
    await fresh.json("/api/sign-in/link", { body: { token: linkFor(member.email) } });
    expect((await notices()).filter((n) => n.kind === "magic_link_new_device")).toHaveLength(1);
    const securityEmails = outbox.to(member.email).filter((m) => m.kind === "security_notice");
    expect(securityEmails).toHaveLength(1);
    expect(securityEmails[0]!.subject).toContain("New sign-in with an email link");
    expect(fresh.cookies.get("__Host-officebox-device")).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // The same browser again: known, no new notice.
    await requestLink(fresh, member.email);
    await fresh.json("/api/sign-in/link", { body: { token: linkFor(member.email) } });
    expect((await notices()).filter((n) => n.kind === "magic_link_new_device")).toHaveLength(1);
  });

  it("passkey sign-ins set the device cookie too, so a later magic link there is no new device", async () => {
    const member = await joinByInvitation(ws);
    const browser = new Browser();
    await signInWithPasskey(browser, member.authenticator);
    const device = browser.cookies.get("__Host-officebox-device");
    expect(device).toBeDefined();
    const response = await browser.call("/api/sign-in/link", { body: { token: "E".repeat(43) } });
    expect(response.status).toBe(410);
    await requestLink(browser, member.email);
    await browser.json("/api/sign-in/link", { body: { token: linkFor(member.email) } });
    expect(outbox.to(member.email).filter((m) => m.kind === "security_notice")).toHaveLength(0);
  });

  it("the device cookie is __Host-, HttpOnly, Secure, Path=/", async () => {
    const member = await joinByInvitation(ws);
    const browser = new Browser();
    const options = await browser.json<{ challenge: string; rpId: string }>(
      "/api/auth/passkey/generate-authenticate-options",
    );
    const assertion = await member.authenticator.authenticate(options.body, ORIGIN);
    const response = await browser.call("/api/auth/passkey/verify-authentication", { body: { response: assertion } });
    const cookie = response.headers.getSetCookie().find((c) => c.startsWith("__Host-officebox-device="));
    expect(cookie).toMatch(/; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=\d+$/);
    expect(cookie).not.toMatch(/Domain=/i);
  });
});

describe("a member's first passkey after a magic link (Identity §4.5 exception)", () => {
  it("a member with no passkeys may add one within 10 minutes of a magic-link sign-in; it's labelled and notified", async () => {
    // A member with no passkey: invited, accepted, never registered.
    const { invite, acceptInvite } = await import("./helpers");
    const email = uniqueEmail("nopk");
    const created = await invite(ws.browser, email);
    await acceptInvite(fragmentToken(created.body.link)!);
    await requestLink(new Browser(), email);
    const browser = new Browser();
    await browser.json("/api/sign-in/link", { body: { token: linkFor(email) } });
    const reg = await registerPasskey(browser, new SoftAuthenticator());
    expect(reg.verify?.status).toBe(200);
    const row = await env.DB.prepare(
      "SELECT p.created_via FROM passkeys p JOIN users u ON u.id = p.user_id WHERE u.email = ?",
    )
      .bind(email)
      .first<{ created_via: string }>();
    expect(row!.created_via).toBe("magic_link");
    const emails = outbox.to(email).filter((m) => m.kind === "security_notice");
    expect(emails.some((m) => m.subject.includes("A passkey was added"))).toBe(true);
    // A second one needs a real passkey step-up.
    const second = await registerPasskey(browser, new SoftAuthenticator());
    expect(second.options.status).toBe(403);
    expect(second.options.body).toMatchObject({ error: { code: "reauth_required" } });
  });

  it("with magic links available, a member may remove their last passkey; with them off, they can't", async () => {
    const member = await joinByInvitation(ws);
    const list = await member.browser.json<{ passkeys: { id: string }[] }>("/api/me/passkeys");
    const id = list.body.passkeys[0]!.id;
    await setSetting("magic_link_enabled", false);
    expect((await member.browser.json(`/api/me/passkeys/${id}`, { method: "DELETE", body: {} })).body).toMatchObject({
      error: { reason: "last_passkey" },
    });
    await setSetting("magic_link_enabled", true);
    const removed = await member.browser.json(`/api/me/passkeys/${id}`, { method: "DELETE", body: {} });
    expect(removed.body).toBeNull();
    expect(removed.status).toBe(200);
  });
});

describe("security notices by email (Identity §4.6a; Notifications §3, §9 M1)", () => {
  it("adding a passkey while signed in emails the person when email is configured, and only then", async () => {
    await registerPasskey(ws.browser, new SoftAuthenticator());
    expect(outbox.to(ws.owner.email).filter((m) => m.kind === "security_notice").length).toBeGreaterThan(0);
    const before = outbox.messages.length;
    await configureEmail({ driver: "none" });
    await registerPasskey(ws.browser, new SoftAuthenticator());
    expect(outbox.messages.length).toBe(before);
  });

  it("a detected clone emails the member and the owners", async () => {
    const member = await joinByInvitation(ws);
    await signInWithPasskey(new Browser(), member.authenticator);
    const stored = (await env.DB.prepare("SELECT sign_count FROM passkeys WHERE user_id = ?")
      .bind(member.id)
      .first<{ sign_count: number }>())!.sign_count;
    const { verify } = await signInWithPasskey(new Browser(), member.authenticator, { counter: stored });
    expect(verify.body).toMatchObject({ error: { reason: "clone_detected" } });
    expect(
      outbox.to(member.email).some((m) => m.kind === "security_notice" && m.subject.includes("copied passkey")),
    ).toBe(true);
    expect(outbox.to(ws.owner.email).some((m) => m.kind === "security_notice" && m.text.includes("Ana Diaz"))).toBe(
      true,
    );
  });
});

describe("no response body or log line contains a session or magic-link token (required sweep)", () => {
  it("sweeps request, confirm, /me and sign-out", async () => {
    const lines: string[] = [];
    const originals = { log: console.log, warn: console.warn, error: console.error, info: console.info };
    const capture = (...args: unknown[]) => lines.push(args.map(String).join(" "));
    Object.assign(console, { log: capture, warn: capture, error: capture, info: capture });
    const browsers: Browser[] = [];
    let token: string;
    try {
      const member = await joinByInvitation(ws);
      browsers.push(member.browser);
      const browser = new Browser();
      browsers.push(browser);
      await requestLink(browser, member.email);
      await requestLink(browser, ws.owner.email);
      token = linkFor(member.email);
      await browser.json("/api/sign-in/link", { body: { token } });
      await browser.json("/api/sign-in/link", { body: { token } });
      await browser.json("/api/me");
      await browser.json("/api/auth/sign-out", { body: {} });
    } finally {
      Object.assign(console, originals);
    }
    const bodies = browsers.flatMap((b) => b.bodies);
    const secrets = new Set<string>([token, ...(await sessionTokens())]);
    for (const b of browsers) {
      const value = b.cookies.get("__Host-officebox.session_token");
      if (value) secrets.add(decodeURIComponent(value).split(".")[0]!);
    }
    for (const secret of secrets) {
      for (const body of bodies) expect(body).not.toContain(secret);
      for (const line of lines) expect(line).not.toContain(secret);
    }
  });
});

import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rootLogger } from "../../src/core/log";
import { startDomainMove } from "../../src/features/identity/domain-move";
import { clearPageInstallationCache, loadInstallationForPages } from "../../src/features/identity/installation";
import { IDENTITY_JOBS } from "../../src/features/identity/jobs";
import { canonicalTarget } from "../../src/features/identity/middleware";
import { onRevocation } from "../../src/features/identity/revocation";
import { SoftAuthenticator } from "./authenticator";
import {
  acceptInvite,
  addMember,
  Browser,
  callWorker,
  configureEmail,
  fragmentToken,
  giveTicket,
  invite,
  meetInviteGate,
  ORIGIN,
  outbox,
  reauth,
  setSetting,
  setupWorkspace,
  staleFreshAuth,
  uniqueEmail,
  type Workspace,
} from "./helpers";
import { auditCount, count, noticeKinds, registerAt } from "./m1c-helpers";

/**
 * M1c domain move (Identity §2, §4.4, §9 "Domain move"; TDD §8.1; Permissions §6; Platform §11). Every
 * test starts from a fresh workspace on ORIGIN (a committed move changes the canonical origin).
 */

const NEW = "https://new.officebox.test";
const OTHER = "https://other-race.officebox.test";
const OLD_HOST = new URL(ORIGIN).host;

let ws: Workspace;
beforeEach(async () => {
  ws = await setupWorkspace();
  clearPageInstallationCache(env.DB);
  await configureEmail();
});
afterEach(async () => {
  // Later files expect ORIGIN to be canonical; each file calls setupWorkspace anyway.
  await env.DB.prepare(
    "UPDATE installation SET pending_origin = NULL, pending_origin_started_by = NULL, pending_origin_expires_at = NULL",
  ).run();
});

interface ErrorBody {
  error: { code: string; reason?: string };
}
type StartBody = { origin: string; link: string; expiresAt: number } & ErrorBody;

function start(browser: Browser, origin: string) {
  return browser.json<StartBody>("/api/admin/domain", { body: { origin } });
}

async function installation() {
  return (await env.DB.prepare(
    "SELECT canonical_origin, allowed_hosts, pending_origin, pending_origin_expires_at FROM installation WHERE id = 1",
  ).first<{
    canonical_origin: string;
    allowed_hosts: string;
    pending_origin: string | null;
    pending_origin_expires_at: number | null;
  }>())!;
}

/** On the new origin: the move link's POST, then a passkey registration there. */
async function commit(token: string, authenticator = new SoftAuthenticator()) {
  const browser = new Browser();
  const opened = await browser.json<{ email: string; origin: string; enrolmentExpiresInSeconds: number } & ErrorBody>(
    "/api/admin/domain/complete",
    { body: { token }, baseUrl: NEW, origin: NEW },
  );
  if (opened.status !== 201) return { browser, opened, reg: null };
  const reg = await registerAt(browser, authenticator, NEW);
  return { browser, opened, reg, authenticator };
}

describe("starting a move (Identity §4.4): owners only, with step-up", () => {
  it("members and admins are refused; an owner without a fresh assertion gets reauth_required", async () => {
    const member = await addMember();
    const admin = await addMember("admin");
    expect((await start(member.browser, NEW)).body.error.reason).toBe("not_permitted");
    expect((await start(admin.browser, NEW)).body.error.reason).toBe("owner_required");
    expect((await admin.browser.json("/api/admin/domain")).status).toBe(403);
    expect((await admin.browser.json("/api/admin/domain/pending", { method: "DELETE" })).status).toBe(403);
    await staleFreshAuth(ws.ownerId);
    const stale = await start(ws.browser, NEW);
    expect(stale.status).toBe(403);
    expect(stale.body.error.code).toBe("reauth_required");
    expect((await installation()).pending_origin).toBeNull();
    expect((await reauth(ws.browser, ws.authenticator)).status).toBe(200);
    expect((await start(ws.browser, NEW)).status).toBe(201);
  });

  it("stores the pending move (24 hours) and returns the move link for the new origin; the old one keeps working", async () => {
    const res = await start(ws.browser, `${NEW}/`);
    expect(res.status).toBe(201);
    expect(res.body.origin).toBe(NEW);
    expect(res.body.link.startsWith(`${NEW}/admin/domain/complete#t=`)).toBe(true);
    const row = await installation();
    expect(row.canonical_origin).toBe(ORIGIN);
    expect(row.pending_origin).toBe(NEW);
    expect(row.pending_origin_expires_at! - Date.now()).toBeGreaterThan(23.9 * 60 * 60 * 1000);
    expect(await auditCount("domain.move_started")).toBeGreaterThan(0);
    const status = await ws.browser.json<{ canonicalOrigin: string; pending: { origin: string } | null }>(
      "/api/admin/domain",
    );
    expect(status.body).toMatchObject({ canonicalOrigin: ORIGIN, pending: { origin: NEW } });
    expect((await ws.browser.call("/api/me")).status).toBe(200);
  });

  it("refuses addresses that aren't a bare https origin with a domain name, and the current address", async () => {
    for (const bad of [
      "http://new.officebox.test",
      "https://new.officebox.test/path",
      "https://new.officebox.test/?q=1",
      "https://user:pw@new.officebox.test",
      "https://192.0.2.10",
      "https://[2001:db8::1]",
      "ftp://new.officebox.test",
      "new.officebox.test",
      "https://intranet",
    ]) {
      const res = await start(ws.browser, bad);
      expect(res.status, bad).toBe(400);
    }
    const same = await start(ws.browser, ORIGIN);
    expect(same.status).toBe(400);
    expect(same.body.error.reason).toBe("same_origin");
  });

  it("starting again replaces the pending move and its link; cancelling clears it", async () => {
    const first = fragmentToken((await start(ws.browser, NEW)).body.link)!;
    const second = fragmentToken((await start(ws.browser, "https://other.officebox.test")).body.link)!;
    expect((await installation()).pending_origin).toBe("https://other.officebox.test");
    // The first move's origin isn't pending any more: it answers like any unknown host.
    const stale = await new Browser().json("/api/admin/domain/complete", {
      body: { token: first },
      baseUrl: NEW,
      origin: NEW,
    });
    expect(stale.status).toBe(404);
    expect((await ws.browser.json("/api/admin/domain/pending", { method: "DELETE" })).status).toBe(200);
    expect(await auditCount("domain.move_cancelled")).toBeGreaterThan(0);
    expect((await installation()).pending_origin).toBeNull();
    const cancelled = await new Browser().json("/api/admin/domain/complete", {
      body: { token: second },
      baseUrl: "https://other.officebox.test",
      origin: "https://other.officebox.test",
    });
    expect(cancelled.status).toBe(404);
    expect((await ws.browser.json("/api/admin/domain/pending", { method: "DELETE" })).status).toBe(404);
  });
});

describe("the new origin while the move is pending (TDD §8.1)", () => {
  it("answers only the move-completion routes; a wrong link is refused; unknown hosts stay refused", async () => {
    await start(ws.browser, NEW);
    const visitor = new Browser();
    expect((await visitor.call("/api/me", { baseUrl: NEW })).status).toBe(404);
    expect((await visitor.call("/api/setup", { baseUrl: NEW })).status).toBe(404);
    expect((await visitor.call("/api/auth/passkey/generate-authenticate-options", { baseUrl: NEW })).status).toBe(404);
    const wrong = await visitor.json<ErrorBody>("/api/admin/domain/complete", {
      body: { token: "x".repeat(43) },
      baseUrl: NEW,
      origin: NEW,
    });
    expect(wrong.status).toBe(410);
    expect(wrong.body.error.reason).toBe("domain_move_invalid");
    // CSRF: the Origin must be the new origin there.
    const crossOrigin = await visitor.json("/api/admin/domain/complete", {
      body: { token: "x".repeat(43) },
      baseUrl: NEW,
      origin: ORIGIN,
    });
    expect(crossOrigin.status).toBe(403);
    // Registration there without a ticket is refused.
    const noTicket = await registerAt(visitor, new SoftAuthenticator(), NEW);
    expect(noTicket.options.status).not.toBe(200);
    // The move-completion route doesn't exist on the canonical origin.
    expect((await ws.browser.json("/api/admin/domain/complete", { body: { token: "x".repeat(43) } })).status).toBe(404);
    expect((await visitor.call("/api/me", { baseUrl: "https://elsewhere.officebox.test" })).status).toBe(404);
  });

  it("the move link sets a ticket only usable on the new origin; other tickets aren't usable there", async () => {
    const token = fragmentToken((await start(ws.browser, NEW)).body.link)!;
    const browser = new Browser();
    const opened = await browser.json<{ email: string }>("/api/admin/domain/complete", {
      body: { token },
      baseUrl: NEW,
      origin: NEW,
    });
    expect(opened.status).toBe(201);
    expect(opened.body.email).toBe(ws.owner.email);
    // The domain-move ticket can't register on the old origin.
    const onOld = await registerAt(browser, new SoftAuthenticator(), ORIGIN);
    expect(onOld.options.status).not.toBe(200);
    expect((await installation()).canonical_origin).toBe(ORIGIN);
    // An ordinary enrolment ticket can't register on the new origin.
    const member = await addMember();
    const other = new Browser();
    await giveTicket(other, member.id, "invitation");
    const onNew = await registerAt(other, new SoftAuthenticator(), NEW);
    expect(onNew.options.status).not.toBe(200);
    // A signed-in owner's session can't register there either (no session on the new origin).
    const signedIn = await registerAt(ws.browser, new SoftAuthenticator(), NEW);
    expect(signedIn.options.status).not.toBe(200);
    expect((await installation()).canonical_origin).toBe(ORIGIN);
  });

  it("another owner's browser can't use the link: it's bound to the owner who started the move", async () => {
    const owner2 = await addMember("owner");
    const token = fragmentToken((await start(owner2.browser, NEW)).body.link)!;
    await env.DB.prepare("UPDATE installation SET pending_origin_started_by = ? WHERE id = 1").bind(ws.ownerId).run();
    const res = await new Browser().json("/api/admin/domain/complete", { body: { token }, baseUrl: NEW, origin: NEW });
    expect(res.status).toBe(410);
  });
});

describe("committing (Identity §4.4, §9)", () => {
  it("only the passkey registration on the new origin commits; then everything the spec lists happens", async () => {
    await setSetting("magic_link_enabled", true);
    await meetInviteGate(ws);
    const owner2 = await addMember("owner");
    const member = await addMember();
    // Outstanding things for the old origin.
    const requester = new Browser();
    await requester.call("/api/auth/sign-in/magic-link", { body: { email: member.email } });
    const magicMail = outbox.to(member.email).filter((m) => m.kind === "magic_link");
    const magic = fragmentToken(magicMail[magicMail.length - 1]!.text)!;
    const invited = await invite(ws.browser, uniqueEmail("invitee"));
    expect(invited.status).toBe(201);
    const inviteToken = fragmentToken(invited.body.link)!;
    const recovery = await ws.browser.json<{ link: string }>(`/api/admin/members/${member.id}/recovery-link`, {
      body: {},
    });
    const recoveryToken = fragmentToken(recovery.body.link)!;
    const ticketHolder = new Browser();
    await giveTicket(ticketHolder, member.id, "invitation");

    const token = fragmentToken((await start(ws.browser, NEW)).body.link)!;
    const committedBefore = await auditCount("domain.move_committed");
    const revocations: string[] = [];
    const stop = onRevocation((userId) => revocations.push(userId));
    let result;
    try {
      result = await commit(token);
    } finally {
      stop();
    }
    expect(result.opened.status).toBe(201);
    expect(result.reg?.options.body.rp.id).toBe("new.officebox.test");
    expect(result.reg?.verify?.status).toBe(200);

    const row = await installation();
    expect(row.canonical_origin).toBe(NEW);
    expect(row.pending_origin).toBeNull();
    expect(JSON.parse(row.allowed_hosts)).toContain(OLD_HOST);
    // The committing owner is signed in on the new origin with a new passkey made for it.
    expect((await result.browser.call("/api/me", { baseUrl: NEW })).status).toBe(200);
    expect(
      await count("SELECT count(*) AS n FROM passkeys WHERE user_id = ? AND created_via = 'domain_move'", ws.ownerId),
    ).toBe(1);
    // Every other session is revoked, closing sockets.
    expect(await count("SELECT count(*) AS n FROM sessions")).toBe(1);
    expect(new Set(revocations)).toEqual(new Set([ws.ownerId, owner2.id, member.id]));
    // The other owners are told; it's audited.
    expect(await noticeKinds(owner2.id)).toContain("domain_moved");
    expect(await noticeKinds(member.id)).not.toContain("domain_moved");
    expect(await auditCount("domain.move_committed")).toBe(committedBefore + 1);
    expect(outbox.to(owner2.email).some((m) => m.text.includes(`moved to ${NEW}`))).toBe(true);

    // Old-origin tokens are revoked: magic links, invitations, recovery links, enrolment tickets.
    expect(
      (await requester.json("/api/sign-in/link", { body: { token: magic }, baseUrl: NEW, origin: NEW })).status,
    ).toBe(410);
    expect(
      (await new Browser().json("/api/invitations/lookup", { body: { token: inviteToken }, baseUrl: NEW, origin: NEW }))
        .status,
    ).toBe(410);
    expect(
      (
        await new Browser().json("/api/auth/recover/lookup", {
          body: { token: recoveryToken },
          baseUrl: NEW,
          origin: NEW,
        })
      ).status,
    ).toBe(410);
    const stale = await registerAt(ticketHolder, new SoftAuthenticator(), NEW);
    expect(stale.options.status).not.toBe(200);
    // The move link itself is used up.
    expect(
      (await new Browser().json("/api/admin/domain/complete", { body: { token }, baseUrl: NEW, origin: NEW })).status,
    ).toBe(404);

    // Invitations are flagged; copying again makes a new link on the new origin, which works.
    const owner = result.browser;
    const list = await owner.json<{ invitations: { id: string; needsNewLink?: boolean }[] }>("/api/admin/invitations", {
      baseUrl: NEW,
      origin: NEW,
    });
    const flagged = list.body.invitations.find((i) => i.id === invited.body.invitation.id);
    expect(flagged?.needsNewLink).toBe(true);
    const copied = await owner.json<{ link: string }>(`/api/admin/invitations/${invited.body.invitation.id}/link`, {
      baseUrl: NEW,
      origin: NEW,
    });
    expect(copied.status).toBe(200);
    expect(copied.body.link.startsWith(`${NEW}/invitations/accept#t=`)).toBe(true);
    const fresh = fragmentToken(copied.body.link)!;
    expect(fresh).not.toBe(inviteToken);
    expect(
      (await new Browser().json("/api/invitations/lookup", { body: { token: fresh }, baseUrl: NEW, origin: NEW }))
        .status,
    ).toBe(200);
    const relisted = await owner.json<{ invitations: { id: string; needsNewLink?: boolean }[] }>(
      "/api/admin/invitations",
      { baseUrl: NEW, origin: NEW },
    );
    expect(relisted.body.invitations.find((i) => i.id === invited.body.invitation.id)?.needsNewLink).toBe(false);
  });

  it("afterwards the old host redirects (302/307, no-store, never 301, never a request-supplied host)", async () => {
    const token = fragmentToken((await start(ws.browser, NEW)).body.link)!;
    expect((await commit(token)).reg?.verify?.status).toBe(200);
    const visitor = new Browser();
    const get = await visitor.call("/api/me?x=1", {
      headers: { "x-forwarded-host": "evil.example", host: "evil.example" },
    });
    expect(get.status).toBe(302);
    expect(get.headers.get("Location")).toBe(`${NEW}/api/me?x=1`);
    expect(get.headers.get("Cache-Control")).toBe("no-store");
    const post = await visitor.call("/api/auth/sign-out", { body: {} });
    expect(post.status).toBe(307);
    expect(post.headers.get("Location")).toBe(`${NEW}/api/auth/sign-out`);
    // Pages redirect too (the Worker runs first for them).
    const page = await visitor.call("/chat?tab=2");
    expect(page.status).toBe(302);
    expect(page.headers.get("Location")).toBe(`${NEW}/chat?tab=2`);
    const head = await visitor.call("/sign-in/link", { method: "HEAD" });
    expect(head.status).toBe(302);
    // Passkeys made for the old origin don't sign in on the new one.
    const options = await visitor.json<{ challenge: string; rpId: string }>(
      "/api/auth/passkey/generate-authenticate-options",
      { baseUrl: NEW },
    );
    expect(options.body.rpId).toBe("new.officebox.test");
  });

  it("a commit that can't happen any more (expired, cancelled) removes the passkey and session it made", async () => {
    const token = fragmentToken((await start(ws.browser, NEW)).body.link)!;
    const browser = new Browser();
    expect(
      (await browser.json("/api/admin/domain/complete", { body: { token }, baseUrl: NEW, origin: NEW })).status,
    ).toBe(201);
    const options = await browser.json<{
      challenge: string;
      rp: { id: string; name: string };
      user: { id: string; name: string };
    }>("/api/auth/passkey/generate-register-options", { baseUrl: NEW, origin: NEW });
    expect(options.status).toBe(200);
    // The move link is revoked (as by a cancel or restart racing the registration), the move still pending.
    await env.DB.prepare("UPDATE auth_tokens SET revoked_at = ? WHERE kind = 'domain_move'").bind(Date.now()).run();
    const { response } = await new SoftAuthenticator().register(options.body, NEW);
    const verify = await browser.json<ErrorBody>("/api/auth/passkey/verify-registration", {
      body: { response },
      baseUrl: NEW,
      origin: NEW,
    });
    expect(verify.status).toBe(400);
    expect((await installation()).canonical_origin).toBe(ORIGIN);
    expect(
      await count("SELECT count(*) AS n FROM passkeys WHERE user_id = ? AND created_via = 'domain_move'", ws.ownerId),
    ).toBe(0);
    expect(await count("SELECT count(*) AS n FROM passkeys WHERE user_id = ?", ws.ownerId)).toBe(1);
    expect(await count("SELECT count(*) AS n FROM sessions WHERE user_id = ?", ws.ownerId)).toBe(1);
    expect((await ws.browser.call("/api/me")).status).toBe(200);
  });

  it("two concurrent registrations with one move ticket commit once", async () => {
    const token = fragmentToken((await start(ws.browser, NEW)).body.link)!;
    const committedBefore = await auditCount("domain.move_committed");
    const browser = new Browser();
    await browser.json("/api/admin/domain/complete", { body: { token }, baseUrl: NEW, origin: NEW });
    const options = await browser.json<{
      challenge: string;
      rp: { id: string; name: string };
      user: { id: string; name: string };
    }>("/api/auth/passkey/generate-register-options", { baseUrl: NEW, origin: NEW });
    const a = await new SoftAuthenticator().register(options.body, NEW);
    const b = await new SoftAuthenticator().register(options.body, NEW);
    const results = await Promise.all([
      browser.json("/api/auth/passkey/verify-registration", {
        body: { response: a.response },
        baseUrl: NEW,
        origin: NEW,
      }),
      browser.json("/api/auth/passkey/verify-registration", {
        body: { response: b.response },
        baseUrl: NEW,
        origin: NEW,
      }),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(await auditCount("domain.move_committed")).toBe(committedBefore + 1);
    expect(await count("SELECT count(*) AS n FROM passkeys WHERE created_via = 'domain_move'")).toBe(1);
  });
});

describe("expiry (Identity §4.4: 24 hours, default)", () => {
  it("an expired move: the new origin stops answering, and the hourly job clears and audits it once", async () => {
    const token = fragmentToken((await start(ws.browser, NEW)).body.link)!;
    await env.DB.prepare("UPDATE installation SET pending_origin_expires_at = ? WHERE id = 1")
      .bind(Date.now() - 1)
      .run();
    expect(
      (await new Browser().json("/api/admin/domain/complete", { body: { token }, baseUrl: NEW, origin: NEW })).status,
    ).toBe(404);
    expect((await ws.browser.json<{ pending: unknown }>("/api/admin/domain")).body.pending).toBeNull();
    const repair = IDENTITY_JOBS.find((j) => j.name === "identity.repair")!;
    const before = await auditCount("domain.move_expired");
    const run = () => repair.run({ env, log: rootLogger, now: Date.now, scheduledTime: Date.now() });
    await Promise.all([run(), run()]);
    expect(await auditCount("domain.move_expired")).toBe(before + 1);
    expect((await installation()).pending_origin).toBeNull();
    expect(await count("SELECT count(*) AS n FROM auth_tokens WHERE kind = 'domain_move' AND revoked_at IS NULL")).toBe(
      0,
    );
    // An unexpired move is left alone.
    await start(ws.browser, NEW);
    await run();
    expect((await installation()).pending_origin).toBe(NEW);
  });
});

describe("review fixes (M1c)", () => {
  it("the old-host redirect never leaves the canonical origin: //host, /\\host and /%2F%2Fhost", async () => {
    const token = fragmentToken((await start(ws.browser, NEW)).body.link)!;
    expect((await commit(token)).reg?.verify?.status).toBe(200);
    for (const path of [
      "//evil.example/x?y=1",
      "/\\evil.example/x",
      "/%2F%2Fevil.example",
      "///evil.example",
      "/api//evil.example",
    ]) {
      const response = await callWorker(new Request(`${ORIGIN}${path}`, { redirect: "manual" }));
      expect(response.status, path).toBe(302);
      const location = response.headers.get("Location")!;
      expect(new URL(location).origin, path).toBe(NEW);
      expect(location, path).not.toMatch(/^https:\/\/new\.officebox\.test\/\//);
    }
    expect(canonicalTarget(new URL(`${ORIGIN}//evil.example/x?q=1`), NEW)).toBe(`${NEW}/evil.example/x?q=1`);
    expect(canonicalTarget(new URL(`${ORIGIN}/%2F%2Fevil.example`), NEW)).toBe(`${NEW}/%2F%2Fevil.example`);
    expect(canonicalTarget(new URL(`${ORIGIN}/chat`), NEW)).toBe(`${NEW}/chat`);
  });

  it("an invitation accepted without a passkey yet can't be reopened after the move (a recovery link is needed)", async () => {
    await meetInviteGate(ws);
    const created = await invite(ws.browser, uniqueEmail("halfway"));
    const inviteToken = fragmentToken(created.body.link)!;
    const { accept } = await acceptInvite(inviteToken);
    expect(accept.status).toBe(201);
    // Before the move it reopens (no passkey, no session yet).
    expect((await new Browser().json("/api/invitations/accept", { body: { token: inviteToken } })).status).toBe(201);
    const token = fragmentToken((await start(ws.browser, NEW)).body.link)!;
    expect((await commit(token)).reg?.verify?.status).toBe(200);
    for (const path of ["/api/invitations/lookup", "/api/invitations/accept"]) {
      const res = await new Browser().json(path, { body: { token: inviteToken }, baseUrl: NEW, origin: NEW });
      expect(res.status, path).toBe(410);
    }
  });

  it("pages use a per-isolate cache of the installation that a commit clears", async () => {
    const db = env.DB;
    clearPageInstallationCache(db);
    const first = await loadInstallationForPages(db, Date.now());
    expect(first?.canonicalOrigin).toBe(ORIGIN);
    await db.prepare("UPDATE installation SET canonical_origin = ? WHERE id = 1").bind(NEW).run();
    expect((await loadInstallationForPages(db, Date.now()))?.canonicalOrigin).toBe(ORIGIN);
    expect((await loadInstallationForPages(db, Date.now() + 31_000))?.canonicalOrigin).toBe(NEW);
    await db.prepare("UPDATE installation SET canonical_origin = ? WHERE id = 1").bind(ORIGIN).run();
    clearPageInstallationCache(db);
    expect((await loadInstallationForPages(db, Date.now()))?.canonicalOrigin).toBe(ORIGIN);
  });

  it("starting a move that loses a race with an address change revokes nothing and issues no link", async () => {
    const first = fragmentToken((await start(ws.browser, NEW)).body.link)!;
    // A DB whose batch is preceded by a concurrent change of the canonical origin.
    const racing = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            await target.prepare("UPDATE installation SET canonical_origin = ? WHERE id = 1").bind(OTHER).run();
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, prop) as unknown;
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    const { identitySecrets } = await import("../../src/features/identity/secrets");
    const secrets = await identitySecrets(env, rootLogger);
    if (!secrets.ok) throw new Error("secrets");
    const ctx = { env: { ...env, DB: racing }, log: rootLogger, now: Date.now };
    const result = await startDomainMove(ctx, secrets.value, ws.ownerId, "https://third.officebox.test");
    expect(result.ok).toBe(false);
    await env.DB.prepare("UPDATE installation SET canonical_origin = ? WHERE id = 1").bind(ORIGIN).run();
    expect((await installation()).pending_origin).toBe(NEW);
    // The earlier move's link is still live.
    const opened = await new Browser().json("/api/admin/domain/complete", {
      body: { token: first },
      baseUrl: NEW,
      origin: NEW,
    });
    expect(opened.status).toBe(201);
    expect(await count("SELECT count(*) AS n FROM auth_tokens WHERE kind = 'domain_move'")).toBe(1);
  });
});

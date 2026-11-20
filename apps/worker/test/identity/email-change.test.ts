import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  addMember,
  Browser,
  configureEmail,
  fragmentToken,
  ORIGIN,
  outbox,
  reauth,
  setSetting,
  setupWorkspace,
  staleFreshAuth,
  uniqueEmail,
  type Workspace,
} from "./helpers";
import { auditCount, count, disableEmail, noticeKinds } from "./m1c-helpers";

/**
 * M1c email change (Identity §4.11, §6, §8, §9 "Email change", "Admin powers", "Notifications of admin
 * actions"; Permissions §6; Platform §10).
 */

let ws: Workspace;
beforeAll(async () => {
  ws = await setupWorkspace();
});
beforeEach(async () => {
  await configureEmail();
  await setSetting("magic_link_enabled", true);
});

interface ErrorBody {
  error: { code: string; reason?: string };
}
type ChangeBody = { status: "pending_confirmation" | "changed"; email: string } & ErrorBody;

function change(browser: Browser, targetId: string, email: string) {
  return browser.json<ChangeBody>(`/api/admin/members/${targetId}`, { method: "PATCH", body: { email } });
}

function confirmationToken(newEmail: string): string {
  const mail = outbox.to(newEmail).filter((m) => m.kind === "email_change");
  const last = mail[mail.length - 1];
  if (!last) throw new Error(`no confirmation email to ${newEmail}`);
  return fragmentToken(last.text)!;
}

async function emailOf(userId: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT email FROM users WHERE id = ?").bind(userId).first<{ email: string }>();
  return row?.email ?? null;
}

describe("who may change an email (Permissions §6, matrix) and step-up", () => {
  it("a member can't; an admin can for members only; an owner can for admins and owners", async () => {
    const member = await addMember();
    const other = await addMember();
    const admin = await addMember("admin");
    const owner2 = await addMember("owner");

    const byMember = await change(member.browser, other.id, uniqueEmail("x"));
    expect(byMember.status).toBe(403);
    expect(byMember.body.error.reason).toBe("not_permitted");

    expect((await change(admin.browser, member.id, uniqueEmail("m"))).status).toBe(200);
    for (const target of [owner2.id, ws.ownerId, (await addMember("admin")).id]) {
      const refused = await change(admin.browser, target, uniqueEmail("x"));
      expect(refused.status).toBe(403);
      expect(refused.body.error.reason).toBe("owner_required");
    }
    expect((await change(ws.browser, admin.id, uniqueEmail("a"))).status).toBe(200);
    expect((await change(ws.browser, owner2.id, uniqueEmail("o"))).status).toBe(200);
  });

  it("needs step-up: reauth_required without a fresh passkey assertion", async () => {
    const admin = await addMember("admin");
    const member = await addMember();
    await staleFreshAuth(admin.id);
    const refused = await change(admin.browser, member.id, uniqueEmail("x"));
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("reauth_required");
    expect((await reauth(admin.browser, admin.authenticator)).status).toBe(200);
    expect((await change(admin.browser, member.id, uniqueEmail("x"))).status).toBe(200);
  });

  it("refuses an unchanged address, one another account uses (any case or form), and a malformed one", async () => {
    const member = await addMember();
    const other = await addMember();
    const same = await change(ws.browser, member.id, member.email.toUpperCase());
    expect(same.status).toBe(400);
    expect(same.body.error.reason).toBe("email_unchanged");
    const taken = await change(ws.browser, member.id, ` ${other.email.toUpperCase()} `);
    expect(taken.status).toBe(409);
    expect(taken.body.error.reason).toBe("email_taken");
    expect((await change(ws.browser, member.id, "not an email")).status).toBe(400);
    expect(
      (
        await ws.browser.json(`/api/admin/members/${member.id}`, {
          method: "PATCH",
          body: { email: "a@b.test", role: "admin" },
        })
      ).status,
    ).toBe(400);
  });
});

describe("with email configured: a confirmation link to the new address (Identity §4.11)", () => {
  it("changes nothing until the confirmation POST; then once; the old address is told; links are revoked", async () => {
    const member = await addMember();
    const oldEmail = member.email;
    const newEmail = uniqueEmail("new");

    // A magic link and a recovery link outstanding for the member before the change.
    const requester = new Browser();
    await requester.call("/api/auth/sign-in/magic-link", { body: { email: oldEmail } });
    const magicMail = outbox.to(oldEmail).filter((m) => m.kind === "magic_link");
    const magic = fragmentToken(magicMail[magicMail.length - 1]!.text)!;
    const recovery = await ws.browser.json<{ link: string }>(`/api/admin/members/${member.id}/recovery-link`, {
      body: {},
    });
    const recoveryToken = fragmentToken(recovery.body.link)!;

    const res = await change(ws.browser, member.id, newEmail);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "pending_confirmation", email: newEmail });
    expect(await emailOf(member.id)).toBe(oldEmail);
    expect(await auditCount("member.email_change_requested", member.id)).toBe(1);

    const mail = outbox.to(newEmail).filter((m) => m.kind === "email_change");
    expect(mail).toHaveLength(1);
    expect(mail[0]!.text).toContain(`${ORIGIN}/me/email/confirm#t=`);
    const token = confirmationToken(newEmail);
    // Stored hashed only.
    expect(await count("SELECT count(*) AS n FROM auth_tokens WHERE token_hash = ?", token)).toBe(0);

    const page = new Browser();
    const lookup = await page.json<{ newEmail: string; workspaceName: string }>("/api/me/email/confirm/lookup", {
      body: { token },
    });
    expect(lookup.status).toBe(200);
    expect(lookup.body.newEmail).toBe(newEmail);
    expect(await emailOf(member.id)).toBe(oldEmail);

    const oldBefore = outbox.to(oldEmail).length;
    const confirmed = await page.json<{ email: string }>("/api/me/email/confirm", { body: { token } });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.email).toBe(newEmail);
    expect(await emailOf(member.id)).toBe(newEmail);
    expect(await auditCount("member.email_changed", member.id)).toBe(1);
    expect(await noticeKinds(member.id)).toContain("email_changed");

    // The old address is told, naming the new address and who changed it.
    const toOld = outbox.to(oldEmail).slice(oldBefore);
    expect(toOld).toHaveLength(1);
    expect(toOld[0]!.kind).toBe("security_notice");
    expect(toOld[0]!.text).toContain(`changed to ${newEmail} by Sam Lee`);

    // Only once.
    expect((await page.json("/api/me/email/confirm", { body: { token } })).status).toBe(410);
    // The old address's magic link and the recovery link no longer work.
    expect((await requester.json("/api/sign-in/link", { body: { token: magic } })).status).toBe(410);
    expect((await new Browser().json("/api/auth/recover/lookup", { body: { token: recoveryToken } })).status).toBe(410);
    // The old address no longer reaches the account.
    const before = outbox.to(oldEmail).length;
    expect((await requester.call("/api/auth/sign-in/magic-link", { body: { email: oldEmail } })).status).toBe(200);
    expect(outbox.to(oldEmail).length).toBe(before);
  });

  it("a GET of the confirmation page changes nothing (only the POST does)", async () => {
    const member = await addMember();
    const newEmail = uniqueEmail("get");
    await change(ws.browser, member.id, newEmail);
    const res = await new Browser().call(`/me/email/confirm`);
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await emailOf(member.id)).toBe(member.email);
  });

  it("two concurrent confirmations apply it once", async () => {
    const member = await addMember();
    const newEmail = uniqueEmail("race");
    await change(ws.browser, member.id, newEmail);
    const token = confirmationToken(newEmail);
    const [a, b] = await Promise.all([
      new Browser().json("/api/me/email/confirm", { body: { token } }),
      new Browser().json("/api/me/email/confirm", { body: { token } }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 410]);
    expect(await auditCount("member.email_changed", member.id)).toBe(1);
  });

  it("a newer change revokes the older link; an expired link answers 410", async () => {
    const member = await addMember();
    const first = uniqueEmail("first");
    const second = uniqueEmail("second");
    await change(ws.browser, member.id, first);
    const firstToken = confirmationToken(first);
    await change(ws.browser, member.id, second);
    expect((await new Browser().json("/api/me/email/confirm", { body: { token: firstToken } })).status).toBe(410);
    const list = await ws.browser.json<{ members: { id: string; pendingEmail: string | null }[] }>(
      "/api/admin/members",
    );
    expect(list.body.members.find((m) => m.id === member.id)?.pendingEmail).toBe(second);
    await env.DB.prepare("UPDATE auth_tokens SET expires_at = ? WHERE user_id = ? AND kind = 'email_change'")
      .bind(Date.now() - 1, member.id)
      .run();
    const secondToken = confirmationToken(second);
    expect((await new Browser().json("/api/me/email/confirm/lookup", { body: { token: secondToken } })).status).toBe(
      410,
    );
    expect((await new Browser().json("/api/me/email/confirm", { body: { token: secondToken } })).status).toBe(410);
    expect(await emailOf(member.id)).toBe(member.email);
  });

  it("an address taken by someone else before the confirmation is refused at confirm", async () => {
    const member = await addMember();
    const contested = uniqueEmail("contested");
    await change(ws.browser, member.id, contested);
    const token = confirmationToken(contested);
    const other = await addMember();
    await env.DB.prepare("UPDATE users SET email = ?, email_normalised = ? WHERE id = ?")
      .bind(contested, contested, other.id)
      .run();
    const res = await new Browser().json<ErrorBody>("/api/me/email/confirm", { body: { token } });
    expect(res.status).toBe(409);
    expect(res.body.error.reason).toBe("email_taken");
    expect(await emailOf(member.id)).toBe(member.email);
  });

  it("the confirmation needs the CSRF header", async () => {
    expect(
      (await new Browser().call("/api/me/email/confirm", { body: { token: "x".repeat(43) }, noCsrf: true })).status,
    ).toBe(403);
  });
});

describe("without email: the change applies at once (default)", () => {
  it("changes the address, revokes pending magic links, and adds the banner notice", async () => {
    const member = await addMember();
    const requester = new Browser();
    await requester.call("/api/auth/sign-in/magic-link", { body: { email: member.email } });
    const magicMail = outbox.to(member.email).filter((m) => m.kind === "magic_link");
    const magic = fragmentToken(magicMail[magicMail.length - 1]!.text)!;
    await disableEmail();
    const newEmail = uniqueEmail("now");
    const res = await change(ws.browser, member.id, newEmail);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "changed", email: newEmail });
    expect(await emailOf(member.id)).toBe(newEmail);
    expect(await noticeKinds(member.id)).toContain("email_changed");
    expect(await auditCount("member.email_changed", member.id)).toBe(1);
    await configureEmail();
    expect((await requester.json("/api/sign-in/link", { body: { token: magic } })).status).toBe(410);
    // Signed-in sessions continue.
    expect((await member.browser.call("/api/me")).status).toBe(200);
  });
});

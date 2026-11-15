import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { addAuthenticator, d1, expectNoAxeViolations, linkIn, loadCredential, OWNER, sinkEmails } from "./fixtures";

/**
 * Invitations, email and magic links end to end (Identity §4.2–§4.4; PLAN M1 exit criteria): invite
 * by copy link with no email configured (accepting registers a passkey), an expired invitation
 * refused, invite by email through the test email sink, and a magic link through the confirmation
 * page. Passkeys are Chromium virtual authenticators with user verification on.
 *
 * Runs after the passkeys project, so the owner already has the second passkey the invite gate asks
 * for. Each sign-in re-adds the owner's credential with a higher counter than any earlier one.
 */
test.describe.configure({ mode: "serial", timeout: 240_000 });

let ownerContext: BrowserContext;
let owner: Page;

/**
 * Every e2e browser shares one IP, and passkey ceremonies are limited to 20 a minute per IP (Platform
 * §8); the earlier projects use most of a minute's allowance. When a ceremony is refused as too many,
 * wait out the window and try again.
 */
async function limitedStep(page: Page, act: () => Promise<unknown>, done: ReturnType<Page["getByRole"]>) {
  const limited = page.getByText(/Too many (sign-in )?attempts|happening too often/);
  for (let attempt = 0; attempt < 3; attempt++) {
    await act();
    await expect(done.or(limited).first()).toBeVisible({ timeout: 15_000 });
    if (await done.isVisible()) return;
    await page.waitForTimeout(61_000);
  }
  await expect(done).toBeVisible();
}

/** Invitation lookup and acceptance share a 5-a-minute per-IP limit (Platform §8), as above. */
function passkeyStep(page: Page, button: string, done: ReturnType<Page["getByRole"]>) {
  return limitedStep(page, () => page.getByRole("button", { name: button }).click(), done);
}

async function signInOwner(browser: Browser) {
  ownerContext = await browser.newContext();
  owner = await ownerContext.newPage();
  await owner.emulateMedia({ reducedMotion: "reduce" });
  const authenticator = await addAuthenticator(ownerContext, owner);
  const saved = loadCredential();
  await authenticator.add({ ...saved, signCount: saved.signCount + 5000 });
  await owner.goto("/sign-in");
  await passkeyStep(owner, "Sign in with a passkey", owner.getByRole("heading", { level: 1, name: "Home" }));
}

async function invite(email: string, { sendEmail = false } = {}): Promise<string> {
  await owner.goto("/admin/invitations");
  await expect(owner.getByRole("heading", { level: 1, name: "Invitations" })).toBeVisible();
  await owner.getByRole("button", { name: "Invite someone" }).click();
  const dialog = owner.getByRole("dialog", { name: "Invite someone" });
  await dialog.getByLabel("Email", { exact: true }).fill(email);
  if (sendEmail) await expect(dialog.getByLabel("Also send the invitation by email")).toBeChecked();
  await dialog.getByRole("button", { name: "Create invitation" }).click();
  const linkDialog = owner.getByRole("dialog", { name: "Invitation link" });
  await expect(linkDialog).toBeVisible();
  const link = await linkDialog.getByLabel("Link to share").inputValue();
  await linkDialog.getByRole("button", { name: "Done" }).click();
  return link;
}

/** Opens an invitation as the invitee on a new browser, accepts it and registers a passkey. */
async function acceptAsNewPerson(browser: Browser, link: string, email: string, name: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.emulateMedia({ reducedMotion: "reduce" });
  const authenticator = await addAuthenticator(context, page);
  await limitedStep(page, () => page.goto(link), page.getByText(email, { exact: true }));
  await expect(page.getByRole("heading", { level: 1, name: "Join the workspace" })).toBeVisible();
  // The invited email is shown prominently, and the token is gone from the address bar.
  await expect(page.getByText(email, { exact: true })).toBeVisible();
  expect(page.url()).not.toContain("#");
  await expectNoAxeViolations(page);
  await page.getByLabel("Your name").fill(name);
  await passkeyStep(page, "Accept and continue", page.getByRole("heading", { level: 1, name: "Create your passkey" }));
  await expectNoAxeViolations(page);
  // The enrolment ticket is HttpOnly and never visible to scripts.
  expect(await page.evaluate(() => document.cookie)).toBe("");
  await passkeyStep(page, "Create passkey", page.getByRole("heading", { level: 1, name: "Home" }));
  expect(await authenticator.credentials()).toHaveLength(1);
  expect((await context.cookies()).some((c) => c.name === "__Host-officebox.session_token")).toBe(true);
  return { context, page };
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);
  await signInOwner(browser);
});

test.afterAll(async () => {
  await ownerContext.close();
});

test("invite by copy link with no email configured: accepting registers a passkey and signs in", async ({
  browser,
}) => {
  await owner.goto("/admin");
  await owner.getByRole("navigation", { name: "Admin sections" }).getByRole("link", { name: "Invitations" }).click();
  await expect(owner.getByRole("heading", { level: 1, name: "Invitations" })).toBeVisible();
  await expectNoAxeViolations(owner);
  await owner.getByRole("button", { name: "Invite someone" }).click();
  const dialog = owner.getByRole("dialog", { name: "Invite someone" });
  await expect(dialog.getByText("Email isn't set up, so you'll share the link yourself.")).toBeVisible();
  await expectNoAxeViolations(owner);
  await owner.keyboard.press("Escape");

  const link = await invite("ana@example.com");
  const url = new URL(link);
  expect(url.pathname).toBe("/invitations/accept");
  expect(url.search).toBe("");
  expect(url.hash).toMatch(/^#t=[A-Za-z0-9_-]{43}$/);
  const row = owner.getByRole("row", { name: /ana@example\.com/ });
  await expect(row).toContainText("Pending");
  await expectNoAxeViolations(owner);

  // The fragment page is served with no-referrer and no-store, and a GET of it uses nothing.
  const page = await owner.request.get("/invitations/accept");
  expect(page.headers()["referrer-policy"]).toBe("no-referrer");
  expect(page.headers()["cache-control"]).toBe("no-store");

  const { context } = await acceptAsNewPerson(browser, link, "ana@example.com", "Ana Diaz");
  await context.close();

  // Accepted: gone from the pending list, and the link doesn't work again.
  await owner.reload();
  await expect(owner.getByRole("row", { name: /ana@example\.com/ })).toHaveCount(0);
  const again = await browser.newContext();
  const againPage = await again.newPage();
  await limitedStep(againPage, () => againPage.goto(link), againPage.getByText(/isn't valid any more/));
  await again.close();
});

test("an expired invitation is refused", async ({ browser }) => {
  const link = await invite("bob@example.com");
  d1("UPDATE invitations SET expires_at = 0 WHERE email = 'bob@example.com'");
  const context = await browser.newContext();
  const page = await context.newPage();
  await limitedStep(
    page,
    () => page.goto(link),
    page.getByText("This invitation has expired. Ask whoever invited you for a new one."),
  );
  await expect(page.getByLabel("Your name")).toHaveCount(0);
  await expectNoAxeViolations(page);
  await context.close();
});

test("the owner sets up email and sends a test email; an invitation by email works end to end", async ({ browser }) => {
  await owner.goto("/admin/settings");
  await expect(owner.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
  await expect(owner.getByText("Email is off.")).toBeVisible();
  await expectNoAxeViolations(owner);
  await owner.getByLabel("Email service").selectOption("cloudflare");
  await owner.getByLabel("Sender address").fill("no-reply@example.com");
  await owner.getByRole("button", { name: "Save email settings" }).click();
  await expect(owner.getByText("Email is on (Cloudflare Email Service).")).toBeVisible();
  await owner.getByRole("button", { name: "Send test email" }).click();
  await expect(owner.getByText(`A test email is on its way to ${OWNER.email}.`)).toBeVisible();
  await expect.poll(() => sinkEmails(OWNER.email).length, { timeout: 30_000 }).toBeGreaterThan(0);
  expect(sinkEmails(OWNER.email)[0]!.subject).toBe(`Test email from ${OWNER.workspace}`);
  await expectNoAxeViolations(owner);

  await invite("carol@example.com", { sendEmail: true });
  await expect.poll(() => sinkEmails("carol@example.com").length, { timeout: 30_000 }).toBe(1);
  const email = sinkEmails("carol@example.com")[0]!;
  expect(email.subject).toBe(`You're invited to ${OWNER.workspace}`);
  const link = linkIn(email);
  expect(new URL(link).pathname).toBe("/invitations/accept");
  const { context } = await acceptAsNewPerson(browser, link, "carol@example.com", "Carol King");
  await context.close();
});

test("a member signs in with a magic link through the confirmation page; owners get no link", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/sign-in");
  const section = page.getByRole("region", { name: "Email me a sign-in link" });
  await expect(section).toBeVisible();
  await expectNoAxeViolations(page);

  // An owner asks: the same answer, and no email.
  await section.getByLabel("Email").fill(OWNER.email);
  await section.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByText(`If ${OWNER.email} belongs to a member`)).toBeVisible();

  // The member asks.
  await page.goto("/sign-in");
  await page.getByRole("region", { name: "Email me a sign-in link" }).getByLabel("Email").fill("carol@example.com");
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByText("If carol@example.com belongs to a member")).toBeVisible();
  await expect
    .poll(() => sinkEmails("carol@example.com").filter((m) => m.subject.startsWith("Sign in to")).length, {
      timeout: 30_000,
    })
    .toBe(1);
  const message = sinkEmails("carol@example.com").find((m) => m.subject.startsWith("Sign in to"))!;
  expect(message.text).not.toContain("magic-link/verify");
  // The owner's request (made first) produced no sign-in link.
  expect(sinkEmails(OWNER.email).filter((m) => m.subject.startsWith("Sign in to"))).toHaveLength(0);

  const link = linkIn(message);
  expect(new URL(link).pathname).toBe("/sign-in/link");
  const headers = (await page.request.get("/sign-in/link")).headers();
  expect(headers["referrer-policy"]).toBe("no-referrer");
  expect(headers["cache-control"]).toBe("no-store");

  // Opening the link shows who'll be signed in and changes nothing; Continue signs in.
  await page.goto(link);
  await expect(page.getByRole("heading", { level: 1, name: "Sign in with your email link" })).toBeVisible();
  await expect(page.getByText("carol@example.com", { exact: true })).toBeVisible();
  expect(page.url()).not.toContain("#");
  await expectNoAxeViolations(page);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();
  expect(await page.evaluate(() => document.cookie)).toBe("");
  // A sign-in from a device this member hasn't used raises a security notice.
  await expect(page.getByRole("region", { name: "Security notices" })).toContainText("from a new device");
  await expect
    .poll(() => sinkEmails("carol@example.com").filter((m) => m.subject.startsWith("Security notice")).length, {
      timeout: 30_000,
    })
    .toBe(1);

  // The link works once.
  const second = await browser.newContext();
  const secondPage = await second.newPage();
  await secondPage.goto(link);
  await expect(secondPage.getByText(/This sign-in link isn't valid any more/)).toBeVisible();
  await second.close();
  await context.close();
});

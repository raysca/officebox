import { expect, test } from "@playwright/test";
import {
  addAuthenticator,
  E2E_SECRETS,
  expectNoAxeViolations,
  OWNER,
  OWNER_STATE,
  saveCredential,
  signInWithPasskey,
} from "./fixtures";

/**
 * First-run setup with the setup token and the owner's passkey, then sign out and sign in with that
 * passkey (Identity §4.1, §4.4; PLAN M1 exit criteria "setup with a token (registering a passkey)" and
 * "sign in with a passkey"). Runs once, before every other test, on a fresh installation, with a
 * Chromium virtual authenticator that verifies the user. It saves the owner's session for the shell
 * tests and the passkey's credential for the passkey tests.
 */
test("a fresh deploy is set up with the token and a passkey, and the owner signs in with it", async ({
  page,
  context,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const authenticator = await addAuthenticator(context, page);

  // Every route leads to setup until it's done.
  await page.goto("/chat");
  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByRole("heading", { level: 1, name: "Set up your workspace" })).toBeVisible();
  await expect(page).toHaveTitle("Set up your workspace · Officebox");
  await expectNoAxeViolations(page);

  // Problems are shown before anything is sent.
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page.getByLabel("Setup token")).toBeFocused();
  await expect(page.getByLabel("Setup token")).toHaveAttribute("aria-invalid", "true");

  // A wrong token is refused.
  await page.getByLabel("Setup token").fill("not-the-token-at-all-0123456789abcdef");
  await page.getByLabel("Workspace name").fill(OWNER.workspace);
  await page.getByLabel("Your name").fill(OWNER.name);
  await expect(page.getByLabel("Handle")).toHaveValue(OWNER.handle);
  await page.getByLabel("Email").fill(OWNER.email);
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page.getByText("This setup token isn't valid. Check it and try again.")).toBeVisible();
  await expectNoAxeViolations(page);

  // The claim, then the owner's passkey.
  await page.getByLabel("Setup token").fill(E2E_SECRETS.SETUP_TOKEN);
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Add your passkey" })).toBeVisible();
  await expect(page.getByText(OWNER.email)).toBeVisible();
  await expectNoAxeViolations(page);
  // The enrolment ticket is HttpOnly and never visible to scripts.
  expect(await page.evaluate(() => document.cookie)).toBe("");
  await page.getByRole("button", { name: "Create passkey" }).click();

  // Setup recommends a second passkey.
  await expect(page.getByRole("heading", { level: 1, name: "Add a second passkey" })).toBeVisible();
  await expectNoAxeViolations(page);
  await page.getByRole("button", { name: "Not now" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();
  await expect(page.getByRole("banner")).toContainText(OWNER.workspace);
  expect(await authenticator.credentials()).toHaveLength(1);

  // Setup can't be claimed again.
  expect((await page.request.get("/api/setup")).status()).toBe(404);

  // The session cookie is __Host-, HttpOnly, Secure and SameSite=Lax, and invisible to scripts.
  expect(await page.evaluate(() => document.cookie)).toBe("");
  const session = (await context.cookies()).find((c) => c.name === "__Host-officebox.session_token");
  expect(session).toMatchObject({ httpOnly: true, secure: true, sameSite: "Lax", path: "/" });

  // Sign out, then sign in with the passkey.
  await page.getByRole("button", { name: "Account" }).click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/sign-in/);
  await expect(page.getByText("You've been signed out.")).toBeVisible();
  await expectNoAxeViolations(page);
  await page.goto("/calendar");
  await expect(page).toHaveURL(/\/sign-in\?redirect=%2Fcalendar/);
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Calendar" })).toBeVisible();
  await signInWithPasskey(page);

  const [credential] = await authenticator.credentials();
  if (!credential) throw new Error("no credential");
  saveCredential(credential);
  await context.storageState({ path: OWNER_STATE });
});

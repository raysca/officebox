import { expect, test } from "@playwright/test";
import {
  addAuthenticator,
  d1,
  expectNoAxeViolations,
  loadCredential,
  OWNER,
  OWNER_STATE,
  signInWithPasskey,
} from "./fixtures";

/**
 * Passkeys and sessions end to end, with Chromium virtual authenticators (Identity §4.4, §4.5; PLAN M1
 * exit criteria). Runs last (the "passkeys" project): the main flow ends by signing every session out.
 *
 * Each test re-adds the owner's saved credential with a higher signature counter than any earlier
 * test used, so a later test never presents a counter the server has already seen (which would be a
 * clone).
 */
test.describe.configure({ mode: "serial" });

test("sign in with a passkey, add a second one with step-up, My devices, sign out everywhere", async ({ browser }) => {
  // The owner's session from setup stands in for another device.
  const otherDevice = await browser.newContext({ storageState: OWNER_STATE });
  const otherPage = await otherDevice.newPage();
  await otherPage.goto("/");
  await expect(otherPage.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();

  const context = await browser.newContext();
  const page = await context.newPage();
  await page.emulateMedia({ reducedMotion: "reduce" });
  const authenticator = await addAuthenticator(context, page);
  const saved = loadCredential();
  await authenticator.add({ ...saved, signCount: saved.signCount + 1000 });
  await signInWithPasskey(page);

  // Passkeys: the owner has one, made at setup, and is reminded to add another.
  await page.getByRole("button", { name: "Account" }).click();
  await page.getByRole("link", { name: "Passkeys" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Passkeys" })).toBeFocused();
  const list = page.getByRole("region", { name: "Your passkeys" });
  await expect(list.getByRole("listitem")).toHaveCount(1);
  await expect(list.getByText("Created during setup")).toBeVisible();
  await expect(page.getByText(/You have one passkey/)).toBeVisible();
  await expectNoAxeViolations(page);

  // Age this session's passkey assertion past 10 minutes, so adding a passkey needs step-up.
  d1("UPDATE sessions SET fresh_auth_at = 0");
  // The new passkey stands for one on another device: once step-up has passed (the options request
  // succeeds), the existing credential leaves this virtual authenticator, so the browser doesn't
  // refuse the registration as a duplicate (excludeCredentials). It comes back afterwards.
  await page.route("**/api/auth/passkey/generate-register-options", async (route) => {
    const response = await route.fetch();
    if (response.ok()) await authenticator.remove(saved.credentialId);
    await route.fulfill({ response });
  });
  await page.getByRole("button", { name: "Add a passkey" }).click();
  const prompt = page.getByRole("dialog", { name: "Confirm it's you" });
  await expect(prompt).toBeVisible();
  await expectNoAxeViolations(page);
  await prompt.getByRole("button", { name: "Use passkey" }).click();
  await expect(page.getByText("Passkey added.")).toBeVisible();
  await expect(list.getByRole("listitem")).toHaveCount(2);
  await expect(list.getByText("Added while signed in")).toBeVisible();
  await page.unrouteAll({ behavior: "ignoreErrors" });
  expect(await authenticator.credentials()).toHaveLength(1);

  // The addition raised a security notice: the banner shows until it's acknowledged.
  await page.reload();
  const banner = page.getByRole("region", { name: "Security notices" });
  await expect(banner).toContainText("was added to your account");
  await expectNoAxeViolations(page);
  await banner.getByRole("button", { name: "I've seen these" }).click();
  await expect(banner).toBeHidden();

  // My devices: this device and the other one.
  await page.getByRole("button", { name: "Account" }).click();
  await page.getByRole("link", { name: "My devices" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "My devices" })).toBeFocused();
  const devices = page.getByRole("region", { name: "Signed-in devices" });
  await expect(devices.getByText("This device")).toHaveCount(1);
  expect(await devices.getByRole("listitem").count()).toBeGreaterThanOrEqual(2);
  await expect(devices.getByRole("listitem").first()).toContainText("Chrome on");
  await expectNoAxeViolations(page);

  // Sign out everywhere.
  await page.getByRole("button", { name: "Sign out everywhere" }).click();
  const dialog = page.getByRole("dialog", { name: "Sign out everywhere" });
  await expect(dialog).toBeVisible();
  await expectNoAxeViolations(page);
  await dialog.getByRole("button", { name: "Sign out everywhere" }).click();
  await expect(page).toHaveURL(/\/sign-in/);
  await expect(page.getByText("You've been signed out.")).toBeVisible();

  // The other device is signed out too, on its next request.
  await otherPage.goto("/documents");
  await expect(otherPage).toHaveURL(/\/sign-in/);

  await context.close();
  await otherDevice.close();
});

test("a passkey that doesn't verify the user is refused (user verification required)", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  // A security key with no PIN or biometric, holding the owner's credential.
  const key = await addAuthenticator(context, page, { userVerified: false, transport: "usb" });
  const saved = loadCredential();
  await key.add({ ...saved, signCount: saved.signCount + 2000 });
  // The browser would refuse a "required" request outright; lower it client-side to test the server.
  // The key can only answer for a named credential without UV, so name it (base64url).
  const id = saved.credentialId.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  await page.route("**/api/auth/passkey/generate-authenticate-options", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as Record<string, unknown>;
    await route.fulfill({
      response,
      json: { ...body, userVerification: "discouraged", allowCredentials: [{ id, type: "public-key" }] },
    });
  });
  await page.goto("/sign-in");
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expect(page.getByText(/must check it's you/)).toBeVisible();
  expect((await context.cookies()).some((c) => c.name === "__Host-officebox.session_token")).toBe(false);
  await context.close();
});

test("a cloned passkey (a counter that went backwards) is refused, and no session is left", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const authenticator = await addAuthenticator(context, page);
  const saved = loadCredential();
  // A copy of the owner's passkey whose counter is behind the server's.
  await authenticator.add({ ...saved, signCount: 1 });
  await page.goto("/sign-in");
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expect(page.getByText(/looks like a copy/)).toBeVisible();
  await expectNoAxeViolations(page);
  expect((await context.cookies()).some((c) => c.name === "__Host-officebox.session_token")).toBe(false);

  // The genuine passkey (counter ahead) still signs in, and the owner sees the clone notice.
  await authenticator.remove(saved.credentialId);
  await authenticator.add({ ...saved, signCount: saved.signCount + 3000 });
  await signInWithPasskey(page);
  await expect(page.getByRole("region", { name: "Security notices" })).toContainText("looked like a copy");
  await expect(page.getByRole("banner")).toContainText(OWNER.workspace);
  await context.close();
});

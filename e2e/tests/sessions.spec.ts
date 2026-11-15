import { expect, test } from "@playwright/test";
import { expectNoAxeViolations, OWNER_STATE, signInThroughUi } from "./fixtures";

/**
 * Sessions end to end (Identity §4.5): My devices, sign out, and sign out everywhere. Runs last (the
 * "sessions" project), because signing out everywhere also ends the session the shell tests use.
 */
test.describe.configure({ mode: "serial" });

test("sign out from the account menu ends this session", async ({ page }) => {
  await signInThroughUi(page);
  await page.getByRole("button", { name: "Account" }).click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/sign-in/);
  await expect(page.getByText("You've been signed out.")).toBeVisible();

  // Signed out for real: the app sends us back to sign-in.
  await page.goto("/calendar");
  await expect(page).toHaveURL(/\/sign-in\?redirect=%2Fcalendar/);
});

test("My devices lists this device, and sign out everywhere ends every session", async ({ browser }) => {
  // The owner's earlier session (from setup) stands in for another device.
  const otherDevice = await browser.newContext({ storageState: OWNER_STATE });
  const otherPage = await otherDevice.newPage();
  await otherPage.goto("/");
  await expect(otherPage.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();

  const context = await browser.newContext();
  const page = await context.newPage();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await signInThroughUi(page);

  await page.getByRole("button", { name: "Account" }).click();
  await page.getByRole("link", { name: "My devices" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "My devices" })).toBeFocused();
  const list = page.getByRole("region", { name: "Signed-in devices" });
  await expect(list.getByRole("listitem")).toHaveCount(2);
  await expect(list.getByText("This device")).toHaveCount(1);
  await expect(list.getByRole("listitem").first()).toContainText("Chrome on");
  await expectNoAxeViolations(page);

  await page.getByRole("button", { name: "Sign out everywhere" }).click();
  const dialog = page.getByRole("dialog", { name: "Sign out everywhere" });
  await expect(dialog).toBeVisible();
  await expectNoAxeViolations(page);
  await dialog.getByRole("button", { name: "Sign out everywhere" }).click();
  await expect(page).toHaveURL(/\/sign-in/);
  await expect(page.getByText("You've been signed out.")).toBeVisible();

  // The other device is signed out too.
  await otherPage.goto("/documents");
  await expect(otherPage).toHaveURL(/\/sign-in/);
  await expect(otherPage.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();

  await context.close();
  await otherDevice.close();
});

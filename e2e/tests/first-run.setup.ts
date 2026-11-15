import { expect, test } from "@playwright/test";
import { E2E_SECRETS, expectNoAxeViolations, OWNER, OWNER_STATE } from "./fixtures";

/**
 * First-run setup with the setup token, then the owner's first sign-in (Identity §4.1, §4.4; PLAN M1
 * exit criterion "setup with a token"). Runs once, before every other test, on a fresh installation,
 * and saves the owner's session for the shell tests.
 */
test("a fresh deploy is set up with the token and the owner signs in", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });

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
  await expectNoAxeViolations(page);

  // A wrong token is refused.
  await page.getByLabel("Setup token").fill("not-the-token-at-all-0123456789abcdef");
  await page.getByLabel("Workspace name").fill(OWNER.workspace);
  await page.getByLabel("Your name").fill(OWNER.name);
  await expect(page.getByLabel("Handle")).toHaveValue(OWNER.handle);
  await page.getByLabel("Email").fill(OWNER.email);
  await page.getByLabel("Password").fill(OWNER.password);
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page.getByText("This setup token isn't valid. Check it and try again.")).toBeVisible();

  await page.getByLabel("Setup token").fill(E2E_SECRETS.SETUP_TOKEN);
  await page.getByRole("button", { name: "Create workspace" }).click();

  // On to sign-in, with the email filled in.
  await expect(page).toHaveURL(/\/sign-in\?/);
  await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
  await expect(page.getByLabel("Email")).toHaveValue(OWNER.email);
  await expectNoAxeViolations(page);

  // Setup can't be claimed again.
  expect((await page.request.get("/api/setup")).status()).toBe(404);

  // A wrong password, then the right one.
  await page.getByLabel("Password").fill("not the password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("The email or password is incorrect.")).toBeVisible();
  await expectNoAxeViolations(page);
  await page.getByLabel("Password").fill(OWNER.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();
  await expect(page.getByRole("banner")).toContainText(OWNER.workspace);

  // The session cookies are HttpOnly and invisible to scripts.
  expect(await page.evaluate(() => document.cookie)).toBe("");
  const cookies = await page.context().cookies();
  for (const name of ["ob_session", "ob_refresh"]) {
    const cookie = cookies.find((c) => c.name === name);
    expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: "Lax" });
  }

  await page.context().storageState({ path: OWNER_STATE });
});

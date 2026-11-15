import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const AREAS = [
  { path: "/", label: "Home" },
  { path: "/chat", label: "Chat" },
  { path: "/calendar", label: "Calendar" },
  { path: "/documents", label: "Documents" },
  { path: "/admin", label: "Admin" },
] as const;

/** WCAG 2.0, 2.1 and 2.2 at levels A and AA (PRD §18). */
const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"];

/** Page background per theme (index.css --ob-bg). */
const BACKGROUND = { light: "rgb(255, 255, 255)", dark: "rgb(15, 17, 21)" } as const;

async function expectNoAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  expect(
    results.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.map((n) => n.target.join(" ")) })),
  ).toEqual([]);
}

async function htmlBackground(page: Page): Promise<string> {
  return page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
}

/** Presses Tab until the element matched by `locator` has focus. */
async function tabTo(page: Page, locator: ReturnType<Page["locator"]>, maxPresses = 40) {
  for (let i = 0; i < maxPresses; i++) {
    await page.keyboard.press("Tab");
    if (await locator.evaluate((el) => el === document.activeElement)) return;
  }
  throw new Error(`Never reached ${locator.toString()} with Tab`);
}

test.describe("desktop shell", () => {
  test("every area can be reached with the keyboard alone", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();

    // The skip link is the first Tab stop, visible when focused, and moves focus to the content.
    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: "Skip to main content" });
    await expect(skip).toBeFocused();
    await expect(skip).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("main")).toBeFocused();

    const nav = page.getByRole("navigation", { name: "Main" });
    for (const { path, label } of [...AREAS.slice(1), AREAS[0]]) {
      const link = nav.getByRole("link", { name: label });
      await tabTo(page, link);
      await page.keyboard.press("Enter");

      await expect(page).toHaveURL(path);
      const heading = page.getByRole("heading", { level: 1, name: label });
      await expect(heading).toBeFocused();
      await expect(page).toHaveTitle(`${label} · Officebox`);
      await expect(link).toHaveAttribute("aria-current", "page");
      await expect(page.getByRole("heading", { level: 2, name: "Coming soon" })).toBeVisible();
    }
  });

  test("the theme toggle switches themes and is remembered on this device", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/");
    const theme = page.getByRole("combobox", { name: "Theme" });
    await expect(theme).toHaveValue("system");
    expect(await htmlBackground(page)).toBe(BACKGROUND.light);

    // Operate it from the keyboard.
    await tabTo(page, theme);
    await theme.selectOption("dark");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect.poll(() => htmlBackground(page)).toBe(BACKGROUND.dark);

    // Survives a reload, with no flash: the attribute is set before the app runs.
    await page.reload();
    await expect(page.getByRole("combobox", { name: "Theme" })).toHaveValue("dark");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    expect(await htmlBackground(page)).toBe(BACKGROUND.dark);

    // Back to System follows the operating system again.
    await page.getByRole("combobox", { name: "Theme" }).selectOption("system");
    await expect(page.locator("html")).not.toHaveAttribute("data-theme");
    await expect.poll(() => htmlBackground(page)).toBe(BACKGROUND.light);
    await page.emulateMedia({ colorScheme: "dark" });
    await expect.poll(() => htmlBackground(page)).toBe(BACKGROUND.dark);
  });

  test("the footer shows the /health status", async ({ page }) => {
    await page.goto("/");
    const indicator = page.getByRole("contentinfo").getByTestId("health-status");
    await expect(indicator).toHaveAttribute("data-state", "ok");
    await expect(indicator).toContainText(/\d+\.\d+\.\d+/); // the deployed version
  });

  test("the footer shows the service as down when /health fails", async ({ page }) => {
    await page.route("**/health", (route) => route.fulfill({ status: 503, body: "" }));
    await page.goto("/");
    await expect(page.getByTestId("health-status")).toHaveAttribute("data-state", "down", { timeout: 15_000 });
  });

  test("the account menu opens and closes with the keyboard", async ({ page }) => {
    await page.goto("/");
    const button = page.getByRole("button", { name: "Account" });
    await tabTo(page, button);
    await page.keyboard.press("Enter");
    await expect(button).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByText("Signed in as")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(button).toHaveAttribute("aria-expanded", "false");
    await expect(button).toBeFocused();
  });
});

test.describe("mobile shell", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the menu traps focus, closes with Escape and navigates", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();
    // The sidebar is collapsed into the menu.
    await expect(page.getByRole("navigation", { name: "Main" })).toBeHidden();

    const trigger = page.getByRole("button", { name: "Open menu" });
    await tabTo(page, trigger);
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Menu" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Close menu" })).toBeFocused();

    // Focus stays inside through more Tab presses than there are controls, in both directions.
    for (const key of ["Tab", "Shift+Tab"]) {
      for (let i = 0; i < 9; i++) {
        await page.keyboard.press(key);
        expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
      }
    }

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();

    // Follow a link from the menu.
    await page.keyboard.press("Enter");
    await dialog.getByRole("link", { name: "Chat" }).click();
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL("/chat");
    await expect(page.getByRole("heading", { level: 1, name: "Chat" })).toBeFocused();
  });

  for (const colorScheme of ["light", "dark"] as const) {
    test(`axe: the open menu has no WCAG 2.2 AA violations (${colorScheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
      await page.goto("/");
      await page.getByRole("button", { name: "Open menu" }).click();
      await expect(page.getByRole("dialog", { name: "Menu" })).toBeVisible();
      await expectNoAxeViolations(page);
    });
  }
});

test.describe("axe: WCAG 2.2 AA", () => {
  for (const colorScheme of ["light", "dark"] as const) {
    for (const { path, label } of [...AREAS, { path: "/no/such/page", label: "Page not found" }]) {
      test(`${label} (${path}) in the ${colorScheme} theme`, async ({ page }) => {
        await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
        await page.goto(path);
        await expect(page.getByRole("heading", { level: 1, name: label })).toBeVisible();
        await expect(page.getByTestId("health-status")).toHaveAttribute("data-state", "ok");
        expect(await htmlBackground(page)).toBe(BACKGROUND[colorScheme]);
        await expectNoAxeViolations(page);
      });
    }

    test(`an explicit ${colorScheme} choice against the opposite system theme`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: colorScheme === "dark" ? "light" : "dark" });
      await page.goto("/");
      await page.getByRole("combobox", { name: "Theme" }).selectOption(colorScheme);
      await expect.poll(() => htmlBackground(page)).toBe(BACKGROUND[colorScheme]);
      await expectNoAxeViolations(page);
    });
  }
});

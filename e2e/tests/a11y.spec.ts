import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/** WCAG 2.0, 2.1 and 2.2 at levels A and AA (PRD §18). */
const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"];
const ROUTES = ["/", "/chat", "/calendar", "/documents", "/admin", "/no/such/page"];

/** TDD §8.2. The Worker sets security headers from M0b; until then the tests add the header. */
const CSP =
  "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; " +
  "img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'";

async function expectNoAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  expect(
    results.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.map((n) => n.target.join(" ")) })),
  ).toEqual([]);
}

async function hasHorizontalScroll(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
}

for (const colorScheme of ["light", "dark"] as const) {
  test.describe(`axe: interactive states (${colorScheme})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    });

    test("with the account menu open", async ({ page }) => {
      await page.goto("/");
      await page.getByRole("button", { name: "Account" }).click();
      await expect(page.getByText("Signing in arrives in a later release.")).toBeVisible();
      await expectNoAxeViolations(page);
    });

    test("with the skip link focused", async ({ page }) => {
      await page.goto("/");
      await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();
      await page.keyboard.press("Tab");
      await expect(page.getByRole("link", { name: "Skip to main content" })).toBeFocused();
      await expectNoAxeViolations(page);
    });
  });
}

/**
 * Layouts for the focus-visibility check. `textScale` doubles the root font size: every size is in
 * rem, so text, the header and scroll-padding all grow, but rem media queries don't respond to it
 * (they use the browser's initial font size), so it isn't the same as browser zoom. `640 px` is the
 * CSS viewport a 1280 px window has at 200% browser zoom, where media queries do respond.
 */
const FOCUS_LAYOUTS = [
  { name: "1280 px", width: 1280, height: 600, textScale: 1 },
  { name: "640 px (200% zoom)", width: 640, height: 400, textScale: 1 },
  { name: "320 px", width: 320, height: 640, textScale: 1 },
  { name: "320 px with 200% text", width: 320, height: 640, textScale: 2 },
] as const;

for (const layout of FOCUS_LAYOUTS) {
  test(`a focused element is never hidden under the sticky header at ${layout.name} (WCAG 2.4.11)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: layout.width, height: layout.height });
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();

    // Temporary long content: a button at the top of the content, a tall spacer, a button below.
    await page.evaluate((textScale) => {
      document.documentElement.style.fontSize = `${textScale * 100}%`;
      const main = document.querySelector("main");
      if (!main) throw new Error("no main");
      const top = Object.assign(document.createElement("button"), { textContent: "Top of content" });
      const spacer = document.createElement("div");
      spacer.style.height = "3000px";
      const bottom = Object.assign(document.createElement("button"), { textContent: "Bottom of content" });
      main.prepend(top);
      main.append(spacer, bottom);
    }, layout.textScale);

    // Focus the bottom button (the page scrolls down), then Shift+Tab back to the top one: the
    // browser scrolls it into view at the top edge, where the header would cover it without
    // scroll-padding.
    await page.getByRole("button", { name: "Bottom of content" }).focus();
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(1000);
    await page.keyboard.press("Shift+Tab");
    const top = page.getByRole("button", { name: "Top of content" });
    await expect(top).toBeFocused();

    const headerBox = await page.getByRole("banner").boundingBox();
    const topBox = await top.boundingBox();
    expect(headerBox && topBox).toBeTruthy();
    expect(topBox!.y).toBeGreaterThanOrEqual(headerBox!.y + headerBox!.height);
  });
}

test.describe("reflow at 320 CSS px (WCAG 1.4.10)", () => {
  test.use({ viewport: { width: 320, height: 640 } });

  for (const path of ROUTES) {
    test(`no horizontal scrolling on ${path}`, async ({ page }) => {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      expect(await hasHorizontalScroll(page)).toBe(false);
    });
  }

  test("header controls stay visible and usable", async ({ page }) => {
    await page.goto("/");
    for (const control of [
      page.getByRole("button", { name: "Open menu" }),
      page.getByRole("combobox", { name: "Theme" }),
      page.getByRole("button", { name: "Account" }),
    ]) {
      await expect(control).toBeInViewport({ ratio: 1 });
    }
    await page.getByRole("combobox", { name: "Theme" }).selectOption("dark");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.getByRole("button", { name: "Account" }).click();
    await expect(page.getByText("Signing in arrives in a later release.")).toBeInViewport();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Open menu" }).click();
    await expect(page.getByRole("dialog", { name: "Menu" })).toBeVisible();
    expect(await hasHorizontalScroll(page)).toBe(false);
  });
});

test("at 200% browser zoom the shell reflows without horizontal scrolling (WCAG 1.4.4)", async ({ page }) => {
  // A 1280 px window at 200% zoom has a 640 CSS px viewport, and media queries respond to it.
  await page.setViewportSize({ width: 640, height: 400 });
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeInViewport();
  expect(await hasHorizontalScroll(page)).toBe(false);
  await expect(page.getByRole("combobox", { name: "Theme" })).toBeInViewport();
  await expect(page.getByRole("button", { name: "Account" })).toBeInViewport();
});

test("text at 200% stays readable without horizontal scrolling (WCAG 1.4.4)", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  // Text-only zoom: every size is in rem, so doubling the root font size doubles all text. Its
  // limit: rem media queries ignore the root font size, so the desktop layout stays. Real browser
  // zoom is covered by the 640 px test above.
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
  });
  await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeInViewport();
  expect(await hasHorizontalScroll(page)).toBe(false);
  for (const label of ["Home", "Chat", "Calendar", "Documents", "Admin"]) {
    await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: label })).toBeVisible();
  }
  await expect(page.getByRole("combobox", { name: "Theme" })).toBeInViewport();
});

test.describe("Content-Security-Policy (TDD §8.2)", () => {
  test.beforeEach(async ({ page }) => {
    // Serve every response with the production CSP, so any inline script or style attribute the
    // shell relied on would be blocked here.
    await page.route("**/*", async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, headers: { ...response.headers(), "content-security-policy": CSP } });
    });
    await page.addInitScript(() => {
      const w = window as unknown as { __cspViolations: string[] };
      w.__cspViolations = [];
      document.addEventListener("securitypolicyviolation", (event) => {
        w.__cspViolations.push(`${event.violatedDirective}: ${event.blockedURI}`);
      });
    });
  });

  test("the shell runs with no violations, including the theme script and the menu", async ({ page }) => {
    await page.addInitScript(() => window.localStorage.setItem("officebox.theme", "dark"));
    await page.setViewportSize({ width: 390, height: 844 });
    const response = await page.goto("/");
    expect(response?.headers()["content-security-policy"]).toBe(CSP);
    await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();
    // theme-init.js ran (it's an external 'self' script).
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.getByTestId("health-status")).toHaveAttribute("data-state", "ok");

    // The drawer sets body overflow through the CSSOM, which CSP allows.
    await page.getByRole("button", { name: "Open menu" }).click();
    await page.getByRole("dialog", { name: "Menu" }).getByRole("link", { name: "Calendar" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Calendar" })).toBeFocused();

    expect(await page.evaluate(() => (window as unknown as { __cspViolations: string[] }).__cspViolations)).toEqual([]);
  });

  test("positive control: an inline script is blocked and reported", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();
    await page.evaluate(() => {
      const script = document.createElement("script");
      script.textContent = "window.__inlineRan = true;";
      document.body.append(script);
    });
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __cspViolations: string[] }).__cspViolations))
      .toEqual([expect.stringMatching(/^script-src/)]);
    expect(await page.evaluate(() => (window as unknown as { __inlineRan?: boolean }).__inlineRan)).toBeUndefined();
  });
});

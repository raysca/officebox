import { expect, test } from "@playwright/test";
import { expectNoAxeViolations, OWNER } from "./fixtures";

/**
 * M1d: editing a profile, uploading an avatar, setting a status and browsing the directory (Identity
 * §4.7, §4.10, §7 screens 6–7), with axe on each new screen. Runs as the owner from first-run setup.
 */

/** A real 1 × 1 PNG; the page crops and re-encodes it in a canvas before uploading. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

/** A directory row's accessible name starts with the person's name. */
const rowName = new RegExp(`^${OWNER.name}`);

test("edit the profile, upload a photo, set a status, then find it in the directory", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await page.getByRole("button", { name: "Account" }).click();
  await page.getByRole("link", { name: "Profile and status" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Profile and status" })).toBeVisible();
  await expect(page.getByLabel("Display name")).toHaveValue(OWNER.name);
  await expectNoAxeViolations(page);

  // Profile details, region and working hours.
  await page.getByLabel("Pronouns").fill("she/her");
  await page.getByLabel("Job title").fill("Head of Studio");
  await page.getByLabel("Team").fill("Studio");
  await page.getByLabel("Country or region").selectOption("GB");
  await page.getByLabel("State, province or nation").fill("ENG");
  await page.getByRole("checkbox", { name: "Working on Saturday" }).check();
  await page.getByLabel("Saturday start").fill("10:00");
  await page.getByLabel("Saturday end").fill("12:00");
  await page.getByRole("button", { name: "Save profile" }).click();
  await expect(page.getByText("Profile saved.")).toBeVisible();

  await page.reload();
  await expect(page.getByLabel("Job title")).toHaveValue("Head of Studio");
  await expect(page.getByLabel("Country or region")).toHaveValue("GB");
  await expect(page.getByRole("checkbox", { name: "Working on Saturday" })).toBeChecked();

  // A handle that's reserved is refused before saving.
  const handle = page.getByLabel("Handle");
  await handle.fill("everyone");
  await page.getByRole("button", { name: "Save profile" }).click();
  await expect(handle).toHaveAttribute("aria-invalid", "true");
  await expect(handle).toBeFocused();
  await handle.fill(OWNER.handle);

  // Photo: cropped and uploaded, then served from our origin under the file CSP.
  await page.getByLabel("Upload a photo").setInputFiles({ name: "me.png", mimeType: "image/png", buffer: PNG });
  await expect(page.getByText("Photo updated.")).toBeVisible();
  const photo = page.locator('img[src^="/api/members/"]').first();
  await expect(photo).toBeVisible();
  await expect.poll(() => photo.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  await expect(page.getByRole("button", { name: "Remove photo" })).toBeVisible();

  // Status with an emoji and an expiry.
  await page.getByLabel("Emoji").fill("🌴");
  await page.getByLabel("What's your status?").fill("Planning the offsite");
  await page.getByLabel("Clear after").selectOption("4h");
  await page.getByRole("button", { name: "Set status" }).click();
  await expect(page.getByText("Status updated.")).toBeVisible();
  await expect(page.getByTestId("current-status")).toContainText("🌴 Planning the offsite");
  await expectNoAxeViolations(page);

  // The directory: search, the profile card, and the Deactivated filter.
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Directory" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Directory" })).toBeFocused();
  await expect(page.getByRole("button", { name: rowName })).toBeVisible();
  await expectNoAxeViolations(page);

  await page.getByLabel("Search people").fill("head of studio");
  const row = page.getByRole("button", { name: rowName });
  await expect(row).toContainText("Planning the offsite");
  await expect(page.getByRole("status").filter({ hasText: "1 person." })).toBeVisible();
  await page.getByLabel("Search people").fill("nobody-matches-this");
  await expect(page.getByText("Nobody matches that search.")).toBeVisible();
  await page.getByLabel("Search people").fill(`@${OWNER.handle}`);
  await row.click();

  const card = page.getByRole("dialog", { name: OWNER.name });
  await expect(card).toBeVisible();
  await expect(card).toContainText("she/her");
  await expect(card).toContainText("Head of Studio · Studio");
  await expect(card).toContainText("Mon–Fri 09:00–17:00 · Sat 10:00–12:00");
  await expect(card).toContainText("United Kingdom (ENG)");
  await expect(card.getByRole("link", { name: OWNER.email })).toHaveAttribute("href", `mailto:${OWNER.email}`);
  await expectNoAxeViolations(page);
  await page.keyboard.press("Escape");
  await expect(card).toBeHidden();
  await expect(row).toBeFocused();

  await page.getByLabel("Search people").fill("");
  await page.getByRole("button", { name: "Deactivated" }).click();
  await expect(page.getByRole("button", { name: "Deactivated" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: rowName })).toBeHidden();

  // Leave the shared owner as later stages expect: no status, no photo.
  const origin = new URL(page.url()).origin;
  const headers = { "X-Officebox-Request": "1", Origin: origin };
  expect((await page.request.delete("/api/me/status", { headers })).ok()).toBe(true);
  expect((await page.request.delete("/api/me/avatar", { headers })).ok()).toBe(true);
});

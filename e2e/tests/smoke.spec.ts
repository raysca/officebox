import { healthResponseSchema } from "@officebox/shared";
import { expect, test } from "@playwright/test";

test("the placeholder page loads", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle("Officebox");
  await expect(page.getByRole("heading", { level: 1, name: "Officebox" })).toBeVisible();
});

test("client-side routes fall back to the web app", async ({ page }) => {
  await page.goto("/some/client/route");
  await expect(page.getByRole("heading", { level: 1, name: "Officebox" })).toBeVisible();
});

test("/health responds ok, even as a browser navigation", async ({ page, request }) => {
  const res = await request.get("/health");
  expect(res.status()).toBe(200);
  expect(healthResponseSchema.parse(await res.json()).status).toBe("ok");

  // A navigation must reach the Worker, not the SPA fallback.
  const nav = await page.goto("/health");
  expect(nav?.headers()["content-type"]).toContain("application/json");
});

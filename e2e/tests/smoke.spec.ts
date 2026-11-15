import { apiErrorBodySchema, healthResponseSchema } from "@officebox/shared";
import { expect, test } from "@playwright/test";

test("the app shell loads", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle("Home · Officebox");
  await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();
  await expect(page.getByRole("banner")).toContainText("Officebox");
});

test("client-side routes fall back to the web app", async ({ page }) => {
  // An unknown path is served index.html by the SPA fallback; the router shows its not-found page.
  await page.goto("/some/client/route");
  await expect(page.getByRole("heading", { level: 1, name: "Page not found" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
});

test("/health responds ok, even as a browser navigation", async ({ page, request }) => {
  const res = await request.get("/health");
  expect(res.status()).toBe(200);
  expect(healthResponseSchema.parse(await res.json()).status).toBe("ok");

  // A navigation must reach the Worker, not the SPA fallback.
  const nav = await page.goto("/health");
  expect(nav?.headers()["content-type"]).toContain("application/json");
});

test("unknown /api paths return a 404 JSON error, even as a browser navigation", async ({ page, request }) => {
  const res = await request.get("/api/nope");
  expect(res.status()).toBe(404);
  expect(apiErrorBodySchema.parse(await res.json()).error.code).toBe("not_found");

  // A navigation must reach the Worker (run_worker_first), not the SPA fallback's index.html.
  const nav = await page.goto("/api/nope");
  expect(nav?.status()).toBe(404);
  expect(nav?.headers()["content-type"]).toContain("application/json");
  expect(apiErrorBodySchema.parse(await nav?.json()).error.code).toBe("not_found");
});

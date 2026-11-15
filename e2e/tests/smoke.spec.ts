import {
  API_CONTENT_SECURITY_POLICY,
  apiErrorBodySchema,
  APP_CONTENT_SECURITY_POLICY,
  COMMON_SECURITY_HEADERS,
  healthResponseSchema,
} from "@officebox/shared";
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

test("security headers are set on the app and the API, and the page has no CSP violations", async ({
  page,
  request,
}) => {
  // Collect CSP violations from the first script onwards. (Plain script text: this package has no DOM types.)
  await page.addInitScript({
    content:
      "window.cspViolations = []; document.addEventListener('securitypolicyviolation', (e) => window.cspViolations.push(e.violatedDirective));",
  });
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  const res = await page.goto("/");
  const headers = res?.headers() ?? {};
  // Served by Workers Assets from apps/web/public/_headers; must match the shared source of truth.
  expect(headers["content-security-policy"]).toBe(APP_CONTENT_SECURITY_POLICY);
  for (const [name, value] of Object.entries(COMMON_SECURITY_HEADERS)) expect(headers[name.toLowerCase()]).toBe(value);
  await expect(page.getByRole("heading", { level: 1, name: "Officebox" })).toBeVisible();
  expect(await page.evaluate("window.cspViolations")).toEqual([]);
  expect(consoleErrors.filter((text) => /Content Security Policy/i.test(text))).toEqual([]);

  const api = await request.get("/api/nope");
  expect(api.headers()["content-security-policy"]).toBe(API_CONTENT_SECURITY_POLICY);
});

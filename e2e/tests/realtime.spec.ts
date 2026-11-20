import { expect, test } from "@playwright/test";
import { addAuthenticator, expectNoAxeViolations, loadCredential, saveCredential, signInWithPasskey } from "./fixtures";

test.describe("realtime backbone (M2a)", () => {
  test("shows live availability, toggles manual DND across tabs, and passes axe", async ({ context, page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();

    const accountBtn = page.getByRole("button", { name: "Account" });
    await accountBtn.click();
    const status = page.getByTestId("user-availability-status");
    await expect(status).toContainText("Online");
    await expectNoAxeViolations(page);

    // Open a second tab in the same browser context (shares the hub socket over BroadcastChannel).
    const tab2 = await context.newPage();
    await tab2.goto("/");
    await expect(tab2.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();

    // Enable Do Not Disturb on tab 1.
    try {
      await page.getByRole("button", { name: "Pause notifications for 1 hour" }).click();
      await expect(status).toContainText("Do Not Disturb");

      // Tab 2 receives the live `status.changed` update without reloading.
      await tab2.getByRole("button", { name: "Account" }).click();
      await expect(tab2.getByTestId("user-availability-status")).toContainText("Do Not Disturb");

      // Clear Do Not Disturb from tab 2 and verify tab 1 returns to Online.
      await tab2.getByRole("button", { name: "Resume notifications" }).click();
      await expect(tab2.getByTestId("user-availability-status")).toContainText("Online");
      await expect(status).toContainText("Online");
    } finally {
      const res = await page.request.put("/api/me/dnd", {
        headers: {
          "X-Officebox-Request": "1",
          Origin: new URL(page.url()).origin,
        },
        data: { until: null },
      });
      expect(res.ok()).toBe(true);
      await tab2.close();
    }
  });

  test("shares one hub socket across tabs and hands over when the leader closes", async ({ context }) => {
    const tab1 = await context.newPage();
    const tab2 = await context.newPage();

    const tab1HubUrls: string[] = [];
    const tab2HubUrls: string[] = [];
    tab1.on("websocket", (ws) => {
      if (ws.url().includes("/api/ws/hub")) tab1HubUrls.push(ws.url());
    });
    tab2.on("websocket", (ws) => {
      if (ws.url().includes("/api/ws/hub")) tab2HubUrls.push(ws.url());
    });

    await tab1.goto("/");
    await expect(tab1.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();
    await expect.poll(() => tab1HubUrls.length).toBe(1);

    // Second tab joins as follower and does not open its own hub socket while tab1 leads.
    await tab2.goto("/");
    await expect(tab2.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();
    await tab2.waitForTimeout(300);
    expect(tab2HubUrls.length).toBe(0);

    // Closing the leading tab triggers BroadcastChannel hand-over to tab2.
    await tab1.close();
    await expect.poll(() => tab2HubUrls.length, { timeout: 5_000 }).toBe(1);

    await tab2.close();
  });

  test("revoking another device's session closes its hub socket and redirects it to sign-in", async ({
    browser,
    page,
  }) => {
    // Sign in as the owner on a second device (fresh browser context with no cookies).
    const device2Context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const device2Page = await device2Context.newPage();
    const auth = await addAuthenticator(device2Context, device2Page);
    const saved = loadCredential();
    const nextCred = { ...saved, signCount: saved.signCount + 10 };
    await auth.add(nextCred);
    saveCredential(nextCred);
    await signInWithPasskey(device2Page);

    // Ensure device 2 has an active hub WebSocket connection.
    await device2Page.getByRole("button", { name: "Account" }).click();
    await expect(device2Page.getByTestId("user-availability-status")).toContainText("Online");

    // On device 1, open My devices and revoke device 2's session.
    await page.goto("/settings/devices");
    await expect(page.getByRole("heading", { level: 1, name: "My devices" })).toBeVisible();
    const signOutOther = page.getByRole("button", { name: "Sign out" }).first();
    await expect(signOutOther).toBeVisible();
    await signOutOther.click();

    // Device 2's hub socket closes with 4401 and redirects to /sign-in?reason=expired within 5 seconds.
    await expect(device2Page).toHaveURL(/\/sign-in\?reason=expired/, { timeout: 5_000 });
    await device2Context.close();
  });
});

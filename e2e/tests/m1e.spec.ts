import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { addAuthenticator, expectNoAxeViolations } from "./fixtures";
import { startOwnDeploy, type OwnDeploy } from "./own-deploy";

/**
 * M1e end to end (PLAN M1 exit criteria "disable user"; Identity §4.9, §4.11, §9 "Groups", "Admin powers",
 * "Promotion", "Step-up"): groups admin (create, add, appoint a manager, the manager adds someone,
 * the directory's group filter) and members admin (change a role with step-up, deactivate, delete),
 * with axe on the new pages and dialogs. A fresh deploy of its own (set up in the open claim window,
 * `RECOVERY_TOKEN` set so the owner meets the invite gate with one passkey), so nothing here depends on
 * the shared installation's state.
 */

const RECOVERY_TOKEN = "e2e-m1e-recovery-token-0123456789abcdefghij";
const OWNER = { workspace: "Groups Co", name: "Robin Park", email: "robin@example.com" };
const ANA = { name: "Ana Diaz", email: "ana@example.com" };
const BEN = { name: "Ben Ortiz", email: "ben@example.com" };

let deploy: OwnDeploy;
let owner: { context: BrowserContext; page: Page };
let ana: { context: BrowserContext; page: Page };
let groupUrl = "";

test.describe.configure({ mode: "serial", timeout: 240_000 });

test.beforeAll(async () => {
  test.setTimeout(180_000);
  deploy = await startOwnDeploy({ name: "m1e", slot: 7, vars: { RECOVERY_TOKEN } });
});
test.afterAll(async () => {
  await deploy.stop();
});

async function newPerson(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await addAuthenticator(context, page);
  return { context, page };
}

async function inviteAndJoin(browser: Browser, person: { name: string; email: string }) {
  const page = owner.page;
  await page.goto(`${deploy.origin}/admin/invitations`);
  await page.getByRole("button", { name: "Invite someone" }).click();
  const dialog = page.getByRole("dialog", { name: "Invite someone" });
  await dialog.getByLabel("Email", { exact: true }).fill(person.email);
  await dialog.getByRole("button", { name: "Create invitation" }).click();
  const linkDialog = page.getByRole("dialog", { name: "Invitation link" });
  const link = await linkDialog.getByLabel("Link to share").inputValue();
  await linkDialog.getByRole("button", { name: "Done" }).click();

  const joined = await newPerson(browser);
  await joined.page.goto(link);
  await joined.page.getByLabel("Your name").fill(person.name);
  await joined.page.getByRole("button", { name: "Accept and continue" }).click();
  await joined.page.getByRole("button", { name: "Create passkey" }).click();
  await expect(joined.page.getByRole("heading", { level: 1, name: "Profile and status" })).toBeVisible({
    timeout: 15_000,
  });
  await joined.page.getByRole("link", { name: "Skip for now" }).click();
  await expect(joined.page.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();
  return joined;
}

test("set up and invite two members (the starting point)", async ({ browser }) => {
  owner = await newPerson(browser);
  const page = owner.page;
  await page.goto(`${deploy.origin}/setup`);
  await page.getByLabel("Workspace name").fill(OWNER.workspace);
  await page.getByLabel("Your name").fill(OWNER.name);
  await page.getByLabel("Email").fill(OWNER.email);
  await page.getByRole("button", { name: "Create workspace" }).click();
  await page.getByRole("button", { name: "Create passkey" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Add a second passkey" })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Not now" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();

  ana = await inviteAndJoin(browser, ANA);
  const ben = await inviteAndJoin(browser, BEN);
  await ben.context.close();
});

test("groups: an admin creates a group and appoints a manager, who adds someone; the directory filters by it", async () => {
  const page = owner.page;
  await page.goto(`${deploy.origin}/admin`);
  await page.getByRole("navigation", { name: "Admin sections" }).getByRole("link", { name: "Groups" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Groups" })).toBeVisible();
  await expect(page.getByText("There are no groups yet.")).toBeVisible();
  await page.getByRole("button", { name: "Create a group" }).click();
  const dialog = page.getByRole("dialog", { name: "Create a group" });
  await dialog.getByLabel("Name").fill("Design");
  await dialog.getByLabel("@handle").fill("design");
  await expectNoAxeViolations(page);
  await dialog.getByRole("button", { name: "Create a group" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Design" })).toBeVisible();
  groupUrl = page.url();

  await page.getByLabel("Find someone").fill("Ana");
  await page.getByRole("button", { name: `Add ${ANA.name} to the group` }).click();
  await expect(page.getByText(`${ANA.name} was added.`)).toBeVisible();
  await page.getByRole("button", { name: `Make manager: ${ANA.name}` }).click();
  await expect(page.getByRole("button", { name: `Remove as manager: ${ANA.name}` })).toBeVisible();
  await expectNoAxeViolations(page);

  // Ana, a group manager (not an admin), adds Ben to her group, and can't edit or delete it.
  await ana.page.goto(groupUrl);
  await expect(ana.page.getByRole("heading", { level: 1, name: "Design" })).toBeVisible();
  await expect(ana.page.getByRole("button", { name: "Edit group" })).toHaveCount(0);
  await ana.page.getByLabel("Find someone").fill("Ben");
  await ana.page.getByRole("button", { name: `Add ${BEN.name} to the group` }).click();
  await expect(ana.page.getByText(`${BEN.name} was added.`)).toBeVisible();
  await expectNoAxeViolations(ana.page);

  // The directory's group filter keeps the group's members; profiles list the group.
  await page.goto(`${deploy.origin}/directory`);
  await page.getByLabel("Group").selectOption({ label: "Design" });
  await expect(page.getByRole("button", { name: new RegExp(BEN.name) })).toBeVisible();
  await expect(page.getByRole("button", { name: new RegExp(OWNER.name) })).toHaveCount(0);
  await expectNoAxeViolations(page);
});

test("members: change a role with step-up, deactivate someone (signed out at once), delete someone", async () => {
  const page = owner.page;
  await page.goto(`${deploy.origin}/admin/members`);
  await expect(page.getByRole("heading", { level: 1, name: "Members" })).toBeVisible();
  await expect(page.getByRole("cell", { name: BEN.email })).toBeVisible();
  await expectNoAxeViolations(page);

  // Age the owner's last passkey assertion, so the role change needs step-up.
  deploy.d1("UPDATE sessions SET fresh_auth_at = 0");
  await page.getByRole("button", { name: `Manage ${BEN.name}` }).click();
  const manage = page.getByRole("dialog", { name: `Manage ${BEN.name}` });
  await expectNoAxeViolations(page);
  await manage.getByLabel("Workspace role").selectOption("admin");
  await manage.getByRole("button", { name: "Change role" }).click();
  const prompt = page.getByRole("dialog", { name: "Confirm it's you" });
  await expect(prompt).toBeVisible();
  await prompt.getByRole("button", { name: "Use passkey" }).click();
  await expect(page.getByText(`${BEN.name} is now admin.`)).toBeVisible({ timeout: 15_000 });
  await manage.getByRole("button", { name: "Done" }).click();
  await expect(
    page.getByRole("row", { name: new RegExp(BEN.name) }).getByRole("cell", { name: "Admin" }),
  ).toBeVisible();

  // Deactivate Ana: her session ends at once.
  await page.getByRole("button", { name: `Manage ${ANA.name}` }).click();
  const anaDialog = page.getByRole("dialog", { name: `Manage ${ANA.name}` });
  await anaDialog.getByRole("button", { name: "Deactivate" }).click();
  await expect(anaDialog.getByText(/signed out everywhere at once/)).toBeVisible();
  await expectNoAxeViolations(page);
  await anaDialog.getByRole("button", { name: "Deactivate" }).click();
  await expect(page.getByText(`${ANA.name} is deactivated.`)).toBeVisible();
  await anaDialog.getByRole("button", { name: "Done" }).click();
  await ana.page.goto(`${deploy.origin}/chat`);
  await expect(ana.page).toHaveURL(/\/sign-in/);
  await ana.context.close();

  // Delete Ben: anonymised, gone from the list.
  await page.getByRole("button", { name: `Manage ${BEN.name}` }).click();
  const benDialog = page.getByRole("dialog", { name: `Manage ${BEN.name}` });
  await benDialog.getByRole("button", { name: "Delete account" }).click();
  await benDialog.getByLabel("I understand this can't be undone").check();
  await expectNoAxeViolations(page);
  await benDialog.getByRole("button", { name: "Delete account" }).click();
  await expect(page.getByText("The account was deleted.")).toBeVisible();
  await expect(page.getByRole("cell", { name: BEN.email })).toHaveCount(0);
  const rows = deploy.d1(`SELECT display_name, email FROM users WHERE display_name = 'Former member'`);
  expect(rows).toEqual([{ display_name: "Former member", email: null }]);
});

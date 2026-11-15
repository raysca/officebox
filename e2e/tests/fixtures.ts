import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";
import { join } from "node:path";

/** Test-only Worker secrets for the e2e server (never used anywhere else). */
export const E2E_SECRETS = {
  SETUP_TOKEN: "e2e-setup-token-0123456789abcdefghijklmnop",
  SESSION_SIGNING_KEY: "e2e-session-signing-key-0123456789abcdefgh",
  TOKEN_HASH_KEY: "e2e-token-hash-key-0123456789abcdefghijklmn",
  PEPPER_1: "e2e-pepper-one-0123456789abcdefghijklmnopqrs",
} as const;

/** The owner created by first-run setup (first-run.setup.ts). */
export const OWNER = {
  workspace: "Acme Studio",
  name: "Sam Lee",
  handle: "sam.lee",
  email: "sam@example.com",
  password: "correct horse battery staple",
} as const;

/** The owner's signed-in browser state, saved by the setup project. */
export const OWNER_STATE = join(import.meta.dirname, "..", ".auth", "owner.json");

/** WCAG 2.0, 2.1 and 2.2 at levels A and AA (PRD §18). */
export const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"];

export async function expectNoAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  expect(
    results.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.map((n) => n.target.join(" ")) })),
  ).toEqual([]);
}

/** Signs in through the sign-in page and waits for Home. */
export async function signInThroughUi(page: Page, email: string = OWNER.email, password: string = OWNER.password) {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();
}

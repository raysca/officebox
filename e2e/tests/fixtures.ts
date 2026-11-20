import AxeBuilder from "@axe-core/playwright";
import { expect, type BrowserContext, type CDPSession, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Test-only Worker secrets for the e2e server (never used anywhere else). */
export const E2E_SECRETS = {
  SETUP_TOKEN: "e2e-setup-token-0123456789abcdefghijklmnop",
  BETTER_AUTH_SECRET: "e2e-better-auth-secret-0123456789abcdefghij",
  TOKEN_HASH_KEY: "e2e-token-hash-key-0123456789abcdefghijklmn",
} as const;

/**
 * Test-only Worker variables. `EMAIL_TEST_SINK=1` (on this loopback origin only) swaps every configured
 * email driver for the test sink, which records messages in a local D1 table instead of sending them
 * (apps/worker/src/features/email/drivers/sink.ts).
 */
export const E2E_VARS = { EMAIL_TEST_SINK: "1" } as const;

export interface SinkEmail {
  recipient: string;
  subject: string;
  text: string;
}

/** Emails the test sink recorded for `to` (oldest first); empty before the first email. */
export function sinkEmails(to: string): SinkEmail[] {
  const state = process.env.OFFICEBOX_E2E_STATE;
  if (!state) throw new Error("OFFICEBOX_E2E_STATE isn't set");
  let output: string;
  try {
    output = execFileSync(
      "npx",
      [
        "wrangler",
        "--config",
        "../wrangler.jsonc",
        "d1",
        "execute",
        "DB",
        "--local",
        "--persist-to",
        state,
        "--json",
        "--command",
        `SELECT recipient, subject, text FROM email_test_sink WHERE lower(recipient) = lower('${to.replace(/'/g, "''")}') ORDER BY created_at`,
      ],
      { stdio: "pipe", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } },
    ).toString();
  } catch {
    // The sink's table doesn't exist until the first email.
    return [];
  }
  const parsed = JSON.parse(output) as { results: SinkEmail[] }[];
  return parsed[0]?.results ?? [];
}

/** The link (with its `#t=` fragment) in an email's text. */
export function linkIn(email: SinkEmail): string {
  const match = /https?:\/\/\S+#t=[A-Za-z0-9_-]+/.exec(email.text);
  if (!match) throw new Error(`no link in "${email.subject}"`);
  return match[0];
}

/**
 * Browser-context options that give one test its own client IP, so it can't spend (or be refused by)
 * the per-IP limits every other e2e browser shares on loopback (Platform §8). The Worker keys those
 * limits on `CF-Connecting-IP`. Local `wrangler dev` keeps a client-sent value; Cloudflare's edge
 * always replaces it with the real client address, so this works only in local runs and changes
 * nothing in the Worker or its limits. Each address is its own /64 in the documentation range
 * (2001:db8::/32), never a real one.
 */
export function ownClientIp(): { extraHTTPHeaders: Record<string, string> } {
  const [a = 0, b = 0] = crypto.getRandomValues(new Uint16Array(2));
  return { extraHTTPHeaders: { "CF-Connecting-IP": `2001:db8:${a.toString(16)}:${b.toString(16)}::1` } };
}

/** The owner created by first-run setup (first-run.setup.ts). */
export const OWNER = {
  workspace: "Acme Studio",
  name: "Sam Lee",
  handle: "sam.lee",
  email: "sam@example.com",
} as const;

/** The owner's signed-in browser state, saved by the setup project. */
export const OWNER_STATE = join(import.meta.dirname, "..", ".auth", "owner.json");
/** The owner's passkey (the virtual authenticator's credential, with its private key), saved by setup. */
export const OWNER_CREDENTIAL = join(import.meta.dirname, "..", ".auth", "owner-credential.json");

/** WCAG 2.0, 2.1 and 2.2 at levels A and AA (PRD §18). */
export const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"];

export async function expectNoAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  expect(
    results.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.map((n) => n.target.join(" ")) })),
  ).toEqual([]);
}

export interface VirtualCredential {
  credentialId: string;
  isResidentCredential: boolean;
  rpId?: string;
  privateKey: string;
  userHandle?: string;
  signCount: number;
}

export interface Authenticator {
  cdp: CDPSession;
  id: string;
  credentials(): Promise<VirtualCredential[]>;
  add(credential: VirtualCredential): Promise<void>;
  remove(credentialId: string): Promise<void>;
}

/**
 * A Chromium virtual authenticator (CDP `WebAuthn` domain) for this page: a platform authenticator
 * with resident keys and **user verification on** by default, answering prompts automatically.
 */
export async function addAuthenticator(
  context: BrowserContext,
  page: Page,
  { userVerified = true, transport = "internal" }: { userVerified?: boolean; transport?: "internal" | "usb" } = {},
): Promise<Authenticator> {
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport,
      hasResidentKey: true,
      hasUserVerification: userVerified,
      isUserVerified: userVerified,
      automaticPresenceSimulation: true,
    },
  });
  return {
    cdp,
    id: authenticatorId,
    async credentials() {
      const { credentials } = await cdp.send("WebAuthn.getCredentials", { authenticatorId });
      return credentials;
    },
    async add(credential) {
      await cdp.send("WebAuthn.addCredential", { authenticatorId, credential });
    },
    async remove(credentialId) {
      await cdp.send("WebAuthn.removeCredential", { authenticatorId, credentialId });
    },
  };
}

export function saveCredential(credential: VirtualCredential): void {
  mkdirSync(dirname(OWNER_CREDENTIAL), { recursive: true });
  writeFileSync(OWNER_CREDENTIAL, JSON.stringify(credential));
}

export function loadCredential(): VirtualCredential {
  return JSON.parse(readFileSync(OWNER_CREDENTIAL, "utf8")) as VirtualCredential;
}

/**
 * Runs SQL against the e2e server's local D1 (the same `--persist-to` directory). Used only to age a
 * session's last passkey assertion so step-up is needed, which can't be waited out in a test.
 */
export function d1(sql: string): void {
  const state = process.env.OFFICEBOX_E2E_STATE;
  if (!state) throw new Error("OFFICEBOX_E2E_STATE isn't set");
  execFileSync(
    "npx",
    [
      "wrangler",
      "--config",
      "../wrangler.jsonc",
      "d1",
      "execute",
      "DB",
      "--local",
      "--persist-to",
      state,
      "--command",
      sql,
    ],
    { stdio: "pipe", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } },
  );
}

/** Signs in on the sign-in page with whatever passkey the page's authenticator holds; waits for Home. */
export async function signInWithPasskey(page: Page) {
  await page.goto("/sign-in");
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();
}

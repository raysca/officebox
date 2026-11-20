import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiError, healthyFetch, jsonResponse, renderApp, TEST_ME, type Route } from "../test/render-app";

/**
 * M1c pages (Identity §4.4, §4.6, §4.11, §7 screens 5, 8): recovery links, owner recovery, the email-change
 * confirmation, the domain move's commit step, and the Members and workspace-address admin pages.
 * WebAuthn is mocked (jsdom has none); the end-to-end run uses Chromium's virtual authenticator.
 */

const webauthn = vi.hoisted(() => ({
  startRegistration: vi.fn(() => Promise.resolve({ id: "cred", type: "public-key" })),
}));
vi.mock("@simplewebauthn/browser", () => ({
  browserSupportsWebAuthn: () => true,
  startRegistration: webauthn.startRegistration,
  startAuthentication: vi.fn(() => Promise.resolve({ id: "cred", type: "public-key" })),
}));

beforeEach(() => {
  webauthn.startRegistration.mockClear();
});

async function expectNoViolations() {
  const results = await axe.run(document.body, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"] },
    rules: { "color-contrast": { enabled: false } },
  });
  expect(results.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target.join(" ")) }))).toEqual([]);
}

const on =
  (method: string, path: string, answer: (init: RequestInit | undefined) => Response): Route =>
  (url, init) =>
    url === path && (init?.method ?? "GET").toUpperCase() === method ? answer(init) : undefined;

const bodyOf = (init: RequestInit | undefined) =>
  JSON.parse(typeof init?.body === "string" ? init.body : "null") as Record<string, unknown>;

const TOKEN = "R".repeat(43);
const passkeyRoutes: Route[] = [
  on("GET", "/api/auth/passkey/generate-register-options", () => jsonResponse({ challenge: "c" })),
  on("POST", "/api/auth/passkey/verify-registration", () => jsonResponse({ id: "p" })),
];

describe("a recovery link (Identity §4.6)", () => {
  it("shows the email, uses the link only on Continue, then registers a passkey and signs in", async () => {
    const user = userEvent.setup();
    window.history.pushState({}, "", `/auth/recover#t=${TOKEN}`);
    let enrolled = false;
    const fetch = healthyFetch({
      me: null,
      routes: [
        on("POST", "/api/auth/recover/lookup", () => jsonResponse({ email: "ana@example.com", workspaceName: "Acme" })),
        on("POST", "/api/auth/recover", () => {
          enrolled = true;
          return jsonResponse({ email: "ana@example.com", enrolmentExpiresInSeconds: 900 }, 201);
        }),
        ...passkeyRoutes,
        on("GET", "/api/me", () => (enrolled ? jsonResponse(TEST_ME) : apiError("unauthenticated", 401))),
      ],
    });
    const { router } = await renderApp("/auth/recover", { fetch });
    expect(await screen.findByText("ana@example.com")).toBeDefined();
    expect(window.location.hash).toBe("");
    expect(fetch.mock.calls.some(([url]) => url === "/api/auth/recover")).toBe(false);
    await expectNoViolations();
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Create your new passkey" })).toBeDefined();
    expect(bodyOf(fetch.mock.calls.find(([url]) => url === "/api/auth/recover")?.[1])).toEqual({ token: TOKEN });
    await expectNoViolations();
    await user.click(screen.getByRole("button", { name: "Create passkey" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(webauthn.startRegistration).toHaveBeenCalledOnce();
  });

  it("explains a used or expired link", async () => {
    window.history.pushState({}, "", `/auth/recover#t=${TOKEN}`);
    const fetch = healthyFetch({
      me: null,
      routes: [
        on("POST", "/api/auth/recover/lookup", () => apiError("gone", 410, { reason: "recovery_link_invalid" })),
      ],
    });
    await renderApp("/auth/recover", { fetch });
    expect(await screen.findByText(/This recovery link isn't valid any more/)).toBeDefined();
  });
});

describe("owner recovery (Identity §4.6)", () => {
  it("checks the form, flags a wrong token on its field, then registers a passkey", async () => {
    const user = userEvent.setup();
    let calls = 0;
    const fetch = healthyFetch({
      me: null,
      routes: [
        on("POST", "/api/recover", () => {
          calls++;
          return calls === 1
            ? apiError("forbidden", 403, { reason: "recovery_token_invalid" })
            : jsonResponse({ email: "sam@example.com", enrolmentExpiresInSeconds: 900 }, 201);
        }),
        ...passkeyRoutes,
      ],
    });
    await renderApp("/recover", { fetch });
    await screen.findByRole("heading", { level: 1, name: "Owner recovery" });
    await expectNoViolations();
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByLabelText("Owner's email").getAttribute("aria-invalid")).toBe("true");
    await user.type(screen.getByLabelText("Owner's email"), "sam@example.com");
    await user.type(screen.getByLabelText("Recovery token"), "a-wrong-value");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(screen.getByLabelText("Recovery token").getAttribute("aria-invalid")).toBe("true"));
    expect(screen.getByText("That recovery token isn't right.")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Create your new passkey" })).toBeDefined();
  });
});

describe("the email-change confirmation (Identity §4.11)", () => {
  it("shows the new address and applies it only on Confirm", async () => {
    const user = userEvent.setup();
    window.history.pushState({}, "", `/me/email/confirm#t=${TOKEN}`);
    const fetch = healthyFetch({
      me: null,
      routes: [
        on("POST", "/api/me/email/confirm/lookup", () =>
          jsonResponse({ newEmail: "new@example.com", workspaceName: "Acme" }),
        ),
        on("POST", "/api/me/email/confirm", () => jsonResponse({ email: "new@example.com" })),
      ],
    });
    await renderApp("/me/email/confirm", { fetch });
    expect(await screen.findByText("new@example.com")).toBeDefined();
    expect(fetch.mock.calls.some(([url]) => url === "/api/me/email/confirm")).toBe(false);
    await expectNoViolations();
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    expect(await screen.findByText("Your email address is now new@example.com.")).toBeDefined();
  });
});

describe("the domain move's commit step (Identity §4.4)", () => {
  it("continues with the link, then creates a passkey for this address", async () => {
    const user = userEvent.setup();
    window.history.pushState({}, "", `/admin/domain/complete#t=${TOKEN}`);
    const fetch = healthyFetch({
      me: null,
      routes: [
        on("POST", "/api/admin/domain/complete", () =>
          jsonResponse(
            {
              email: "sam@example.com",
              origin: "https://new.example.com",
              workspaceName: "Acme",
              enrolmentExpiresInSeconds: 900,
            },
            201,
          ),
        ),
        on("GET", "/api/auth/passkey/generate-register-options", () => jsonResponse({ challenge: "c" })),
        on("POST", "/api/auth/passkey/verify-registration", () =>
          apiError("validation_failed", 400, { reason: "DOMAIN_MOVE_INVALID" }),
        ),
      ],
    });
    await renderApp("/admin/domain/complete", { fetch });
    await screen.findByRole("heading", { level: 1, name: "Finish moving the workspace" });
    // It never asks who's signed in: the new address answers only the move routes until the commit.
    expect(fetch.mock.calls.some(([url]) => url === "/api/me")).toBe(false);
    await expectNoViolations();
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(await screen.findByRole("button", { name: "Create passkey and move" }));
    expect(await screen.findByText(/The move couldn't be completed/)).toBeDefined();
  });
});

describe("Members and the workspace address (admin)", () => {
  const MEMBER = {
    id: "01JABCDEFGHJKMNPQRSTVWXYZ1",
    email: "ana@example.com",
    displayName: "Ana Diaz",
    handle: "ana",
    role: "member",
    status: "active",
    passkeyCount: 1,
    recoveryFlag: { at: Date.UTC(2026, 10, 1), byName: "Pat Doe" },
    pendingEmail: null,
  };

  it("issues a recovery link to copy, shows the owners' flag, and changes an email", async () => {
    const user = userEvent.setup();
    const fetch = healthyFetch({
      routes: [
        on("GET", "/api/admin/members", () => jsonResponse({ members: [MEMBER] })),
        on("POST", `/api/admin/members/${MEMBER.id}/recovery-link`, () =>
          jsonResponse(
            {
              link: `https://officebox.example/auth/recover#t=${TOKEN}`,
              expiresAt: Date.now(),
              notifiedByEmail: false,
              flagged: true,
            },
            201,
          ),
        ),
        on("PATCH", `/api/admin/members/${MEMBER.id}`, () =>
          jsonResponse({ status: "pending_confirmation", email: "ana.new@example.com" }),
        ),
      ],
    });
    await renderApp("/admin/members", { fetch });
    const row = (await screen.findByText("Ana Diaz")).closest("tr")!;
    expect(within(row).getByText(/Recovery link issued by Pat Doe/)).toBeDefined();
    await expectNoViolations();
    await user.click(within(row).getByRole("button", { name: "Issue a recovery link for Ana Diaz" }));
    const dialog = await screen.findByRole("dialog", { name: "Recovery link" });
    expect(within(dialog).getByLabelText<HTMLInputElement>("Recovery link").value).toContain("#t=");
    await expectNoViolations();
    await user.click(within(dialog).getByRole("button", { name: "Done" }));
    await user.click(within(row).getByRole("button", { name: "Change the email address of Ana Diaz" }));
    const edit = await screen.findByRole("dialog", { name: "Change email" });
    await user.type(within(edit).getByLabelText("New email"), "ana.new@example.com");
    await user.click(within(edit).getByRole("button", { name: "Change email" }));
    expect(await within(edit).findByText(/A confirmation link was sent to ana.new@example.com/)).toBeDefined();
  });

  it("the owner starts a move and sees the move link once; a bad address is flagged first", async () => {
    const user = userEvent.setup();
    let pending = false;
    const fetch = healthyFetch({
      routes: [
        on("GET", "/api/admin/domain", () =>
          jsonResponse({
            canonicalOrigin: "https://officebox.example",
            pending: pending
              ? { origin: "https://new.example.com", expiresAt: Date.now() + 1000, startedBy: null }
              : null,
          }),
        ),
        on("POST", "/api/admin/domain", () => {
          pending = true;
          return jsonResponse(
            {
              origin: "https://new.example.com",
              link: `https://new.example.com/admin/domain/complete#t=${TOKEN}`,
              expiresAt: Date.now(),
            },
            201,
          );
        }),
      ],
    });
    await renderApp("/admin/domain", { fetch });
    expect(await screen.findByText("https://officebox.example")).toBeDefined();
    await expectNoViolations();
    await user.type(screen.getByLabelText("New address"), "https://new.example.com/path");
    await user.click(screen.getByRole("button", { name: "Start the move" }));
    expect(screen.getByLabelText("New address").getAttribute("aria-invalid")).toBe("true");
    await user.clear(screen.getByLabelText("New address"));
    await user.type(screen.getByLabelText("New address"), "https://new.example.com");
    await user.click(screen.getByRole("button", { name: "Start the move" }));
    const dialog = await screen.findByRole("dialog", { name: "Move link" });
    expect(within(dialog).getByLabelText<HTMLInputElement>("Move link").value).toContain("/admin/domain/complete#t=");
    expect(
      bodyOf(fetch.mock.calls.find(([url, init]) => url === "/api/admin/domain" && init?.method === "POST")?.[1]),
    ).toEqual({
      origin: "https://new.example.com",
    });
  });

  it("owners see the banner while a used RECOVERY_TOKEN is still set", async () => {
    await renderApp("/", { fetch: healthyFetch({ me: { ...TEST_ME, ownerRecoveryUsed: true } }) });
    expect(await screen.findByRole("region", { name: "Owner recovery" })).toBeDefined();
  });

  it("the sign-in page shows the admin-reset notice for this browser's member", async () => {
    const fetch = healthyFetch({
      me: null,
      routes: [
        on("GET", "/api/status/public", () =>
          jsonResponse({ magicLinks: false, recoveryNotice: { at: Date.UTC(2026, 10, 2) } }),
        ),
      ],
    });
    await renderApp("/sign-in", { fetch });
    expect(await screen.findByText(/An admin reset your account on/)).toBeDefined();
    expect(screen.getByRole("link", { name: "owner recovery" }).getAttribute("href")).toBe("/recover");
  });
});

import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiError, healthyFetch, jsonResponse, renderApp, TEST_ME, type Route } from "../test/render-app";

/**
 * M1b pages (Identity §4.2–§4.4, §7 screens 2–4; Admin §3, §6): "Email me a sign-in link", the
 * magic-link confirmation page, accepting an invitation, the invitations admin page and the email
 * settings. WebAuthn is mocked (jsdom has none); the end-to-end run uses Chromium's virtual
 * authenticator and the test email sink.
 */

const webauthn = vi.hoisted(() => ({
  supported: true,
  startRegistration: vi.fn(() => Promise.resolve({ id: "cred", type: "public-key" })),
  startAuthentication: vi.fn(() => Promise.resolve({ id: "cred", type: "public-key" })),
}));
vi.mock("@simplewebauthn/browser", () => ({
  browserSupportsWebAuthn: () => webauthn.supported,
  startRegistration: webauthn.startRegistration,
  startAuthentication: webauthn.startAuthentication,
}));

beforeEach(() => {
  webauthn.supported = true;
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

const TOKEN = "T".repeat(43);

describe("sign in with an email link (Identity §4.4)", () => {
  it("is offered only when magic links are available, and answers the same for any address", async () => {
    const user = userEvent.setup();
    const fetch = healthyFetch({
      me: null,
      routes: [
        on("GET", "/api/status/public", () => jsonResponse({ magicLinks: true })),
        on("POST", "/api/auth/sign-in/magic-link", () => jsonResponse({ status: true })),
      ],
    });
    await renderApp("/sign-in", { fetch });
    const section = await screen.findByRole("region", { name: "Email me a sign-in link" });
    await expectNoViolations();
    await user.click(within(section).getByRole("button", { name: "Email me a sign-in link" }));
    expect(within(section).getByLabelText("Email").getAttribute("aria-invalid")).toBe("true");
    await user.type(within(section).getByLabelText("Email"), "ana@example.com");
    await user.click(within(section).getByRole("button", { name: "Email me a sign-in link" }));
    expect(await screen.findByText(/If ana@example.com belongs to a member/)).toBeDefined();
    const call = fetch.mock.calls.find(([url]) => url === "/api/auth/sign-in/magic-link");
    expect(bodyOf(call?.[1])).toEqual({ email: "ana@example.com" });
  });

  it("is hidden when email isn't configured", async () => {
    const fetch = healthyFetch({
      me: null,
      routes: [on("GET", "/api/status/public", () => jsonResponse({ magicLinks: false }))],
    });
    await renderApp("/sign-in", { fetch });
    expect(await screen.findByRole("button", { name: "Sign in with a passkey" })).toBeDefined();
    await waitFor(() => expect(fetch.mock.calls.some(([url]) => url === "/api/status/public")).toBe(true));
    expect(screen.queryByRole("region", { name: "Email me a sign-in link" })).toBeNull();
  });
});

describe("the magic-link confirmation page (Platform §10)", () => {
  it("reads the token from the fragment, strips it, shows the email, and signs in only on Continue", async () => {
    const user = userEvent.setup();
    const replace = vi.spyOn(window.history, "replaceState");
    window.history.pushState({}, "", `/sign-in/link#t=${TOKEN}`);
    let signedIn = false;
    const fetch = healthyFetch({
      me: null,
      routes: [
        on("POST", "/api/sign-in/link/lookup", () => jsonResponse({ email: "ana@example.com", workspaceName: "Acme" })),
        on("POST", "/api/sign-in/link", () => {
          signedIn = true;
          return jsonResponse({ signedIn: true });
        }),
        on("GET", "/api/me", () => (signedIn ? jsonResponse(TEST_ME) : apiError("unauthenticated", 401))),
      ],
    });
    const { router } = await renderApp("/sign-in/link", { fetch });
    expect(await screen.findByText("ana@example.com")).toBeDefined();
    expect(screen.getByText("Sign in to Acme as")).toBeDefined();
    expect(window.location.hash).toBe("");
    expect(replace).toHaveBeenCalled();
    expect(document.querySelector('meta[name="referrer"]')?.getAttribute("content")).toBe("no-referrer");
    // Nothing was used yet.
    expect(fetch.mock.calls.some(([url]) => url === "/api/sign-in/link")).toBe(false);
    const lookup = fetch.mock.calls.find(([url]) => url === "/api/sign-in/link/lookup");
    expect(bodyOf(lookup?.[1])).toEqual({ token: TOKEN });
    await expectNoViolations();
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    replace.mockRestore();
  });

  it("explains an invalid link", async () => {
    window.history.pushState({}, "", `/sign-in/link#t=${"U".repeat(43)}`);
    const fetch = healthyFetch({
      me: null,
      routes: [on("POST", "/api/sign-in/link/lookup", () => apiError("gone", 410))],
    });
    await renderApp("/sign-in/link", { fetch });
    expect(await screen.findByText(/This sign-in link isn't valid any more/)).toBeDefined();
  });
});

describe("accepting an invitation (Identity §4.3)", () => {
  const invitationRoutes = (extra: Route[] = []) =>
    healthyFetch({
      me: null,
      routes: [
        ...extra,
        on("POST", "/api/invitations/lookup", () =>
          jsonResponse({ email: "ana@example.com", role: "member", workspaceName: "Acme", state: "new" }),
        ),
        on("POST", "/api/invitations/accept", () =>
          jsonResponse({ email: "ana@example.com", enrolmentExpiresInSeconds: 900, resumed: false }, 201),
        ),
        on("GET", "/api/auth/passkey/generate-register-options", () => jsonResponse({ challenge: "abc" })),
        on("POST", "/api/auth/passkey/verify-registration", () => jsonResponse({ id: "p" })),
      ],
    });

  it("shows the invited email, suggests a handle, creates the account and registers a passkey", async () => {
    const user = userEvent.setup();
    window.history.pushState({}, "", `/invitations/accept#t=${TOKEN}`);
    const fetch = invitationRoutes();
    await renderApp("/invitations/accept", { fetch });
    expect(await screen.findByText("ana@example.com")).toBeDefined();
    expect(window.location.hash).toBe("");
    await expectNoViolations();
    await user.type(screen.getByLabelText("Your name"), "Ana Díaz");
    expect(screen.getByLabelText<HTMLInputElement>("Handle").value).toBe("ana.diaz");
    await user.click(screen.getByRole("button", { name: "Accept and continue" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Create your passkey" })).toBeDefined();
    const accept = fetch.mock.calls.find(([url]) => url === "/api/invitations/accept");
    expect(bodyOf(accept?.[1])).toEqual({ token: TOKEN, name: "Ana Díaz", handle: "ana.diaz" });
    await expectNoViolations();
    await user.click(screen.getByRole("button", { name: "Create passkey" }));
    await waitFor(() => expect(webauthn.startRegistration).toHaveBeenCalled());
  });

  it("a taken handle is flagged on the field", async () => {
    const user = userEvent.setup();
    window.history.pushState({}, "", `/invitations/accept#t=${TOKEN}`);
    const fetch = invitationRoutes([
      on("POST", "/api/invitations/accept", () => apiError("conflict", 409, { reason: "handle_taken" })),
    ]);
    await renderApp("/invitations/accept", { fetch });
    await user.type(await screen.findByLabelText("Your name"), "Sam");
    await user.click(screen.getByRole("button", { name: "Accept and continue" }));
    await waitFor(() => expect(screen.getByLabelText("Handle").getAttribute("aria-invalid")).toBe("true"));
    expect(screen.getByText("That handle is taken. Choose another.")).toBeDefined();
  });

  it("an expired invitation is refused with an explanation", async () => {
    window.history.pushState({}, "", `/invitations/accept#t=${TOKEN}`);
    const fetch = invitationRoutes([
      on("POST", "/api/invitations/lookup", () => apiError("gone", 410, { reason: "invitation_expired" })),
    ]);
    await renderApp("/invitations/accept", { fetch });
    expect(
      await screen.findByText("This invitation has expired. Ask whoever invited you for a new one."),
    ).toBeDefined();
  });

  it("someone already signed in is asked to sign out first", async () => {
    window.history.pushState({}, "", `/invitations/accept#t=${TOKEN}`);
    const fetch = invitationRoutes([on("GET", "/api/me", () => jsonResponse(TEST_ME))]);
    await renderApp("/invitations/accept", { fetch });
    expect(await screen.findByText("You're signed in as Sam Lee. Sign out to accept this invitation.")).toBeDefined();
  });
});

describe("admin: invitations and email settings (Admin §3, §6)", () => {
  const settings = (driver: "none" | "cloudflare", canChange = true) => ({
    settings: [
      {
        key: "email_provider",
        value: driver === "none" ? { driver: "none" } : { driver, from: "no-reply@example.com" },
        isDefault: driver === "none",
        changeableBy: "owner",
        canChange,
      },
      { key: "magic_link_enabled", value: true, isDefault: true, changeableBy: "admin", canChange: true },
      { key: "allowed_invite_domains", value: [], isDefault: true, changeableBy: "admin", canChange: true },
    ],
    email: { driver, configured: driver !== "none", missing: [] },
    signInKeys: { betterAuthSecret: "worker_secret", tokenHashKey: "generated" },
  });

  it("invites by copy link and lists pending invitations", async () => {
    const user = userEvent.setup();
    const invitation = {
      id: "01JABCDEFGHJKMNPQRSTVWXYZ1",
      email: "ana@example.com",
      role: "member",
      invitedBy: { id: TEST_ME.user.id, displayName: "Sam Lee" },
      createdAt: Date.UTC(2026, 10, 15),
      expiresAt: Date.UTC(2026, 10, 22),
      lastSentAt: null,
      status: "pending",
    };
    let created = false;
    const fetch = healthyFetch({
      routes: [
        on("GET", "/api/admin/invitations", () => jsonResponse({ invitations: created ? [invitation] : [] })),
        on("GET", "/api/admin/settings", () => jsonResponse(settings("none"))),
        on("POST", "/api/admin/invitations", () => {
          created = true;
          return jsonResponse(
            { invitation, link: `https://officebox.example/invitations/accept#t=${TOKEN}`, email: "not_requested" },
            201,
          );
        }),
      ],
    });
    await renderApp("/admin/invitations", { fetch });
    expect(await screen.findByText("No pending invitations.")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Invite someone" }));
    const dialog = await screen.findByRole("dialog", { name: "Invite someone" });
    expect(within(dialog).getByText("Email isn't set up, so you'll share the link yourself.")).toBeDefined();
    await expectNoViolations();
    await user.type(within(dialog).getByLabelText("Email"), "ana@example.com");
    await user.click(within(dialog).getByRole("button", { name: "Create invitation" }));
    const linkDialog = await screen.findByRole("dialog", { name: "Invitation link" });
    expect(within(linkDialog).getByLabelText<HTMLInputElement>("Link to share").value).toContain("#t=");
    const post = fetch.mock.calls.find(([url, init]) => url === "/api/admin/invitations" && init?.method === "POST");
    expect(bodyOf(post?.[1])).toEqual({ email: "ana@example.com", role: "member", sendEmail: false });
    await expectNoViolations();
    await user.click(within(linkDialog).getByRole("button", { name: "Done" }));
    const table = await screen.findByRole("table");
    expect(within(table).getByRole("rowheader", { name: "ana@example.com" })).toBeDefined();
    expect(within(table).getByRole("button", { name: "Revoke the invitation for ana@example.com" })).toBeDefined();
    await expectNoViolations();
  });

  it("explains the owners' invite gate", async () => {
    const user = userEvent.setup();
    const fetch = healthyFetch({
      routes: [
        on("GET", "/api/admin/invitations", () => jsonResponse({ invitations: [] })),
        on("GET", "/api/admin/settings", () => jsonResponse(settings("none"))),
        on("POST", "/api/admin/invitations", () => apiError("forbidden", 403, { reason: "owner_invite_gate" })),
      ],
    });
    await renderApp("/admin/invitations", { fetch });
    await user.click(await screen.findByRole("button", { name: "Invite someone" }));
    const dialog = await screen.findByRole("dialog", { name: "Invite someone" });
    await user.type(within(dialog).getByLabelText("Email"), "ana@example.com");
    await user.click(within(dialog).getByRole("button", { name: "Create invitation" }));
    expect(await within(dialog).findByText(/Before you invite people, add a second passkey/)).toBeDefined();
    expect(within(dialog).getByRole("link", { name: "Add a passkey" }).getAttribute("href")).toBe("/settings/passkeys");
  });

  it("the owner sets up email and sends a test email; admins see it read-only with the reason", async () => {
    const user = userEvent.setup();
    const fetch = healthyFetch({
      routes: [
        on("GET", "/api/admin/settings", () => jsonResponse(settings("none"))),
        on("PATCH", "/api/admin/settings", (init) => jsonResponse({ key: bodyOf(init).key })),
        on("POST", "/api/admin/email/test", () => jsonResponse({ to: "sam@example.com", jobId: "j" }, 202)),
      ],
    });
    await renderApp("/admin/settings", { fetch });
    expect(await screen.findByText("Email is off.")).toBeDefined();
    // Each sign-in key's source, never a value (Platform §16, M1b-1).
    const keys = screen.getByRole("region", { name: "Sign-in keys" });
    expect(within(keys).getByText("Worker secret")).toBeDefined();
    expect(within(keys).getByText("Generated by the Worker")).toBeDefined();
    await expectNoViolations();
    await user.selectOptions(screen.getByLabelText("Email service"), "cloudflare");
    await user.type(screen.getByLabelText("Sender address"), "no-reply@example.com");
    await user.click(screen.getByRole("button", { name: "Save email settings" }));
    await waitFor(() =>
      expect(fetch.mock.calls.some(([url, init]) => url === "/api/admin/settings" && init?.method === "PATCH")).toBe(
        true,
      ),
    );
    const patch = fetch.mock.calls.find(([url, init]) => url === "/api/admin/settings" && init?.method === "PATCH");
    expect(bodyOf(patch?.[1])).toEqual({
      key: "email_provider",
      value: { driver: "cloudflare", from: "no-reply@example.com" },
    });
    await user.click(screen.getByRole("button", { name: "Send test email" }));
    expect(await screen.findByText("A test email is on its way to sam@example.com.")).toBeDefined();
  });

  it("admins can't change the email driver: aria-disabled with the reason", async () => {
    const fetch = healthyFetch({
      me: { ...TEST_ME, user: { ...TEST_ME.user, role: "admin" } },
      routes: [on("GET", "/api/admin/settings", () => jsonResponse(settings("cloudflare", false)))],
    });
    await renderApp("/admin/settings", { fetch });
    const select = await screen.findByLabelText("Email service");
    expect(select.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText("Only owners can change this.")).toBeDefined();
    await expectNoViolations();
  });
});

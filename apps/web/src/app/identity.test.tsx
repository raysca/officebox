import { act, screen, waitFor, within } from "@testing-library/react";
import type { QueryClient } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiError, healthyFetch, jsonResponse, renderApp, TEST_ME, type Route } from "../test/render-app";
import { safeRedirect } from "./routes/sign-in";

/**
 * The identity pages (Identity §7): setup with a passkey, sign-in, Passkeys, My devices, the step-up
 * prompt, the security banner and /not-configured. WebAuthn itself is mocked here (jsdom has none);
 * the end-to-end run uses Chromium's virtual authenticator.
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
  webauthn.startAuthentication.mockClear();
});

async function expectNoViolations() {
  const results = await axe.run(document.body, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"] },
    rules: { "color-contrast": { enabled: false } },
  });
  expect(results.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target.join(" ")) }))).toEqual([]);
}

/**
 * Waits for every in-flight query to finish and React to render the result, inside `act`. Tests that
 * must not depend on a findBy timeout under load wait on the requests themselves this way.
 */
async function settleQueries(queryClient: QueryClient) {
  await act(async () => {
    while (queryClient.isFetching() > 0) {
      // `cancelRefetch: false` joins the fetch already in flight rather than starting another.
      await queryClient.refetchQueries({ fetchStatus: "fetching" }, { cancelRefetch: false });
    }
    // Query results reach observers in a zero-delay task (TanStack's notifyManager); let it run.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const on =
  (method: string, path: string, answer: () => Response): Route =>
  (url, init) =>
    url === path && (init?.method ?? "GET").toUpperCase() === method ? answer() : undefined;

const options = () => jsonResponse({ challenge: "abc" });

const SERVICE_IDS = ["d1", "durable_objects", "queues", "r2", "better_auth_secret", "token_hash_key"] as const;
const allServices = () => SERVICE_IDS.map((id) => ({ id, ok: true }));
/** A setup status in token mode with every service passing (M1b-1 fields included). */
const tokenStatus = (claimed: boolean) =>
  jsonResponse({ setupRequired: true, tokenSource: "generated", claimed, services: allServices(), mode: "token" });

describe("setup (Identity §4.1)", () => {
  const notSetUp = (extra: Route[] = [], claimed = false) =>
    healthyFetch({
      me: null,
      routes: [
        on("GET", "/api/me", () => apiError("setup_required", 409)),
        on("GET", "/api/setup", () => tokenStatus(claimed)),
        ...extra,
      ],
    });

  it("every route leads to /setup before setup; the form checks fields before sending", async () => {
    const user = userEvent.setup();
    const fetch = notSetUp();
    const { router } = await renderApp("/chat", { fetch });
    await waitFor(() => expect(router.state.location.pathname).toBe("/setup"));
    expect(await screen.findByRole("heading", { level: 1, name: "Set up your workspace" })).toBeDefined();
    await expectNoViolations();
    await user.click(screen.getByRole("button", { name: "Create workspace" }));
    expect(screen.getByLabelText("Setup token").getAttribute("aria-invalid")).toBe("true");
    expect(fetch.mock.calls.some(([url, init]) => url === "/api/setup" && init?.method === "POST")).toBe(false);
  });

  it("stops before the claim when the browser can't create a passkey", async () => {
    webauthn.supported = false;
    await renderApp("/setup", { fetch: notSetUp() });
    expect(
      await screen.findByText("This browser can't create a passkey. Use another device or a security key."),
    ).toBeDefined();
    expect(screen.queryByLabelText("Setup token")).toBeNull();
  });

  it("claims, registers the owner's passkey, then recommends a second one", async () => {
    const user = userEvent.setup();
    const fetch = notSetUp([
      on("POST", "/api/setup", () =>
        jsonResponse({ ownerEmail: "sam@example.com", enrolmentExpiresInSeconds: 900 }, 201),
      ),
      on("GET", "/api/auth/passkey/generate-register-options", options),
      on("POST", "/api/auth/passkey/verify-registration", () => jsonResponse({ id: "p" })),
    ]);
    await renderApp("/setup", { fetch });
    await user.type(await screen.findByLabelText("Setup token"), "token-0123456789abcdefghijklmnopqrstuv");
    await user.type(screen.getByLabelText("Workspace name"), "Acme Studio");
    await user.type(screen.getByLabelText("Your name"), "Sam Lee");
    expect(screen.getByLabelText<HTMLInputElement>("Handle").value).toBe("sam.lee");
    await user.type(screen.getByLabelText("Email"), "sam@example.com");
    await user.click(screen.getByRole("button", { name: "Create workspace" }));

    expect(await screen.findByRole("heading", { level: 1, name: "Add your passkey" })).toBeDefined();
    expect(screen.getByText(/sam@example.com/)).toBeDefined();
    await expectNoViolations();
    await user.click(screen.getByRole("button", { name: "Create passkey" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Add a second passkey" })).toBeDefined();
    await expectNoViolations();
    expect(webauthn.startRegistration).toHaveBeenCalledTimes(1);
    // The options GET carries the CSRF header (it writes a challenge).
    const [, init] = fetch.mock.calls.find(([url]) => url === "/api/auth/passkey/generate-register-options") ?? [];
    expect((init?.headers as Record<string, string>)["X-Officebox-Request"]).toBe("1");
  });

  it("a wrong token is flagged on the field", async () => {
    const user = userEvent.setup();
    const fetch = notSetUp([on("POST", "/api/setup", () => apiError("forbidden", 403))]);
    await renderApp("/setup", { fetch });
    await user.type(await screen.findByLabelText("Setup token"), "wrong-token-0123456789abcdefghijklmnop");
    await user.type(screen.getByLabelText("Workspace name"), "Acme");
    await user.type(screen.getByLabelText("Your name"), "Sam Lee");
    await user.type(screen.getByLabelText("Email"), "sam@example.com");
    await user.click(screen.getByRole("button", { name: "Create workspace" }));
    expect(await screen.findByText("This setup token isn't valid. Check it and try again.")).toBeDefined();
  });

  it("an open claim offers resume with the same token", async () => {
    const user = userEvent.setup();
    const fetch = notSetUp([on("POST", "/api/setup/resume", () => apiError("gone", 410))], true);
    await renderApp("/setup", { fetch });
    expect(await screen.findByRole("heading", { level: 1, name: "Setup has started" })).toBeDefined();
    await expectNoViolations();
    await user.type(screen.getByLabelText("Setup token"), "token-0123456789abcdefghijklmnopqrstuv");
    await user.click(screen.getByRole("button", { name: "Continue setup" }));
    expect(await screen.findByText(/can't be continued/)).toBeDefined();
  });

  it("a released claim sends resume back to the full setup form", async () => {
    const user = userEvent.setup();
    let claimed = true;
    const fetch = healthyFetch({
      me: null,
      routes: [
        on("GET", "/api/me", () => apiError("setup_required", 409)),
        on("GET", "/api/setup", () => tokenStatus(claimed)),
        on("POST", "/api/setup/resume", () => {
          claimed = false;
          return apiError("conflict", 409, { reason: "setup_released" });
        }),
      ],
    });
    await renderApp("/setup", { fetch });
    await user.type(await screen.findByLabelText("Setup token"), "token-0123456789abcdefghijklmnopqrstuv");
    await user.click(screen.getByRole("button", { name: "Continue setup" }));
    expect(await screen.findByRole("button", { name: "Create workspace" })).toBeDefined();
  });

  it("while a required service fails, only the checklist is shown, with a plain fix (M1b-1)", async () => {
    const user = userEvent.setup();
    let failing = true;
    const fetch = healthyFetch({
      me: null,
      routes: [
        on("GET", "/api/me", () => apiError("setup_required", 409)),
        on("GET", "/api/setup", () =>
          jsonResponse({
            setupRequired: true,
            tokenSource: "generated",
            claimed: false,
            services: allServices().map((s) =>
              s.id === "r2" && failing ? { id: "r2", ok: false, problem: "missing" } : s,
            ),
            mode: failing ? "token" : "open",
            ...(failing ? {} : { openUntil: Date.now() + 42 * 60_000 }),
          }),
        ),
      ],
    });
    const { queryClient } = await renderApp("/setup", { fetch });
    await settleQueries(queryClient);
    expect(screen.getByRole("heading", { level: 1, name: "Officebox isn't ready to set up yet" })).toBeDefined();
    const list = screen.getByRole("list", { name: "Required services" });
    expect(
      within(list).getByText("R2 isn't enabled on this Cloudflare account: dashboard → R2, then redeploy."),
    ).toBeDefined();
    expect(within(list).getAllByText("Working")).toHaveLength(5);
    expect(within(list).getByText("Needs attention:")).toBeDefined();
    // The live region gets its text in a zero-delay task after the commit (see ServicesChecklist).
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(screen.getByText("1 required service needs attention.")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Create workspace" })).toBeNull();
    await expectNoViolations();
    failing = false;
    const setupCalls = () => fetch.mock.calls.filter(([url]) => url === "/api/setup").length;
    const before = setupCalls();
    await user.click(screen.getByRole("button", { name: "Check again" }));
    // The button itself started the re-check; wait for that request, not for a findBy timeout.
    expect(setupCalls()).toBe(before + 1);
    await settleQueries(queryClient);
    expect(screen.getByRole("button", { name: "Create workspace" })).toBeDefined();
    // Focus moves to the new page's heading.
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1, name: "Set up your workspace" }));
  });

  it("inside the open window: the notice with the time left, no token needed, and the resume code shown once", async () => {
    const user = userEvent.setup();
    const openUntil = Date.now() + 42 * 60_000 - 1000;
    let posted: unknown = null;
    const fetch = healthyFetch({
      me: null,
      routes: [
        on("GET", "/api/me", () => apiError("setup_required", 409)),
        on("GET", "/api/setup", () =>
          jsonResponse({
            setupRequired: true,
            tokenSource: "generated",
            claimed: false,
            services: allServices(),
            mode: "open",
            openUntil,
          }),
        ),
        (url, init) => {
          if (url !== "/api/setup" || init?.method !== "POST") return undefined;
          posted = JSON.parse(init.body as string);
          return jsonResponse(
            {
              ownerEmail: "sam@example.com",
              enrolmentExpiresInSeconds: 900,
              resumeCode: "resume-code-0123456789abcdefghijklmnopqrstu",
            },
            201,
          );
        },
      ],
    });
    await renderApp("/setup", { fetch });
    expect(await screen.findByText(/No setup token is needed until .* \(42 minutes left\)/)).toBeDefined();
    expect(screen.getByText(/anyone who opens this address can claim this workspace/)).toBeDefined();
    await expectNoViolations();
    await user.type(screen.getByLabelText("Workspace name"), "Acme Studio");
    await user.type(screen.getByLabelText("Your name"), "Sam Lee");
    await user.type(screen.getByLabelText("Email"), "sam@example.com");
    await user.click(screen.getByRole("button", { name: "Create workspace" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Add your passkey" })).toBeDefined();
    expect(posted).not.toHaveProperty("token");
    expect(screen.getByLabelText<HTMLInputElement>("Setup resume code").value).toBe(
      "resume-code-0123456789abcdefghijklmnopqrstu",
    );
    await expectNoViolations();
  });

  it("counts the time left against the server's clock, not a skewed browser clock", async () => {
    // The browser runs 20 minutes fast: the server says it's 20 minutes earlier than the browser thinks.
    const serverNow = Date.now() - 20 * 60_000;
    const fetch = healthyFetch({
      me: null,
      routes: [
        on("GET", "/api/me", () => apiError("setup_required", 409)),
        on("GET", "/api/setup", () =>
          jsonResponse({
            setupRequired: true,
            tokenSource: "generated",
            claimed: false,
            services: allServices(),
            mode: "open",
            openUntil: serverNow + 30 * 60_000 - 1000,
            now: serverNow,
          }),
        ),
      ],
    });
    await renderApp("/setup", { fetch });
    expect(await screen.findByText(/\(30 minutes left\)/)).toBeDefined();
  });

  it("counts against the server's clock when the browser clock is behind, too", async () => {
    // The browser runs 20 minutes slow: the server is 20 minutes ahead of it.
    const serverNow = Date.now() + 20 * 60_000;
    const fetch = healthyFetch({
      me: null,
      routes: [
        on("GET", "/api/me", () => apiError("setup_required", 409)),
        on("GET", "/api/setup", () =>
          jsonResponse({
            setupRequired: true,
            tokenSource: "generated",
            claimed: false,
            services: allServices(),
            mode: "open",
            openUntil: serverNow + 30 * 60_000 - 1000,
            now: serverNow,
          }),
        ),
      ],
    });
    await renderApp("/setup", { fetch });
    // A naive browser-clock count would say 50 minutes.
    expect(await screen.findByText(/\(30 minutes left\)/)).toBeDefined();
  });

  it("a claim refused with setup_token_required keeps what was typed and asks for the token", async () => {
    const user = userEvent.setup();
    const fetch = healthyFetch({
      me: null,
      routes: [
        on("GET", "/api/me", () => apiError("setup_required", 409)),
        on("GET", "/api/setup", () =>
          jsonResponse({
            setupRequired: true,
            tokenSource: "generated",
            claimed: false,
            services: allServices(),
            mode: "open",
            openUntil: Date.now() + 5 * 60_000,
          }),
        ),
        on("POST", "/api/setup", () => apiError("setup_token_required", 403)),
      ],
    });
    await renderApp("/setup", { fetch });
    await user.type(await screen.findByLabelText("Workspace name"), "Acme Studio");
    await user.type(screen.getByLabelText("Your name"), "Sam Lee");
    await user.type(screen.getByLabelText("Email"), "sam@example.com");
    await user.click(screen.getByRole("button", { name: "Create workspace" }));
    const token = await screen.findByLabelText("Setup token");
    await waitFor(() => expect(token.getAttribute("aria-invalid")).toBe("true"));
    expect(screen.getByLabelText<HTMLInputElement>("Workspace name").value).toBe("Acme Studio");
    expect(screen.queryByText(/No setup token is needed/)).toBeNull();
    await expectNoViolations();
  });

  it("announces the time left politely only at 10 minutes and at 1 minute", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const openUntil = Date.now() + 11 * 60_000 - 500;
      const fetch = healthyFetch({
        me: null,
        routes: [
          on("GET", "/api/me", () => apiError("setup_required", 409)),
          on("GET", "/api/setup", () =>
            jsonResponse({
              setupRequired: true,
              tokenSource: "generated",
              claimed: false,
              services: allServices(),
              mode: "open",
              openUntil,
            }),
          ),
        ],
      });
      await renderApp("/setup", { fetch });
      expect(await screen.findByText(/\(11 minutes left\)/)).toBeDefined();
      const live = document.querySelector('[aria-live="polite"]');
      expect(live?.textContent).toBe("");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await screen.findByText(/\(10 minutes left\)/)).toBeDefined();
      expect(live?.textContent).toBe("10 minutes left to set up without a setup token.");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await screen.findByText(/\(9 minutes left\)/)).toBeDefined();
      expect(live?.textContent).toBe("10 minutes left to set up without a setup token.");
      for (let minute = 9; minute > 1; minute--) {
        await vi.advanceTimersByTimeAsync(60_000);
        expect(await screen.findByText(new RegExp(`\\((${minute - 1}) minutes? left\\)`))).toBeDefined();
      }
      expect(await screen.findByText(/\(1 minute left\)/)).toBeDefined();
      expect(live?.textContent).toBe("1 minute left to set up without a setup token.");
      // When the window ends, the page asks for the token.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await screen.findByLabelText("Setup token")).toBeDefined();
      expect(screen.queryByText(/No setup token is needed/)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("after setup, /setup says so and links to sign-in", async () => {
    await renderApp("/setup", {
      fetch: healthyFetch({ routes: [on("GET", "/api/setup", () => apiError("not_found", 404))] }),
    });
    expect(await screen.findByText("This workspace is already set up.")).toBeDefined();
    expect(screen.getByRole("link", { name: "Sign in" })).toBeDefined();
  });
});

describe("sign-in (Identity §4.4)", () => {
  it("signed out, the app sends you to sign-in and back after a passkey sign-in", async () => {
    const user = userEvent.setup();
    let signedIn = false;
    const fetch = healthyFetch({
      me: null,
      routes: [
        on("GET", "/api/me", () => (signedIn ? jsonResponse(TEST_ME) : apiError("unauthenticated", 401))),
        on("GET", "/api/auth/passkey/generate-authenticate-options", options),
        on("POST", "/api/auth/passkey/verify-authentication", () => {
          signedIn = true;
          return jsonResponse({ user: { id: TEST_ME.user.id } });
        }),
      ],
    });
    const { router } = await renderApp("/calendar", { fetch });
    await waitFor(() => expect(router.state.location.pathname).toBe("/sign-in"));
    expect(await screen.findByRole("heading", { level: 1, name: "Sign in" })).toBeDefined();
    await expectNoViolations();
    await user.click(screen.getByRole("button", { name: "Sign in with a passkey" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/calendar"));
  });

  it("explains a refused clone and a cancelled prompt", async () => {
    const user = userEvent.setup();
    const fetch = healthyFetch({
      me: null,
      routes: [
        on("GET", "/api/auth/passkey/generate-authenticate-options", options),
        on("POST", "/api/auth/passkey/verify-authentication", () =>
          apiError("forbidden", 403, { reason: "clone_detected" }),
        ),
      ],
    });
    await renderApp("/sign-in", { fetch });
    await user.click(await screen.findByRole("button", { name: "Sign in with a passkey" }));
    expect(await screen.findByText(/looks like a copy/)).toBeDefined();
    webauthn.startAuthentication.mockRejectedValueOnce(Object.assign(new Error("x"), { name: "NotAllowedError" }));
    await user.click(screen.getByRole("button", { name: "Sign in with a passkey" }));
    expect(await screen.findByText(/cancelled or timed out/)).toBeDefined();
  });

  it("only same-origin paths are accepted as the redirect", () => {
    expect(safeRedirect("/calendar?x=1", "https://a.test")).toBe("/calendar?x=1");
    expect(safeRedirect("//evil.test", "https://a.test")).toBe("/");
    expect(safeRedirect("https://evil.test", "https://a.test")).toBe("/");
    expect(safeRedirect("/\\evil.test", "https://a.test")).toBe("/");
    expect(safeRedirect("/sign-in", "https://a.test")).toBe("/");
  });
});

describe("passkeys, step-up and the banner (Identity §4.4, §4.5, §4.6a)", () => {
  const passkeyList = (n: number) =>
    jsonResponse({
      passkeys: Array.from({ length: n }, (_, i) => ({
        id: `01JPASSKEY00000000000000${i}${i}`,
        name: i === 0 ? "Laptop" : null,
        createdVia: i === 0 ? "setup" : "signed_in",
        createdAt: 1_700_000_000_000,
        lastUsedAt: null,
        deviceType: "multiDevice",
        backedUp: i === 0,
      })),
    });

  it("lists passkeys with how each was created, and reminds an owner with one to add another", async () => {
    const fetch = healthyFetch({
      me: { ...TEST_ME, passkeyCount: 1 },
      routes: [on("GET", "/api/me/passkeys", () => passkeyList(1))],
    });
    await renderApp("/settings/passkeys", { fetch });
    const list = await screen.findByRole("region", { name: "Your passkeys" });
    expect(within(list).getByText("Laptop")).toBeDefined();
    expect(within(list).getByText("Created during setup")).toBeDefined();
    expect(screen.getByText(/You have one passkey/)).toBeDefined();
    await expectNoViolations();
  });

  it("adding a passkey asks for step-up with a passkey, then retries", async () => {
    const user = userEvent.setup();
    let fresh = false;
    const fetch = healthyFetch({
      routes: [
        on("GET", "/api/me/passkeys", () => passkeyList(2)),
        on("GET", "/api/auth/passkey/generate-register-options", () =>
          fresh ? options() : apiError("reauth_required", 403, { reason: "reauth_required" }),
        ),
        on("POST", "/api/me/reauth/options", options),
        on("POST", "/api/me/reauth", () => {
          fresh = true;
          return jsonResponse({ freshAuthAt: Date.now() });
        }),
        on("POST", "/api/auth/passkey/verify-registration", () => jsonResponse({ id: "p" })),
      ],
    });
    await renderApp("/settings/passkeys", { fetch });
    await user.click(await screen.findByRole("button", { name: "Add a passkey" }));
    const dialog = await screen.findByRole("dialog", { name: "Confirm it's you" });
    await expectNoViolations();
    await user.click(within(dialog).getByRole("button", { name: "Use passkey" }));
    expect(await screen.findByText("Passkey added.")).toBeDefined();
    expect(webauthn.startAuthentication).toHaveBeenCalledTimes(1);
    expect(webauthn.startRegistration).toHaveBeenCalledTimes(1);
  });

  it("removing the last passkey explains why it can't", async () => {
    const user = userEvent.setup();
    const fetch = healthyFetch({
      routes: [
        on("GET", "/api/me/passkeys", () => passkeyList(1)),
        (url, init) =>
          url.startsWith("/api/me/passkeys/") && init?.method === "DELETE"
            ? apiError("forbidden", 403, { reason: "last_passkey" })
            : undefined,
      ],
    });
    await renderApp("/settings/passkeys", { fetch });
    await user.click(await screen.findByRole("button", { name: "Remove Laptop" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove passkey" });
    await user.click(within(dialog).getByRole("button", { name: "Remove" }));
    expect(await within(dialog).findByText(/only passkey/)).toBeDefined();
  });

  it("shows the security banner and acknowledges it after a fresh passkey", async () => {
    const user = userEvent.setup();
    let acked = false;
    let fresh = false;
    const notice = {
      id: "01JABCDEFGHJKMNPQRSTVWXYZ1",
      kind: "passkey_added",
      at: 1_700_000_000_000,
      details: { createdVia: "signed_in", passkeyName: "Phone" },
    };
    const fetch = healthyFetch({
      me: null,
      routes: [
        on("GET", "/api/me", () => jsonResponse({ ...TEST_ME, securityNotices: acked ? [] : [notice] })),
        on("POST", "/api/me/security-notices/ack", () => {
          if (!fresh) return apiError("reauth_required", 403, { reason: "reauth_required" });
          acked = true;
          return jsonResponse({ acknowledged: 1 });
        }),
        on("POST", "/api/me/reauth/options", options),
        on("POST", "/api/me/reauth", () => {
          fresh = true;
          return jsonResponse({ freshAuthAt: Date.now() });
        }),
      ],
    });
    await renderApp("/", { fetch });
    const banner = await screen.findByRole("region", { name: "Security notices" });
    expect(within(banner).getByText(/“Phone” was added/)).toBeDefined();
    await expectNoViolations();
    await user.click(within(banner).getByRole("button", { name: "I've seen these" }));
    await user.click(
      within(await screen.findByRole("dialog", { name: "Confirm it's you" })).getByRole("button", {
        name: "Use passkey",
      }),
    );
    await waitFor(() => expect(screen.queryByRole("region", { name: "Security notices" })).toBeNull());
  });

  it("My devices lists sessions and offers sign out everywhere", async () => {
    const fetch = healthyFetch({
      routes: [
        on("GET", "/api/me/sessions", () =>
          jsonResponse({
            sessions: [
              {
                id: "01JABCDEFGHJKMNPQRSTVWXY01",
                deviceLabel: "Chrome on macOS",
                approxLocation: null,
                createdAt: 1,
                lastSeenAt: 2,
                current: true,
              },
              {
                id: "01JABCDEFGHJKMNPQRSTVWXY02",
                deviceLabel: "Safari on iOS",
                approxLocation: "Leeds, GB",
                createdAt: 1,
                lastSeenAt: 2,
                current: false,
              },
            ],
          }),
        ),
      ],
    });
    await renderApp("/settings/devices", { fetch });
    const list = await screen.findByRole("region", { name: "Signed-in devices" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(within(list).getByText("This device")).toBeDefined();
    expect(screen.getByRole("button", { name: "Sign out everywhere" })).toBeDefined();
    await expectNoViolations();
  });
});

describe("/not-configured", () => {
  it("is shown when the Worker's identity secrets aren't set", async () => {
    const fetch = healthyFetch({ me: null, routes: [on("GET", "/api/me", () => apiError("unavailable", 503))] });
    const { router } = await renderApp("/", { fetch });
    await waitFor(() => expect(router.state.location.pathname).toBe("/not-configured"));
    expect(
      await screen.findByRole("heading", { level: 1, name: "This workspace isn't fully configured yet" }),
    ).toBeDefined();
    await expectNoViolations();
  });
});

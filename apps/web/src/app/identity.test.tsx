import type { DeviceSession } from "@officebox/shared";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { describe, expect, it, vi } from "vitest";
import { apiError, healthyFetch, jsonResponse, renderApp, TEST_ME, type Route } from "../test/render-app";
import { suggestHandle } from "./forms";
import { safeRedirect } from "./routes/sign-in";

async function expectNoViolations() {
  const results = await axe.run(document.body, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"] },
    rules: { "color-contrast": { enabled: false } },
  });
  expect(results.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target.join(" ")) }))).toEqual([]);
}

function bodyOf(init: RequestInit | undefined): unknown {
  return typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
}

const SESSIONS: DeviceSession[] = [
  {
    id: "01JABCDEFGHJKMNPQRSTVWXY01",
    deviceLabel: "Chrome on macOS",
    approxLocation: "London, GB",
    createdAt: 1_700_000_000_000,
    lastSeenAt: 1_700_000_500_000,
    current: true,
  },
  {
    id: "01JABCDEFGHJKMNPQRSTVWXY02",
    deviceLabel: "Firefox on Windows",
    approxLocation: null,
    createdAt: 1_700_000_000_000,
    lastSeenAt: 1_700_000_100_000,
    current: false,
  },
];

describe("routing by session state", () => {
  it("sends a signed-out visitor to sign-in and back to where they were going", async () => {
    const user = userEvent.setup();
    let signedIn = false;
    const fetch = healthyFetch({
      me: null,
      routes: [
        (url) => (url === "/api/me" && signedIn ? jsonResponse(TEST_ME) : undefined),
        (url, init) => {
          if (url !== "/api/auth/password") return undefined;
          expect(bodyOf(init)).toEqual({ email: "sam@example.com", password: "a long password" });
          expect((init?.headers as Record<string, string>)["X-Officebox-Request"]).toBe("1");
          signedIn = true;
          return jsonResponse(TEST_ME);
        },
      ],
    });
    const { router } = await renderApp("/calendar", { fetch });
    expect(router.state.location.pathname).toBe("/sign-in");
    expect(router.state.location.search).toMatchObject({ redirect: "/calendar" });
    expect(await screen.findByRole("heading", { level: 1, name: "Sign in" })).toBeDefined();
    await expectNoViolations();

    await user.type(screen.getByLabelText("Email"), "sam@example.com");
    await user.type(screen.getByLabelText("Password"), "a long password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Calendar" })).toBeDefined();
    expect(router.state.location.pathname).toBe("/calendar");
    expect(screen.getByRole("banner")).toHaveProperty("textContent", expect.stringContaining("Acme") as string);
  });

  it("sends everyone to /setup before first-run setup", async () => {
    const fetch = healthyFetch({
      routes: [
        (url) => (url === "/api/me" ? apiError("setup_required", 409) : undefined),
        (url) => (url === "/api/setup" ? jsonResponse({ setupRequired: true, tokenSource: "generated" }) : undefined),
      ],
    });
    const { router } = await renderApp("/", { fetch });
    expect(router.state.location.pathname).toBe("/setup");
    expect(await screen.findByRole("heading", { level: 1, name: "Set up your workspace" })).toBeDefined();
  });

  it("refreshes an expired access cookie once and retries, without bothering the person", async () => {
    let refreshed = false;
    const fetch = healthyFetch({
      routes: [
        (url) => (url === "/api/me" && !refreshed ? apiError("unauthenticated", 401) : undefined),
        (url) => {
          if (url !== "/api/auth/refresh") return undefined;
          refreshed = true;
          return jsonResponse(null);
        },
      ],
    });
    const { router } = await renderApp("/chat", { fetch });
    expect(router.state.location.pathname).toBe("/chat");
    expect(await screen.findByRole("heading", { level: 1, name: "Chat" })).toBeDefined();
    expect(fetch.mock.calls.filter(([url]) => url === "/api/auth/refresh")).toHaveLength(1);
  });

  it("goes to sign-in with a notice when the session ends while using the app", async () => {
    let expired = false;
    const fetch = healthyFetch({
      routes: [
        (url) =>
          url === "/api/me/sessions"
            ? expired
              ? apiError("unauthenticated", 401)
              : jsonResponse({ sessions: SESSIONS })
            : undefined,
      ],
    });
    const { router, queryClient } = await renderApp("/settings/devices", { fetch });
    expect(await screen.findByText("Firefox on Windows")).toBeDefined();
    expired = true;
    await queryClient.refetchQueries({ queryKey: ["me", "sessions"] });
    await waitFor(() => expect(router.state.location.pathname).toBe("/sign-in"));
    expect(router.state.location.search).toMatchObject({ redirect: "/settings/devices", reason: "expired" });
    expect(await screen.findByText("Your session has ended. Sign in again to continue.")).toBeDefined();
  });

  it("shows Admin in the navigation to owners and admins only", async () => {
    await renderApp("/", { fetch: healthyFetch({ me: { ...TEST_ME, user: { ...TEST_ME.user, role: "member" } } }) });
    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(within(nav).queryByRole("link", { name: "Admin" })).toBeNull();
    expect(within(nav).getByRole("link", { name: "Chat" })).toBeDefined();
  });
});

describe("sign-in page", () => {
  async function submit(routes: Route[]) {
    const user = userEvent.setup();
    await renderApp("/sign-in", { fetch: healthyFetch({ me: null, routes }) });
    await user.type(await screen.findByLabelText("Email"), "sam@example.com");
    await user.type(screen.getByLabelText("Password"), "wrong password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
  }

  it("says the email or password is incorrect, without saying which", async () => {
    await submit([(url) => (url === "/api/auth/password" ? apiError("invalid_credentials", 401) : undefined)]);
    const alert = await screen.findByText("The email or password is incorrect.");
    expect(alert.closest("[role=alert]")).not.toBeNull();
    expect(screen.getByLabelText<HTMLInputElement>("Password").value).toBe("");
  });

  it("says how long to wait when rate-limited", async () => {
    await submit([
      (url) => (url === "/api/auth/password" ? apiError("rate_limited", 429, { retryAfterSeconds: 4 }) : undefined),
    ]);
    expect(await screen.findByText("Too many sign-in attempts. Try again in 4 seconds.")).toBeDefined();
  });

  it("checks fields before sending and moves focus to the first problem", async () => {
    const user = userEvent.setup();
    const { fetch } = await renderApp("/sign-in", { fetch: healthyFetch({ me: null }) });
    await user.click(await screen.findByRole("button", { name: "Sign in" }));
    const email = screen.getByLabelText("Email");
    await waitFor(() => expect(document.activeElement).toBe(email));
    expect(email.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getAllByText("Fill in this field.")).toHaveLength(2);
    expect(vi.mocked(fetch).mock.calls.some(([url]) => url === "/api/auth/password")).toBe(false);
    await expectNoViolations();
  });

  it("only follows same-origin redirects", () => {
    expect(safeRedirect("/chat?x=1")).toBe("/chat?x=1");
    expect(safeRedirect("//evil.example")).toBe("/");
    expect(safeRedirect("https://evil.example")).toBe("/");
    expect(safeRedirect("/\\evil.example")).toBe("/");
    expect(safeRedirect("/sign-in")).toBe("/");
    expect(safeRedirect(undefined)).toBe("/");
  });
});

describe("setup page", () => {
  const setupRoutes = (onPost: Route): Route[] => [
    (url) => (url === "/api/me" ? apiError("setup_required", 409) : undefined),
    (url, init) => {
      if (url !== "/api/setup") return undefined;
      return init?.method === "POST"
        ? onPost(url, init)
        : jsonResponse({ setupRequired: true, tokenSource: "generated" });
    },
  ];

  it("creates the workspace and goes to sign-in with the email filled in", async () => {
    const user = userEvent.setup();
    let posted: unknown;
    const fetch = healthyFetch({
      me: null,
      routes: setupRoutes((_url, init) => {
        posted = bodyOf(init);
        return jsonResponse({ ownerEmail: "sam@example.com" }, 201);
      }),
    });
    const { router } = await renderApp("/setup", { fetch });
    expect(await screen.findByText(/Workers & Pages → officebox → Logs/)).toBeDefined();
    await expectNoViolations();

    await user.type(screen.getByLabelText("Setup token"), "the-token");
    await user.type(screen.getByLabelText("Workspace name"), "Acme");
    await user.type(screen.getByLabelText("Your name"), "Sam Lee");
    expect(screen.getByLabelText<HTMLInputElement>("Handle").value).toBe("sam.lee");
    await user.type(screen.getByLabelText("Email"), "sam@example.com");
    await user.type(screen.getByLabelText("Password"), "correct horse battery");
    await user.click(screen.getByRole("button", { name: "Create workspace" }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/sign-in"));
    expect(posted).toEqual({
      token: "the-token",
      workspaceName: "Acme",
      ownerName: "Sam Lee",
      ownerHandle: "sam.lee",
      ownerEmail: "sam@example.com",
      password: "correct horse battery",
    });
    expect((await screen.findByLabelText<HTMLInputElement>("Email")).value).toBe("sam@example.com");
    expect(await screen.findByText("Your workspace is ready. Sign in to continue.")).toBeDefined();
  });

  it("shows field problems before sending, and a refused token on the token field", async () => {
    const user = userEvent.setup();
    const fetch = healthyFetch({ me: null, routes: setupRoutes(() => apiError("forbidden", 403)) });
    await renderApp("/setup", { fetch });
    await user.type(await screen.findByLabelText("Password"), "password123");
    await user.click(screen.getByRole("button", { name: "Create workspace" }));
    expect(await screen.findByText("That password is too common. Choose something harder to guess.")).toBeDefined();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Setup token")));
    await expectNoViolations();

    await user.type(screen.getByLabelText("Setup token"), "bad");
    await user.type(screen.getByLabelText("Workspace name"), "Acme");
    await user.type(screen.getByLabelText("Your name"), "Sam");
    await user.type(screen.getByLabelText("Email"), "sam@example.com");
    await user.clear(screen.getByLabelText("Password"));
    await user.type(screen.getByLabelText("Password"), "correct horse battery");
    await user.click(screen.getByRole("button", { name: "Create workspace" }));
    expect(await screen.findByText("This setup token isn't valid. Check it and try again.")).toBeDefined();
    expect(screen.getByLabelText("Setup token").getAttribute("aria-invalid")).toBe("true");
  });

  it("points to sign-in once the workspace is set up", async () => {
    await renderApp("/setup", { fetch: healthyFetch({ me: null }) });
    expect(await screen.findByText("This workspace is already set up.")).toBeDefined();
    expect(screen.getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe("/sign-in");
  });

  it("suggests handles from names", () => {
    expect(suggestHandle("Sam Lee")).toBe("sam.lee");
    expect(suggestHandle("  Zoë O'Brien ")).toBe("zoe.o.brien");
    expect(suggestHandle("!!!")).toBe("");
  });
});

describe("account menu and My devices", () => {
  it("shows who is signed in, links to My devices and signs out", async () => {
    const user = userEvent.setup();
    let signedOut = false;
    const fetch = healthyFetch({
      routes: [
        (url) => (url === "/api/me" && signedOut ? apiError("unauthenticated", 401) : undefined),
        (url) => {
          if (url !== "/api/auth/sign-out") return undefined;
          signedOut = true;
          return jsonResponse(null);
        },
      ],
    });
    const { router } = await renderApp("/", { fetch });
    await user.click(screen.getByRole("button", { name: "Account" }));
    expect(screen.getByText("Sam Lee")).toBeDefined();
    expect(screen.getByText("sam@example.com")).toBeDefined();
    expect(screen.getByRole("link", { name: "My devices" }).getAttribute("href")).toBe("/settings/devices");
    await expectNoViolations();
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/sign-in"));
    expect(await screen.findByText("You've been signed out.")).toBeDefined();
  });

  it("lists devices, marks this one, and signs out another", async () => {
    const user = userEvent.setup();
    let sessions = SESSIONS;
    const deleted: string[] = [];
    const fetch = healthyFetch({
      routes: [
        (url) => (url === "/api/me/sessions" ? jsonResponse({ sessions }) : undefined),
        (url, init) => {
          if (!url.startsWith("/api/me/sessions/") || init?.method !== "DELETE") return undefined;
          deleted.push(url);
          sessions = sessions.filter((s) => !url.endsWith(s.id));
          return jsonResponse(null);
        },
      ],
    });
    await renderApp("/settings/devices", { fetch });
    expect(await screen.findByRole("heading", { level: 1, name: "My devices" })).toBeDefined();
    const list = await screen.findByRole("region", { name: "Signed-in devices" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(within(items[0]!).getByText("This device")).toBeDefined();
    expect(within(items[0]!).queryByRole("button")).toBeNull();
    expect(within(items[1]!).getByText("Location unknown")).toBeDefined();
    await expectNoViolations();

    await user.click(screen.getByRole("button", { name: "Sign out Firefox on Windows" }));
    await waitFor(() => expect(screen.queryByText("Firefox on Windows")).toBeNull());
    expect(deleted).toEqual([`/api/me/sessions/${SESSIONS[1]!.id}`]);
    expect(screen.getByText("Only this device is signed in.")).toBeDefined();
  });

  it("signs out everywhere after confirming", async () => {
    const user = userEvent.setup();
    let called = 0;
    const fetch = healthyFetch({
      routes: [
        (url) => (url === "/api/me/sessions" ? jsonResponse({ sessions: SESSIONS }) : undefined),
        (url) => {
          if (url !== "/api/auth/sign-out-everywhere") return undefined;
          called++;
          return jsonResponse(null);
        },
      ],
    });
    const { router } = await renderApp("/settings/devices", { fetch });
    await user.click(await screen.findByRole("button", { name: "Sign out everywhere" }));
    const dialog = screen.getByRole("dialog", { name: "Sign out everywhere" });
    await expectNoViolations();
    await user.click(within(dialog).getByRole("button", { name: "Sign out everywhere" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/sign-in"));
    expect(called).toBe(1);
  });

  it("signs out all other devices", async () => {
    const user = userEvent.setup();
    let posted = false;
    const fetch = healthyFetch({
      routes: [
        (url) =>
          url === "/api/me/sessions" ? jsonResponse({ sessions: posted ? [SESSIONS[0]] : SESSIONS }) : undefined,
        (url) => {
          if (url !== "/api/me/sessions/sign-out-others") return undefined;
          posted = true;
          return jsonResponse({ signedOut: 1 });
        },
      ],
    });
    await renderApp("/settings/devices", { fetch });
    await user.click(await screen.findByRole("button", { name: "Sign out all other devices" }));
    expect(await screen.findByText("Signed out 1 other device.")).toBeDefined();
    await waitFor(() => expect(screen.queryByText("Firefox on Windows")).toBeNull());
  });
});

import { DEFAULT_WORKING_HOURS, type MemberProfile, type MyProfile } from "@officebox/shared";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { describe, expect, it } from "vitest";
import { apiError, healthyFetch, jsonResponse, renderApp, TEST_ME, type Route } from "../test/render-app";

/**
 * M1d pages in jsdom (Identity §4.7, §4.10, §7 screens 6–7): profile and status, and the directory with
 * the profile card. Colour contrast and the real upload are covered by the Playwright run.
 */

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
    url.split("?")[0] === path && (init?.method ?? "GET").toUpperCase() === method ? answer(init) : undefined;

const bodyOf = (init: RequestInit | undefined) =>
  JSON.parse(typeof init?.body === "string" ? init.body : "null") as Record<string, unknown>;

const MEMBER: MemberProfile = {
  id: TEST_ME.user.id,
  displayName: "Sam Lee",
  handle: "sam",
  email: "sam@example.com",
  avatarUrl: null,
  jobTitle: "Designer",
  team: "Brand",
  pronouns: "she/her",
  phone: null,
  location: null,
  timezone: "Europe/London",
  workingHours: DEFAULT_WORKING_HOURS,
  workingHoursDefaulted: true,
  region: "GB-ENG",
  status: { emoji: "🌴", text: "On holiday", expiresAt: null },
  deactivated: false,
  groups: [],
};
const PROFILE: MyProfile = { ...MEMBER, onboardedAt: 1, handleChangesLeft: 3 };

describe("profile and status (M1d)", () => {
  it("shows the profile, passes axe, and saves only valid changes", async () => {
    const user = userEvent.setup();
    const patches: Record<string, unknown>[] = [];
    const fetch = healthyFetch({
      routes: [
        on("GET", "/api/me/profile", () => jsonResponse(PROFILE)),
        on("PATCH", "/api/me/profile", (init) => {
          patches.push(bodyOf(init));
          return jsonResponse({ ...PROFILE, jobTitle: "Lead" });
        }),
      ],
    });
    await renderApp("/settings/profile", { fetch });
    expect(await screen.findByLabelText("Job title")).toHaveProperty("value", "Designer");
    expect(screen.getByTestId("current-status").textContent).toBe("🌴 On holiday");
    await expectNoViolations();

    // A reserved handle is refused on the page, before any request.
    const handle = screen.getByLabelText("Handle");
    await user.clear(handle);
    await user.type(handle, "everyone");
    await user.click(screen.getByRole("button", { name: "Save profile" }));
    expect(handle.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(handle);
    expect(patches).toHaveLength(0);

    await user.clear(handle);
    await user.type(handle, "sam");
    const title = screen.getByLabelText("Job title");
    await user.clear(title);
    await user.type(title, "Lead");
    await user.click(screen.getByRole("button", { name: "Save profile" }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toMatchObject({ jobTitle: "Lead", region: "GB-ENG", timezone: "Europe/London" });
    // Unchanged handle and untouched default hours aren't sent.
    expect(patches[0]).not.toHaveProperty("handle");
    expect(patches[0]).not.toHaveProperty("workingHours");
  });

  it("shows a taken handle from the server on the field", async () => {
    const user = userEvent.setup();
    const fetch = healthyFetch({
      routes: [
        on("GET", "/api/me/profile", () => jsonResponse(PROFILE)),
        on("GET", "/api/handles/ana/available", () =>
          jsonResponse({ handle: "ana", available: false, yours: false, reason: "taken" }),
        ),
        on("PATCH", "/api/me/profile", () => apiError("conflict", 409, { reason: "handle_taken" })),
      ],
    });
    await renderApp("/settings/profile", { fetch });
    const handle = await screen.findByLabelText("Handle");
    await user.clear(handle);
    await user.type(handle, "ana");
    await user.tab();
    expect(await screen.findByText("That handle is taken.")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Save profile" }));
    await waitFor(() => expect(handle.getAttribute("aria-invalid")).toBe("true"));
  });

  it("refuses more than one emoji in a status", async () => {
    const user = userEvent.setup();
    const fetch = healthyFetch({ routes: [on("GET", "/api/me/profile", () => jsonResponse(PROFILE))] });
    await renderApp("/settings/profile", { fetch });
    const emoji = await screen.findByLabelText("Emoji");
    await user.clear(emoji);
    await user.type(emoji, "🌴🌴");
    await user.click(screen.getByRole("button", { name: "Set status" }));
    expect(await screen.findByText("Use a single emoji.")).toBeDefined();
    expect(fetch.mock.calls.some(([url]) => url === "/api/me/status")).toBe(false);
  });

  it("suggests a region only during profile setup; a cleared region stays cleared", async () => {
    const cleared = healthyFetch({
      routes: [on("GET", "/api/me/profile", () => jsonResponse({ ...PROFILE, region: null, onboardedAt: 1 }))],
    });
    const first = await renderApp("/settings/profile", { fetch: cleared });
    expect((await screen.findByLabelText<HTMLSelectElement>("Country or region")).value).toBe("");
    first.unmount();

    const settingUp = healthyFetch({
      routes: [on("GET", "/api/me/profile", () => jsonResponse({ ...PROFILE, region: null, onboardedAt: null }))],
    });
    await renderApp("/settings/profile", { fetch: settingUp });
    const suggested = navigator.languages.map((tag) => new Intl.Locale(tag).maximize().region).find(Boolean) ?? "";
    expect((await screen.findByLabelText<HTMLSelectElement>("Country or region")).value).toBe(suggested);
  });

  it("is the profile setup step after accepting an invitation, with a way to skip", async () => {
    const fetch = healthyFetch({ routes: [on("GET", "/api/me/profile", () => jsonResponse(PROFILE))] });
    await renderApp("/settings/profile?welcome=1", { fetch });
    expect(await screen.findByRole("link", { name: "Skip for now" })).toBeDefined();
  });
});

describe("the member directory (M1d)", () => {
  it("lists members, searches, opens the profile card and passes axe", async () => {
    const user = userEvent.setup();
    const queries: string[] = [];
    const fetch = healthyFetch({
      routes: [
        (url) => {
          if (url.startsWith("/api/members?")) queries.push(url);
          return undefined;
        },
        on("GET", "/api/members", () => jsonResponse({ members: [MEMBER], nextCursor: null })),
        on("GET", `/api/members/${MEMBER.id}`, () => jsonResponse(MEMBER)),
      ],
    });
    await renderApp("/directory", { fetch });
    const row = await screen.findByRole("button", { name: /^Sam Lee/ });
    expect(row.textContent).toContain("On holiday");
    expect(screen.getByText("1 person.").getAttribute("role")).toBe("status");
    await expectNoViolations();

    await user.type(screen.getByLabelText("Search people"), "brand");
    await waitFor(() => expect(queries.some((q) => q.includes("q=brand"))).toBe(true));

    await user.click(await screen.findByRole("button", { name: /^Sam Lee/ }));
    const card = await screen.findByRole("dialog", { name: "Sam Lee" });
    expect(within(card).getByText("Mon–Fri 09:00–17:00 (default)")).toBeDefined();
    expect(within(card).getByRole("link", { name: "sam@example.com" }).getAttribute("href")).toBe(
      "mailto:sam@example.com",
    );
    await expectNoViolations();

    await user.click(screen.getByRole("button", { name: "Deactivated" }));
    await waitFor(() => expect(queries.some((q) => q.includes("filter=deactivated"))).toBe(true));
  });
});

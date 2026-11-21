import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { DEFAULT_WORKING_HOURS } from "@officebox/shared";
import { describe, expect, it } from "vitest";
import { apiError, healthyFetch, jsonResponse, renderApp, TEST_ME, type Route } from "../test/render-app";

/**
 * M1e pages (Identity §4.9, §4.11, §7 screen 8; Admin §3, §5): members administration (the Manage
 * dialog: role, deactivate, sign out, delete) and groups (list, create, a group's page). The API decides;
 * these check the requests sent, the `aria-disabled` reasons, and axe.
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
    url === path && (init?.method ?? "GET").toUpperCase() === method ? answer(init) : undefined;

const bodyOf = (init: RequestInit | undefined) =>
  (JSON.parse(typeof init?.body === "string" ? init.body : "null") ?? {}) as Record<string, unknown>;

/** The member-list row of the person named `name` (the name also appears in the account menu). */
async function rowOf(name: string): Promise<HTMLElement> {
  const table = await screen.findByRole("table");
  const row = within(table).getByText(name).closest("tr");
  if (!row) throw new Error(`no row for ${name}`);
  return row;
}

const ANA = {
  id: "01JABCDEFGHJKMNPQRSTVWXYZ1",
  email: "ana@example.com",
  displayName: "Ana Diaz",
  handle: "ana",
  role: "member",
  status: "active",
  passkeyCount: 1,
  recoveryFlag: null,
  pendingEmail: null,
  groups: [{ id: "01JABCDEFGHJKMNPQRSTVWXYZ9", name: "Design", handle: "design" }],
  lastActiveAt: Date.UTC(2026, 10, 20),
  joinedAt: Date.UTC(2026, 9, 1),
  pendingSecurityNotice: false,
};
const OWNER_ROW = {
  ...ANA,
  id: TEST_ME.user.id,
  email: TEST_ME.user.email,
  displayName: "Sam Lee",
  handle: "sam",
  role: "owner",
  passkeyCount: 2,
  groups: [],
};

describe("members administration (Identity §4.11; Admin §5)", () => {
  it("shows groups and activity; the Manage dialog changes a role, deactivates, signs out and deletes", async () => {
    const user = userEvent.setup();
    const fetch = healthyFetch({
      routes: [
        (url, init) =>
          url.startsWith("/api/admin/members") && (init?.method ?? "GET") === "GET"
            ? jsonResponse({ members: [OWNER_ROW, ANA] })
            : undefined,
        on("PATCH", `/api/admin/members/${ANA.id}`, (init) => {
          const body = bodyOf(init);
          return jsonResponse({
            id: ANA.id,
            role: body.role ?? "member",
            status: body.status ?? "active",
            changed: true,
          });
        }),
        on("POST", `/api/admin/members/${ANA.id}/sign-out`, () => jsonResponse({ signedOut: 2 })),
        on("DELETE", `/api/admin/members/${ANA.id}`, () => jsonResponse({ id: ANA.id, deleted: true })),
      ],
    });
    await renderApp("/admin/members", { fetch });
    const row = await rowOf("Ana Diaz");
    expect(within(row).getByText("Design")).toBeDefined();
    await expectNoViolations();

    // The filters send their values.
    await user.selectOptions(screen.getByLabelText("Status"), "disabled");
    await waitFor(() =>
      expect(fetch.mock.calls.some(([url]) => url === "/api/admin/members?status=disabled")).toBe(true),
    );
    await user.selectOptions(screen.getByLabelText("Status"), "");

    await user.click(within(row).getByRole("button", { name: "Manage Ana Diaz" }));
    const dialog = await screen.findByRole("dialog", { name: "Manage Ana Diaz" });
    await expectNoViolations();
    await user.selectOptions(within(dialog).getByLabelText("Workspace role"), "admin");
    await user.click(within(dialog).getByRole("button", { name: "Change role" }));
    await waitFor(() =>
      expect(
        fetch.mock.calls.some(([url, init]) => url === `/api/admin/members/${ANA.id}` && bodyOf(init).role === "admin"),
      ).toBe(true),
    );

    await user.click(within(dialog).getByRole("button", { name: "Sign out of all devices" }));
    expect(await screen.findByText("Signed out of 2 sessions.")).toBeDefined();

    await user.click(within(dialog).getByRole("button", { name: "Deactivate" }));
    expect(within(dialog).getByText(/They're signed out everywhere at once/)).toBeDefined();
    await user.click(within(dialog).getByRole("button", { name: "Deactivate" }));
    await waitFor(() => expect(fetch.mock.calls.some(([, init]) => bodyOf(init).status === "disabled")).toBe(true));

    await user.click(within(dialog).getByRole("button", { name: "Delete account" }));
    const confirm = within(dialog).getByRole("button", { name: "Delete account" });
    expect(confirm).toHaveProperty("disabled", true);
    await user.click(within(dialog).getByLabelText("I understand this can't be undone"));
    await expectNoViolations();
    await user.click(within(dialog).getByRole("button", { name: "Delete account" }));
    await waitFor(() =>
      expect(
        fetch.mock.calls.some(([url, init]) => url === `/api/admin/members/${ANA.id}` && init?.method === "DELETE"),
      ).toBe(true),
    );
  });

  it("an admin sees the owners' controls aria-disabled with the reason, and sends nothing", async () => {
    const user = userEvent.setup();
    const fetch = healthyFetch({
      me: { ...TEST_ME, user: { ...TEST_ME.user, id: "01JABCDEFGHJKMNPQRSTVWXYZ2", role: "admin" } },
      routes: [on("GET", "/api/admin/members", () => jsonResponse({ members: [OWNER_ROW, ANA] }))],
    });
    await renderApp("/admin/members", { fetch });
    const row = await rowOf("Sam Lee");
    await user.click(within(row).getByRole("button", { name: "Manage Sam Lee" }));
    const dialog = await screen.findByRole("dialog", { name: "Manage Sam Lee" });
    const deactivate = within(dialog).getByRole("button", { name: "Deactivate" });
    expect(deactivate.getAttribute("aria-disabled")).toBe("true");
    expect(within(dialog).getAllByText("An owner must do this.").length).toBeGreaterThan(0);
    await user.click(deactivate);
    expect(fetch.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
    await user.selectOptions(within(dialog).getByLabelText("Workspace role"), "admin");
    expect(within(dialog).getByText("Only owners can change roles.")).toBeDefined();
    await expectNoViolations();
  });

  it("explains the last-owner refusal", async () => {
    const user = userEvent.setup();
    const fetch = healthyFetch({
      routes: [
        on("GET", "/api/admin/members", () => jsonResponse({ members: [OWNER_ROW, ANA] })),
        on("PATCH", `/api/admin/members/${OWNER_ROW.id}`, () => apiError("forbidden", 403, { reason: "last_owner" })),
      ],
    });
    await renderApp("/admin/members", { fetch });
    const row = await rowOf("Sam Lee");
    await user.click(within(row).getByRole("button", { name: "Manage Sam Lee" }));
    const dialog = await screen.findByRole("dialog", { name: "Manage Sam Lee" });
    // The engine already knows: the only active owner can't be demoted.
    await user.selectOptions(within(dialog).getByLabelText("Workspace role"), "admin");
    expect(within(dialog).getByText("The workspace must keep at least one active owner.")).toBeDefined();
  });
});

const GROUP = {
  id: "01JABCDEFGHJKMNPQRSTVWXYZ9",
  name: "Design",
  handle: "design",
  description: "The design team",
  memberCount: 1,
  managerCount: 0,
  youManage: false,
  youAreMember: false,
  createdAt: Date.UTC(2026, 10, 1),
};

describe("groups (Identity §4.9)", () => {
  it("lists groups and lets an admin create one", async () => {
    const user = userEvent.setup();
    const fetch = healthyFetch({
      routes: [
        on("GET", "/api/groups", () => jsonResponse({ groups: [GROUP] })),
        on("POST", "/api/groups", (init) =>
          jsonResponse({ ...GROUP, id: "01JABCDEFGHJKMNPQRSTVWXYZ8", ...bodyOf(init), members: [] }, 201),
        ),
        on("GET", "/api/groups/01JABCDEFGHJKMNPQRSTVWXYZ8", () =>
          jsonResponse({ ...GROUP, id: "01JABCDEFGHJKMNPQRSTVWXYZ8", name: "Research", members: [] }),
        ),
      ],
    });
    const { router } = await renderApp("/groups", { fetch });
    expect(await screen.findByRole("link", { name: "Design" })).toBeDefined();
    await expectNoViolations();
    await user.click(screen.getByRole("button", { name: "Create a group" }));
    const dialog = await screen.findByRole("dialog", { name: "Create a group" });
    await user.click(within(dialog).getByRole("button", { name: "Create a group" }));
    expect(within(dialog).getAllByText("Required.").length).toBe(2);
    await user.type(within(dialog).getByLabelText("Name"), "Research");
    await user.type(within(dialog).getByLabelText("@handle"), "research");
    await expectNoViolations();
    await user.click(within(dialog).getByRole("button", { name: "Create a group" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/groups/01JABCDEFGHJKMNPQRSTVWXYZ8"));
    expect(
      bodyOf(fetch.mock.calls.find(([url, init]) => url === "/api/groups" && init?.method === "POST")?.[1]),
    ).toEqual({
      name: "Research",
      handle: "research",
      description: null,
    });
  });

  it("a group's page: admins appoint managers, add people found in the directory, and remove members", async () => {
    const user = userEvent.setup();
    const detail = {
      ...GROUP,
      members: [
        {
          id: ANA.id,
          displayName: "Ana Diaz",
          handle: "ana",
          avatarUrl: null,
          role: "member",
          deactivated: false,
          addedAt: Date.UTC(2026, 10, 2),
        },
      ],
    };
    const fetch = healthyFetch({
      routes: [
        on("GET", `/api/groups/${GROUP.id}`, () => jsonResponse(detail)),
        on("PUT", `/api/groups/${GROUP.id}/members/${ANA.id}`, () =>
          jsonResponse({ groupId: GROUP.id, userId: ANA.id, role: "manager", changed: true }),
        ),
        on("DELETE", `/api/groups/${GROUP.id}/members/${ANA.id}`, () => jsonResponse({})),
        on("PUT", `/api/groups/${GROUP.id}/members/01JABCDEFGHJKMNPQRSTVWXYZ3`, () =>
          jsonResponse({ groupId: GROUP.id, userId: "01JABCDEFGHJKMNPQRSTVWXYZ3", role: "member", changed: true }),
        ),
        (url) =>
          url.startsWith("/api/members?")
            ? jsonResponse({
                members: [
                  {
                    id: "01JABCDEFGHJKMNPQRSTVWXYZ3",
                    displayName: "Lee Park",
                    handle: "lee",
                    email: "lee@example.com",
                    avatarUrl: null,
                    jobTitle: null,
                    team: null,
                    pronouns: null,
                    phone: null,
                    location: null,
                    timezone: "UTC",
                    workingHours: DEFAULT_WORKING_HOURS,
                    workingHoursDefaulted: true,
                    region: null,
                    status: null,
                    deactivated: false,
                    groups: [],
                  },
                ],
                nextCursor: null,
              })
            : undefined,
      ],
    });
    await renderApp(`/groups/${GROUP.id}`, { fetch });
    expect(await screen.findByRole("heading", { level: 1, name: "Design" })).toBeDefined();
    await expectNoViolations();
    await user.click(screen.getByRole("button", { name: "Make Ana Diaz a manager" }));
    await waitFor(() =>
      expect(
        fetch.mock.calls.some(
          ([url, init]) => url === `/api/groups/${GROUP.id}/members/${ANA.id}` && bodyOf(init).role === "manager",
        ),
      ).toBe(true),
    );
    await user.type(screen.getByLabelText("Find someone"), "lee");
    await user.click(await screen.findByRole("button", { name: "Add Lee Park to the group" }));
    expect(await screen.findByText("Lee Park was added.")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Remove Ana Diaz from the group" }));
    await waitFor(() =>
      expect(
        fetch.mock.calls.some(
          ([url, init]) => url === `/api/groups/${GROUP.id}/members/${ANA.id}` && init?.method === "DELETE",
        ),
      ).toBe(true),
    );
    await expectNoViolations();
  });

  it("a plain member sees the group but no management controls", async () => {
    const fetch = healthyFetch({
      me: { ...TEST_ME, user: { ...TEST_ME.user, role: "member" } },
      routes: [on("GET", `/api/groups/${GROUP.id}`, () => jsonResponse({ ...GROUP, members: [] }))],
    });
    await renderApp(`/groups/${GROUP.id}`, { fetch });
    expect(await screen.findByRole("heading", { level: 1, name: "Design" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Edit group" })).toBeNull();
    expect(screen.queryByLabelText("Find someone")).toBeNull();
  });
});

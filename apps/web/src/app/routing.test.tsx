import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { healthyFetch, renderApp } from "../test/render-app";

const AREAS = [
  { path: "/", label: "Home" },
  { path: "/chat", label: "Chat" },
  { path: "/calendar", label: "Calendar" },
  { path: "/documents", label: "Documents" },
] as const;

describe("routing", () => {
  it("renders the admin area at /admin with links to its pages", async () => {
    await renderApp("/admin");
    expect(await screen.findByRole("heading", { level: 1, name: "Admin" })).toBeDefined();
    const sections = screen.getByRole("navigation", { name: "Admin sections" });
    expect(within(sections).getByRole("link", { name: "Invitations" }).getAttribute("href")).toBe("/admin/invitations");
    expect(within(sections).getByRole("link", { name: "Settings" }).getAttribute("href")).toBe("/admin/settings");
    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(within(nav).getByRole("link", { name: "Admin" }).getAttribute("aria-current")).toBe("page");
  });

  it.each(AREAS)("renders $label at $path with its title and an empty state", async ({ path, label }) => {
    await renderApp(path);
    expect(await screen.findByRole("heading", { level: 1, name: label })).toBeDefined();
    expect(screen.getByRole("heading", { level: 2, name: "Coming soon" })).toBeDefined();
    await waitFor(() => expect(document.title).toBe(`${label} · Officebox`));

    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(within(nav).getByRole("link", { name: label }).getAttribute("aria-current")).toBe("page");
    // Only the current area is marked.
    expect(
      within(nav)
        .getAllByRole("link")
        .filter((a) => a.getAttribute("aria-current") === "page"),
    ).toHaveLength(1);
  });

  it("has the header, navigation, main and footer landmarks", async () => {
    await renderApp("/");
    expect(screen.getByRole("banner")).toBeDefined();
    expect(screen.getByRole("navigation", { name: "Main" })).toBeDefined();
    expect(screen.getByRole("main")).toBeDefined();
    expect(screen.getByRole("contentinfo")).toBeDefined();
  });

  it("navigates from the sidebar and moves focus to the new page's heading", async () => {
    const user = userEvent.setup();
    const { router } = await renderApp("/");
    const nav = screen.getByRole("navigation", { name: "Main" });

    await user.click(within(nav).getByRole("link", { name: "Calendar" }));

    const heading = await screen.findByRole("heading", { level: 1, name: "Calendar" });
    expect(router.state.location.pathname).toBe("/calendar");
    await waitFor(() => expect(document.activeElement).toBe(heading));
    await waitFor(() => expect(document.title).toBe("Calendar · Officebox"));
  });

  it("shows a not-found page inside the shell for unknown paths", async () => {
    await renderApp("/no/such/page");
    expect(await screen.findByRole("heading", { level: 1, name: "Page not found" })).toBeDefined();
    expect(screen.getByRole("navigation", { name: "Main" })).toBeDefined();
    expect(screen.getByRole("link", { name: "Go to Home" }).getAttribute("href")).toBe("/");
    await waitFor(() => expect(document.title).toBe("Page not found · Officebox"));
  });

  it("makes the skip link the first Tab stop, and it moves focus to the main content", async () => {
    const user = userEvent.setup();
    await renderApp("/");
    await user.tab();
    const skip = screen.getByRole("link", { name: "Skip to main content" });
    expect(document.activeElement).toBe(skip);
    await user.keyboard("{Enter}");
    expect(document.activeElement).toBe(screen.getByRole("main"));
  });

  it("shows the service status from /health in the footer", async () => {
    const { fetch } = await renderApp("/");
    const footer = screen.getByRole("contentinfo");
    expect(await within(footer).findByText("Service status: Online (version 0.1.0)")).toBeDefined();
    expect(fetch).toHaveBeenCalledWith(
      "/health",
      expect.objectContaining({ method: "GET", credentials: "same-origin" }),
    );
  });

  it("shows the service as unavailable when /health fails", async () => {
    const failing = healthyFetch({
      routes: [(url) => (url.endsWith("/health") ? new Response("", { status: 404 }) : undefined)],
    });
    await renderApp("/", { fetch: failing });
    expect(await screen.findByText("Service status: Unavailable")).toBeDefined();
  });
});

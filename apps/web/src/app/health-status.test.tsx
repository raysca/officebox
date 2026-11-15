import { QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { healthQueryKey } from "../lib/api/health";
import { createQueryClient } from "../lib/api/query-client";
import { jsonResponse } from "../test/render-app";
import { HealthStatus } from "./layout/HealthStatus";

describe("HealthStatus", () => {
  it("doesn't announce the first result, but announces a later change", async () => {
    let healthy = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(healthy ? jsonResponse({ status: "ok", version: "0.1.0" }) : new Response("", { status: 400 })),
      ),
    );
    const client = createQueryClient();
    render(
      <QueryClientProvider client={client}>
        <HealthStatus />
      </QueryClientProvider>,
    );

    const indicator = screen.getByTestId("health-status");
    const announcer = screen.getByRole("status");
    expect(indicator.dataset.state).toBe("checking");
    await waitFor(() => expect(indicator.dataset.state).toBe("ok"));
    expect(indicator.textContent).toContain("Online (version 0.1.0)");
    // The visible indicator isn't a live region, and the first result isn't announced.
    expect(indicator.closest("[role=status], [aria-live]")).toBeNull();
    expect(announcer.textContent).toBe("");

    healthy = false;
    await act(() => client.refetchQueries({ queryKey: healthQueryKey }).catch(() => undefined));
    await waitFor(() => expect(indicator.dataset.state).toBe("down"));
    expect(announcer.textContent).toBe("Service status: Unavailable");

    healthy = true;
    await act(() => client.refetchQueries({ queryKey: healthQueryKey }));
    await waitFor(() => expect(indicator.dataset.state).toBe("ok"));
    expect(announcer.textContent).toBe("Service status: Online (version 0.1.0)");
  });
});

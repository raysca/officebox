import { createMemoryHistory } from "@tanstack/react-router";
import { act, render } from "@testing-library/react";
import { vi } from "vitest";
import { App } from "../app/App";
import { createAppRouter } from "../app/router";
import { createQueryClient } from "../lib/api/query-client";

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** A fetch that answers /health with ok. */
export function healthyFetch() {
  return vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith("/health")) return Promise.resolve(jsonResponse({ status: "ok", version: "0.1.0", checks: {} }));
    return Promise.resolve(jsonResponse({ error: { code: "not_found", message: "No such endpoint." } }, 404));
  });
}

/** Renders the whole app at `path` with a memory history, and waits for the first route to load. */
export async function renderApp(path = "/", { fetch = healthyFetch() }: { fetch?: typeof globalThis.fetch } = {}) {
  vi.stubGlobal("fetch", fetch);
  const queryClient = createQueryClient();
  const history = createMemoryHistory({ initialEntries: [path] });
  const router = createAppRouter({ queryClient, history });
  await act(() => router.load());
  const utils = render(<App router={router} queryClient={queryClient} />);
  return { ...utils, router, queryClient, fetch };
}

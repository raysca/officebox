import type { Me } from "@officebox/shared";
import { createMemoryHistory } from "@tanstack/react-router";
import { act, render } from "@testing-library/react";
import { vi } from "vitest";
import { App } from "../app/App";
import { createAppClients } from "../app/clients";

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export function apiError(code: string, status: number, extra: Record<string, unknown> = {}): Response {
  return jsonResponse({ error: { code, message: code, ...extra } }, status);
}

/** The signed-in owner the default fetch reports from `GET /api/me`. */
export const TEST_ME: Me = {
  user: {
    id: "01JABCDEFGHJKMNPQRSTVWXYZ0",
    email: "sam@example.com",
    displayName: "Sam Lee",
    handle: "sam",
    role: "owner",
  },
  workspace: { name: "Acme", canonicalOrigin: "https://officebox.example" },
  passkeyCount: 2,
  securityNotices: [],
  session: { freshAuthAt: null, freshAuthMethod: null },
};

export type Route = (url: string, init: RequestInit | undefined) => Response | Promise<Response> | undefined;

function urlOf(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

/**
 * A fetch that answers /health with ok and /api/me with `me` (signed in by default), consulting
 * `routes` first; anything else is a 404.
 */
export function healthyFetch({ me = TEST_ME, routes = [] }: { me?: Me | null; routes?: Route[] } = {}) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input);
    for (const route of routes) {
      const answer = await route(url, init);
      if (answer) return answer;
    }
    if (url.endsWith("/health")) return jsonResponse({ status: "ok", version: "0.1.0", checks: {} });
    if (url === "/api/me") return me ? jsonResponse(me) : apiError("unauthenticated", 401);
    return jsonResponse({ error: { code: "not_found", message: "No such endpoint." } }, 404);
  });
}

/** Renders the whole app at `path` with a memory history, and waits for the first route to load. */
export async function renderApp(path = "/", { fetch = healthyFetch() }: { fetch?: typeof globalThis.fetch } = {}) {
  vi.stubGlobal("fetch", fetch);
  const history = createMemoryHistory({ initialEntries: [path] });
  const { queryClient, router } = createAppClients({ history });
  await act(() => router.load());
  const utils = render(<App router={router} queryClient={queryClient} />);
  return { ...utils, router, queryClient, fetch };
}

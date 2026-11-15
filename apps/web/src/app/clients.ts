import type { RouterHistory } from "@tanstack/react-router";
import { createQueryClient } from "../lib/api/query-client";
import { createAppRouter, type AppRouter } from "./router";

const PUBLIC_PATHS = new Set(["/sign-in", "/setup", "/not-configured"]);

/**
 * Creates the query client and the router together, wiring the query client's `onUnauthorized` hook:
 * when any request finds the session gone (revoked, expired after 30 days unused, or the member
 * disabled), cached data is dropped and the person goes to sign-in, which brings them back here
 * afterwards. There is no refresh token to try first: better-auth's session slides on its own.
 */
export function createAppClients({ history }: { history?: RouterHistory } = {}) {
  let router: AppRouter | null = null;
  const queryClient = createQueryClient({
    onUnauthorized: () => {
      if (!router) return;
      const { pathname, href } = router.state.location;
      if (PUBLIC_PATHS.has(pathname)) return;
      queryClient.clear();
      void router.navigate({ to: "/sign-in", search: { redirect: href, reason: "expired" }, replace: true });
    },
  });
  router = createAppRouter({ queryClient, history });
  return { queryClient, router };
}

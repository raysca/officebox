import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, createRoute, createRouter, type RouterHistory } from "@tanstack/react-router";
import { RootErrorPage, RouteErrorPage } from "./ErrorPage";
import { AppShell } from "./layout/AppShell";
import { AdminPage, CalendarPage, ChatPage, DocumentsPage, HomePage, NotFoundPage } from "./routes/pages";

/**
 * Routes are **code-based** (default): declared here with createRoute rather than generated from a
 * routes/ folder. That needs no code generator in the build or the typecheck, keeps the whole route
 * tree readable in one file, and is fully typed all the same. Features add their routes under the
 * root as they land; if the tree outgrows this file we can switch to file-based routing then.
 */

export interface RouterContext {
  queryClient: QueryClient;
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: AppShell,
  errorComponent: RootErrorPage,
  // Rendered inside the shell for any path no route matches.
  notFoundComponent: NotFoundPage,
});

const homeRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: HomePage });
const chatRoute = createRoute({ getParentRoute: () => rootRoute, path: "/chat", component: ChatPage });
const calendarRoute = createRoute({ getParentRoute: () => rootRoute, path: "/calendar", component: CalendarPage });
const documentsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/documents", component: DocumentsPage });
const adminRoute = createRoute({ getParentRoute: () => rootRoute, path: "/admin", component: AdminPage });

export const routeTree = rootRoute.addChildren([homeRoute, chatRoute, calendarRoute, documentsRoute, adminRoute]);

export interface CreateAppRouterOptions {
  queryClient: QueryClient;
  /** A memory history in tests; the browser history by default. */
  history?: RouterHistory;
}

export function createAppRouter({ queryClient, history }: CreateAppRouterOptions) {
  return createRouter({
    routeTree,
    history,
    context: { queryClient },
    defaultErrorComponent: RouteErrorPage,
    defaultPreload: "intent",
    // Keep the window at the top on navigation; focus handling is in the shell.
    scrollRestoration: true,
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}

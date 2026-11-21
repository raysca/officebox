import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  redirect,
  type RouterHistory,
} from "@tanstack/react-router";
import { ApiRequestError, errorCodeOf } from "../lib/api/client";
import { meQuery, meQueryKey } from "../lib/api/identity";
import { Toaster } from "../lib/ui/Toaster";
import { RootErrorPage, RouteErrorPage } from "./ErrorPage";
import { AppShell } from "./layout/AppShell";
import { PublicLayout } from "./layout/PublicLayout";
import { AcceptInvitationPage } from "./routes/accept-invitation";
import { AdminPage } from "./routes/admin";
import { DevicesPage } from "./routes/devices";
import { DirectoryPage } from "./routes/directory";
import { DomainPage } from "./routes/domain";
import { DomainCompletePage } from "./routes/domain-complete";
import { EmailConfirmPage } from "./routes/email-confirm";
import { InvitationsPage } from "./routes/invitations";
import { MagicLinkPage } from "./routes/magic-link";
import { MembersPage } from "./routes/members";
import { CalendarPage, ChatPage, DocumentsPage, HomePage, NotFoundPage } from "./routes/pages";
import { NotConfiguredPage } from "./routes/not-configured";
import { PasskeysPage } from "./routes/passkeys";
import { ProfilePage, profileSearchSchema } from "./routes/profile";
import { OwnerRecoverPage, RecoverPage } from "./routes/recover";
import { SettingsPage } from "./routes/settings";
import { SetupPage } from "./routes/setup";
import { SignInPage, signInSearchSchema } from "./routes/sign-in";

/**
 * Routes are **code-based** (default): declared here with createRoute rather than generated from a
 * routes/ folder. That needs no code generator in the build or the typecheck, keeps the whole route
 * tree readable in one file, and is fully typed all the same.
 *
 * Two layouts sit under the root:
 * - **public** (`/setup`, `/sign-in`): no shell, no session needed.
 * - **app** (everything else): the shell. Its `beforeLoad` loads `GET /api/me` and redirects to
 *   `/setup` before first-run setup (TDD §6.8), to `/sign-in` without a session (remembering where the
 *   person was going), or to `/not-configured` when the Worker's secrets aren't set.
 */

export interface RouterContext {
  queryClient: QueryClient;
}

function RootLayout() {
  return (
    <>
      <Outlet />
      <Toaster />
    </>
  );
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
  errorComponent: RootErrorPage,
});

const publicRoute = createRoute({ getParentRoute: () => rootRoute, id: "public", component: PublicLayout });

const setupRoute = createRoute({ getParentRoute: () => publicRoute, path: "/setup", component: SetupPage });

const notConfiguredRoute = createRoute({
  getParentRoute: () => publicRoute,
  path: "/not-configured",
  component: NotConfiguredPage,
});

const signInRoute = createRoute({
  getParentRoute: () => publicRoute,
  path: "/sign-in",
  validateSearch: signInSearchSchema,
  component: function SignInRoute() {
    return <SignInPage search={signInRoute.useSearch()} />;
  },
});

// Pages whose links carry a token in the fragment (Identity §2): public, served with no-referrer and
// no-store (`_headers`), and they strip the fragment as soon as they read it.
const magicLinkRoute = createRoute({
  getParentRoute: () => publicRoute,
  path: "/sign-in/link",
  component: MagicLinkPage,
});
const acceptInvitationRoute = createRoute({
  getParentRoute: () => publicRoute,
  path: "/invitations/accept",
  component: AcceptInvitationPage,
});
// M1c: recovery links, the email-change confirmation and the domain move's commit step (fragment
// pages), and owner recovery with RECOVERY_TOKEN (a form; no token in any link).
const recoverRoute = createRoute({ getParentRoute: () => publicRoute, path: "/auth/recover", component: RecoverPage });
const ownerRecoverRoute = createRoute({
  getParentRoute: () => publicRoute,
  path: "/recover",
  component: OwnerRecoverPage,
});
const emailConfirmRoute = createRoute({
  getParentRoute: () => publicRoute,
  path: "/me/email/confirm",
  component: EmailConfirmPage,
});
const domainCompleteRoute = createRoute({
  getParentRoute: () => publicRoute,
  path: "/admin/domain/complete",
  component: DomainCompletePage,
});

const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "app",
  component: AppShell,
  notFoundComponent: NotFoundPage,
  beforeLoad: async ({ context, location }) => {
    try {
      await context.queryClient.ensureQueryData(meQuery);
    } catch (error) {
      const code = errorCodeOf(error);
      // TanStack Router's redirects are thrown values by design, not Errors.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      if (code === "setup_required") throw redirect({ to: "/setup" });
      // The Worker's identity secrets aren't set: explain, rather than show the generic error page.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      if (code === "unavailable") throw redirect({ to: "/not-configured" });
      if (code === "unauthenticated" || (error instanceof ApiRequestError && error.status === 401)) {
        context.queryClient.removeQueries({ queryKey: meQueryKey });
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw redirect({ to: "/sign-in", search: { redirect: location.href } });
      }
      throw error;
    }
  },
});

const homeRoute = createRoute({ getParentRoute: () => appRoute, path: "/", component: HomePage });
const chatRoute = createRoute({ getParentRoute: () => appRoute, path: "/chat", component: ChatPage });
const calendarRoute = createRoute({ getParentRoute: () => appRoute, path: "/calendar", component: CalendarPage });
const documentsRoute = createRoute({ getParentRoute: () => appRoute, path: "/documents", component: DocumentsPage });
const adminRoute = createRoute({ getParentRoute: () => appRoute, path: "/admin", component: AdminPage });
const adminInvitationsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/admin/invitations",
  component: InvitationsPage,
});
const adminSettingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/admin/settings",
  component: SettingsPage,
});
const adminMembersRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/admin/members",
  component: MembersPage,
});
const adminDomainRoute = createRoute({ getParentRoute: () => appRoute, path: "/admin/domain", component: DomainPage });
const devicesRoute = createRoute({ getParentRoute: () => appRoute, path: "/settings/devices", component: DevicesPage });
const passkeysRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/settings/passkeys",
  component: PasskeysPage,
});
// M1d: profile and status, and the member directory.
const profileRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/settings/profile",
  validateSearch: profileSearchSchema,
  component: function ProfileRoute() {
    return <ProfilePage welcome={profileRoute.useSearch().welcome === true} />;
  },
});
const directoryRoute = createRoute({ getParentRoute: () => appRoute, path: "/directory", component: DirectoryPage });
// Any other path: the not-found page inside the shell, behind the same session check. A splat route
// rather than the root's notFoundComponent, which would render outside the shell.
const notFoundRoute = createRoute({ getParentRoute: () => appRoute, path: "$", component: NotFoundPage });

export const routeTree = rootRoute.addChildren([
  publicRoute.addChildren([
    setupRoute,
    signInRoute,
    notConfiguredRoute,
    magicLinkRoute,
    acceptInvitationRoute,
    recoverRoute,
    ownerRecoverRoute,
    emailConfirmRoute,
    domainCompleteRoute,
  ]),
  appRoute.addChildren([
    homeRoute,
    chatRoute,
    calendarRoute,
    documentsRoute,
    adminRoute,
    adminInvitationsRoute,
    adminSettingsRoute,
    adminMembersRoute,
    adminDomainRoute,
    devicesRoute,
    passkeysRoute,
    profileRoute,
    directoryRoute,
    notFoundRoute,
  ]),
]);

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

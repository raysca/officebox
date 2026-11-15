import { Outlet, useRouterState } from "@tanstack/react-router";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { IconButton } from "../../lib/ui/Button";
import { Dialog } from "../../lib/ui/Dialog";
import { MenuIcon } from "../../lib/ui/icons";
import { useMe } from "../../lib/api/identity";
import { messages } from "../messages";
import { ReauthPrompt } from "../reauth";
import { HealthStatus } from "./HealthStatus";
import { NavList } from "./NavList";
import { SecurityBanner } from "./SecurityBanner";
import { ThemeSelect } from "./ThemeSelect";
import { UserMenu } from "./UserMenu";

const MAIN_ID = "main-content";
const MOBILE_MENU_ID = "mobile-menu";
/** Tailwind's `md` breakpoint: the sidebar is always shown at this width and up. */
export const DESKTOP_QUERY = "(min-width: 48rem)";

/**
 * The application shell for signed-in people: skip link, header (workspace name, theme, account menu),
 * sidebar navigation, the security-notice banner, main content and footer, and the step-up prompt.
 * Toasts are rendered by the root layout.
 *
 * Below the `md` breakpoint the sidebar is replaced by a menu button that opens the same navigation
 * in a modal drawer. After every client-side navigation, focus moves to the new page's h1 so keyboard
 * and screen-reader users start at the content (the skip link is still the first Tab stop).
 */
export function AppShell({ children }: { children?: ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);
  // Loaded by the app route's beforeLoad before the shell renders.
  const me = useMe().data;
  // The resolved location changes once the new route has loaded and rendered, so its heading exists.
  const pathname = useRouterState({ select: (state) => state.resolvedLocation?.pathname });
  const previousPathname = useRef(pathname);

  useEffect(() => {
    const previous = previousPathname.current;
    previousPathname.current = pathname;
    // Not on the first load (undefined until it resolves): the page starts at the top as usual.
    if (previous === undefined || previous === pathname) return;
    setMenuOpen(false);
    document.querySelector<HTMLElement>(`#${MAIN_ID} [data-page-heading]`)?.focus();
  }, [pathname]);

  // The drawer is for small screens only: close it if the window grows to the desktop layout.
  useEffect(() => {
    if (!menuOpen || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(DESKTOP_QUERY);
    const onChange = () => {
      if (query.matches) setMenuOpen(false);
    };
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [menuOpen]);

  return (
    <div className="flex min-h-dvh flex-col bg-bg text-fg">
      <a
        href={`#${MAIN_ID}`}
        className={
          "sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 " +
          "focus:rounded-md focus:bg-accent focus:px-4 focus:py-2 focus:text-accent-fg"
        }
        onClick={(event) => {
          // Move focus as well as scroll, so the next Tab continues from the content.
          event.preventDefault();
          document.getElementById(MAIN_ID)?.focus();
        }}
      >
        {messages.skipToContent}
      </a>

      <header className="sticky top-0 z-20 flex h-header items-center gap-2 border-b border-border bg-surface px-2 sm:px-4">
        <IconButton
          label={messages.openMenu}
          icon={<MenuIcon />}
          className="md:hidden"
          aria-haspopup="dialog"
          aria-expanded={menuOpen}
          // Only while the menu exists in the page: aria-controls must point at a real element.
          aria-controls={menuOpen ? MOBILE_MENU_ID : undefined}
          onClick={() => setMenuOpen(true)}
        />
        <p className="truncate text-base font-semibold">{me?.workspace.name || messages.workspaceName}</p>
        <div className="ml-auto flex items-center gap-1 sm:gap-2">
          <ThemeSelect />
          <UserMenu />
        </div>
      </header>

      <div className="flex flex-1">
        <nav
          aria-label={messages.mainNavigation}
          className="sticky top-header hidden h-[calc(100dvh-var(--spacing-header))] w-60 shrink-0 overflow-y-auto border-r border-border bg-surface md:block"
        >
          <NavList />
        </nav>

        <div className="flex min-w-0 flex-1 flex-col">
          <SecurityBanner />
          <main id={MAIN_ID} tabIndex={-1} className="flex-1 focus:outline-none">
            {children ?? <Outlet />}
          </main>
          <footer className="border-t border-border px-4 py-3 sm:px-8">
            <HealthStatus />
          </footer>
        </div>
      </div>

      <Dialog
        id={MOBILE_MENU_ID}
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        title={messages.menuTitle}
        closeLabel={messages.closeMenu}
        placement="left"
      >
        <nav aria-label={messages.mainNavigation}>
          <NavList onNavigate={() => setMenuOpen(false)} />
        </nav>
      </Dialog>

      <ReauthPrompt />
    </div>
  );
}

/**
 * Interface text for the app shell, in one place so it can be handed to a translation library later
 * (PRD §18: all interface text is externalised). English only at launch.
 *
 * Feature names stay generic ("Chat", "Calendar", "Documents"); marketing names come later (AGENTS §8).
 */
export const messages = {
  appName: "Officebox",
  /** Placeholder until the workspace name comes from admin settings (M1). */
  workspaceName: "Officebox",
  skipToContent: "Skip to main content",
  mainNavigation: "Main",
  openMenu: "Open menu",
  menuTitle: "Menu",
  closeMenu: "Close menu",
  comingSoon: "Coming soon",
  theme: {
    label: "Theme",
    system: "System",
    light: "Light",
    dark: "Dark",
  },
  account: {
    menuLabel: "Account",
    signedOut: "You're previewing Officebox. Signing in arrives in a later release.",
  },
  health: {
    label: "Service status",
    checking: "Checking…",
    ok: (version: string) => `Online (version ${version})`,
    down: "Unavailable",
  },
  areas: {
    home: {
      label: "Home",
      description: "Your inbox: mentions, replies, reminders and invitations will gather here.",
    },
    chat: {
      label: "Chat",
      description: "Channels, direct messages and threads for your team.",
    },
    calendar: {
      label: "Calendar",
      description: "Events, invitations and your team's availability.",
    },
    documents: {
      label: "Documents",
      description: "Documents, whiteboards and files, organised in spaces.",
    },
    admin: {
      label: "Admin",
      description: "Members, settings and workspace health.",
    },
  },
  notFound: {
    title: "Page not found",
    description: "There's nothing at this address. It may have moved, or the link may be wrong.",
    home: "Go to Home",
  },
  error: {
    title: "Something went wrong",
    description: "The page hit an unexpected problem. Reloading usually fixes it.",
    reload: "Reload the page",
    home: "Go to Home",
  },
} as const;

/** The document title for a page: "Chat · Officebox". */
export function pageTitle(title: string): string {
  return `${title} · ${messages.appName}`;
}

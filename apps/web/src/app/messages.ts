/**
 * Interface text for the app shell, in one place so it can be handed to a translation library later
 * (PRD §18: all interface text is externalised). English only at launch.
 *
 * Feature names stay generic ("Chat", "Calendar", "Documents"); marketing names come later (AGENTS §8).
 */
import type { ErrorCode } from "@officebox/shared";

/** What people see for each server error code. Generic copy for now (default). */
const errorByCode: Record<ErrorCode, string> = {
  validation_failed: "Some details need fixing. Check the highlighted fields and try again.",
  unauthenticated: "Your session has ended. Sign in again to continue.",
  forbidden: "You don't have permission to do that.",
  not_found: "We couldn't find that. It may have been moved or deleted.",
  conflict: "Someone else changed this at the same time. Refresh and try again.",
  gone: "That's no longer available.",
  payload_too_large: "That's too large to upload or save.",
  rate_limited: "That's happening too often. Wait a moment and try again.",
  read_only: "The workspace is read-only right now, so changes can't be saved.",
  unavailable: "This service isn't available right now. Try again later.",
  internal: "Something went wrong on our side. Try again in a moment.",
};

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
  errors: {
    byCode: errorByCode,
    generic: "Something went wrong. Try again in a moment.",
    server: "The server had a problem. Try again in a moment.",
    invalidResponse: "The server sent an unexpected response. Try again in a moment.",
    network: "Can't reach the server. Check your connection and try again.",
    timeout: "The server took too long to respond. Try again.",
    /** A change that timed out or lost its connection may still have gone through. */
    outcomeUnknown: "We couldn't confirm this went through. Check before trying again.",
    aborted: "The request was cancelled.",
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

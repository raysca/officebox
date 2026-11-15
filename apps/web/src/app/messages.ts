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
  invalid_credentials: "The email or password is incorrect.",
  csrf_failed: "This request was blocked for your security. Reload the page and try again.",
  setup_required: "This workspace hasn't been set up yet.",
  not_found: "We couldn't find that. It may have been moved or deleted.",
  method_not_allowed: "That action isn't supported here.",
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
    signedInAs: "Signed in as",
    devices: "My devices",
    signOut: "Sign out",
    signingOut: "Signing out…",
  },
  form: {
    required: "Fill in this field.",
    emailInvalid: "Enter an email address, like name@example.com.",
    nameTooLong: "Use at most 64 characters.",
    handleInvalid: "Use 2–32 lowercase letters, digits, dots, dashes or underscores, starting with a letter or digit.",
    handleReserved: "That handle is reserved. Choose another.",
    passwordTooShort: "Use at least 10 characters.",
    passwordTooLong: "Use at most 256 characters.",
    passwordCommon: "That password is too common. Choose something harder to guess.",
  },
  setup: {
    title: "Set up your workspace",
    description: "Create the workspace and its first owner account. This page works only once.",
    loading: "Checking whether this workspace is set up…",
    tokenLabel: "Setup token",
    tokenHintSecret: "The SETUP_TOKEN secret you set when you deployed Officebox.",
    tokenHintGenerated:
      "Find it in your Cloudflare dashboard: Workers & Pages → officebox → Logs, in the entry “officebox setup token”. It expires after 24 hours.",
    tokenInvalid: "This setup token isn't valid. Check it and try again.",
    workspaceSection: "Workspace",
    workspaceNameLabel: "Workspace name",
    ownerSection: "Your owner account",
    ownerNameLabel: "Your name",
    ownerHandleLabel: "Handle",
    ownerHandleHint: "Used for @mentions. 2–32 lowercase letters, digits, dots, dashes or underscores.",
    ownerEmailLabel: "Email",
    passwordLabel: "Password",
    passwordHint: "At least 10 characters. Common passwords aren't allowed.",
    submit: "Create workspace",
    submitting: "Creating workspace…",
    done: "Your workspace is ready. Sign in to continue.",
    alreadyDone: "This workspace is already set up.",
    failed: "Setup couldn't be loaded. Reload the page to try again.",
  },
  signIn: {
    title: "Sign in",
    emailLabel: "Email",
    passwordLabel: "Password",
    submit: "Sign in",
    submitting: "Signing in…",
    invalid: "The email or password is incorrect.",
    refused: "This account can't sign in. Contact an admin.",
    tooMany: (seconds: number) =>
      `Too many sign-in attempts. Try again in ${seconds} ${seconds === 1 ? "second" : "seconds"}.`,
    signedOut: "You've been signed out.",
    sessionEnded: "Your session has ended. Sign in again to continue.",
  },
  devices: {
    title: "My devices",
    description: "Browsers and devices that are signed in to your account. Sign out any you don't recognise.",
    listLabel: "Signed-in devices",
    loading: "Loading your devices…",
    failed: "Your devices couldn't be loaded.",
    retry: "Try again",
    unknownDevice: "Unknown browser",
    unknownLocation: "Location unknown",
    thisDevice: "This device",
    signedIn: (when: string) => `Signed in ${when}`,
    lastActive: (when: string) => `Last active ${when}`,
    signOutDevice: "Sign out",
    signOutDeviceLabel: (device: string) => `Sign out ${device}`,
    signedOutDevice: "That device was signed out.",
    signOutOthers: "Sign out all other devices",
    signedOutOthers: (count: number) =>
      count === 0
        ? "No other devices were signed in."
        : `Signed out ${count} other ${count === 1 ? "device" : "devices"}.`,
    everywhereTitle: "Sign out everywhere",
    everywhereDescription: "Sign out of every device, including this one. You'll need to sign in again.",
    everywhereButton: "Sign out everywhere",
    everywhereConfirm: "Sign out of every device, including this one?",
    cancel: "Cancel",
    onlyThisDevice: "Only this device is signed in.",
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

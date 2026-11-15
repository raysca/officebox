/**
 * Interface text for the app shell, in one place so it can be handed to a translation library later
 * (PRD §18: all interface text is externalised). English only at launch.
 *
 * Feature names stay generic ("Chat", "Calendar", "Documents"); marketing names come later (AGENTS §8).
 */
import type { DenialReason, ErrorCode } from "@officebox/shared";

/** What people see for each server error code. Generic copy for now (default). */
const errorByCode: Record<ErrorCode, string> = {
  validation_failed: "Some details need fixing. Check the highlighted fields and try again.",
  unauthenticated: "Your session has ended. Sign in again to continue.",
  forbidden: "You don't have permission to do that.",
  reauth_required: "Confirm it's you with your passkey to continue.",
  csrf_failed: "Your browser sent the request in a way we can't accept. Reload the page and try again.",
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

/**
 * What people see when the permission engine refuses, keyed by the error's `reason` (packages/shared
 * permissions.ts). More specific than the code's copy; unknown reasons fall back to the code's.
 */
const errorByDenial: Record<DenialReason, string> = {
  inactive: "Your account can't do that. Contact an owner or admin.",
  system_actor: "This account can't do that.",
  not_permitted: "You don't have permission to do that.",
  owner_required: "An owner must do this.",
  last_owner: "The workspace must keep at least one active owner. Add another owner first.",
  not_own: "You can only change your own account.",
  role_not_assignable: "That role can't be given.",
  invalid_target: "That person's account can't be changed.",
  self_target: "You can't do that to your own account. Ask another owner.",
  owner_invite_gate: "Before you invite people, add a second passkey to your account (for example on your phone).",
  promotion_passkeys:
    "This person needs more passkeys first: one to become an admin, two to become an owner (or a recovery token set).",
  last_passkey: "You can't remove your last passkey, or you'd have no way to sign in.",
  reauth_required: "Confirm it's you with your passkey to continue.",
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
    signedInAs: "Signed in as",
    devices: "My devices",
    passkeys: "Passkeys",
    signOut: "Sign out",
    signingOut: "Signing out…",
  },
  form: {
    required: "Fill in this field.",
    emailInvalid: "Enter an email address, like name@example.com.",
    nameTooLong: "Use at most 64 characters.",
    handleInvalid: "Use 2–32 lowercase letters, digits, dots, dashes or underscores, starting with a letter or digit.",
    handleReserved: "That handle is reserved. Choose another.",
  },
  passkey: {
    cancelled: "The passkey request was cancelled or timed out. Try again when you're ready.",
    alreadyRegistered: "This device already has a passkey for your account. Use a different device or security key.",
    failed: "Your browser couldn't use a passkey. Try again, or use another device or security key.",
    unsupported: "This browser can't create a passkey. Use another device or a security key.",
    uvRequired:
      "Your passkey must check it's you, with a PIN, fingerprint or face. Set one up on the device and try again.",
    cloneDetected:
      "That passkey was refused because it looks like a copy. We've let you and the workspace owners know. Use another passkey.",
    workersDevWarning: "If this workspace moves to a custom domain, you'll need to add this passkey again.",
  },
  setup: {
    title: "Set up your workspace",
    description: "Create the workspace and its first owner, then add a passkey to sign in. This page works only once.",
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
    submit: "Create workspace",
    submitting: "Creating workspace…",
    alreadyDone: "This workspace is already set up.",
    failed: "Setup couldn't be loaded. Reload the page to try again.",
    claimedTitle: "Setup has started",
    claimedDescription:
      "Someone started setting up this workspace but hasn't added a passkey yet. If that was you, enter the setup token to continue, on this device or another one.",
    resume: "Continue setup",
    resuming: "Continuing…",
    resumeGone: "This setup can't be continued: the owner already has a passkey or has signed in. Sign in instead.",
    passkeyTitle: "Add your passkey",
    passkeyDescription: (email: string) =>
      `Your workspace is almost ready. Create a passkey for ${email} with this device's screen lock, or with a security key. There's no password.`,
    createPasskey: "Create passkey",
    creatingPasskey: "Waiting for your passkey…",
    ticketExpired: "This step expired. Enter the setup token again to continue.",
    secondTitle: "Add a second passkey",
    secondDescription:
      "You have one passkey. Add another, for example on your phone, so you can still sign in if you lose this device. Until you do, you can't invite people.",
    addSecond: "Add a second passkey",
    skipSecond: "Not now",
    checklistTitle: "Before you invite people",
    workersDevNoEmail:
      "This workspace runs on a workers.dev address, which usually means no email. Without email there are no sign-in links, so a second passkey or a RECOVERY_TOKEN is your only way back in.",
  },
  signIn: {
    title: "Sign in",
    description: "Use the passkey on this device, your phone or a security key.",
    submit: "Sign in with a passkey",
    submitting: "Waiting for your passkey…",
    unknownPasskey: "That passkey isn't registered here. Try another one, or ask an admin for help.",
    refused: "This account can't sign in. Contact an admin.",
    tooMany: (seconds: number) =>
      `Too many sign-in attempts. Try again in ${seconds} ${seconds === 1 ? "second" : "seconds"}.`,
    signedOut: "You've been signed out.",
    sessionEnded: "Your session has ended. Sign in again to continue.",
  },
  notConfigured: {
    title: "This workspace isn't fully configured yet",
    description: "Signing in and setting up aren't available until the workspace is configured.",
    ownerHint:
      "If you run this workspace: some required Worker secrets aren't set. Follow “Secrets” in the README of your Officebox repository, then try again.",
    retry: "Try again",
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
  passkeys: {
    title: "Passkeys",
    description:
      "Passkeys you can sign in with. Each one lives on a device, in a password manager or on a security key.",
    listLabel: "Your passkeys",
    loading: "Loading your passkeys…",
    failed: "Your passkeys couldn't be loaded.",
    retry: "Try again",
    unnamed: "Passkey",
    createdVia: {
      setup: "Created during setup",
      invitation: "Created when you joined",
      recovery_link: "Added with a recovery link",
      owner_recovery: "Added with owner recovery",
      magic_link: "Added after a sign-in link",
      signed_in: "Added while signed in",
      domain_move: "Added when the workspace moved",
    },
    added: (when: string) => `Added ${when}`,
    lastUsed: (when: string) => `Last used ${when}`,
    neverUsed: "Not used yet",
    synced: "Synced",
    add: "Add a passkey",
    adding: "Waiting for your passkey…",
    addedToast: "Passkey added.",
    rename: "Rename",
    renameLabel: (name: string) => `Rename ${name}`,
    renameTitle: "Rename passkey",
    nameLabel: "Name",
    save: "Save",
    renamedToast: "Passkey renamed.",
    remove: "Remove",
    removeLabel: (name: string) => `Remove ${name}`,
    removeTitle: "Remove passkey",
    removeConfirm: (name: string) =>
      `Remove “${name}”? You won't be able to sign in with it any more. Other devices stay signed in.`,
    removedToast: "Passkey removed.",
    cancel: "Cancel",
    lastOne: "This is your only passkey, so it can't be removed. Add another one first.",
    ownerReminder:
      "You have one passkey. Add a second one, for example on your phone, so you can still sign in if you lose this device. Owners need two passkeys (or a recovery token) before inviting people.",
  },
  reauth: {
    title: "Confirm it's you",
    description: "For your security, confirm with your passkey before continuing.",
    confirm: "Use passkey",
    confirming: "Waiting for your passkey…",
    cancel: "Cancel",
    failed: "That passkey couldn't confirm it's you. Try again.",
  },
  banner: {
    label: "Security notices",
    passkey_added: (name: string | null, via: string) =>
      `A passkey${name ? ` “${name}”` : ""} was added to your account (${via}). If this wasn't you, remove it and contact an owner.`,
    passkey_clone_detected: (subject: string | undefined) =>
      subject
        ? `A copied passkey was refused for ${subject}'s account. Check with them.`
        : "A passkey that looked like a copy was refused on your account. If you didn't expect this, remove that passkey and contact an owner.",
    other: "There's a security notice on your account.",
    at: (when: string) => `On ${when}.`,
    acknowledge: "I've seen these",
    acknowledged: "Thanks. The notices are dismissed.",
    needsFreshSignIn: "Confirm it's you with a passkey to dismiss these notices.",
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
    byDenial: errorByDenial,
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

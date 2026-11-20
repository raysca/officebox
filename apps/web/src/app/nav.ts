import type { WorkspaceAction } from "@officebox/shared";
import type { ComponentType, SVGProps } from "react";
import { AdminIcon, CalendarIcon, ChatIcon, DocumentIcon, HomeIcon, PeopleIcon } from "../lib/ui/icons";
import { messages } from "./messages";

export interface NavItem {
  to: "/" | "/chat" | "/calendar" | "/documents" | "/directory" | "/admin";
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  /** Shown only to people the permission engine allows this action (an affordance; the API checks again). */
  requires?: WorkspaceAction;
}

/**
 * The sidebar's top-level areas. Chat's own sections (starred, custom, channels, DMs; Chat §3.3) and
 * the per-area navigation (Calendar §11, Documents §3.2) arrive with those features. Admin is shown to
 * owners and admins only.
 */
export const NAV_ITEMS: readonly NavItem[] = [
  { to: "/", label: messages.areas.home.label, icon: HomeIcon },
  { to: "/chat", label: messages.areas.chat.label, icon: ChatIcon },
  { to: "/calendar", label: messages.areas.calendar.label, icon: CalendarIcon },
  { to: "/documents", label: messages.areas.documents.label, icon: DocumentIcon },
  // M1d: the member directory (Identity §4.10), for everyone (`directory.view`).
  { to: "/directory", label: messages.areas.directory.label, icon: PeopleIcon, requires: "directory.view" },
  { to: "/admin", label: messages.areas.admin.label, icon: AdminIcon, requires: "admin.open" },
];

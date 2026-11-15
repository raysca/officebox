import type { ComponentType, SVGProps } from "react";
import { AdminIcon, CalendarIcon, ChatIcon, DocumentIcon, HomeIcon } from "../lib/ui/icons";
import { messages } from "./messages";

export interface NavItem {
  to: "/" | "/chat" | "/calendar" | "/documents" | "/admin";
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
}

/**
 * The sidebar's top-level areas. Chat's own sections (starred, custom, channels, DMs; Chat §3.3) and
 * the per-area navigation (Calendar §11, Documents §3.2) arrive with those features. Admin will be
 * shown to admins only once roles exist (M1).
 */
export const NAV_ITEMS: readonly NavItem[] = [
  { to: "/", label: messages.areas.home.label, icon: HomeIcon },
  { to: "/chat", label: messages.areas.chat.label, icon: ChatIcon },
  { to: "/calendar", label: messages.areas.calendar.label, icon: CalendarIcon },
  { to: "/documents", label: messages.areas.documents.label, icon: DocumentIcon },
  { to: "/admin", label: messages.areas.admin.label, icon: AdminIcon },
];

import { Link } from "@tanstack/react-router";
import { NAV_ITEMS } from "../nav";

export interface NavListProps {
  /** Called when a link is followed (the mobile menu closes itself). */
  onNavigate?: () => void;
}

/**
 * The list of areas. The router's Link sets aria-current="page" on the active item; the style keys off
 * that attribute, so the current page is marked for screen readers and sighted users alike, and not
 * by colour alone (a bar on the left and bold text as well).
 */
export function NavList({ onNavigate }: NavListProps) {
  return (
    <ul className="flex flex-col gap-1 p-3">
      {NAV_ITEMS.map(({ to, label, icon: Icon }) => (
        <li key={to}>
          <Link
            to={to}
            activeOptions={{ exact: to === "/" }}
            onClick={onNavigate}
            className={
              "flex items-center gap-3 rounded-md border-l-4 border-transparent px-3 py-2 text-fg " +
              "hover:bg-accent-subtle hover:text-accent-subtle-fg motion-safe:transition-colors " +
              "aria-[current=page]:border-accent aria-[current=page]:bg-accent-subtle " +
              "aria-[current=page]:font-semibold aria-[current=page]:text-accent-subtle-fg"
            }
          >
            <Icon />
            <span>{label}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

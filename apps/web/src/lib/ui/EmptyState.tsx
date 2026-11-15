import { useId, type ReactNode } from "react";

export interface EmptyStateProps {
  title: string;
  description?: ReactNode;
  /** Decorative; hidden from assistive technology. */
  icon?: ReactNode;
  /** Optional call to action. */
  action?: ReactNode;
}

/**
 * A placeholder for an area with nothing to show yet. The title is an h2: the page's own h1 comes
 * first, so the heading outline stays in order.
 */
export function EmptyState({ title, description, icon, action }: EmptyStateProps) {
  const titleId = useId();
  return (
    <section
      aria-labelledby={titleId}
      className="mx-auto flex max-w-md flex-col items-center gap-3 rounded-lg border border-dashed border-border-strong px-6 py-12 text-center"
    >
      {icon ? (
        <span aria-hidden="true" className="text-muted">
          {icon}
        </span>
      ) : null}
      <h2 id={titleId} className="text-lg font-semibold">
        {title}
      </h2>
      {description ? <p className="text-muted">{description}</p> : null}
      {action}
    </section>
  );
}

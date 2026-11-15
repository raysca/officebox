import type { ComponentPropsWithRef, ReactNode } from "react";
import { cx } from "./cx";
import { VisuallyHidden } from "./VisuallyHidden";

export type ButtonVariant = "primary" | "secondary" | "ghost";

const base =
  "inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium " +
  "motion-safe:transition-colors disabled:cursor-not-allowed disabled:opacity-60";

const variants: Record<ButtonVariant, string> = {
  primary: "bg-accent px-4 py-2 text-accent-fg hover:bg-accent-hover",
  secondary: "border border-border-strong bg-bg px-4 py-2 text-fg hover:bg-surface",
  ghost: "px-3 py-2 text-fg hover:bg-accent-subtle hover:text-accent-subtle-fg",
};

export interface ButtonProps extends ComponentPropsWithRef<"button"> {
  variant?: ButtonVariant;
}

/** A button. Defaults to `type="button"` so it never submits a form by accident. */
export function Button({ variant = "secondary", className, type = "button", ...props }: ButtonProps) {
  return <button type={type} className={cx(base, variants[variant], className)} {...props} />;
}

export interface IconButtonProps extends Omit<ComponentPropsWithRef<"button">, "children"> {
  /** The accessible name. Required: an icon alone says nothing to a screen reader. */
  label: string;
  icon: ReactNode;
}

/** A square button showing only an icon, with a 40 px target (WCAG 2.5.8 asks for at least 24 px). */
export function IconButton({ label, icon, className, type = "button", ...props }: IconButtonProps) {
  return (
    <button
      type={type}
      className={cx(
        "inline-flex size-10 items-center justify-center rounded-md text-fg",
        "hover:bg-accent-subtle hover:text-accent-subtle-fg motion-safe:transition-colors",
        className,
      )}
      {...props}
    >
      {icon}
      <VisuallyHidden>{label}</VisuallyHidden>
    </button>
  );
}

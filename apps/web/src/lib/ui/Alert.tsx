import type { ReactNode } from "react";
import { cx } from "./cx";

export interface AlertProps {
  children: ReactNode;
  /** "error" is announced at once (role="alert"); "info" politely (role="status"). */
  tone?: "error" | "info";
  className?: string;
}

/** An inline message above a form or list. Not colour alone: errors carry a border and their text. */
export function Alert({ children, tone = "error", className }: AlertProps) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cx(
        "rounded-md border px-3 py-2 text-sm text-fg",
        tone === "error" ? "border-danger bg-danger-subtle" : "border-border-strong bg-surface",
        className,
      )}
    >
      {children}
    </div>
  );
}

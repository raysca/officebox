import type { ComponentPropsWithoutRef } from "react";
import { cx } from "./cx";

/** Content for screen readers only. Tailwind's `sr-only` keeps it in the accessibility tree. */
export function VisuallyHidden({ className, ...props }: ComponentPropsWithoutRef<"span">) {
  return <span className={cx("sr-only", className)} {...props} />;
}

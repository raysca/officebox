import { createLink } from "@tanstack/react-router";
import type { ComponentPropsWithRef } from "react";
import { cx } from "./cx";

function StyledAnchor({ className, ...props }: ComponentPropsWithRef<"a">) {
  return (
    <a
      className={cx("rounded-sm text-accent underline underline-offset-2 hover:text-accent-hover", className)}
      {...props}
    />
  );
}

/**
 * An in-app link: TanStack Router's typed `to`/`params`, with link styling. Underlined so it doesn't
 * rely on colour alone (WCAG 1.4.1). For navigation lists use the router's Link with its own styles.
 */
export const Link = createLink(StyledAnchor);

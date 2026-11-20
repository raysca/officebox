import { useState } from "react";
import { initials } from "../profile-format";
import { cx } from "./cx";

export interface AvatarProps {
  name: string;
  url: string | null | undefined;
  size?: "sm" | "md" | "lg";
  /**
   * Whether the avatar names the person on its own. When the name is shown next to it (the usual case)
   * the avatar is decorative and hidden from screen readers, so the name isn't read twice.
   */
  labelled?: boolean;
  className?: string;
}

const SIZES = { sm: "size-8 text-xs", md: "size-10 text-sm", lg: "size-24 text-2xl" } as const;

/**
 * A member's avatar (Identity §4.7): their uploaded image, or their initials when there's none or it
 * fails to load. Images come from our own origin (`/api/members/:id/avatar`), allowed by the app CSP.
 */
export function Avatar({ name, url, size = "md", labelled = false, className }: AvatarProps) {
  const [failed, setFailed] = useState<string | null>(null);
  const showImage = url && failed !== url;
  const classes = cx(
    "inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-accent-subtle font-semibold text-accent-subtle-fg",
    SIZES[size],
    className,
  );
  if (showImage) {
    return (
      <img
        src={url}
        alt={labelled ? name : ""}
        className={cx(classes, "object-cover")}
        onError={() => setFailed(url)}
        decoding="async"
        loading="lazy"
      />
    );
  }
  return labelled ? (
    <span className={classes} role="img" aria-label={name}>
      <span aria-hidden="true">{initials(name)}</span>
    </span>
  ) : (
    <span className={classes} aria-hidden="true">
      {initials(name)}
    </span>
  );
}

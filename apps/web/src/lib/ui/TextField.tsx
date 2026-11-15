import { forwardRef, useId, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { cx } from "./cx";

export interface TextFieldProps extends Omit<ComponentPropsWithoutRef<"input">, "id"> {
  label: string;
  /** Help shown under the label, linked with aria-describedby. */
  hint?: ReactNode;
  /** An error for this field: shown under it, linked with aria-describedby, and sets aria-invalid. */
  error?: string | null;
}

/**
 * A labelled text input with optional hint and error (WCAG 1.3.1, 3.3.1, 3.3.2). The label is a real
 * <label>, the hint and error are announced with the field, and an invalid field is marked
 * `aria-invalid` and drawn with a danger border, plus the error text (not colour alone).
 */
export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { label, hint, error, className, required, ...props },
  ref,
) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className={cx("flex flex-col gap-1", className)}>
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {hint ? (
        <p id={hintId} className="text-sm text-muted">
          {hint}
        </p>
      ) : null}
      <input
        ref={ref}
        id={id}
        required={required}
        aria-required={required ? true : undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={cx(
          "rounded-md border bg-bg px-3 py-2 text-base text-fg",
          error ? "border-danger" : "border-border-strong",
        )}
        {...props}
      />
      {error ? (
        <p id={errorId} className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
});

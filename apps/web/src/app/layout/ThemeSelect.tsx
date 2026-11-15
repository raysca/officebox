import { useId } from "react";
import { SunMoonIcon } from "../../lib/ui/icons";
import { VisuallyHidden } from "../../lib/ui/VisuallyHidden";
import { messages } from "../messages";
import { THEME_PREFERENCES, useThemePreference, type ThemePreference } from "../theme";

/**
 * Theme choice: System (default), Light or Dark, remembered on this device. A native <select> is
 * compact, keyboard operable and announced correctly everywhere, which a hand-built menu would have
 * to earn.
 */
export function ThemeSelect() {
  const id = useId();
  const [preference, setPreference] = useThemePreference();

  return (
    <div className="flex items-center gap-1">
      <label htmlFor={id} className="flex items-center text-muted">
        <SunMoonIcon />
        <VisuallyHidden>{messages.theme.label}</VisuallyHidden>
      </label>
      <select
        id={id}
        value={preference}
        onChange={(event) => setPreference(event.target.value as ThemePreference)}
        className="h-10 rounded-md border border-border-strong bg-bg px-2 text-sm text-fg"
      >
        {THEME_PREFERENCES.map((value) => (
          <option key={value} value={value}>
            {messages.theme[value]}
          </option>
        ))}
      </select>
    </div>
  );
}

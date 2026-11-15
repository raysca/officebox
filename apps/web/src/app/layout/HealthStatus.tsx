import { useState } from "react";
import { useHealth } from "../../lib/api/health";
import { cx } from "../../lib/ui/cx";
import { VisuallyHidden } from "../../lib/ui/VisuallyHidden";
import { messages } from "../messages";

type HealthState = "checking" | "ok" | "down";

/**
 * A small indicator for `GET /health`. The coloured dot is decorative; the text says the same thing,
 * so the state never depends on colour alone.
 *
 * The visible text isn't a live region, so loading a page doesn't announce it. A separate, hidden
 * status region announces only a change after the first result (the service going down or coming
 * back).
 */
export function HealthStatus() {
  const health = useHealth();
  const state: HealthState = health.isPending ? "checking" : health.isError ? "down" : "ok";
  const text =
    state === "checking"
      ? messages.health.checking
      : state === "down"
        ? messages.health.down
        : messages.health.ok(health.data?.version ?? "");

  // Adjusting state while rendering (not in an effect): remember the last settled state, and set an
  // announcement when it changes after the first one.
  const [lastSettled, setLastSettled] = useState<HealthState | null>(null);
  const [announcement, setAnnouncement] = useState("");
  if (state !== "checking" && state !== lastSettled) {
    if (lastSettled !== null) setAnnouncement(`${messages.health.label}: ${text}`);
    setLastSettled(state);
  }

  const dot = state === "checking" ? "bg-muted" : state === "down" ? "bg-danger" : "bg-success";

  return (
    <>
      <p data-testid="health-status" data-state={state} className="flex items-center gap-2 text-sm text-muted">
        <span aria-hidden="true" className={cx("inline-block size-2.5 rounded-full", dot)} />
        <span>
          {messages.health.label}: {text}
        </span>
      </p>
      <VisuallyHidden role="status" data-testid="health-announcer">
        {announcement}
      </VisuallyHidden>
    </>
  );
}

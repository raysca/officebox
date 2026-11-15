import { useHealth } from "../../lib/api/health";
import { cx } from "../../lib/ui/cx";
import { messages } from "../messages";

/**
 * A small indicator for `GET /health`. The coloured dot is decorative; the text says the same thing,
 * so the state never depends on colour alone. role="status" announces changes politely.
 */
export function HealthStatus() {
  const health = useHealth();

  let text: string;
  let dot: string;
  if (health.isPending) {
    text = messages.health.checking;
    dot = "bg-muted";
  } else if (health.isError) {
    text = messages.health.down;
    dot = "bg-danger";
  } else {
    text = messages.health.ok(health.data.version);
    dot = "bg-success";
  }

  return (
    <p role="status" data-testid="health-status" className="flex items-center gap-2 text-sm text-muted">
      <span aria-hidden="true" className={cx("inline-block size-2.5 rounded-full", dot)} />
      <span>
        {messages.health.label}: {text}
      </span>
    </p>
  );
}

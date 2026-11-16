import type { SecurityNotice } from "@officebox/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId } from "react";
import { errorCodeOf } from "../../lib/api/client";
import { acknowledgeNotices, meQueryKey, noticesQueryKey, useMe } from "../../lib/api/identity";
import { Button } from "../../lib/ui/Button";
import { toastStore } from "../../lib/ui/toast-store";
import { messages } from "../messages";

const copy = messages.banner;
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

function describe(notice: SecurityNotice): string {
  if (notice.kind === "passkey_added") {
    const via = notice.details.createdVia ? messages.passkeys.createdVia[notice.details.createdVia].toLowerCase() : "";
    return copy.passkey_added(notice.details.passkeyName ?? null, via);
  }
  if (notice.kind === "passkey_clone_detected") return copy.passkey_clone_detected(notice.details.subjectName);
  if (notice.kind === "magic_link_new_device") {
    const device = [notice.details.deviceLabel, notice.details.approxLocation].filter(Boolean).join(", ");
    return copy.magic_link_new_device(device || null);
  }
  return copy.other;
}

/**
 * The security-notice banner (Identity §4.6a): every pending notice, shown after sign-in until it's
 * acknowledged. Acknowledging needs a fresh passkey assertion: the API answers `reauth_required` and
 * the client's step-up prompt asks for a passkey, then retries, so a stolen session can't dismiss it.
 */
export function SecurityBanner() {
  const me = useMe().data;
  const queryClient = useQueryClient();
  const headingId = useId();
  const notices = me?.securityNotices ?? [];
  const ack = useMutation({
    mutationFn: () => acknowledgeNotices(notices.map((n) => n.id)),
    meta: { errorToast: false },
    onSuccess: async () => {
      toastStore.show(copy.acknowledged, "info");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: meQueryKey }),
        queryClient.invalidateQueries({ queryKey: noticesQueryKey }),
      ]);
    },
    onError: (error) => {
      if (errorCodeOf(error) === "reauth_required") toastStore.show(copy.needsFreshSignIn, "error");
      else toastStore.show(messages.errors.generic, "error");
    },
  });
  if (notices.length === 0) return null;
  return (
    <section
      aria-labelledby={headingId}
      className="border-b border-danger bg-danger-subtle px-4 py-3 text-sm text-fg sm:px-8"
    >
      <h2 id={headingId} className="font-semibold">
        {copy.label}
      </h2>
      <ul className="mt-1 flex list-disc flex-col gap-1 pl-5">
        {notices.map((notice) => (
          <li key={notice.id}>
            {describe(notice)} {copy.at(dateFormat.format(new Date(notice.at)))}
          </li>
        ))}
      </ul>
      <div className="mt-2">
        <Button onClick={() => ack.mutate()} disabled={ack.isPending}>
          {copy.acknowledge}
        </Button>
      </div>
    </section>
  );
}

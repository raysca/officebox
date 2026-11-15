import type { DeviceSession } from "@officebox/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useId, useState } from "react";
import {
  devicesQuery,
  devicesQueryKey,
  signOutDevice,
  signOutEverywhere,
  signOutOtherDevices,
} from "../../lib/api/identity";
import { Alert } from "../../lib/ui/Alert";
import { Button } from "../../lib/ui/Button";
import { Dialog } from "../../lib/ui/Dialog";
import { toastStore } from "../../lib/ui/toast-store";
import { messages } from "../messages";
import { Page } from "../Page";

const copy = messages.devices;

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

function formatTime(ms: number): string {
  return dateFormat.format(new Date(ms));
}

/**
 * My devices (Identity §4.5): the signed-in sessions with browser and system, approximate location,
 * when each signed in and was last active, and which one is this device. Sign out any other device,
 * all other devices, or everywhere (this one included).
 */
export function DevicesPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const devices = useQuery(devicesQuery);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const everywhereId = useId();

  const signOutOne = useMutation({
    mutationFn: signOutDevice,
    onSuccess: async () => {
      toastStore.show(copy.signedOutDevice, "info");
      await queryClient.invalidateQueries({ queryKey: devicesQueryKey });
    },
  });
  const signOutOthers = useMutation({
    mutationFn: signOutOtherDevices,
    onSuccess: async (result) => {
      toastStore.show(copy.signedOutOthers(result.signedOut), "info");
      await queryClient.invalidateQueries({ queryKey: devicesQueryKey });
    },
  });
  const everywhere = useMutation({
    mutationFn: signOutEverywhere,
    onSuccess: async () => {
      setConfirmOpen(false);
      queryClient.clear();
      await navigate({ to: "/sign-in", search: { reason: "signed-out" }, replace: true });
    },
  });

  const sessions = devices.data ?? [];
  const others = sessions.filter((s) => !s.current);

  return (
    <Page title={copy.title} description={copy.description}>
      {devices.isPending ? <p role="status">{copy.loading}</p> : null}
      {devices.isError ? (
        <Alert>
          <span>{copy.failed} </span>
          <button type="button" className="underline underline-offset-2" onClick={() => void devices.refetch()}>
            {copy.retry}
          </button>
        </Alert>
      ) : null}

      {devices.isSuccess ? (
        <section aria-label={copy.listLabel} className="flex flex-col gap-4">
          <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
            {sessions.map((session) => (
              <DeviceRow
                key={session.id}
                session={session}
                pending={signOutOne.isPending && signOutOne.variables === session.id}
                onSignOut={() => signOutOne.mutate(session.id)}
              />
            ))}
          </ul>
          {others.length > 0 ? (
            <div>
              <Button onClick={() => signOutOthers.mutate()} disabled={signOutOthers.isPending}>
                {copy.signOutOthers}
              </Button>
            </div>
          ) : (
            <p className="text-muted">{copy.onlyThisDevice}</p>
          )}
        </section>
      ) : null}

      <section aria-labelledby={everywhereId} className="flex flex-col items-start gap-2 border-t border-border pt-6">
        <h2 id={everywhereId} className="text-lg font-semibold">
          {copy.everywhereTitle}
        </h2>
        <p className="text-muted">{copy.everywhereDescription}</p>
        <Button onClick={() => setConfirmOpen(true)}>{copy.everywhereButton}</Button>
      </section>

      <Dialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title={copy.everywhereTitle}
        closeLabel={copy.cancel}
      >
        <div className="flex flex-col gap-4">
          <p>{copy.everywhereConfirm}</p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button onClick={() => setConfirmOpen(false)}>{copy.cancel}</Button>
            <Button variant="primary" onClick={() => everywhere.mutate()} disabled={everywhere.isPending}>
              {copy.everywhereButton}
            </Button>
          </div>
        </div>
      </Dialog>
    </Page>
  );
}

function DeviceRow({
  session,
  pending,
  onSignOut,
}: {
  session: DeviceSession;
  pending: boolean;
  onSignOut: () => void;
}) {
  const label = session.deviceLabel ?? copy.unknownDevice;
  return (
    <li className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 flex-col gap-1">
        <p className="flex flex-wrap items-center gap-2 font-medium">
          <span>{label}</span>
          {session.current ? (
            <span className="rounded-full border border-accent px-2 py-0.5 text-xs font-semibold text-accent">
              {copy.thisDevice}
            </span>
          ) : null}
        </p>
        <p className="text-sm text-muted">{session.approxLocation ?? copy.unknownLocation}</p>
        <p className="text-sm text-muted">
          {copy.signedIn(formatTime(session.createdAt))} · {copy.lastActive(formatTime(session.lastSeenAt))}
        </p>
      </div>
      {session.current ? null : (
        <Button onClick={onSignOut} disabled={pending} aria-label={copy.signOutDeviceLabel(label)}>
          {copy.signOutDevice}
        </Button>
      )}
    </li>
  );
}

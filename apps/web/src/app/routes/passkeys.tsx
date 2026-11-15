import { isWorkersDevHost, type PasskeySummary } from "@officebox/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { errorReasonOf } from "../../lib/api/client";
import {
  meQueryKey,
  noticesQueryKey,
  passkeysQuery,
  passkeysQueryKey,
  registerPasskey,
  removePasskey,
  renamePasskey,
  useMe,
} from "../../lib/api/identity";
import { Alert } from "../../lib/ui/Alert";
import { Button } from "../../lib/ui/Button";
import { Dialog } from "../../lib/ui/Dialog";
import { TextField } from "../../lib/ui/TextField";
import { toastStore } from "../../lib/ui/toast-store";
import { describePasskeyFailure } from "../forms";
import { messages } from "../messages";
import { Page } from "../Page";

const copy = messages.passkeys;
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const format = (ms: number) => dateFormat.format(new Date(ms));

function nameOf(passkey: PasskeySummary): string {
  return passkey.name ?? copy.unnamed;
}

/**
 * Passkeys (Identity §4.4, §7 screen 6): the member's passkeys with how each was created, add (with
 * step-up, which the API client asks for), rename and remove (step-up; the last one can't go). Shows
 * the `*.workers.dev` warning and the owners' second-passkey reminder.
 */
export function PasskeysPage() {
  const queryClient = useQueryClient();
  const passkeys = useQuery(passkeysQuery);
  const me = useMe().data;
  const [addError, setAddError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<PasskeySummary | null>(null);
  const [removing, setRemoving] = useState<PasskeySummary | null>(null);

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: passkeysQueryKey }),
      queryClient.invalidateQueries({ queryKey: meQueryKey }),
      queryClient.invalidateQueries({ queryKey: noticesQueryKey }),
    ]);
  };

  const add = useMutation({
    mutationFn: registerPasskey,
    meta: { errorToast: false },
    onSuccess: async (result) => {
      if (!result.ok) {
        setAddError(describePasskeyFailure(result.error));
        return;
      }
      toastStore.show(copy.addedToast, "info");
      await refresh();
    },
  });

  const list = passkeys.data ?? [];
  const isOwnerWithOne = me?.user.role === "owner" && me.passkeyCount === 1;

  return (
    <Page title={copy.title} description={copy.description}>
      {isWorkersDevHost(window.location.host) ? <Alert tone="info">{messages.passkey.workersDevWarning}</Alert> : null}
      {isOwnerWithOne ? <Alert tone="info">{copy.ownerReminder}</Alert> : null}
      {passkeys.isPending ? <p role="status">{copy.loading}</p> : null}
      {passkeys.isError ? (
        <Alert>
          <span>{copy.failed} </span>
          <button type="button" className="underline underline-offset-2" onClick={() => void passkeys.refetch()}>
            {copy.retry}
          </button>
        </Alert>
      ) : null}
      {passkeys.isSuccess ? (
        <section aria-label={copy.listLabel} className="flex flex-col gap-4">
          <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
            {list.map((passkey) => (
              <li key={passkey.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 flex-col gap-1">
                  <p className="flex flex-wrap items-center gap-2 font-medium">
                    <span>{nameOf(passkey)}</span>
                    {passkey.backedUp ? (
                      <span className="rounded-full border border-border-strong px-2 py-0.5 text-xs">
                        {copy.synced}
                      </span>
                    ) : null}
                  </p>
                  <p className="text-sm text-muted">{copy.createdVia[passkey.createdVia]}</p>
                  <p className="text-sm text-muted">
                    {passkey.createdAt ? copy.added(format(passkey.createdAt)) : null}
                    {passkey.createdAt ? " · " : null}
                    {passkey.lastUsedAt ? copy.lastUsed(format(passkey.lastUsedAt)) : copy.neverUsed}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button onClick={() => setRenaming(passkey)} aria-label={copy.renameLabel(nameOf(passkey))}>
                    {copy.rename}
                  </Button>
                  <Button onClick={() => setRemoving(passkey)} aria-label={copy.removeLabel(nameOf(passkey))}>
                    {copy.remove}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
          {addError ? <Alert>{addError}</Alert> : null}
          <div>
            <Button
              variant="primary"
              disabled={add.isPending}
              onClick={() => {
                setAddError(null);
                add.mutate();
              }}
            >
              {add.isPending ? copy.adding : copy.add}
            </Button>
          </div>
        </section>
      ) : null}

      {renaming ? <RenameDialog passkey={renaming} onClose={() => setRenaming(null)} onDone={refresh} /> : null}
      {removing ? <RemoveDialog passkey={removing} onClose={() => setRemoving(null)} onDone={refresh} /> : null}
    </Page>
  );
}

function RenameDialog({
  passkey,
  onClose,
  onDone,
}: {
  passkey: PasskeySummary;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [name, setName] = useState(passkey.name ?? "");
  const [error, setError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: renamePasskey,
    onSuccess: async () => {
      toastStore.show(copy.renamedToast, "info");
      onClose();
      await onDone();
    },
  });
  return (
    <Dialog open onClose={onClose} title={copy.renameTitle} closeLabel={copy.cancel}>
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim() === "") {
            setError(messages.form.required);
            return;
          }
          mutation.mutate({ id: passkey.id, name: name.trim() });
        }}
      >
        <TextField
          label={copy.nameLabel}
          value={name}
          maxLength={64}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
          error={error}
          required
        />
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" onClick={onClose}>
            {copy.cancel}
          </Button>
          <Button type="submit" variant="primary" disabled={mutation.isPending}>
            {copy.save}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function RemoveDialog({
  passkey,
  onClose,
  onDone,
}: {
  passkey: PasskeySummary;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: removePasskey,
    meta: { errorToast: false },
    onSuccess: async () => {
      toastStore.show(copy.removedToast, "info");
      onClose();
      await onDone();
    },
    onError: (failure) => {
      setError(errorReasonOf(failure) === "last_passkey" ? copy.lastOne : messages.errors.generic);
    },
  });
  return (
    <Dialog open onClose={onClose} title={copy.removeTitle} closeLabel={copy.cancel}>
      <div className="flex flex-col gap-4">
        <p>{copy.removeConfirm(nameOf(passkey))}</p>
        {error ? <Alert>{error}</Alert> : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button onClick={onClose}>{copy.cancel}</Button>
          <Button variant="primary" disabled={mutation.isPending} onClick={() => mutation.mutate(passkey.id)}>
            {copy.remove}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

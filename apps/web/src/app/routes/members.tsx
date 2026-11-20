import type { AdminMember, EmailChangeResult, RecoveryLinkResult } from "@officebox/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState, type FormEvent } from "react";
import {
  acknowledgeReset,
  changeMemberEmail,
  issueRecoveryLink,
  membersQuery,
  membersQueryKey,
} from "../../lib/api/admin";
import { ApiRequestError, describeApiError, errorReasonOf } from "../../lib/api/client";
import { Alert } from "../../lib/ui/Alert";
import { Button } from "../../lib/ui/Button";
import { Dialog } from "../../lib/ui/Dialog";
import { TextField } from "../../lib/ui/TextField";
import { toastStore } from "../../lib/ui/toast-store";
import { emailError } from "../forms";
import { messages } from "../messages";
import { Page } from "../Page";
import { LoadFailure } from "./admin";
import { LinkField } from "./invitations";

const copy = messages.members;
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

function describe(error: unknown): string {
  const reason = errorReasonOf(error);
  if (reason === "owner_required") return copy.ownerRequired;
  if (reason === "member_disabled") return copy.disabledMember;
  return error instanceof ApiRequestError ? describeApiError(error.detail, "mutation") : messages.errors.generic;
}

/**
 * Members (Identity §4.6, §4.11; Admin §3, §5), M1c's part: the people in the workspace, a recovery link
 * to copy and share privately, and email changes. Both need a fresh passkey confirmation (the API answers
 * `reauth_required` and the step-up prompt asks). Owners see the no-email recovery flag until one
 * acknowledges it. The rest of members administration (roles, disable, delete) arrives with M1e.
 */
export function MembersPage() {
  const members = useQuery(membersQuery);
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: membersQueryKey });
  const [link, setLink] = useState<{ member: AdminMember; result: RecoveryLinkResult } | null>(null);
  const [editing, setEditing] = useState<AdminMember | null>(null);

  const recovery = useMutation({
    mutationFn: async (member: AdminMember) => ({ member, result: await issueRecoveryLink(member.id) }),
    meta: { errorToast: false },
    onSuccess: async (value) => {
      setLink(value);
      await refresh();
    },
    onError: (error) => toastStore.show(describe(error), "error"),
  });
  const acknowledge = useMutation({
    mutationFn: (member: AdminMember) => acknowledgeReset(member.id),
    meta: { errorToast: false },
    onSuccess: async () => {
      toastStore.show(copy.acknowledged, "info");
      await refresh();
    },
    onError: (error) => toastStore.show(describe(error), "error"),
  });

  return (
    <Page title={copy.title} description={copy.description}>
      {members.isPending ? <p role="status">{copy.loading}</p> : null}
      {members.isError ? <LoadFailure query={members} /> : null}
      {members.data ? (
        <section aria-labelledby="members-heading" className="flex flex-col gap-3">
          <h2 id="members-heading" className="text-lg font-semibold">
            {copy.listLabel}
          </h2>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-left text-sm">
              <thead className="bg-surface">
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium">
                    {copy.columnName}
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    {copy.columnEmail}
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    {copy.columnRole}
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    {copy.columnPasskeys}
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    {copy.columnActions}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {members.data.map((member) => (
                  <tr key={member.id}>
                    <th scope="row" className="px-3 py-2 font-normal">
                      <span className="block">{member.displayName}</span>
                      {member.status === "disabled" ? (
                        <span className="block text-sm text-muted">{copy.disabled}</span>
                      ) : null}
                      {member.recoveryFlag ? (
                        <span className="block text-sm text-danger">
                          {copy.flag(member.recoveryFlag.byName, dateFormat.format(new Date(member.recoveryFlag.at)))}
                        </span>
                      ) : null}
                    </th>
                    <td className="px-3 py-2 break-all">
                      {member.email}
                      {member.pendingEmail ? (
                        <span className="block text-sm text-muted">{copy.pendingEmail(member.pendingEmail)}</span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2">{copy.role[member.role]}</td>
                    <td className="px-3 py-2">{member.passkeyCount}</td>
                    <td className="px-3 py-2">
                      {member.status === "active" ? (
                        <div className="flex flex-wrap gap-2">
                          <Button
                            aria-label={copy.recoveryLinkLabel(member.displayName)}
                            disabled={recovery.isPending}
                            onClick={() => recovery.mutate(member)}
                          >
                            {copy.recoveryLink}
                          </Button>
                          <Button
                            aria-label={copy.changeEmailLabel(member.displayName)}
                            onClick={() => setEditing(member)}
                          >
                            {copy.changeEmail}
                          </Button>
                          {member.recoveryFlag ? (
                            <Button
                              aria-label={copy.acknowledgeLabel(member.displayName)}
                              disabled={acknowledge.isPending}
                              onClick={() => acknowledge.mutate(member)}
                            >
                              {copy.acknowledge}
                            </Button>
                          ) : null}
                        </div>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {link ? (
        <Dialog open onClose={() => setLink(null)} title={copy.recoveryTitle}>
          <div className="flex flex-col gap-4 p-4">
            <p className="font-medium break-all">{link.member.email}</p>
            <LinkField link={link.result.link} label={copy.recoveryLinkField} hint={copy.recoveryHint} />
            {link.result.notifiedByEmail ? <p className="text-sm">{copy.recoveryEmailed}</p> : null}
            {link.result.flagged ? <Alert tone="info">{copy.recoveryFlagged}</Alert> : null}
            <div className="flex justify-end">
              <Button onClick={() => setLink(null)}>{copy.done}</Button>
            </div>
          </div>
        </Dialog>
      ) : null}
      {editing ? <ChangeEmailDialog member={editing} onClose={() => setEditing(null)} onDone={refresh} /> : null}
    </Page>
  );
}

function ChangeEmailDialog({
  member,
  onClose,
  onDone,
}: {
  member: AdminMember;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [result, setResult] = useState<EmailChangeResult | null>(null);
  const mutation = useMutation({
    mutationFn: changeMemberEmail,
    meta: { errorToast: false },
    onSuccess: async (value) => {
      setResult(value);
      await onDone();
    },
    onError: (failure) => {
      const reason = errorReasonOf(failure);
      if (reason === "email_taken") setError(copy.taken);
      else if (reason === "email_unchanged") setError(copy.unchanged);
      else setFormError(describe(failure));
      if (reason === "email_taken" || reason === "email_unchanged") inputRef.current?.focus();
    },
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    const problem = emailError(email);
    setError(problem);
    if (problem) {
      inputRef.current?.focus();
      return;
    }
    mutation.mutate({ id: member.id, email: email.trim() });
  }

  return (
    <Dialog open onClose={onClose} title={copy.changeEmailTitle} initialFocusRef={inputRef}>
      <div className="flex flex-col gap-4 p-4">
        <p className="break-all">{member.email}</p>
        {result ? (
          <>
            <Alert tone="info">
              {result.status === "changed" ? copy.changed(result.email) : copy.pendingConfirmation(result.email)}
            </Alert>
            <div className="flex justify-end">
              <Button onClick={onClose}>{copy.done}</Button>
            </div>
          </>
        ) : (
          <form noValidate onSubmit={onSubmit} className="flex flex-col gap-4">
            {formError ? <Alert>{formError}</Alert> : null}
            <TextField
              ref={inputRef}
              label={copy.newEmailLabel}
              type="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setError(null);
              }}
              error={error}
              required
              autoComplete="off"
            />
            <div className="flex flex-wrap justify-end gap-2">
              <Button onClick={onClose}>{copy.cancel}</Button>
              <Button type="submit" variant="primary" disabled={mutation.isPending}>
                {mutation.isPending ? copy.saving : copy.save}
              </Button>
            </div>
          </form>
        )}
      </div>
    </Dialog>
  );
}

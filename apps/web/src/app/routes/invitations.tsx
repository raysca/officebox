import type {
  CreateInvitationResult,
  InvitableRole,
  InvitationEmailOutcome,
  InvitationSummary,
} from "@officebox/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useRef, useState, type FormEvent } from "react";
import {
  copyInvitationLink,
  createInvitation,
  invitationsQuery,
  invitationsQueryKey,
  resendInvitation,
  revokeInvitation,
  settingsQuery,
} from "../../lib/api/admin";
import { ApiRequestError, describeApiError, errorReasonOf } from "../../lib/api/client";
import { groupsQuery } from "../../lib/api/groups";
import { useMe } from "../../lib/api/identity";
import { Alert } from "../../lib/ui/Alert";
import { Button } from "../../lib/ui/Button";
import { Dialog } from "../../lib/ui/Dialog";
import { Link } from "../../lib/ui/Link";
import { TextField } from "../../lib/ui/TextField";
import { toastStore } from "../../lib/ui/toast-store";
import { emailError } from "../forms";
import { messages } from "../messages";
import { Page } from "../Page";
import { LoadFailure } from "./admin";

const copy = messages.invitations;
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const format = (ms: number) => dateFormat.format(new Date(ms));

/** Copies text to the clipboard; false when the browser refused (the caller shows the text to copy). */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function emailOutcomeMessage(outcome: InvitationEmailOutcome, email: string): string | null {
  if (outcome === "queued") return copy.emailQueued(email);
  if (outcome === "not_configured") return copy.emailNotConfigured;
  if (outcome === "limited") return copy.emailLimited;
  if (outcome === "email_unavailable") return copy.emailUnavailable;
  return null;
}

/**
 * Invitations (Identity §4.2; Admin §3): invite by copy link (always) and email (when configured);
 * the pending list with email, role, inviter, sent, expiry and status; copy again, resend and revoke.
 * The Worker's permission engine decides every action (admins invite members; owners invite admins
 * and must meet the invite gate).
 */
export function InvitationsPage() {
  const invitations = useQuery(invitationsQuery);
  const [inviting, setInviting] = useState(false);
  const [revoking, setRevoking] = useState<InvitationSummary | null>(null);
  const [shownLink, setShownLink] = useState<{ email: string; link: string } | null>(null);
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: invitationsQueryKey });

  const copyAgain = useMutation({
    mutationFn: async (invitation: InvitationSummary) => ({
      invitation,
      link: await copyInvitationLink(invitation.id),
    }),
    onSuccess: async ({ invitation, link }) => {
      if (await copyText(link)) toastStore.show(copy.copied, "info");
      else setShownLink({ email: invitation.email, link });
    },
  });
  const resend = useMutation({
    mutationFn: async (invitation: InvitationSummary) => ({
      invitation,
      result: await resendInvitation(invitation.id),
    }),
    onSuccess: async ({ invitation, result }) => {
      const message =
        result.email === "queued"
          ? copy.resent(invitation.email)
          : (emailOutcomeMessage(result.email, invitation.email) ?? "");
      toastStore.show(message, result.email === "queued" ? "info" : "error");
      await refresh();
    },
  });

  const list = invitations.data ?? [];

  return (
    <Page title={copy.title} description={copy.description}>
      <div>
        <Button variant="primary" onClick={() => setInviting(true)}>
          {copy.invite}
        </Button>
      </div>
      {invitations.isPending ? <p role="status">{copy.loading}</p> : null}
      {invitations.isError ? <LoadFailure query={invitations} /> : null}
      {invitations.isSuccess ? (
        <section aria-labelledby="pending-heading" className="flex flex-col gap-2">
          <h2 id="pending-heading" className="text-lg font-semibold">
            {copy.pendingLabel}
          </h2>
          {list.length === 0 ? (
            <p className="text-muted">{copy.empty}</p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-left text-sm">
                <thead className="bg-surface">
                  <tr>
                    <th scope="col" className="px-3 py-2 font-medium">
                      {copy.columnEmail}
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      {copy.columnRole}
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      {copy.columnInviter}
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      {copy.columnSent}
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      {copy.columnExpires}
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      {copy.columnStatus}
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      {copy.columnActions}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {list.map((invitation) => (
                    <tr key={invitation.id}>
                      <th scope="row" className="px-3 py-2 font-normal break-all">
                        {invitation.email}
                      </th>
                      <td className="px-3 py-2">{invitation.role === "admin" ? copy.roleAdmin : copy.roleMember}</td>
                      <td className="px-3 py-2">{invitation.invitedBy?.displayName ?? copy.formerMember}</td>
                      <td className="px-3 py-2">{format(invitation.lastSentAt ?? invitation.createdAt)}</td>
                      <td className="px-3 py-2">{format(invitation.expiresAt)}</td>
                      <td className="px-3 py-2">
                        {copy.status[invitation.status]}
                        {invitation.needsNewLink ? (
                          <span className="block text-sm text-danger">{copy.needsNewLink}</span>
                        ) : null}
                      </td>
                      <td className="px-3 py-2">
                        {invitation.status === "pending" ? (
                          <div className="flex flex-wrap gap-2">
                            <Button
                              aria-label={copy.copyAgainLabel(invitation.email)}
                              disabled={copyAgain.isPending}
                              onClick={() => copyAgain.mutate(invitation)}
                            >
                              {copy.copyAgain}
                            </Button>
                            <Button
                              aria-label={copy.resendLabel(invitation.email)}
                              disabled={resend.isPending}
                              onClick={() => resend.mutate(invitation)}
                            >
                              {copy.resend}
                            </Button>
                            <Button
                              aria-label={copy.revokeLabel(invitation.email)}
                              onClick={() => setRevoking(invitation)}
                            >
                              {copy.revoke}
                            </Button>
                          </div>
                        ) : invitation.status === "expired" ? (
                          <Button
                            aria-label={copy.revokeLabel(invitation.email)}
                            onClick={() => setRevoking(invitation)}
                          >
                            {copy.revoke}
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}

      {inviting ? <InviteDialog onClose={() => setInviting(false)} onCreated={refresh} /> : null}
      {revoking ? <RevokeDialog invitation={revoking} onClose={() => setRevoking(null)} onDone={refresh} /> : null}
      {shownLink ? (
        <Dialog open onClose={() => setShownLink(null)} title={copy.linkTitle}>
          <div className="flex flex-col gap-4 p-4">
            <LinkField link={shownLink.link} />
            <div className="flex justify-end">
              <Button onClick={() => setShownLink(null)}>{copy.done}</Button>
            </div>
          </div>
        </Dialog>
      ) : null}
    </Page>
  );
}

/** A read-only link with a Copy button; shared with the recovery-link and domain-move dialogs (M1c). */
export function LinkField({
  link,
  label = copy.linkLabel,
  hint = copy.linkHint,
}: {
  link: string;
  label?: string;
  hint?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [failed, setFailed] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <TextField
        ref={inputRef}
        label={label}
        hint={hint}
        value={link}
        readOnly
        onFocus={(e) => e.target.select()}
        spellCheck={false}
      />
      {failed ? <Alert>{copy.copyFailed}</Alert> : null}
      <div>
        <Button
          onClick={() => {
            void copyText(link).then((copied) => {
              setFailed(!copied);
              if (copied) toastStore.show(copy.copied, "info");
              else inputRef.current?.select();
            });
          }}
        >
          {copy.copy}
        </Button>
      </div>
    </div>
  );
}

function InviteDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => Promise<void> }) {
  const me = useMe().data;
  const settings = useQuery(settingsQuery);
  const emailOn = settings.data?.email.configured ?? false;
  const isOwner = me?.user.role === "owner";
  const formRef = useRef<HTMLFormElement>(null);
  const roleHintId = useId();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<InvitableRole>("member");
  const [sendEmail, setSendEmail] = useState(true);
  // Groups to join on accepting (Identity §4.2; M1e).
  const groups = useQuery(groupsQuery);
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [gated, setGated] = useState(false);
  const [created, setCreated] = useState<CreateInvitationResult | null>(null);

  const mutation = useMutation({
    mutationFn: createInvitation,
    meta: { errorToast: false },
    onSuccess: async (result) => {
      setCreated(result);
      await onCreated();
    },
    onError: (failure) => {
      const reason = errorReasonOf(failure);
      if (reason === "owner_invite_gate") return setGated(true);
      if (reason === "invitation_pending") return setError(copy.pendingExists);
      if (reason === "already_member") return setError(copy.alreadyMember);
      if (reason === "member_disabled") return setError(copy.memberDisabled);
      if (reason === "invite_domain_not_allowed") return setError(copy.domainNotAllowed);
      setFormError(
        failure instanceof ApiRequestError ? describeApiError(failure.detail, "mutation") : messages.errors.generic,
      );
    },
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    setGated(false);
    const problem = emailError(email);
    setError(problem);
    if (problem) {
      requestAnimationFrame(() => formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
      return;
    }
    mutation.mutate({
      email: email.trim(),
      role,
      sendEmail: emailOn && sendEmail,
      ...(groupIds.length > 0 ? { groupIds } : {}),
    });
  }

  if (created) {
    const outcome = emailOutcomeMessage(created.email, created.invitation.email);
    return (
      <Dialog open onClose={onClose} title={copy.linkTitle}>
        <div className="flex flex-col gap-4 p-4">
          {outcome ? <Alert tone={created.email === "queued" ? "info" : "error"}>{outcome}</Alert> : null}
          <LinkField link={created.link} />
          <div className="flex justify-end">
            <Button variant="primary" onClick={onClose}>
              {copy.done}
            </Button>
          </div>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog open onClose={onClose} title={copy.dialogTitle} closeLabel={copy.cancel}>
      <form ref={formRef} noValidate onSubmit={onSubmit} className="flex flex-col gap-4 p-4">
        {gated ? (
          <Alert>
            <span>{copy.gate} </span>
            <Link to="/settings/passkeys">{copy.gateLink}</Link>
          </Alert>
        ) : null}
        {formError ? <Alert>{formError}</Alert> : null}
        <TextField
          label={copy.emailLabel}
          hint={copy.emailHint}
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
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium">{copy.roleLabel}</legend>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="role"
              value="member"
              checked={role === "member"}
              onChange={() => setRole("member")}
            />
            {copy.roleMember}
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="role"
              value="admin"
              checked={role === "admin"}
              aria-disabled={!isOwner}
              aria-describedby={isOwner ? undefined : roleHintId}
              onChange={() => {
                if (isOwner) setRole("admin");
              }}
            />
            {copy.roleAdmin}
          </label>
          {isOwner ? null : (
            <p id={roleHintId} className="text-sm text-muted">
              {copy.adminOwnerOnly}
            </p>
          )}
        </fieldset>
        {groups.data && groups.data.length > 0 ? (
          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-medium">{copy.groupsLabel}</legend>
            <p className="text-sm text-muted">{copy.groupsHint}</p>
            <div className="flex max-h-40 flex-col gap-1 overflow-y-auto">
              {groups.data.map((group) => (
                <label key={group.id} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={groupIds.includes(group.id)}
                    onChange={(e) =>
                      setGroupIds((ids) =>
                        e.target.checked ? [...ids, group.id] : ids.filter((id) => id !== group.id),
                      )
                    }
                  />
                  {group.name}
                </label>
              ))}
            </div>
          </fieldset>
        ) : null}
        {emailOn ? (
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={sendEmail} onChange={(e) => setSendEmail(e.target.checked)} />
            {copy.sendEmail}
          </label>
        ) : (
          <p className="text-sm text-muted">{copy.emailOff}</p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button onClick={onClose}>{copy.cancel}</Button>
          <Button type="submit" variant="primary" disabled={mutation.isPending}>
            {mutation.isPending ? copy.creating : copy.create}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function RevokeDialog({
  invitation,
  onClose,
  onDone,
}: {
  invitation: InvitationSummary;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const mutation = useMutation({
    mutationFn: revokeInvitation,
    onSuccess: async () => {
      toastStore.show(copy.revoked, "info");
      onClose();
      await onDone();
    },
  });
  return (
    <Dialog open onClose={onClose} title={copy.revokeTitle} closeLabel={copy.cancel}>
      <div className="flex flex-col gap-4 p-4">
        <p>{copy.revokeConfirm(invitation.email)}</p>
        <div className="flex flex-wrap justify-end gap-2">
          <Button onClick={onClose}>{copy.cancel}</Button>
          <Button variant="primary" disabled={mutation.isPending} onClick={() => mutation.mutate(invitation.id)}>
            {copy.revoke}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

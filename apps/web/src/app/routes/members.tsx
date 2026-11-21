import {
  decide,
  type Actor,
  type AdminMember,
  type AdminMemberStatus,
  type AdminMembersQuery,
  type AssignableRole,
  type EmailChangeResult,
  type LastActiveFilter,
  type PermissionCheck,
  type RecoveryLinkResult,
} from "@officebox/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import {
  acknowledgeReset,
  changeMemberEmail,
  changeMemberRole,
  deleteMember,
  issueRecoveryLink,
  membersQueryFor,
  membersQueryKey,
  setMemberStatus,
  signOutMember,
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
import { LinkField } from "./invitations";

const copy = messages.members;
const dateTimeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const dayFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const SELECT_CLASS = "rounded-md border border-border-strong bg-bg px-3 py-2 text-base text-fg";

function describe(error: unknown): string {
  const reason = errorReasonOf(error);
  if (reason === "owner_required") return copy.ownerRequired;
  if (reason === "member_disabled") return copy.disabledMember;
  if (reason === "self_target") return copy.selfOnly;
  if (reason === "last_owner") return copy.lastOwner;
  if (reason === "promotion_passkeys") return copy.promotionPasskeys;
  if (reason === "member_changed") return copy.changedMeanwhile;
  return error instanceof ApiRequestError ? describeApiError(error.detail, "mutation") : messages.errors.generic;
}

/** The search text, settled for 250 ms so each keystroke doesn't send a request. */
function useDebounced(value: string, ms = 250): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/**
 * Members (Identity §4.6, §4.11; Admin §3, §5): everyone in the workspace with role, status, groups and
 * last activity, searchable and filterable; recovery links and email changes (M1c); and for each person
 * the **Manage** dialog (M1e): change role (owners, with a fresh passkey confirmation), deactivate and
 * reactivate, sign out of all devices, and delete. The API asks the permission engine every time;
 * controls the viewer can't use are shown `aria-disabled` with the reason (Admin §3).
 */
export function MembersPage() {
  const [search, setSearch] = useState("");
  const [role, setRole] = useState<AssignableRole | "">("");
  const [status, setStatus] = useState<AdminMemberStatus | "">("");
  const [group, setGroup] = useState("");
  const [lastActive, setLastActive] = useState<LastActiveFilter | "">("");
  const q = useDebounced(search);
  const filters: AdminMembersQuery = {
    ...(q ? { q } : {}),
    ...(role ? { role } : {}),
    ...(status ? { status } : {}),
    ...(group ? { group } : {}),
    ...(lastActive ? { lastActive } : {}),
  };
  const members = useQuery(membersQueryFor(filters));
  const groups = useQuery(groupsQuery);
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: membersQueryKey });
  const [link, setLink] = useState<{ member: AdminMember; result: RecoveryLinkResult } | null>(null);
  const [editing, setEditing] = useState<AdminMember | null>(null);
  const [managing, setManaging] = useState<AdminMember | null>(null);
  const ids = { search: useId(), role: useId(), status: useId(), group: useId(), lastActive: useId() };

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
      <form
        role="search"
        aria-label={copy.filters}
        className="flex flex-wrap items-end gap-4"
        onSubmit={(e) => e.preventDefault()}
      >
        <div className="flex min-w-48 flex-1 flex-col gap-1">
          <label htmlFor={ids.search} className="text-sm font-medium">
            {copy.search}
          </label>
          <p id={`${ids.search}-hint`} className="text-sm text-muted">
            {copy.searchHint}
          </p>
          <input
            id={ids.search}
            type="search"
            className={SELECT_CLASS}
            aria-describedby={`${ids.search}-hint`}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            maxLength={100}
            autoComplete="off"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={ids.role} className="text-sm font-medium">
            {copy.roleFilter}
          </label>
          <select
            id={ids.role}
            className={SELECT_CLASS}
            value={role}
            onChange={(e) => setRole(e.target.value as AssignableRole | "")}
          >
            <option value="">{copy.any}</option>
            {(["owner", "admin", "member"] as const).map((r) => (
              <option key={r} value={r}>
                {copy.role[r]}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={ids.status} className="text-sm font-medium">
            {copy.statusFilter}
          </label>
          <select
            id={ids.status}
            className={SELECT_CLASS}
            value={status}
            onChange={(e) => setStatus(e.target.value as AdminMemberStatus | "")}
          >
            <option value="">{copy.anyStatus}</option>
            {(["active", "invited", "disabled"] as const).map((s) => (
              <option key={s} value={s}>
                {copy.statusLabel[s]}
              </option>
            ))}
          </select>
        </div>
        {groups.data && groups.data.length > 0 ? (
          <div className="flex flex-col gap-1">
            <label htmlFor={ids.group} className="text-sm font-medium">
              {copy.groupFilter}
            </label>
            <select id={ids.group} className={SELECT_CLASS} value={group} onChange={(e) => setGroup(e.target.value)}>
              <option value="">{copy.any}</option>
              {groups.data.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <div className="flex flex-col gap-1">
          <label htmlFor={ids.lastActive} className="text-sm font-medium">
            {copy.lastActiveFilter}
          </label>
          <select
            id={ids.lastActive}
            className={SELECT_CLASS}
            value={lastActive}
            onChange={(e) => setLastActive(e.target.value as LastActiveFilter | "")}
          >
            <option value="">{copy.any}</option>
            {(["within_7d", "within_30d", "over_30d", "never"] as const).map((v) => (
              <option key={v} value={v}>
                {copy.lastActiveLabel[v]}
              </option>
            ))}
          </select>
        </div>
      </form>

      {members.isPending ? <p role="status">{copy.loading}</p> : null}
      {members.isError ? <LoadFailure query={members} /> : null}
      {members.data ? (
        <section aria-labelledby="members-heading" className="flex flex-col gap-3">
          <h2 id="members-heading" className="text-lg font-semibold">
            {copy.listLabel}
          </h2>
          <p role="status" className="text-sm text-muted">
            {members.data.length === 0 ? copy.empty : copy.count(members.data.length)}
          </p>
          {members.data.length > 0 ? (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-left text-sm">
                <thead className="bg-surface">
                  <tr>
                    {[
                      copy.columnName,
                      copy.columnEmail,
                      copy.columnRole,
                      copy.columnStatus,
                      copy.columnGroups,
                      copy.columnPasskeys,
                      copy.columnLastActive,
                      copy.columnJoined,
                      copy.columnActions,
                    ].map((label) => (
                      <th key={label} scope="col" className="px-3 py-2 font-medium">
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {members.data.map((member) => (
                    <tr key={member.id}>
                      <th scope="row" className="px-3 py-2 font-normal">
                        <span className="block">{member.displayName}</span>
                        {member.handle ? <span className="block text-sm text-muted">@{member.handle}</span> : null}
                        {member.recoveryFlag ? (
                          <span className="block text-sm text-danger">
                            {copy.flag(
                              member.recoveryFlag.byName,
                              dateTimeFormat.format(new Date(member.recoveryFlag.at)),
                            )}
                          </span>
                        ) : null}
                        {member.pendingSecurityNotice ? (
                          <span className="block text-sm text-muted">{copy.noticePending}</span>
                        ) : null}
                      </th>
                      <td className="px-3 py-2 break-all">
                        {member.email}
                        {member.pendingEmail ? (
                          <span className="block text-sm text-muted">{copy.pendingEmail(member.pendingEmail)}</span>
                        ) : null}
                      </td>
                      <td className="px-3 py-2">{copy.role[member.role]}</td>
                      <td className="px-3 py-2">{copy.statusLabel[member.status]}</td>
                      <td className="px-3 py-2">
                        {member.groups.length > 0 ? member.groups.map((g) => g.name).join(", ") : copy.noGroups}
                      </td>
                      <td className="px-3 py-2">{member.status === "invited" ? "" : member.passkeyCount}</td>
                      <td className="px-3 py-2">
                        {member.lastActiveAt ? dayFormat.format(new Date(member.lastActiveAt)) : copy.never}
                      </td>
                      <td className="px-3 py-2">
                        {member.joinedAt ? dayFormat.format(new Date(member.joinedAt)) : ""}
                      </td>
                      <td className="px-3 py-2">
                        {member.status === "invited" ? (
                          <Link to="/admin/invitations">{copy.seeInvitations}</Link>
                        ) : (
                          <div className="flex flex-wrap gap-2">
                            <Button
                              aria-label={copy.manageLabel(member.displayName)}
                              onClick={() => setManaging(member)}
                            >
                              {copy.manage}
                            </Button>
                            {member.status === "active" ? (
                              <>
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
                              </>
                            ) : null}
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
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
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
      {managing ? (
        <ManageDialog
          member={managing}
          activeOwners={members.data?.filter((m) => m.role === "owner" && m.status === "active").length ?? 1}
          onClose={() => setManaging(null)}
          onChanged={async (next) => {
            await refresh();
            if (next) setManaging(next);
            else setManaging(null);
          }}
        />
      ) : null}
    </Page>
  );
}

/**
 * Whether the engine would let the viewer try this, for affordances only (the API decides). A step-up
 * denial counts as allowed: the API asks for a passkey and the client retries.
 */
function affordance(actor: Actor | null, check: PermissionCheck): string | null {
  if (!actor) return copy.ownerRequired;
  const decision = decide(actor, check, Date.now());
  if (decision.ok || decision.error === "reauth_required") return null;
  if (decision.error === "self_target") return copy.selfOnly;
  if (decision.error === "last_owner") return copy.lastOwner;
  if (decision.error === "promotion_passkeys") return copy.promotionPasskeys;
  if (decision.error === "owner_required" && check.action === "member.change_role") return copy.roleOwnersOnly;
  return copy.ownerRequired;
}

/** A button the viewer may not be able to use: `aria-disabled` with its reason linked (Admin §3). */
function GuardedButton({
  reason,
  onClick,
  children,
  variant,
  disabled,
}: {
  reason: string | null;
  onClick: () => void;
  children: string;
  variant?: "primary" | "secondary";
  disabled?: boolean;
}) {
  const reasonId = useId();
  return (
    <span className="flex flex-col gap-1">
      <Button
        variant={variant}
        aria-disabled={reason ? true : undefined}
        aria-describedby={reason ? reasonId : undefined}
        disabled={disabled}
        onClick={() => {
          if (!reason) onClick();
        }}
      >
        {children}
      </Button>
      {reason ? (
        <span id={reasonId} className="text-sm text-muted">
          {reason}
        </span>
      ) : null}
    </span>
  );
}

function ManageDialog({
  member,
  activeOwners,
  onClose,
  onChanged,
}: {
  member: AdminMember;
  activeOwners: number;
  onClose: () => void;
  onChanged: (next: AdminMember | null) => Promise<void>;
}) {
  const me = useMe().data;
  const actor: Actor | null = me
    ? { userId: me.user.id, role: me.user.role, status: "active", session: { ...me.session } }
    : null;
  const target = {
    userId: member.id,
    role: member.role,
    status: member.status === "disabled" ? "disabled" : "active",
  } as const;
  const [role, setRole] = useState<AssignableRole>(member.role === "guest" ? "member" : member.role);
  const [confirming, setConfirming] = useState<"deactivate" | "delete" | null>(null);
  const [understood, setUnderstood] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const roleId = useId();
  const roleHintId = useId();

  const facts = { activeOwnerCount: activeOwners };
  const roleReason = affordance(actor, {
    action: "member.change_role",
    target,
    newRole: role,
    activeOwnerCount: activeOwners,
    // The list knows passkeys; the token's state only the Worker knows, so assume it may help.
    targetPasskeyCount: member.passkeyCount,
    recoveryTokenUnconsumed: true,
  });
  const disableReason = affordance(actor, { action: "member.disable", target, ...facts });
  const enableReason = affordance(actor, { action: "member.enable", target, ...facts });
  const signOutReason = affordance(actor, { action: "member.sign_out_all", target, ...facts });
  const deleteReason = affordance(actor, { action: "member.delete", target, ...facts });

  const onError = (failure: unknown) => setError(describe(failure));
  const changeRole = useMutation({
    mutationFn: changeMemberRole,
    meta: { errorToast: false },
    onSuccess: async (result) => {
      toastStore.show(copy.roleChanged(member.displayName, copy.role[result.role]), "info");
      await onChanged({ ...member, role: result.role });
    },
    onError,
  });
  const status = useMutation({
    mutationFn: setMemberStatus,
    meta: { errorToast: false },
    onSuccess: async (result) => {
      toastStore.show(
        result.status === "disabled" ? copy.deactivated(member.displayName) : copy.reactivated(member.displayName),
        "info",
      );
      setConfirming(null);
      await onChanged({ ...member, status: result.status });
    },
    onError,
  });
  const signOut = useMutation({
    mutationFn: signOutMember,
    meta: { errorToast: false },
    onSuccess: (result) => toastStore.show(copy.signedOut(result.signedOut), "info"),
    onError,
  });
  const remove = useMutation({
    mutationFn: deleteMember,
    meta: { errorToast: false },
    onSuccess: async () => {
      toastStore.show(copy.deletedToast, "info");
      await onChanged(null);
    },
    onError,
  });

  function submitRole(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (roleReason) return;
    changeRole.mutate({ id: member.id, role });
  }

  return (
    <Dialog open onClose={onClose} title={copy.manageTitle(member.displayName)} closeLabel={copy.cancel}>
      <div className="flex flex-col gap-6 p-4">
        <p className="break-all">
          {member.email} · {copy.role[member.role]} · {copy.statusLabel[member.status]}
        </p>
        {error ? <Alert>{error}</Alert> : null}

        <section aria-labelledby={`${roleId}-h`} className="flex flex-col gap-2">
          <h3 id={`${roleId}-h`} className="font-semibold">
            {copy.roleSection}
          </h3>
          <form noValidate onSubmit={submitRole} className="flex flex-wrap items-end gap-2">
            <div className="flex flex-col gap-1">
              <label htmlFor={roleId} className="text-sm font-medium">
                {copy.roleSelect}
              </label>
              <p id={roleHintId} className="text-sm text-muted">
                {copy.roleHint}
              </p>
              <select
                id={roleId}
                className={SELECT_CLASS}
                aria-describedby={roleHintId}
                value={role}
                onChange={(e) => setRole(e.target.value as AssignableRole)}
              >
                {(["member", "admin", "owner"] as const).map((r) => (
                  <option key={r} value={r}>
                    {copy.role[r]}
                  </option>
                ))}
              </select>
            </div>
            {roleReason && role !== member.role ? (
              <GuardedButton reason={roleReason} onClick={() => undefined}>
                {copy.changeRole}
              </GuardedButton>
            ) : (
              <Button type="submit" variant="primary" disabled={changeRole.isPending || role === member.role}>
                {changeRole.isPending ? copy.changingRole : copy.changeRole}
              </Button>
            )}
          </form>
        </section>

        <section aria-labelledby={`${roleId}-access`} className="flex flex-col gap-2">
          <h3 id={`${roleId}-access`} className="font-semibold">
            {copy.accessSection}
          </h3>
          {confirming === "deactivate" ? (
            <div className="flex flex-col gap-2 rounded-md border border-border p-3">
              <p>{copy.deactivateConfirm(member.displayName)}</p>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="primary"
                  disabled={status.isPending}
                  onClick={() => status.mutate({ id: member.id, status: "disabled" })}
                >
                  {copy.deactivate}
                </Button>
                <Button onClick={() => setConfirming(null)}>{copy.cancel}</Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-4">
              {member.status === "active" ? (
                <GuardedButton reason={disableReason} onClick={() => setConfirming("deactivate")}>
                  {copy.deactivate}
                </GuardedButton>
              ) : (
                <GuardedButton
                  reason={enableReason}
                  disabled={status.isPending}
                  onClick={() => status.mutate({ id: member.id, status: "active" })}
                >
                  {copy.reactivate}
                </GuardedButton>
              )}
              <GuardedButton
                reason={signOutReason}
                disabled={signOut.isPending}
                onClick={() => signOut.mutate(member.id)}
              >
                {copy.signOutAll}
              </GuardedButton>
            </div>
          )}
        </section>

        <section aria-labelledby={`${roleId}-delete`} className="flex flex-col gap-2">
          <h3 id={`${roleId}-delete`} className="font-semibold">
            {copy.deleteSection}
          </h3>
          <p className="text-sm text-muted">{copy.deleteHint}</p>
          {confirming === "delete" ? (
            <div className="flex flex-col gap-2 rounded-md border border-danger p-3">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />
                {copy.deleteAcknowledge}
              </label>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="primary"
                  disabled={!understood || remove.isPending}
                  onClick={() => remove.mutate(member.id)}
                >
                  {remove.isPending ? copy.deleting : copy.deleteAccount}
                </Button>
                <Button onClick={() => setConfirming(null)}>{copy.cancel}</Button>
              </div>
            </div>
          ) : (
            <div>
              <GuardedButton reason={deleteReason} onClick={() => setConfirming("delete")}>
                {copy.deleteAccount}
              </GuardedButton>
            </div>
          )}
        </section>

        <div className="flex justify-end">
          <Button onClick={onClose}>{copy.done}</Button>
        </div>
      </div>
    </Dialog>
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

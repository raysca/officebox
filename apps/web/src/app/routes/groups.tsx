import type { GroupDetail, GroupMember, GroupSummary } from "@officebox/shared";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { ApiRequestError, describeApiError, errorCodeOf, errorReasonOf } from "../../lib/api/client";
import {
  createGroup,
  deleteGroup,
  groupQuery,
  groupsQuery,
  groupsQueryKey,
  putGroupMember,
  removeGroupMember,
  updateGroup,
} from "../../lib/api/groups";
import { useMe } from "../../lib/api/identity";
import { directoryQuery } from "../../lib/api/profile";
import { Alert } from "../../lib/ui/Alert";
import { Avatar } from "../../lib/ui/Avatar";
import { Button } from "../../lib/ui/Button";
import { Dialog } from "../../lib/ui/Dialog";
import { Link } from "../../lib/ui/Link";
import { TextField } from "../../lib/ui/TextField";
import { toastStore } from "../../lib/ui/toast-store";
import { messages } from "../messages";
import { Page } from "../Page";

const copy = messages.groups;

function describe(error: unknown): string {
  const reason = errorReasonOf(error);
  if (reason === "owner_required") return copy.ownerRequired;
  if (reason === "group_name_taken") return copy.nameTaken;
  if (reason === "not_permitted") return copy.adminsOnly;
  return error instanceof ApiRequestError ? describeApiError(error.detail, "mutation") : messages.errors.generic;
}

/** The field errors a create or edit got back, by field. */
function fieldErrors(error: unknown): { name?: string; handle?: string } {
  if (!(error instanceof ApiRequestError) || error.detail.kind !== "api") return {};
  const fields = error.detail.error.fields ?? {};
  return { name: fields.name?.[0], handle: fields.handle?.[0] };
}

function useIsAdmin(): boolean {
  const role = useMe().data?.user.role;
  return role === "owner" || role === "admin";
}

/**
 * Groups (Identity §4.9; Admin §3; M1e): every group with its members and managers, for everyone.
 * Admins create groups here; each group's page manages it.
 */
export function GroupsPage() {
  const groups = useQuery(groupsQuery);
  const isAdmin = useIsAdmin();
  const [creating, setCreating] = useState(false);

  return (
    <Page title={copy.title} description={copy.description}>
      {isAdmin ? (
        <div>
          <Button variant="primary" onClick={() => setCreating(true)}>
            {copy.create}
          </Button>
        </div>
      ) : null}
      {groups.isPending ? <p role="status">{copy.loading}</p> : null}
      {groups.isError ? (
        <Alert>
          <span>{copy.failed} </span>
          <button type="button" className="underline underline-offset-2" onClick={() => void groups.refetch()}>
            {copy.retry}
          </button>
        </Alert>
      ) : null}
      {groups.data ? (
        groups.data.length === 0 ? (
          <p>{copy.empty}</p>
        ) : (
          <ul aria-label={copy.title} className="grid gap-3 sm:grid-cols-2">
            {groups.data.map((group) => (
              <li key={group.id} className="flex flex-col gap-1 rounded-lg border border-border p-4">
                <p className="font-medium">
                  <Link to="/groups/$groupId" params={{ groupId: group.id }}>
                    {group.name}
                  </Link>
                </p>
                {group.handle ? <p className="text-sm text-muted">@{group.handle}</p> : null}
                {group.description ? <p className="text-sm">{group.description}</p> : null}
                <p className="text-sm text-muted">
                  {copy.members(group.memberCount)} · {copy.managers(group.managerCount)}
                </p>
                {group.youManage ? <p className="text-sm">{copy.youManage}</p> : null}
              </li>
            ))}
          </ul>
        )
      ) : null}
      {creating ? <GroupFormDialog onClose={() => setCreating(false)} /> : null}
    </Page>
  );
}

/** Create a group (no `group`) or edit one. */
function GroupFormDialog({ group, onClose }: { group?: GroupSummary; onClose: () => void }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(group?.name ?? "");
  const [handle, setHandle] = useState(group?.handle ?? "");
  const [description, setDescription] = useState(group?.description ?? "");
  const [errors, setErrors] = useState<{ name?: string; handle?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const descriptionId = useId();

  const mutation = useMutation({
    mutationFn: (body: { name: string; handle: string; description: string | null }) =>
      group ? updateGroup({ id: group.id, ...body }) : createGroup(body),
    meta: { errorToast: false },
    onSuccess: async (saved) => {
      await queryClient.invalidateQueries({ queryKey: groupsQueryKey });
      toastStore.show(group ? copy.saved : copy.created(saved.name), "info");
      onClose();
      if (!group) await navigate({ to: "/groups/$groupId", params: { groupId: saved.id } });
    },
    onError: (failure) => {
      const fields = fieldErrors(failure);
      if (errorReasonOf(failure) === "group_name_taken") fields.name = copy.nameTaken;
      setErrors(fields);
      if (!fields.name && !fields.handle) setFormError(describe(failure));
      else nameRef.current?.focus();
    },
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    setErrors({});
    const problems = {
      ...(name.trim() === "" ? { name: copy.required } : {}),
      ...(handle.trim() === "" ? { handle: copy.required } : {}),
    };
    if (problems.name || problems.handle) {
      setErrors(problems);
      return;
    }
    mutation.mutate({ name: name.trim(), handle: handle.trim(), description: description.trim() || null });
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={group ? copy.editTitle : copy.createTitle}
      initialFocusRef={nameRef}
      closeLabel={copy.cancel}
    >
      <form noValidate onSubmit={onSubmit} className="flex flex-col gap-4 p-4">
        {formError ? <Alert>{formError}</Alert> : null}
        <TextField
          ref={nameRef}
          label={copy.nameLabel}
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={errors.name}
          required
          maxLength={64}
          autoComplete="off"
        />
        <TextField
          label={copy.handleLabel}
          hint={copy.handleHint}
          value={handle}
          onChange={(e) => setHandle(e.target.value)}
          error={errors.handle}
          required
          maxLength={33}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
        />
        <div className="flex flex-col gap-1">
          <label htmlFor={descriptionId} className="text-sm font-medium">
            {copy.descriptionLabel}
          </label>
          <textarea
            id={descriptionId}
            className="rounded-md border border-border-strong bg-bg px-3 py-2 text-base text-fg"
            rows={3}
            maxLength={500}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <Button onClick={onClose}>{copy.cancel}</Button>
          <Button type="submit" variant="primary" disabled={mutation.isPending}>
            {group ? (mutation.isPending ? copy.saving : copy.save) : mutation.isPending ? copy.creating : copy.create}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** The search text, settled for 250 ms. */
function useDebounced(value: string, ms = 250): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/**
 * One group (Identity §4.9): its members, managers first. Admins edit, delete and appoint managers;
 * admins and the group's managers add and remove members. The API asks the engine every time.
 */
export function GroupPage({ groupId }: { groupId: string }) {
  const group = useQuery(groupQuery(groupId));
  const isAdmin = useIsAdmin();
  const me = useMe().data;
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const refresh = () => queryClient.invalidateQueries({ queryKey: groupsQueryKey });

  const membership = useMutation({
    mutationFn: putGroupMember,
    meta: { errorToast: false },
    onSuccess: refresh,
    onError: (failure) => toastStore.show(describe(failure), "error"),
  });
  const removal = useMutation({
    mutationFn: removeGroupMember,
    meta: { errorToast: false },
    onSuccess: refresh,
    onError: (failure) => toastStore.show(describe(failure), "error"),
  });
  const removeGroup = useMutation({
    mutationFn: deleteGroup,
    meta: { errorToast: false },
    onSuccess: async () => {
      toastStore.show(copy.deleted(group.data?.name ?? ""), "info");
      await refresh();
      await navigate({ to: "/groups" });
    },
    onError: (failure) => toastStore.show(describe(failure), "error"),
  });

  const title = group.data?.name ?? copy.title;
  if (group.isError) {
    return (
      <Page title={copy.title}>
        <Alert>{errorCodeOf(group.error) === "not_found" ? copy.notFound : copy.failed}</Alert>
        <p>
          <Link to="/groups">{copy.back}</Link>
        </p>
      </Page>
    );
  }
  const data = group.data;
  const canManageMembers = isAdmin || data?.youManage === true;

  return (
    <Page title={title} description={data?.description ?? undefined}>
      <p>
        <Link to="/groups">{copy.back}</Link>
      </p>
      {group.isPending ? <p role="status">{copy.loading}</p> : null}
      {data ? (
        <>
          <p className="text-muted">
            {data.handle ? `@${data.handle} · ` : ""}
            {copy.members(data.memberCount)} · {copy.managers(data.managerCount)}
          </p>
          {isAdmin ? (
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => setEditing(true)}>{copy.edit}</Button>
              <Button onClick={() => setDeleting(true)}>{copy.deleteGroup}</Button>
            </div>
          ) : null}

          <section aria-labelledby="group-members" className="flex flex-col gap-3">
            <h2 id="group-members" className="text-lg font-semibold">
              {copy.membersHeading}
            </h2>
            {data.members.length === 0 ? <p>{copy.noMembers}</p> : null}
            <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
              {data.members.map((member) => (
                <MemberItem
                  key={member.id}
                  member={member}
                  isAdmin={isAdmin}
                  canManage={canManageMembers}
                  isSelf={member.id === me?.user.id}
                  busy={membership.isPending || removal.isPending}
                  onRole={(role) => membership.mutate({ groupId, userId: member.id, role })}
                  onRemove={() =>
                    removal.mutate(
                      { groupId, userId: member.id },
                      { onSuccess: () => toastStore.show(copy.removed(member.displayName), "info") },
                    )
                  }
                />
              ))}
            </ul>
          </section>

          {canManageMembers ? <AddPeople group={data} /> : null}
        </>
      ) : null}
      {editing && data ? <GroupFormDialog group={data} onClose={() => setEditing(false)} /> : null}
      {deleting && data ? (
        <Dialog open onClose={() => setDeleting(false)} title={copy.deleteTitle(data.name)} closeLabel={copy.cancel}>
          <div className="flex flex-col gap-4 p-4">
            <p>{copy.deleteHint}</p>
            <div className="flex flex-wrap justify-end gap-2">
              <Button onClick={() => setDeleting(false)}>{copy.cancel}</Button>
              <Button variant="primary" disabled={removeGroup.isPending} onClick={() => removeGroup.mutate(data.id)}>
                {copy.deleteGroup}
              </Button>
            </div>
          </div>
        </Dialog>
      ) : null}
    </Page>
  );
}

function MemberItem({
  member,
  isAdmin,
  canManage,
  isSelf,
  busy,
  onRole,
  onRemove,
}: {
  member: GroupMember;
  isAdmin: boolean;
  canManage: boolean;
  isSelf: boolean;
  busy: boolean;
  onRole: (role: "manager" | "member") => void;
  onRemove: () => void;
}) {
  // A manager who isn't an admin removes members and themselves, never another manager.
  const mayRemove = isAdmin || (canManage && (member.role === "member" || isSelf));
  return (
    <li className="flex flex-wrap items-center gap-3 p-3">
      <Avatar name={member.displayName} url={member.avatarUrl} size="sm" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="font-medium">{member.displayName}</span>
        <span className="text-sm text-muted">
          {[member.handle ? `@${member.handle}` : null, member.role === "manager" ? copy.manager : copy.member]
            .concat(member.deactivated ? [copy.deactivated] : [])
            .filter(Boolean)
            .join(" · ")}
        </span>
      </span>
      <span className="flex flex-wrap gap-2">
        {isAdmin ? (
          member.role === "manager" ? (
            <Button
              aria-label={copy.makeMemberLabel(member.displayName)}
              disabled={busy}
              onClick={() => onRole("member")}
            >
              {copy.makeMember}
            </Button>
          ) : (
            <Button
              aria-label={copy.makeManagerLabel(member.displayName)}
              disabled={busy || member.deactivated}
              onClick={() => onRole("manager")}
            >
              {copy.makeManager}
            </Button>
          )
        ) : null}
        {mayRemove ? (
          <Button
            aria-label={isSelf ? copy.leave : copy.removeLabel(member.displayName)}
            disabled={busy}
            onClick={onRemove}
          >
            {isSelf ? copy.leave : copy.remove}
          </Button>
        ) : null}
      </span>
    </li>
  );
}

/** Find people in the directory and add them (admins and the group's managers). */
function AddPeople({ group }: { group: GroupDetail }) {
  const [search, setSearch] = useState("");
  const q = useDebounced(search);
  const people = useInfiniteQuery({ ...directoryQuery(q, "active"), enabled: q.trim().length > 0 });
  const queryClient = useQueryClient();
  const searchId = useId();
  const inGroup = new Set(group.members.map((m) => m.id));
  const add = useMutation({
    mutationFn: putGroupMember,
    meta: { errorToast: false },
    onSuccess: async (_result, variables) => {
      const person = people.data?.pages.flatMap((p) => p.members).find((m) => m.id === variables.userId);
      toastStore.show(copy.added(person?.displayName ?? ""), "info");
      await queryClient.invalidateQueries({ queryKey: groupsQueryKey });
    },
    onError: (failure) => toastStore.show(describe(failure), "error"),
  });
  const results = people.data?.pages[0]?.members.slice(0, 10) ?? [];

  return (
    <section aria-labelledby="group-add" className="flex flex-col gap-3">
      <h2 id="group-add" className="text-lg font-semibold">
        {copy.addHeading}
      </h2>
      <div className="flex flex-col gap-1">
        <label htmlFor={searchId} className="text-sm font-medium">
          {copy.addSearch}
        </label>
        <p id={`${searchId}-hint`} className="text-sm text-muted">
          {copy.addSearchHint}
        </p>
        <input
          id={searchId}
          type="search"
          aria-describedby={`${searchId}-hint`}
          className="rounded-md border border-border-strong bg-bg px-3 py-2 text-base text-fg"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          maxLength={100}
          autoComplete="off"
        />
      </div>
      {q.trim() && people.isSuccess ? (
        <div className="flex flex-col gap-2">
          <p role="status" className="text-sm text-muted">
            {results.length === 0 ? copy.noMatches : ""}
          </p>
          <ul className="flex flex-col gap-2">
            {results.map((person) => (
              <li key={person.id} className="flex flex-wrap items-center gap-3">
                <Avatar name={person.displayName} url={person.avatarUrl} size="sm" />
                <span className="flex-1">
                  {person.displayName}
                  {person.handle ? <span className="text-sm text-muted"> @{person.handle}</span> : null}
                </span>
                {inGroup.has(person.id) ? (
                  <span className="text-sm text-muted">{copy.alreadyIn}</span>
                ) : (
                  <Button
                    aria-label={copy.addLabel(person.displayName)}
                    disabled={add.isPending}
                    onClick={() => add.mutate({ groupId: group.id, userId: person.id, role: "member" })}
                  >
                    {copy.add}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

import type { DirectoryFilter, MemberProfile } from "@officebox/shared";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import { directoryQuery, memberQuery } from "../../lib/api/profile";
import { localTime, regionLabel, workingHoursSummary } from "../../lib/profile-format";
import { Alert } from "../../lib/ui/Alert";
import { Avatar } from "../../lib/ui/Avatar";
import { Button } from "../../lib/ui/Button";
import { Dialog } from "../../lib/ui/Dialog";
import { messages } from "../messages";
import { Page } from "../Page";

const copy = messages.directory;
const card = messages.profileCard;

/** The search text, settled for 250 ms so each keystroke doesn't send a request. */
function useDebounced(value: string, ms = 250): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/** Re-renders once a minute, so local times stay current. */
function useMinuteClock(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function statusText(member: MemberProfile): string | null {
  if (!member.status) return null;
  return [member.status.emoji, member.status.text].filter(Boolean).join(" ") || null;
}

/**
 * The member directory (Identity §4.10, §7 screen 7; M1d): everyone's name, handle, avatar, title, team,
 * local time and status, searchable by name, handle, email, title or team, with the Deactivated filter.
 * Choosing someone opens their profile card.
 */
export function DirectoryPage() {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<DirectoryFilter>("active");
  const [openId, setOpenId] = useState<string | null>(null);
  const q = useDebounced(search);
  const people = useInfiniteQuery(directoryQuery(q, filter));
  const now = useMinuteClock();
  const searchId = useId();
  const filterId = useId();

  const members = people.data?.pages.flatMap((page) => page.members) ?? [];

  return (
    <Page title={copy.title} description={copy.description}>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
        <div className="flex flex-1 flex-col gap-1">
          <label htmlFor={searchId} className="text-sm font-medium">
            {copy.search}
          </label>
          <p id={`${searchId}-hint`} className="text-sm text-muted">
            {copy.searchHint}
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
        <div role="group" aria-labelledby={filterId} className="flex flex-col gap-1">
          <span id={filterId} className="text-sm font-medium">
            {copy.filterLabel}
          </span>
          <div className="flex gap-2">
            {(["active", "deactivated"] as const).map((value) => (
              <Button
                key={value}
                variant={filter === value ? "primary" : "secondary"}
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
              >
                {copy[value]}
              </Button>
            ))}
          </div>
        </div>
      </div>

      {people.isPending ? <p role="status">{copy.loading}</p> : null}
      {people.isError ? (
        <Alert>
          <span>{copy.failed} </span>
          <button type="button" className="underline underline-offset-2" onClick={() => void people.refetch()}>
            {copy.retry}
          </button>
        </Alert>
      ) : null}

      {people.isSuccess ? (
        <section aria-label={copy.title} className="flex flex-col gap-4">
          <p role="status" className="text-sm text-muted">
            {members.length === 0 ? copy.empty : copy.results(members.length, Boolean(people.hasNextPage))}
          </p>
          {members.length > 0 ? (
            <ul className="grid gap-3 sm:grid-cols-2">
              {members.map((member) => (
                <li key={member.id}>
                  <MemberRow member={member} now={now} onOpen={() => setOpenId(member.id)} />
                </li>
              ))}
            </ul>
          ) : null}
          {people.hasNextPage ? (
            <div>
              <Button onClick={() => void people.fetchNextPage()} disabled={people.isFetchingNextPage}>
                {people.isFetchingNextPage ? copy.loadingMore : copy.loadMore}
              </Button>
            </div>
          ) : null}
        </section>
      ) : null}

      <ProfileCard
        memberId={openId}
        initial={members.find((m) => m.id === openId) ?? null}
        now={now}
        onClose={() => setOpenId(null)}
      />
    </Page>
  );
}

function MemberRow({ member, now, onOpen }: { member: MemberProfile; now: Date; onOpen: () => void }) {
  const time = localTime(member.timezone, now);
  const status = statusText(member);
  const subtitle = [member.jobTitle, member.team].filter(Boolean).join(" · ");
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-start gap-3 rounded-lg border border-border p-3 text-left hover:bg-surface motion-safe:transition-colors"
    >
      <Avatar name={member.displayName} url={member.avatarUrl} />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-medium">{member.displayName}</span>
          {member.pronouns ? <span className="text-sm text-muted">{member.pronouns}</span> : null}
          {member.deactivated ? (
            <span className="rounded-full border border-border-strong px-2 text-xs">{copy.deactivatedBadge}</span>
          ) : null}
        </span>
        {member.handle ? <span className="text-sm text-muted">@{member.handle}</span> : null}
        {subtitle ? <span className="text-sm">{subtitle}</span> : null}
        {status ? <span className="text-sm">{status}</span> : null}
        {time ? <span className="text-sm text-muted">{copy.localTime(time)}</span> : null}
      </span>
    </button>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col">
      <dt className="text-sm text-muted">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/**
 * The profile card (Identity §4.7): name, handle, pronouns, title, team, local time and working hours,
 * status, contact details, region and groups. The message and call buttons arrive with Chat (M3) and
 * Calls (M4) **(default)**.
 */
function ProfileCard({
  memberId,
  initial,
  now,
  onClose,
}: {
  memberId: string | null;
  initial: MemberProfile | null;
  now: Date;
  onClose: () => void;
}) {
  const fresh = useQuery({ ...memberQuery(memberId ?? ""), enabled: memberId !== null });
  const member = fresh.data ?? initial;
  const title = member?.displayName ?? card.loading;
  const time = member ? localTime(member.timezone, now) : null;
  return (
    <Dialog open={memberId !== null} onClose={onClose} title={title} closeLabel={card.close}>
      {!member && fresh.isError ? <Alert>{card.failed}</Alert> : null}
      {!member && !fresh.isError ? <p role="status">{card.loading}</p> : null}
      {member ? (
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-4">
            <Avatar name={member.displayName} url={member.avatarUrl} size="lg" />
            <div className="flex min-w-0 flex-col">
              {member.handle ? <span className="text-muted">@{member.handle}</span> : null}
              {member.pronouns ? <span>{member.pronouns}</span> : null}
              {member.jobTitle || member.team ? (
                <span>{[member.jobTitle, member.team].filter(Boolean).join(" · ")}</span>
              ) : null}
              {member.deactivated ? <span className="text-sm">{copy.deactivatedBadge}</span> : null}
            </div>
          </div>
          <dl className="grid gap-3 sm:grid-cols-2">
            {statusText(member) ? <Detail label={card.status}>{statusText(member)}</Detail> : null}
            <Detail label={card.localTime}>
              {time ? `${time} (${member.timezone.replace(/_/g, " ")})` : member.timezone}
            </Detail>
            <Detail label={card.workingHours}>
              {workingHoursSummary(member.workingHours)}
              {member.workingHoursDefaulted ? ` ${card.workingHoursDefault}` : null}
            </Detail>
            {member.region ? <Detail label={card.region}>{regionLabel(member.region)}</Detail> : null}
            <Detail label={card.email}>
              <a className="underline underline-offset-2" href={`mailto:${member.email}`}>
                {member.email}
              </a>
            </Detail>
            {member.phone ? (
              <Detail label={card.phone}>
                <a className="underline underline-offset-2" href={`tel:${member.phone.replace(/[^+\d]/g, "")}`}>
                  {member.phone}
                </a>
              </Detail>
            ) : null}
            {member.location ? <Detail label={card.location}>{member.location}</Detail> : null}
            <Detail label={card.groups}>
              {member.groups.length > 0 ? member.groups.map((g) => g.name).join(", ") : card.noGroups}
            </Detail>
          </dl>
        </div>
      ) : null}
    </Dialog>
  );
}

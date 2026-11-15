import {
  apiErrorBodySchema,
  type Actor,
  type PersonRef,
  type SessionFacts,
  type WorkspaceRole,
} from "@officebox/shared";
import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createApp, defineFeature } from "../src/core/app";
import type { AppEnv } from "../src/core/context";
import { HTTP_STATUS, respond } from "../src/core/errors";
import { createLogger, type LogLevel } from "../src/core/log";
import {
  authorize,
  authorizeCheck,
  denialError,
  type PermissionContext,
  type PermissionFacts,
  type PermissionRequest,
} from "../src/core/permissions";

/**
 * The Worker wrapper around the permission engine: fact loading, the mapping of denials to typed
 * errors and HTTP statuses, and denial logging. The engine's rules themselves are covered by the matrix
 * test in packages/shared.
 */

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;

interface World {
  people: Record<string, PersonRef>;
  passkeys: Record<string, number>;
  recoveryTokenUnconsumed: boolean;
  magicLinksAvailable: boolean;
  groups: Record<string, string[]>;
}

/** Stub loaders over an in-memory world, recording each call so tests can see what was loaded. */
function stubFacts(world: World) {
  const calls: string[] = [];
  /** Records the call and answers asynchronously, like a D1 query. */
  const load = <T>(name: string, value: () => T): Promise<T> => {
    calls.push(name);
    return Promise.resolve().then(value);
  };
  const facts: PermissionFacts = {
    person: (id) => load(`person:${id}`, () => world.people[id] ?? null),
    activeOwnerCount: () =>
      load(
        "activeOwnerCount",
        () => Object.values(world.people).filter((p) => p.role === "owner" && p.status === "active").length,
      ),
    passkeyCount: (id) => load(`passkeyCount:${id}`, () => world.passkeys[id] ?? 0),
    recoveryTokenUnconsumed: () => load("recoveryTokenUnconsumed", () => world.recoveryTokenUnconsumed),
    magicLinksAvailable: () => load("magicLinksAvailable", () => world.magicLinksAvailable),
    groupManagerIds: (id) => load(`groupManagerIds:${id}`, () => world.groups[id] ?? null),
  };
  return { facts, calls };
}

/** A fresh world per test (storage-free, but the same habit as AGENTS §5: unique IDs per test). */
function world(overrides: Partial<World> = {}): World {
  const id = crypto.randomUUID();
  return {
    people: {
      [`owner-${id}`]: { userId: `owner-${id}`, role: "owner", status: "active" },
      [`admin-${id}`]: { userId: `admin-${id}`, role: "admin", status: "active" },
      [`member-${id}`]: { userId: `member-${id}`, role: "member", status: "active" },
    },
    passkeys: {},
    recoveryTokenUnconsumed: false,
    magicLinksAvailable: true,
    groups: {},
    ...overrides,
  };
}

const idOf = (w: World, role: WorkspaceRole): string => {
  const found = Object.values(w.people).find((p) => p.role === role);
  if (!found) throw new Error(`no ${role} in the world`);
  return found.userId;
};

const passkeySession = (ageMs: number): SessionFacts => ({ freshAuthAt: NOW - ageMs, freshAuthMethod: "passkey" });

function setup(w: World, role: WorkspaceRole, session: SessionFacts | null = passkeySession(MINUTE)) {
  const person = w.people[idOf(w, role)]!;
  const actor: Actor = { ...person, session };
  const lines: { level: LogLevel; line: string }[] = [];
  const { facts, calls } = stubFacts(w);
  const ctx: PermissionContext = {
    log: createLogger({}, (level, line) => lines.push({ level, line })),
    now: () => NOW,
    actor,
    facts,
  };
  return { ctx, calls, lines, actor };
}

describe("authorize: results", () => {
  it("returns ok when the engine allows", async () => {
    const w = world();
    const { ctx } = setup(w, "admin");
    expect(await authorize(ctx, { action: "member.disable", targetId: idOf(w, "member") })).toEqual({
      ok: true,
      value: undefined,
    });
  });

  it("maps a denial to forbidden with the engine's reason and message", async () => {
    const w = world();
    const { ctx } = setup(w, "admin");
    const result = await authorize(ctx, { action: "member.disable", targetId: idOf(w, "owner") });
    expect(result).toEqual({
      ok: false,
      error: { code: "forbidden", message: "An owner must do this.", reason: "owner_required" },
    });
  });

  it("maps a step-up denial to reauth_required", async () => {
    const w = world();
    const { ctx } = setup(w, "admin", passkeySession(60 * MINUTE));
    const result = await authorize(ctx, { action: "member.issue_recovery_link", targetId: idOf(w, "member") });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("reauth_required");
      expect(result.error.reason).toBe("reauth_required");
    }
  });

  it("hides a denial as not_found when asked, but never a step-up denial", async () => {
    const w = world();
    const member = setup(w, "member");
    const hidden = await authorize(
      member.ctx,
      { action: "member.export", subjectId: idOf(w, "owner"), phase: "start" },
      { hideAs404: true },
    );
    expect(hidden).toEqual({ ok: false, error: { code: "not_found", message: "Not found." } });

    const stale = setup(w, "owner", passkeySession(60 * MINUTE));
    const reauth = await authorize(
      stale.ctx,
      { action: "member.export", subjectId: idOf(w, "admin"), phase: "download" },
      { hideAs404: true },
    );
    expect(!reauth.ok && reauth.error.code).toBe("reauth_required");
  });

  it("answers not_found for a target, subject or group that doesn't exist", async () => {
    const w = world();
    const { ctx } = setup(w, "owner");
    const missing = crypto.randomUUID();
    const requests: PermissionRequest[] = [
      { action: "member.delete", targetId: missing },
      { action: "member.change_role", targetId: missing, newRole: "admin" },
      { action: "member.export", subjectId: missing, phase: "start" },
      { action: "group.add_member", groupId: missing, memberId: idOf(w, "member") },
      { action: "group.remove_member", groupId: missing, memberId: missing },
    ];
    for (const request of requests) {
      const result = await authorize(ctx, request);
      expect(!result.ok && result.error.code, request.action).toBe("not_found");
    }
  });

  it("authorizeCheck decides a complete check without loaders", () => {
    const w = world();
    const { ctx } = setup(w, "member");
    expect(authorizeCheck(ctx, { action: "directory.view" }).ok).toBe(true);
    const denied = authorizeCheck(ctx, { action: "audit.view" });
    expect(!denied.ok && denied.error).toEqual({
      code: "forbidden",
      message: "You don't have permission to do that.",
      reason: "not_permitted",
    });
  });
});

describe("authorize: actors who can't act", () => {
  for (const [status, reason] of [
    ["disabled", "inactive"],
    ["deleted", "inactive"],
    ["system", "system_actor"],
  ] as const) {
    it(`refuses a ${status} actor before loading any fact (${reason})`, async () => {
      const w = world();
      const { ctx, calls } = setup(w, "owner");
      ctx.actor = { ...ctx.actor, status };
      const result = await authorize(ctx, {
        action: "member.change_role",
        targetId: idOf(w, "member"),
        newRole: "admin",
      });
      expect(!result.ok && result.error).toMatchObject({ code: "forbidden", reason });
      expect(calls).toEqual([]);
    });
  }
});

describe("authorize: facts come from the loaders", () => {
  it("the owners' invite gate uses the acting owner's passkeys and the recovery token", async () => {
    const w = world();
    const owner = idOf(w, "owner");
    const invite: PermissionRequest = { action: "invitation.create", role: "member" };

    w.passkeys[owner] = 1;
    const gated = setup(w, "owner");
    expect(await authorize(gated.ctx, invite)).toMatchObject({ ok: false, error: { reason: "owner_invite_gate" } });
    expect(gated.calls).toEqual(expect.arrayContaining([`passkeyCount:${owner}`, "recoveryTokenUnconsumed"]));

    w.recoveryTokenUnconsumed = true;
    expect((await authorize(setup(w, "owner").ctx, invite)).ok).toBe(true);

    w.recoveryTokenUnconsumed = false; // consumed: no longer satisfies the gate
    expect((await authorize(setup(w, "owner").ctx, invite)).ok).toBe(false);

    w.passkeys[owner] = 2;
    expect((await authorize(setup(w, "owner").ctx, invite)).ok).toBe(true);

    // An admin may invite members whatever the owners' passkeys.
    expect((await authorize(setup(w, "admin").ctx, invite)).ok).toBe(true);
  });

  it("promotion counts the target's passkeys, not the actor's", async () => {
    const w = world();
    const owner = idOf(w, "owner");
    const member = idOf(w, "member");
    w.passkeys[owner] = 5;
    const promote: PermissionRequest = { action: "member.change_role", targetId: member, newRole: "admin" };

    const first = setup(w, "owner");
    expect(await authorize(first.ctx, promote)).toMatchObject({ ok: false, error: { reason: "promotion_passkeys" } });
    expect(first.calls).toContain(`passkeyCount:${member}`);

    w.passkeys[member] = 1;
    expect((await authorize(setup(w, "owner").ctx, promote)).ok).toBe(true);
    const toOwner: PermissionRequest = { action: "member.change_role", targetId: member, newRole: "owner" };
    expect((await authorize(setup(w, "owner").ctx, toOwner)).ok).toBe(false);
    w.recoveryTokenUnconsumed = true;
    expect((await authorize(setup(w, "owner").ctx, toOwner)).ok).toBe(true);
  });

  it("the last owner is protected using the loaded owner count", async () => {
    const w = world();
    const owner = idOf(w, "owner");
    const demote: PermissionRequest = { action: "member.change_role", targetId: owner, newRole: "admin" };
    expect(await authorize(setup(w, "owner").ctx, demote)).toMatchObject({
      ok: false,
      error: { reason: "last_owner" },
    });

    const second = `owner2-${crypto.randomUUID()}`;
    w.people[second] = { userId: second, role: "owner", status: "active" };
    expect((await authorize(setup(w, "owner").ctx, demote)).ok).toBe(true);
  });

  it("a per-member export download re-reads the subject's current role", async () => {
    const w = world();
    const member = idOf(w, "member");
    const download: PermissionRequest = { action: "member.export", subjectId: member, phase: "download" };
    expect((await authorize(setup(w, "admin").ctx, download)).ok).toBe(true);
    w.people[member] = { ...w.people[member]!, role: "admin" }; // promoted after the export started
    expect(await authorize(setup(w, "admin").ctx, download)).toMatchObject({
      ok: false,
      error: { reason: "owner_required" },
    });
  });

  it("group membership uses the loaded managers", async () => {
    const w = world();
    const groupId = `group-${crypto.randomUUID()}`;
    const member = idOf(w, "member");
    const admin = idOf(w, "admin");
    w.groups[groupId] = [member];
    const addAdmin: PermissionRequest = { action: "group.add_member", groupId, memberId: admin };
    expect((await authorize(setup(w, "member").ctx, addAdmin)).ok).toBe(true); // the manager
    // An admin adding themselves needs an owner.
    expect(await authorize(setup(w, "admin").ctx, addAdmin)).toMatchObject({
      ok: false,
      error: { reason: "owner_required" },
    });
    expect((await authorize(setup(w, "owner").ctx, addAdmin)).ok).toBe(true);
    w.groups[groupId] = [];
    expect(await authorize(setup(w, "member").ctx, addAdmin)).toMatchObject({
      ok: false,
      error: { reason: "not_permitted" },
    });
  });

  it("removing the last passkey uses the passkey count and whether magic links work", async () => {
    const w = world();
    const member = idOf(w, "member");
    w.passkeys[member] = 1;
    const remove: PermissionRequest = { action: "passkey.remove", ownerId: member };
    expect((await authorize(setup(w, "member").ctx, remove)).ok).toBe(true);
    w.magicLinksAvailable = false;
    expect(await authorize(setup(w, "member").ctx, remove)).toMatchObject({
      ok: false,
      error: { reason: "last_passkey" },
    });
  });

  it("doesn't load someone else's passkey facts; the engine refuses as not_own", async () => {
    const w = world();
    const { ctx, calls } = setup(w, "owner");
    for (const action of ["passkey.add", "passkey.remove"] as const) {
      expect(await authorize(ctx, { action, ownerId: idOf(w, "member") })).toMatchObject({
        ok: false,
        error: { reason: "not_own" },
      });
    }
    expect(calls).toEqual([]);
  });

  it("step-up uses the injected clock: 9:59 allowed, 10:00:01 refused", async () => {
    const w = world();
    const request: PermissionRequest = { action: "member.change_email", targetId: idOf(w, "member") };
    const ok959 = setup(w, "owner", passkeySession(9 * MINUTE + 59_000));
    expect((await authorize(ok959.ctx, request)).ok).toBe(true);
    const late = setup(w, "owner", passkeySession(10 * MINUTE + 1_000));
    expect(await authorize(late.ctx, request)).toMatchObject({ ok: false, error: { code: "reauth_required" } });
    // The same session, a minute earlier on the clock, passes again.
    late.ctx.now = () => NOW - MINUTE;
    expect((await authorize(late.ctx, request)).ok).toBe(true);
  });
});

describe("authorize: logging", () => {
  it("logs a denial at info with action, reason and actor ID only", async () => {
    const w = world();
    const { ctx, lines, actor } = setup(w, "admin");
    await authorize(ctx, { action: "member.delete", targetId: idOf(w, "owner") });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.level).toBe("info");
    expect(JSON.parse(lines[0]!.line)).toEqual({
      level: "info",
      message: "permission denied",
      action: "member.delete",
      reason: "owner_required",
      actorId: actor.userId,
    });
  });

  it("logs nothing when allowed", async () => {
    const w = world();
    const { ctx, lines } = setup(w, "owner");
    await authorize(ctx, { action: "admin.open" });
    expect(lines).toEqual([]);
  });
});

describe("denials over HTTP", () => {
  it("maps forbidden and reauth_required to 403", () => {
    expect(HTTP_STATUS.forbidden).toBe(403);
    expect(HTTP_STATUS.reauth_required).toBe(403);
    expect(denialError("reauth_required", { hideAs404: true }).code).toBe("reauth_required");
    expect(denialError("owner_required", { hideAs404: true }).code).toBe("not_found");
  });

  it("a route returns the typed error body with its reason", async () => {
    const w = world();
    const routes = new Hono<AppEnv>()
      .post("/members/:id/disable", async (c) => {
        const { ctx } = setup(w, "admin");
        return respond(c, await authorize(ctx, { action: "member.disable", targetId: c.req.param("id") }));
      })
      .post("/members/:id/recovery-link", async (c) => {
        const { ctx } = setup(w, "admin", passkeySession(11 * MINUTE));
        return respond(c, await authorize(ctx, { action: "member.issue_recovery_link", targetId: c.req.param("id") }));
      });
    const app = createApp({ features: [defineFeature("perm", routes)], logSink: () => {} });
    const call = (path: string) => app.request(`http://officebox.test/api/perm${path}`, { method: "POST" }, env);

    const forbidden = await call(`/members/${idOf(w, "owner")}/disable`);
    expect(forbidden.status).toBe(403);
    const forbiddenBody = apiErrorBodySchema.parse(await forbidden.json());
    expect(forbiddenBody.error).toEqual({
      code: "forbidden",
      message: "An owner must do this.",
      reason: "owner_required",
    });

    const reauth = await call(`/members/${idOf(w, "member")}/recovery-link`);
    expect(reauth.status).toBe(403);
    expect(apiErrorBodySchema.parse(await reauth.json()).error).toMatchObject({
      code: "reauth_required",
      reason: "reauth_required",
    });

    const allowed = await call(`/members/${idOf(w, "member")}/disable`);
    expect(allowed.status).toBe(200);
  });
});

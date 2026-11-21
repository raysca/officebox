import { describe, expect, it } from "vitest";
import {
  can,
  decide,
  decideWithoutFacts,
  DENIAL_REASONS,
  denialMessage,
  effectiveResourceRole,
  generalAccessRole,
  GROUP_MEMBER_ACTIONS,
  highestResourceRole,
  isResourceRoleValidFor,
  MEMBER_ADMIN_ACTIONS,
  resourceRoleAtLeast,
  SELF_ACTIONS,
  STEP_UP_ACTIONS,
  WORKSPACE_ACTIONS,
  type Actor,
  type DenialReason,
  type GroupMemberAction,
  type MemberAdminAction,
  type PermissionAction,
  type PermissionCheck,
  type PersonRef,
  type SelfAction,
  type SessionFacts,
  type UserStatus,
  type WorkspaceAction,
  type WorkspaceRole,
} from "../src/permissions";

/**
 * The permission matrix test (Permissions §11). Every action × actor role × target × status is checked
 * against expected tables transcribed **literally** from Permissions §4.6 and §6, Identity §2, §3,
 * §4.5 and §4.11, and Admin §3 and §17, never derived from the engine's logic.
 *
 * It grows per milestone: M1p covers workspace roles, the admin-power limits, the promotion and invite
 * gates, step-up, group membership and own-account actions; M1d adds profiles; M1e the rest of groups
 * (managers can't remove other managers; groups.manage) and completes the M1 matrix (workspace roles,
 * groups, profiles);
 * M3a channels; M4 calls; M5a calendars; M6a documents; M7 the admin endpoints.
 *
 * `✓` allowed, otherwise the expected denial reason.
 */
type Expect = "✓" | DenialReason;

const ACTOR_ROLES = ["owner", "admin", "member", "guest"] as const satisfies readonly WorkspaceRole[];
type ActorRole = (typeof ACTOR_ROLES)[number];
const TARGET_ROLES = ["owner", "admin", "member", "guest"] as const satisfies readonly WorkspaceRole[];
type TargetRole = (typeof TARGET_ROLES)[number];

const NOW = 1_800_000_000_000;
const SECOND = 1000;
const MINUTE = 60 * SECOND;

const passkeyAt = (ageMs: number): SessionFacts => ({ freshAuthAt: NOW - ageMs, freshAuthMethod: "passkey" });
const magicLinkAt = (ageMs: number): SessionFacts => ({ freshAuthAt: NOW - ageMs, freshAuthMethod: "magic_link" });
/** A session that signed in with a passkey a minute ago: step-up satisfied. */
const FRESH = passkeyAt(MINUTE);
/** A session whose last passkey assertion was an hour ago. */
const STALE = passkeyAt(60 * MINUTE);

const actor = (
  role: WorkspaceRole,
  options: { status?: UserStatus; userId?: string; session?: SessionFacts | null } = {},
): Actor => ({
  userId: options.userId ?? `actor-${role}`,
  role,
  status: options.status ?? "active",
  session: options.session === undefined ? FRESH : options.session,
});

const person = (
  role: WorkspaceRole,
  status: UserStatus = "active",
  userId = `target-${role}-${status}`,
): PersonRef => ({
  userId,
  role,
  status,
});

function outcome(a: Actor, check: PermissionCheck, now = NOW): Expect {
  const decision = decide(a, check, now);
  expect(can(a, check, now)).toBe(decision.ok);
  // The fact-free pre-check never denies what decide allows, and when it denies, decide agrees.
  const pre = decideWithoutFacts(a, check.action);
  if (decision.ok) expect(pre.ok).toBe(true);
  if (!pre.ok) expect(decision).toEqual(pre);
  return decision.ok ? "✓" : decision.error;
}

// ---- Literal tables ----------------------------------------------------------------------------

type RoleRow = Record<ActorRole, Expect>;
const EVERYONE: RoleRow = { owner: "✓", admin: "✓", member: "✓", guest: "not_permitted" };
const ADMINS: RoleRow = { owner: "✓", admin: "✓", member: "not_permitted", guest: "not_permitted" };
const OWNERS: RoleRow = { owner: "✓", admin: "owner_required", member: "not_permitted", guest: "not_permitted" };

// Permissions §4.6 (directory, groups, audit) and §6; Admin §3 pages and §17 endpoints.
const WORKSPACE_MATRIX: Record<WorkspaceAction, RoleRow> = {
  "directory.view": EVERYONE,
  "presence.view": EVERYONE,
  "availability.view": EVERYONE,
  "admin.open": ADMINS,
  "admin.overview.view": ADMINS,
  "admin.alerts.dismiss": ADMINS,
  "admin.members.view": ADMINS,
  "admin.invitations.view": ADMINS,
  "admin.groups.view": ADMINS,
  "admin.settings.view": ADMINS,
  "admin.email.test": ADMINS,
  "admin.health.view": ADMINS,
  "admin.storage.view": ADMINS,
  "admin.assistant.view": ADMINS,
  "admin.data.view": ADMINS,
  "admin.exports.manage": ADMINS,
  "admin.maintenance.view": ADMINS,
  "admin.updates.view": ADMINS,
  "admin.jobs.view": ADMINS,
  "audit.view": ADMINS,
  "groups.manage": ADMINS,
  "members.bulk": ADMINS,
  "invitations.bulk": ADMINS,
  "content.transfer": ADMINS,
  "members.csv.download": ADMINS,
  "audit.csv.download": ADMINS,
  "admin.usage.view": OWNERS,
  "admin.checklist.manage": OWNERS,
  "admin.telemetry.view": OWNERS,
  "admin.diagnostics.download": OWNERS,
  "admin.restore_report.dismiss": OWNERS,
  "maintenance.manage": OWNERS,
  "domain.move_start": OWNERS,
  "domain.move_commit": OWNERS,
  "domain.move_cancel": OWNERS,
  "domain.view": OWNERS,
  "member.acknowledge_reset": OWNERS,
};

// "Invite with role member / admin" (§4.6, §6): admins invite members; only owners invite admins; owner
// and guest are never invitable. The owner here meets the invite gate (two passkeys).
const INVITE_MATRIX: Record<WorkspaceRole, RoleRow> = {
  member: { owner: "✓", admin: "✓", member: "not_permitted", guest: "not_permitted" },
  admin: { owner: "✓", admin: "owner_required", member: "not_permitted", guest: "not_permitted" },
  owner: {
    owner: "role_not_assignable",
    admin: "role_not_assignable",
    member: "not_permitted",
    guest: "not_permitted",
  },
  guest: {
    owner: "role_not_assignable",
    admin: "role_not_assignable",
    member: "not_permitted",
    guest: "not_permitted",
  },
};

// Revoking a pending invitation (Identity §4.2): admins revoke member invitations; admin invitations
// need an owner (default). No invite gate: revoking takes access away.
const REVOKE_MATRIX: Record<WorkspaceRole, RoleRow> = {
  member: { owner: "✓", admin: "✓", member: "not_permitted", guest: "not_permitted" },
  admin: { owner: "✓", admin: "owner_required", member: "not_permitted", guest: "not_permitted" },
  owner: {
    owner: "role_not_assignable",
    admin: "role_not_assignable",
    member: "not_permitted",
    guest: "not_permitted",
  },
  guest: {
    owner: "role_not_assignable",
    admin: "role_not_assignable",
    member: "not_permitted",
    guest: "not_permitted",
  },
};

// The owners' invite gate (Identity §2 "Owners' second passkey", §9 Invitations; PLAN M1 "Invite gate").
const INVITE_GATE: readonly [
  actor: ActorRole,
  invite: WorkspaceRole,
  passkeys: number,
  tokenUnconsumed: boolean,
  expected: Expect,
][] = [
  ["owner", "member", 1, false, "owner_invite_gate"],
  ["owner", "admin", 1, false, "owner_invite_gate"],
  ["owner", "member", 0, false, "owner_invite_gate"],
  ["owner", "member", 1, true, "✓"], // an unconsumed RECOVERY_TOKEN satisfies it
  ["owner", "admin", 1, true, "✓"],
  ["owner", "member", 2, false, "✓"], // a second passkey satisfies it
  ["owner", "admin", 3, false, "✓"],
  ["admin", "member", 1, false, "✓"], // admins may still invite members when no owner meets the gate
  ["admin", "member", 0, false, "✓"],
  ["admin", "admin", 2, true, "owner_required"],
  ["owner", "owner", 1, false, "role_not_assignable"], // the role rule comes before the gate
];

// "Change someone's email · issue a recovery link · disable · re-enable · delete · sign out all
// sessions" (§4.6, §6): admins on members only; owners on anyone. Several active owners exist here.
const MEMBER_ADMIN_MATRIX: Record<ActorRole, Record<TargetRole, Expect>> = {
  owner: { owner: "✓", admin: "✓", member: "✓", guest: "✓" },
  admin: { owner: "owner_required", admin: "owner_required", member: "✓", guest: "✓" },
  member: { owner: "not_permitted", admin: "not_permitted", member: "not_permitted", guest: "not_permitted" },
  guest: { owner: "not_permitted", admin: "not_permitted", member: "not_permitted", guest: "not_permitted" },
};

// Targets that aren't people an action can be aimed at: deleted (anonymised) members and the reserved
// system rows (default), whatever their role. (default) An admin gets invalid_target rather than
// owner_required even for a deleted admin or owner: the target check comes first.
const UNUSABLE_TARGET: RoleRow = {
  owner: "invalid_target",
  admin: "invalid_target",
  member: "not_permitted",
  guest: "not_permitted",
};

// "Change role to member or admin" (§4.6), "Invite or promote admins; demote admins; manage owners"
// (§6): owners only. Target passkeys and owner counts satisfy every gate here.
const CHANGE_ROLE_MATRIX: Record<ActorRole, Record<WorkspaceRole, Expect>> = {
  owner: { owner: "✓", admin: "✓", member: "✓", guest: "role_not_assignable" },
  admin: { owner: "owner_required", admin: "owner_required", member: "owner_required", guest: "owner_required" },
  member: { owner: "not_permitted", admin: "not_permitted", member: "not_permitted", guest: "not_permitted" },
  guest: { owner: "not_permitted", admin: "not_permitted", member: "not_permitted", guest: "not_permitted" },
};

// Disabled targets (default): they can be demoted and removed from groups, but not promoted or added.
// The acting owner is fresh; the target has two passkeys and an unconsumed token exists.
const DISABLED_TARGET: readonly [
  label: string,
  from: WorkspaceRole,
  change: WorkspaceRole | "group add" | "group remove",
  expected: Expect,
][] = [
  ["promote a disabled member to admin", "member", "admin", "invalid_target"],
  ["promote a disabled admin to owner", "admin", "owner", "invalid_target"],
  ["demote a disabled admin to member", "admin", "member", "✓"],
  ["demote a disabled owner to admin", "owner", "admin", "✓"],
  ["keep a disabled admin an admin", "admin", "admin", "✓"],
  ["add a disabled member to a group", "member", "group add", "invalid_target"],
  ["remove a disabled member from a group", "member", "group remove", "✓"],
];

// "Edit own profile, status, handle, sign-in methods, devices" (§4.6): only the person. Guests are
// refused everything, own account included, (default) until Phase 2 defines them.
const OWN_MATRIX: Record<ActorRole, { own: Expect; other: Expect }> = {
  owner: { own: "✓", other: "not_own" },
  admin: { own: "✓", other: "not_own" },
  member: { own: "✓", other: "not_own" },
  guest: { own: "not_permitted", other: "not_permitted" },
};

// Bulk-job progress (Admin §17 `GET /admin/jobs/:id`): the actor's own jobs, or any for owners.
const JOB_VIEW_MATRIX: Record<ActorRole, { own: Expect; other: Expect }> = {
  owner: { own: "✓", other: "✓" },
  admin: { own: "✓", other: "owner_required" },
  member: { own: "not_permitted", other: "not_permitted" },
  guest: { own: "not_permitted", other: "not_permitted" },
};

// The promotion rule (Identity §2 "Promotion", §4.11, §9 "Promotion"; Permissions §6). The acting owner
// is fresh and three owners exist.
const PROMOTION: readonly [
  from: WorkspaceRole,
  to: WorkspaceRole,
  passkeys: number,
  tokenUnconsumed: boolean,
  expected: Expect,
][] = [
  ["member", "admin", 0, false, "promotion_passkeys"],
  ["member", "admin", 0, true, "promotion_passkeys"], // the token is for owner promotions only
  ["member", "admin", 1, false, "✓"],
  ["member", "owner", 0, false, "promotion_passkeys"],
  ["member", "owner", 1, false, "promotion_passkeys"],
  ["member", "owner", 1, true, "✓"],
  ["member", "owner", 2, false, "✓"],
  ["member", "owner", 0, true, "promotion_passkeys"], // (default) at least one passkey for any promotion
  ["admin", "owner", 1, false, "promotion_passkeys"],
  ["admin", "owner", 1, true, "✓"],
  ["admin", "owner", 2, false, "✓"],
  // Not promotions: keeping or lowering a role is never gated.
  ["owner", "owner", 0, false, "✓"],
  ["owner", "admin", 0, false, "✓"],
  ["admin", "member", 0, false, "✓"],
  ["admin", "admin", 0, false, "✓"],
];

// `workspace.export` (Permissions §2 Exports, §6; Admin §11, §17): owners and admins at start and
// download; the maintenance option is owner-only.
const WORKSPACE_EXPORT_MATRIX: Record<"start" | "start in maintenance" | "download", RoleRow> = {
  start: ADMINS,
  "start in maintenance": OWNERS,
  download: ADMINS,
};

// `member.export` (Permissions §6; Admin §12): admins for members only; an owner for admin or owner
// subjects, at start and at download (the subject's role then).
const MEMBER_EXPORT_MATRIX: Record<ActorRole, Record<"owner" | "admin" | "member", Expect>> = {
  owner: { owner: "✓", admin: "✓", member: "✓" },
  admin: { owner: "owner_required", admin: "owner_required", member: "✓" },
  member: { owner: "not_permitted", admin: "not_permitted", member: "not_permitted" },
  guest: { owner: "not_permitted", admin: "not_permitted", member: "not_permitted" },
};

// "Add or remove group members" (§4.6): group managers for their own group; admins (adding themselves
// needs an owner); owners.
const GROUP_MATRIX: readonly [
  who: string,
  role: WorkspaceRole,
  manages: boolean,
  Record<"add other" | "add self" | "remove other" | "remove self", Expect>,
][] = [
  ["owner", "owner", false, { "add other": "✓", "add self": "✓", "remove other": "✓", "remove self": "✓" }],
  [
    "admin",
    "admin",
    false,
    { "add other": "✓", "add self": "owner_required", "remove other": "✓", "remove self": "✓" },
  ],
  [
    "admin who manages the group",
    "admin",
    true,
    { "add other": "✓", "add self": "owner_required", "remove other": "✓", "remove self": "✓" },
  ],
  ["group manager", "member", true, { "add other": "✓", "add self": "✓", "remove other": "✓", "remove self": "✓" }],
  [
    "member",
    "member",
    false,
    {
      "add other": "not_permitted",
      "add self": "not_permitted",
      "remove other": "not_permitted",
      "remove self": "not_permitted",
    },
  ],
  [
    "guest",
    "guest",
    false,
    {
      "add other": "not_permitted",
      "add self": "not_permitted",
      "remove other": "not_permitted",
      "remove self": "not_permitted",
    },
  ],
];

// Platform §7 "Who can change".
const SETTING_MATRIX: Record<"admin" | "owner", RoleRow> = { admin: ADMINS, owner: OWNERS };

// Removing a passkey (Identity §2 "Removing the last passkey", §8 "Last sign-in method").
const PASSKEY_REMOVE: readonly [role: ActorRole, count: number, magicLinks: boolean, expected: Expect][] = [
  ["member", 2, false, "✓"],
  ["member", 1, true, "✓"], // magic links work for them
  ["member", 1, false, "last_passkey"],
  ["admin", 1, true, "last_passkey"], // magic links aren't available to admins
  ["admin", 2, false, "✓"],
  ["owner", 1, true, "last_passkey"], // an owner never can
  ["owner", 2, false, "✓"],
];

// ---- Matrix ------------------------------------------------------------------------------------

describe("permission matrix: workspace actions (Permissions §4.6, §6; Admin §3, §17)", () => {
  it("has a literal row for every workspace action", () => {
    expect(Object.keys(WORKSPACE_MATRIX).sort()).toEqual([...WORKSPACE_ACTIONS].sort());
  });

  for (const action of WORKSPACE_ACTIONS) {
    for (const role of ACTOR_ROLES) {
      it(`${role}: ${action} → ${WORKSPACE_MATRIX[action][role]}`, () => {
        expect(outcome(actor(role), { action })).toBe(WORKSPACE_MATRIX[action][role]);
      });
    }
  }

  for (const role of ACTOR_ROLES) {
    const row = JOB_VIEW_MATRIX[role];
    it(`${role}: view a bulk job they started → ${row.own}, someone else's → ${row.other}`, () => {
      const a = actor(role);
      expect(outcome(a, { action: "admin.job.view", startedBy: a.userId })).toBe(row.own);
      expect(outcome(a, { action: "admin.job.view", startedBy: "someone" })).toBe(row.other);
    });
  }
});

describe("permission matrix: invitations (Permissions §4.6, §6; Identity §2)", () => {
  for (const inviteRole of ["owner", "admin", "member", "guest"] as const) {
    for (const role of ACTOR_ROLES) {
      it(`${role}: invite as ${inviteRole} → ${INVITE_MATRIX[inviteRole][role]}`, () => {
        const check: PermissionCheck = {
          action: "invitation.create",
          role: inviteRole,
          actorPasskeyCount: 2,
          recoveryTokenUnconsumed: false,
        };
        expect(outcome(actor(role), check)).toBe(INVITE_MATRIX[inviteRole][role]);
      });
    }
  }

  for (const [role, inviteRole, passkeys, token, expected] of INVITE_GATE) {
    it(`invite gate: ${role} with ${passkeys} passkey(s), token ${token ? "unconsumed" : "absent or consumed"}, invites ${inviteRole} → ${expected}`, () => {
      const check: PermissionCheck = {
        action: "invitation.create",
        role: inviteRole,
        actorPasskeyCount: passkeys,
        recoveryTokenUnconsumed: token,
      };
      expect(outcome(actor(role), check)).toBe(expected);
    });
  }

  it("invitations don't need step-up", () => {
    const check: PermissionCheck = {
      action: "invitation.create",
      role: "member",
      actorPasskeyCount: 2,
      recoveryTokenUnconsumed: false,
    };
    expect(outcome(actor("owner", { session: STALE }), check)).toBe("✓");
    expect(outcome(actor("owner", { session: null }), check)).toBe("✓");
  });

  for (const inviteRole of ["owner", "admin", "member", "guest"] as const) {
    for (const role of ACTOR_ROLES) {
      it(`${role}: revoke an invitation as ${inviteRole} → ${REVOKE_MATRIX[inviteRole][role]}`, () => {
        expect(outcome(actor(role), { action: "invitation.revoke", role: inviteRole })).toBe(
          REVOKE_MATRIX[inviteRole][role],
        );
      });
    }
  }

  it("revoking isn't gated by the owners' invite gate and needs no step-up", () => {
    expect(outcome(actor("owner", { session: STALE }), { action: "invitation.revoke", role: "admin" })).toBe("✓");
  });
});

describe("permission matrix: admin actions on people (Permissions §4.6, §6; Identity §3, §4.11)", () => {
  for (const action of MEMBER_ADMIN_ACTIONS) {
    for (const role of ACTOR_ROLES) {
      for (const targetRole of TARGET_ROLES) {
        for (const status of ["active", "disabled"] as const) {
          const expected = MEMBER_ADMIN_MATRIX[role][targetRole];
          it(`${role}: ${action} on a ${status} ${targetRole} → ${expected}`, () => {
            const check: PermissionCheck = { action, target: person(targetRole, status), activeOwnerCount: 3 };
            expect(outcome(actor(role), check)).toBe(expected);
          });
        }
        for (const status of ["deleted", "system"] as const) {
          it(`${role}: ${action} on a ${status} ${targetRole} row → ${UNUSABLE_TARGET[role]}`, () => {
            const check: PermissionCheck = { action, target: person(targetRole, status), activeOwnerCount: 3 };
            expect(outcome(actor(role), check)).toBe(UNUSABLE_TARGET[role]);
          });
        }
      }
    }
  }
});

describe("permission matrix: role changes and promotion (Permissions §4.6, §6; Identity §2, §4.11)", () => {
  for (const role of ACTOR_ROLES) {
    for (const targetRole of TARGET_ROLES) {
      for (const newRole of ["owner", "admin", "member", "guest"] as const) {
        const expected = CHANGE_ROLE_MATRIX[role][newRole];
        it(`${role}: change an active ${targetRole} to ${newRole} → ${expected}`, () => {
          const check: PermissionCheck = {
            action: "member.change_role",
            target: person(targetRole),
            newRole,
            activeOwnerCount: 3,
            targetPasskeyCount: 2,
            recoveryTokenUnconsumed: false,
          };
          expect(outcome(actor(role), check)).toBe(expected);
        });
      }
    }
  }

  for (const status of ["deleted", "system"] as const) {
    it(`owner: change the role of a ${status} row → invalid_target; admin → owner_required`, () => {
      const check: PermissionCheck = {
        action: "member.change_role",
        target: person("member", status),
        newRole: "admin",
        activeOwnerCount: 3,
        targetPasskeyCount: 2,
        recoveryTokenUnconsumed: true,
      };
      expect(outcome(actor("owner"), check)).toBe("invalid_target");
      expect(outcome(actor("admin"), check)).toBe("owner_required");
    });
  }

  for (const [from, to, passkeys, token, expected] of PROMOTION) {
    it(`promotion: ${from} → ${to} with ${passkeys} passkey(s), token ${token ? "unconsumed" : "absent or consumed"} → ${expected}`, () => {
      const check: PermissionCheck = {
        action: "member.change_role",
        target: person(from),
        newRole: to,
        activeOwnerCount: 3,
        targetPasskeyCount: passkeys,
        recoveryTokenUnconsumed: token,
      };
      expect(outcome(actor("owner"), check)).toBe(expected);
    });
  }
});

describe("permission matrix: disabled targets (default)", () => {
  for (const [label, from, change, expected] of DISABLED_TARGET) {
    it(`${label} → ${expected}`, () => {
      const target = person(from, "disabled");
      const check: PermissionCheck =
        change === "group add" || change === "group remove"
          ? {
              action: change === "group add" ? "group.add_member" : "group.remove_member",
              group: { managerIds: [] },
              target,
            }
          : {
              action: "member.change_role",
              target,
              newRole: change,
              activeOwnerCount: 3,
              targetPasskeyCount: 2,
              recoveryTokenUnconsumed: true,
            };
      expect(outcome(actor("owner"), check)).toBe(expected);
    });
  }
});

describe("permission matrix: exports (Permissions §2, §6, §11; Admin §11, §12)", () => {
  for (const [label, row] of Object.entries(WORKSPACE_EXPORT_MATRIX)) {
    for (const role of ACTOR_ROLES) {
      it(`${role}: workspace.export ${label} → ${row[role]}`, () => {
        const check: PermissionCheck = {
          action: "workspace.export",
          phase: label === "download" ? "download" : "start",
          inMaintenance: label === "start in maintenance",
        };
        expect(outcome(actor(role), check)).toBe(row[role]);
      });
    }
  }

  for (const role of ACTOR_ROLES) {
    for (const subjectRole of ["owner", "admin", "member"] as const) {
      for (const phase of ["start", "download"] as const) {
        const expected = MEMBER_EXPORT_MATRIX[role][subjectRole];
        it(`${role}: member.export ${phase} for a ${subjectRole} → ${expected}`, () => {
          const check: PermissionCheck = { action: "member.export", subject: person(subjectRole), phase };
          expect(outcome(actor(role), check)).toBe(expected);
        });
      }
    }
  }

  it("an admin can't download an export whose subject was promoted after it started", () => {
    const admin = actor("admin");
    const subjectAtStart = person("member", "active", "subject");
    const subjectNow = person("admin", "active", "subject");
    expect(outcome(admin, { action: "member.export", subject: subjectAtStart, phase: "start" })).toBe("✓");
    expect(outcome(admin, { action: "member.export", subject: subjectNow, phase: "download" })).toBe("owner_required");
    expect(outcome(actor("owner"), { action: "member.export", subject: subjectNow, phase: "download" })).toBe("✓");
  });

  it("(default) a deleted subject stays exportable, so an export started before the deletion can be downloaded", () => {
    for (const phase of ["start", "download"] as const) {
      expect(outcome(actor("admin"), { action: "member.export", subject: person("member", "deleted"), phase })).toBe(
        "✓",
      );
    }
  });

  it("the system rows are never export subjects", () => {
    expect(
      outcome(actor("owner"), { action: "member.export", subject: person("member", "system"), phase: "start" }),
    ).toBe("invalid_target");
  });
});

describe("permission matrix: group membership (Permissions §4.6, §6; Identity §4.9)", () => {
  for (const [who, role, manages, row] of GROUP_MATRIX) {
    const a = actor(role, { userId: `actor-${who}` });
    const group = { managerIds: manages ? [a.userId, "another-manager"] : ["another-manager"] };
    const other = person("member", "active", "other-member");
    const self = person(role, "active", a.userId);
    const cases = {
      "add other": { action: "group.add_member", target: other },
      "add self": { action: "group.add_member", target: self },
      "remove other": { action: "group.remove_member", target: other },
      "remove self": { action: "group.remove_member", target: self },
    } as const;
    for (const [label, { action, target }] of Object.entries(cases) as [
      keyof typeof cases,
      (typeof cases)[keyof typeof cases],
    ][]) {
      it(`${who}: ${label} → ${row[label]}`, () => {
        expect(outcome(a, { action, group, target })).toBe(row[label]);
      });
    }
  }

  it("deleted members and the system rows can't be added to groups", () => {
    for (const status of ["deleted", "system"] as const) {
      expect(
        outcome(actor("owner"), {
          action: "group.add_member",
          group: { managerIds: [] },
          target: person("member", status),
        }),
      ).toBe("invalid_target");
    }
  });

  it("covers both group actions", () => {
    expect([...GROUP_MEMBER_ACTIONS].sort()).toEqual(["group.add_member", "group.remove_member"]);
  });

  // M1e (default): appointing and removing managers is an admin's (Identity §2 "Groups", §4.9), so a
  // group manager who isn't an admin can't remove another manager of their group.
  const REMOVE_MANAGER: readonly [who: string, role: WorkspaceRole, manages: boolean, expected: Expect][] = [
    ["owner", "owner", false, "✓"],
    ["admin", "admin", false, "✓"],
    ["admin who manages the group", "admin", true, "✓"],
    ["group manager", "member", true, "not_permitted"],
    ["member", "member", false, "not_permitted"],
    ["guest", "guest", false, "not_permitted"],
  ];
  for (const [who, role, manages, expected] of REMOVE_MANAGER) {
    it(`${who}: remove another manager of the group → ${expected}`, () => {
      const a = actor(role, { userId: `actor-${who}` });
      const group = { managerIds: manages ? [a.userId, "another-manager"] : ["another-manager"] };
      const target = person("member", "active", "another-manager");
      expect(outcome(a, { action: "group.remove_member", group, target })).toBe(expected);
    });
  }

  it("a group manager may still remove a plain member, and leave the group themselves", () => {
    const a = actor("member", { userId: "mgr" });
    const group = { managerIds: ["mgr", "another-manager"] };
    expect(outcome(a, { action: "group.remove_member", group, target: person("member", "active", "plain") })).toBe("✓");
    expect(outcome(a, { action: "group.remove_member", group, target: person("member", "active", "mgr") })).toBe("✓");
  });

  it("disabled people can be removed from a group but not added (default)", () => {
    const group = { managerIds: [] };
    const target = person("member", "disabled");
    expect(outcome(actor("owner"), { action: "group.add_member", group, target })).toBe("invalid_target");
    expect(outcome(actor("owner"), { action: "group.remove_member", group, target })).toBe("✓");
  });
});

describe("permission matrix: own account (Permissions §4.6 'Edit own profile, status, handle, sign-in methods, devices')", () => {
  for (const action of SELF_ACTIONS) {
    for (const role of ACTOR_ROLES) {
      const row = OWN_MATRIX[role];
      it(`${role}: ${action} on their own → ${row.own}, on someone else's → ${row.other}`, () => {
        const a = actor(role);
        expect(outcome(a, { action, ownerId: a.userId })).toBe(row.own);
        expect(outcome(a, { action, ownerId: "someone-else" })).toBe(row.other);
      });
    }
  }

  for (const role of ACTOR_ROLES) {
    const row = OWN_MATRIX[role];
    it(`${role}: add a passkey to their own account → ${row.own}, to someone else's → ${row.other}`, () => {
      const a = actor(role);
      expect(outcome(a, { action: "passkey.add", ownerId: a.userId, ownerPasskeyCount: 1 })).toBe(row.own);
      expect(outcome(a, { action: "passkey.add", ownerId: "someone-else", ownerPasskeyCount: 1 })).toBe(row.other);
    });
  }

  it("a guest can't remove their own passkey either (default)", () => {
    const a = actor("guest");
    expect(
      outcome(a, { action: "passkey.remove", ownerId: a.userId, ownerPasskeyCount: 3, magicLinksAvailable: true }),
    ).toBe("not_permitted");
  });

  for (const [role, count, magicLinks, expected] of PASSKEY_REMOVE) {
    it(`${role}: remove a passkey with ${count} left, magic links ${magicLinks ? "working" : "unavailable"} → ${expected}`, () => {
      const a = actor(role);
      const check: PermissionCheck = {
        action: "passkey.remove",
        ownerId: a.userId,
        ownerPasskeyCount: count,
        magicLinksAvailable: magicLinks,
      };
      expect(outcome(a, check)).toBe(expected);
    });
  }

  it("nobody removes someone else's passkey, an owner included", () => {
    expect(
      outcome(actor("owner"), {
        action: "passkey.remove",
        ownerId: "someone-else",
        ownerPasskeyCount: 3,
        magicLinksAvailable: true,
      }),
    ).toBe("not_own");
  });
});

describe("permission matrix: settings (Platform §7)", () => {
  for (const changeableBy of ["admin", "owner"] as const) {
    for (const role of ACTOR_ROLES) {
      it(`${role}: change a setting changeable by ${changeableBy} → ${SETTING_MATRIX[changeableBy][role]}`, () => {
        expect(outcome(actor(role), { action: "setting.change", changeableBy })).toBe(
          SETTING_MATRIX[changeableBy][role],
        );
      });
    }
  }
});

// ---- Admin-power limits ------------------------------------------------------------------------

describe("the last owner is protected (Permissions §6; Identity §4.11)", () => {
  const soleOwner = person("owner", "active", "o1");
  const changeRole = (newRole: WorkspaceRole, activeOwnerCount: number, target = soleOwner): PermissionCheck => ({
    action: "member.change_role",
    target,
    newRole,
    activeOwnerCount,
    targetPasskeyCount: 2,
    recoveryTokenUnconsumed: false,
  });

  it("the last active owner can't demote themselves", () => {
    const self = actor("owner", { userId: "o1" });
    expect(outcome(self, changeRole("admin", 1))).toBe("last_owner");
    expect(outcome(self, changeRole("member", 1))).toBe("last_owner");
    // Keeping them an owner is fine.
    expect(outcome(self, changeRole("owner", 1))).toBe("✓");
  });

  it("the last active owner can't be disabled, deleted or demoted, even when the facts race (another owner acting)", () => {
    // Facts are loaded per request: a second owner may have been disabled concurrently, so the engine
    // refuses on the count it's given. The D1 write is conditional as well (Admin §5.3).
    const other = actor("owner", { userId: "o2" });
    for (const count of [1, 0]) {
      expect(outcome(other, { action: "member.disable", target: soleOwner, activeOwnerCount: count })).toBe(
        "last_owner",
      );
      expect(outcome(other, { action: "member.delete", target: soleOwner, activeOwnerCount: count })).toBe(
        "last_owner",
      );
      expect(outcome(other, changeRole("admin", count))).toBe("last_owner");
    }
  });

  it("actions that don't remove an owner are fine on the last owner", () => {
    const other = actor("owner", { userId: "o2" });
    for (const action of [
      "member.enable",
      "member.sign_out_all",
      "member.change_email",
      "member.issue_recovery_link",
    ] as const) {
      expect(outcome(other, { action, target: soleOwner, activeOwnerCount: 1 })).toBe("✓");
    }
  });

  it("with a second active owner, an owner can be disabled, deleted or demoted", () => {
    const other = actor("owner", { userId: "o2" });
    expect(outcome(other, { action: "member.disable", target: soleOwner, activeOwnerCount: 2 })).toBe("✓");
    expect(outcome(other, { action: "member.delete", target: soleOwner, activeOwnerCount: 2 })).toBe("✓");
    expect(outcome(other, changeRole("admin", 2))).toBe("✓");
    expect(outcome(actor("owner", { userId: "o1" }), changeRole("member", 2))).toBe("✓");
  });

  it("a disabled owner isn't the last active owner", () => {
    const disabledOwner = person("owner", "disabled", "o3");
    expect(outcome(actor("owner"), { action: "member.delete", target: disabledOwner, activeOwnerCount: 1 })).toBe("✓");
    expect(outcome(actor("owner"), changeRole("member", 1, disabledOwner))).toBe("✓");
  });
});

describe("other admin-power limits", () => {
  it("nobody disables or deletes themselves (default, after Admin §5.3)", () => {
    const owner = actor("owner", { userId: "o1" });
    const self = person("owner", "active", "o1");
    expect(outcome(owner, { action: "member.disable", target: self, activeOwnerCount: 3 })).toBe("self_target");
    expect(outcome(owner, { action: "member.delete", target: self, activeOwnerCount: 3 })).toBe("self_target");
    // Signing out all one's own sessions is fine.
    expect(outcome(owner, { action: "member.sign_out_all", target: self, activeOwnerCount: 3 })).toBe("✓");
  });

  it("an admin acting on themselves is acting on an admin: an owner must do it", () => {
    const admin = actor("admin", { userId: "a1" });
    const self = person("admin", "active", "a1");
    for (const action of MEMBER_ADMIN_ACTIONS) {
      expect(outcome(admin, { action, target: self, activeOwnerCount: 1 })).toBe("owner_required");
    }
  });

  it("guest is never assignable, by invitation or role change", () => {
    expect(
      outcome(actor("owner"), {
        action: "invitation.create",
        role: "guest",
        actorPasskeyCount: 2,
        recoveryTokenUnconsumed: true,
      }),
    ).toBe("role_not_assignable");
    expect(
      outcome(actor("owner"), {
        action: "member.change_role",
        target: person("member"),
        newRole: "guest",
        activeOwnerCount: 2,
        targetPasskeyCount: 2,
        recoveryTokenUnconsumed: true,
      }),
    ).toBe("role_not_assignable");
  });
});

// ---- Actor status ------------------------------------------------------------------------------

/** One check of every kind, with facts that would allow an active owner. */
const ONE_OF_EACH = (a: Actor): PermissionCheck[] => [
  { action: "directory.view" },
  { action: "admin.open" },
  { action: "maintenance.manage" },
  { action: "admin.job.view", startedBy: a.userId },
  { action: "invitation.create", role: "member", actorPasskeyCount: 2, recoveryTokenUnconsumed: true },
  { action: "invitation.revoke", role: "admin" },
  ...MEMBER_ADMIN_ACTIONS.map((action): PermissionCheck => ({ action, target: person("member"), activeOwnerCount: 3 })),
  {
    action: "member.change_role",
    target: person("member"),
    newRole: "admin",
    activeOwnerCount: 3,
    targetPasskeyCount: 2,
    recoveryTokenUnconsumed: true,
  },
  { action: "member.export", subject: person("member"), phase: "download" },
  { action: "workspace.export", phase: "download", inMaintenance: false },
  { action: "group.add_member", group: { managerIds: [a.userId] }, target: person("member") },
  { action: "group.remove_member", group: { managerIds: [a.userId] }, target: person("member") },
  ...SELF_ACTIONS.map((action): PermissionCheck => ({ action, ownerId: a.userId })),
  { action: "passkey.add", ownerId: a.userId, ownerPasskeyCount: 1 },
  { action: "passkey.remove", ownerId: a.userId, ownerPasskeyCount: 3, magicLinksAvailable: true },
  { action: "setting.change", changeableBy: "admin" },
];

describe("only active people act (Identity §4.5, §4.8; TDD §2.1 'Permission resolution' step 1)", () => {
  it("an active owner is allowed every check in the sample (the sample is meaningful)", () => {
    const owner = actor("owner");
    for (const check of ONE_OF_EACH(owner)) expect(outcome(owner, check)).toBe("✓");
  });

  for (const [status, expected] of [
    ["disabled", "inactive"],
    ["deleted", "inactive"],
    ["system", "system_actor"],
  ] as const) {
    for (const role of ACTOR_ROLES) {
      it(`a ${status} ${role} is refused everything, own account included, with a fresh session → ${expected}`, () => {
        const a = actor(role, { status });
        for (const check of ONE_OF_EACH(a)) expect(outcome(a, check)).toBe(expected);
        for (const action of WORKSPACE_ACTIONS) expect(outcome(a, { action })).toBe(expected);
      });
    }
  }
});

// ---- Unknown values fail closed -----------------------------------------------------------------

describe("unknown roles, statuses and actions are denied, never allowed by falling through", () => {
  // Facts come from storage and requests: these casts stand for values a loader or caller could pass.
  const superadmin = "superadmin" as WorkspaceRole;

  it("an actor with an unknown role is refused everything, own account included", () => {
    const a = actor(superadmin);
    for (const check of ONE_OF_EACH(a)) expect(outcome(a, check)).toBe("not_permitted");
    for (const action of WORKSPACE_ACTIONS) expect(outcome(a, { action })).toBe("not_permitted");
  });

  it("an actor with an unknown status is inactive", () => {
    const a = actor("owner", { status: "suspended" as UserStatus });
    expect(outcome(a, { action: "directory.view" })).toBe("inactive");
  });

  it("a target with an unknown role or status is invalid, for owners and admins alike", () => {
    for (const target of [person(superadmin), person("member", "suspended" as UserStatus)]) {
      for (const role of ["owner", "admin"] as const) {
        expect(outcome(actor(role), { action: "member.disable", target, activeOwnerCount: 3 })).toBe("invalid_target");
        expect(outcome(actor(role), { action: "group.add_member", group: { managerIds: [] }, target })).toBe(
          "invalid_target",
        );
        expect(outcome(actor(role), { action: "member.export", subject: target, phase: "start" })).toBe(
          "invalid_target",
        );
      }
      // A promotion can't skip the passkey gate by way of an unknown current role.
      expect(
        outcome(actor("owner"), {
          action: "member.change_role",
          target,
          newRole: "owner",
          activeOwnerCount: 3,
          targetPasskeyCount: 0,
          recoveryTokenUnconsumed: false,
        }),
      ).toBe("invalid_target");
    }
  });

  it("an unknown new role or invitation role can't be given", () => {
    expect(
      outcome(actor("owner"), {
        action: "member.change_role",
        target: person("member"),
        newRole: superadmin,
        activeOwnerCount: 3,
        targetPasskeyCount: 2,
        recoveryTokenUnconsumed: true,
      }),
    ).toBe("role_not_assignable");
    expect(
      outcome(actor("owner"), {
        action: "invitation.create",
        role: superadmin,
        actorPasskeyCount: 2,
        recoveryTokenUnconsumed: true,
      }),
    ).toBe("role_not_assignable");
  });

  for (const action of ["bogus", "constructor", "toString", "__proto__", "hasOwnProperty", ""]) {
    it(`an unknown action ${JSON.stringify(action)} is denied without throwing`, () => {
      const check = { action } as unknown as PermissionCheck;
      for (const role of ["owner", "admin", "member"] as const) {
        expect(decide(actor(role), check, NOW)).toEqual({ ok: false, error: "not_permitted" });
        expect(decideWithoutFacts(actor(role), action)).toEqual({ ok: false, error: "not_permitted" });
      }
    });
  }

  it("an active guest is refused everything (default, until Phase 2)", () => {
    const a = actor("guest");
    for (const check of ONE_OF_EACH(a)) expect(outcome(a, check)).toBe("not_permitted");
  });
});

// ---- Step-up -----------------------------------------------------------------------------------

/** Every step-up action, as an active owner with every other fact satisfied (Identity §4.5; Admin §11.3). */
const STEP_UP_CHECKS = (a: Actor): [string, PermissionCheck][] => [
  [
    "change a role (promotion)",
    {
      action: "member.change_role",
      target: person("member"),
      newRole: "admin",
      activeOwnerCount: 3,
      targetPasskeyCount: 1,
      recoveryTokenUnconsumed: false,
    },
  ],
  [
    "change a role (demotion)",
    {
      action: "member.change_role",
      target: person("admin"),
      newRole: "member",
      activeOwnerCount: 3,
      targetPasskeyCount: 1,
      recoveryTokenUnconsumed: false,
    },
  ],
  ["change someone's email", { action: "member.change_email", target: person("member"), activeOwnerCount: 3 }],
  ["issue a recovery link", { action: "member.issue_recovery_link", target: person("admin"), activeOwnerCount: 3 }],
  ["start a domain move", { action: "domain.move_start" }],
  ["add a passkey", { action: "passkey.add", ownerId: a.userId, ownerPasskeyCount: 1 }],
  [
    "remove a passkey",
    { action: "passkey.remove", ownerId: a.userId, ownerPasskeyCount: 2, magicLinksAvailable: false },
  ],
  ["download the member CSV", { action: "members.csv.download" }],
  ["download the audit CSV", { action: "audit.csv.download" }],
  ["download a workspace export", { action: "workspace.export", phase: "download", inMaintenance: false }],
  ["download a per-member export", { action: "member.export", subject: person("admin"), phase: "download" }],
];

/** Sensitive-looking actions that don't need step-up. */
const NO_STEP_UP_CHECKS = (a: Actor): [string, PermissionCheck][] => [
  ["disable", { action: "member.disable", target: person("member"), activeOwnerCount: 3 }],
  ["re-enable", { action: "member.enable", target: person("member", "disabled"), activeOwnerCount: 3 }],
  ["delete", { action: "member.delete", target: person("member"), activeOwnerCount: 3 }],
  ["sign out all sessions", { action: "member.sign_out_all", target: person("member"), activeOwnerCount: 3 }],
  ["invite", { action: "invitation.create", role: "admin", actorPasskeyCount: 2, recoveryTokenUnconsumed: false }],
  ["start a workspace export", { action: "workspace.export", phase: "start", inMaintenance: true }],
  ["start a per-member export", { action: "member.export", subject: person("admin"), phase: "start" }],
  ["commit a domain move (the passkey registration is the proof)", { action: "domain.move_commit" }],
  ["cancel a domain move", { action: "domain.move_cancel" }],
  ["rename a passkey", { action: "passkey.rename", ownerId: a.userId }],
  ["change an owner-only setting", { action: "setting.change", changeableBy: "owner" }],
  ["add a group member", { action: "group.add_member", group: { managerIds: [] }, target: person("member") }],
  ["start maintenance", { action: "maintenance.manage" }],
];

describe("step-up: a passkey assertion within 10 minutes (Permissions §6; Identity §4.5; Admin §11.3, §18)", () => {
  it("lists exactly the spec's step-up actions", () => {
    expect([...STEP_UP_ACTIONS].sort()).toEqual(
      [
        "audit.csv.download",
        "domain.move_start",
        "member.change_email",
        "member.change_role",
        "member.export",
        "member.issue_recovery_link",
        "members.csv.download",
        "passkey.add",
        "passkey.remove",
        "security_notice.ack",
        "workspace.export",
      ].sort(),
    );
  });

  const boundaries: [label: string, session: SessionFacts | null, expected: Expect][] = [
    ["a passkey assertion just now", passkeyAt(0), "✓"],
    ["a passkey assertion 9:59 ago", passkeyAt(9 * MINUTE + 59 * SECOND), "✓"],
    ["a passkey assertion exactly 10:00 ago", passkeyAt(10 * MINUTE), "✓"],
    ["a passkey assertion 10:00.001 ago", passkeyAt(10 * MINUTE + 1), "reauth_required"],
    ["a passkey assertion 10:00:01 ago", passkeyAt(10 * MINUTE + SECOND), "reauth_required"],
    ["a passkey assertion an hour ago", STALE, "reauth_required"],
    ["a magic-link sign-in just now", magicLinkAt(0), "reauth_required"],
    ["no fresh authentication at all", { freshAuthAt: null, freshAuthMethod: null }, "reauth_required"],
    ["no session (a job or queue consumer)", null, "reauth_required"],
    ["a timestamp 30 s in the future (clock skew)", passkeyAt(-30 * SECOND), "✓"],
    ["a timestamp 61 s in the future", passkeyAt(-61 * SECOND), "reauth_required"],
  ];

  for (const [label, session, expected] of boundaries) {
    const owner = actor("owner", { session });
    for (const [what, check] of STEP_UP_CHECKS(owner)) {
      it(`${what} with ${label} → ${expected}`, () => {
        expect(outcome(owner, check)).toBe(expected);
      });
    }
  }

  for (const [what, check] of NO_STEP_UP_CHECKS(actor("owner"))) {
    it(`${what} needs no step-up`, () => {
      expect(outcome(actor("owner", { session: STALE }), check)).toBe("✓");
      expect(outcome(actor("owner", { session: null }), check)).toBe("✓");
    });
  }

  it("admins' step-up actions on members are refused without a fresh assertion and allowed with one", () => {
    for (const [session, expected] of [
      [FRESH, "✓"],
      [STALE, "reauth_required"],
    ] as const) {
      const admin = actor("admin", { session });
      expect(
        outcome(admin, { action: "member.issue_recovery_link", target: person("member"), activeOwnerCount: 2 }),
      ).toBe(expected);
      expect(outcome(admin, { action: "member.change_email", target: person("member"), activeOwnerCount: 2 })).toBe(
        expected,
      );
      expect(outcome(admin, { action: "members.csv.download" })).toBe(expected);
      expect(outcome(admin, { action: "audit.csv.download" })).toBe(expected);
      expect(outcome(admin, { action: "workspace.export", phase: "download", inMaintenance: false })).toBe(expected);
      expect(outcome(admin, { action: "member.export", subject: person("member"), phase: "download" })).toBe(expected);
    }
  });

  it("a role denial wins over reauth_required: nobody is asked for a passkey for something they can't do", () => {
    const stale = { session: STALE };
    expect(
      outcome(actor("admin", stale), {
        action: "member.change_role",
        target: person("member"),
        newRole: "admin",
        activeOwnerCount: 2,
        targetPasskeyCount: 1,
        recoveryTokenUnconsumed: false,
      }),
    ).toBe("owner_required");
    expect(
      outcome(actor("admin", stale), { action: "member.change_email", target: person("owner"), activeOwnerCount: 2 }),
    ).toBe("owner_required");
    expect(outcome(actor("member", stale), { action: "members.csv.download" })).toBe("not_permitted");
    expect(outcome(actor("admin", stale), { action: "domain.move_start" })).toBe("owner_required");
    const owner = actor("owner", stale);
    expect(
      outcome(owner, {
        action: "passkey.remove",
        ownerId: owner.userId,
        ownerPasskeyCount: 1,
        magicLinksAvailable: true,
      }),
    ).toBe("last_passkey");
    expect(
      outcome(owner, {
        action: "member.change_role",
        target: person("member"),
        newRole: "owner",
        activeOwnerCount: 2,
        targetPasskeyCount: 1,
        recoveryTokenUnconsumed: false,
      }),
    ).toBe("promotion_passkeys");
  });

  describe("the first-passkey exception (Identity §4.5)", () => {
    const firstPasskey = (a: Actor, count = 0): PermissionCheck => ({
      action: "passkey.add",
      ownerId: a.userId,
      ownerPasskeyCount: count,
    });

    it("a member with no passkeys may add one within 10 minutes of a magic-link sign-in", () => {
      for (const age of [0, 9 * MINUTE + 59 * SECOND, 10 * MINUTE]) {
        const member = actor("member", { session: magicLinkAt(age) });
        expect(outcome(member, firstPasskey(member))).toBe("✓");
      }
    });

    it("not after 10 minutes", () => {
      const member = actor("member", { session: magicLinkAt(10 * MINUTE + SECOND) });
      expect(outcome(member, firstPasskey(member))).toBe("reauth_required");
    });

    it("not once they have a passkey, and never for removal", () => {
      const member = actor("member", { session: magicLinkAt(MINUTE) });
      expect(outcome(member, firstPasskey(member, 1))).toBe("reauth_required");
      expect(
        outcome(member, {
          action: "passkey.remove",
          ownerId: member.userId,
          ownerPasskeyCount: 2,
          magicLinksAvailable: true,
        }),
      ).toBe("reauth_required");
    });

    it("not for admins or owners, who never sign in by magic link", () => {
      for (const role of ["admin", "owner"] as const) {
        const a = actor(role, { session: magicLinkAt(MINUTE) });
        expect(outcome(a, firstPasskey(a))).toBe("reauth_required");
      }
    });

    it("a magic-link sign-in satisfies no other step-up action", () => {
      const member = actor("member", { session: magicLinkAt(0) });
      expect(outcome(member, { action: "passkey.add", ownerId: member.userId, ownerPasskeyCount: 2 })).toBe(
        "reauth_required",
      );
      const owner = actor("owner", { session: magicLinkAt(0) });
      expect(outcome(owner, { action: "domain.move_start" })).toBe("reauth_required");
    });
  });
});

// ---- Messages, reasons and the union rule ------------------------------------------------------

describe("denials", () => {
  it("every reason has a message, and owner_required says it plainly (Identity §8)", () => {
    for (const reason of DENIAL_REASONS) expect(denialMessage(reason).length).toBeGreaterThan(0);
    expect(denialMessage("owner_required")).toBe("An owner must do this.");
  });
});

describe("union rule building blocks (Permissions §3.2, §5.1, §9)", () => {
  it("takes the highest role from any path and has no deny", () => {
    expect(highestResourceRole(["viewer", "editor", null])).toBe("editor");
    expect(highestResourceRole(["freebusy", "commenter"])).toBe("commenter");
    expect(highestResourceRole(["manager", "owner"])).toBe("owner");
    expect(highestResourceRole(["editor", "manager"])).toBe("manager");
    expect(highestResourceRole([null, undefined])).toBeNull();
    expect(highestResourceRole([])).toBeNull();
  });

  it("a viewer grant on a folder plus an editor grant on an item inside gives editor (§11 Union)", () => {
    expect(
      effectiveResourceRole([
        { via: "grant", on: "folder", role: "viewer" },
        { via: "grant", on: "item", role: "editor" },
      ]),
    ).toBe("editor");
  });

  it("an item can't be restricted below its folder: restricted general access on the item narrows nothing", () => {
    expect(
      effectiveResourceRole([
        { via: "general_access", on: "item", level: "restricted" },
        { via: "general_access", on: "folder", level: "workspace_comment" },
      ]),
    ).toBe("commenter");
  });

  it("combines built-in drive and channel-folder roles with grants", () => {
    expect(
      effectiveResourceRole([
        { via: "builtin", rule: "channel_folder", role: "editor" },
        { via: "general_access", on: "drive", level: "workspace_view" },
      ]),
    ).toBe("editor");
    expect(effectiveResourceRole([{ via: "builtin", rule: "my_files_owner", role: "owner" }])).toBe("owner");
    expect(effectiveResourceRole([])).toBeNull();
  });

  it("maps general access to roles", () => {
    expect(generalAccessRole("restricted")).toBeNull();
    expect(generalAccessRole("workspace_freebusy")).toBe("freebusy");
    expect(generalAccessRole("workspace_view")).toBe("viewer");
    expect(generalAccessRole("workspace_comment")).toBe("commenter");
    expect(generalAccessRole("workspace_edit")).toBe("editor");
  });

  it("compares roles by rank", () => {
    expect(resourceRoleAtLeast("editor", "commenter")).toBe(true);
    expect(resourceRoleAtLeast("editor", "editor")).toBe(true);
    expect(resourceRoleAtLeast("viewer", "commenter")).toBe(false);
    expect(resourceRoleAtLeast("freebusy", "viewer")).toBe(false);
    expect(resourceRoleAtLeast(null, "freebusy")).toBe(false);
  });

  it("manager is valid only on drives, freebusy only on calendars (§9)", () => {
    expect(isResourceRoleValidFor("drive", "manager")).toBe(true);
    expect(isResourceRoleValidFor("document", "manager")).toBe(false);
    expect(isResourceRoleValidFor("calendar", "freebusy")).toBe(true);
    expect(isResourceRoleValidFor("folder", "freebusy")).toBe(false);
    expect(isResourceRoleValidFor("document", "editor")).toBe(true);
  });
});

// Profiles (M1d; Permissions §4.6 "View the directory and profiles": everyone; Identity §4.10: disabled
// members under the Deactivated filter, deleted ones only as "Former member", reserved rows never).
// Viewing never needs step-up. Editing is the own-account rows above (profile, status, handle, avatar):
// an admin or owner can't edit someone else's profile.
const PROFILE_VIEW_MATRIX: Record<ActorRole, Record<"active" | "disabled" | "deleted" | "system", Expect>> = {
  owner: { active: "✓", disabled: "✓", deleted: "invalid_target", system: "invalid_target" },
  admin: { active: "✓", disabled: "✓", deleted: "invalid_target", system: "invalid_target" },
  member: { active: "✓", disabled: "✓", deleted: "invalid_target", system: "invalid_target" },
  guest: { active: "not_permitted", disabled: "not_permitted", deleted: "not_permitted", system: "not_permitted" },
};

describe("permission matrix: profiles (Permissions §4.6, Identity §4.7–§4.10)", () => {
  for (const role of ACTOR_ROLES) {
    for (const status of ["active", "disabled", "deleted", "system"] as const) {
      for (const targetRole of TARGET_ROLES) {
        const expected = PROFILE_VIEW_MATRIX[role][status];
        it(`${role} views a ${status} ${targetRole}'s profile → ${expected}`, () => {
          // A stale session doesn't matter: viewing isn't a step-up action.
          const a = actor(role, { session: STALE });
          expect(outcome(a, { action: "profile.view", target: person(targetRole, status) })).toBe(expected);
        });
      }
    }
  }

  it("a disabled or deleted viewer sees nothing", () => {
    for (const status of ["disabled", "deleted"] as const) {
      expect(outcome(actor("member", { status }), { action: "profile.view", target: person("member") })).toBe(
        "inactive",
      );
    }
    expect(outcome(actor("member", { status: "system" }), { action: "profile.view", target: person("member") })).toBe(
      "system_actor",
    );
  });

  for (const action of ["profile.edit", "status.edit", "handle.change", "avatar.edit"] as const) {
    it(`${action}: only the person, never an admin or owner on someone else's (no step-up)`, () => {
      for (const role of ["owner", "admin", "member"] as const) {
        const a = actor(role, { session: STALE });
        expect(outcome(a, { action, ownerId: a.userId })).toBe("✓");
        expect(outcome(a, { action, ownerId: "someone-else" })).toBe("not_own");
      }
    });
  }
});

/**
 * The literal table covering each action outside the exported lists. Typed so that adding a check type
 * to the engine is a compile error until it is listed here with its table. The exported lists
 * (workspace, member-admin, group, own-account actions) are covered by tables keyed on, or loops over,
 * those same lists. This needs no shared state, so it holds under filtering, shuffling and concurrency.
 */
const TABLE_FOR: Record<
  Exclude<PermissionAction, WorkspaceAction | MemberAdminAction | GroupMemberAction | SelfAction>,
  object
> = {
  "admin.job.view": JOB_VIEW_MATRIX,
  "invitation.create": INVITE_MATRIX,
  "invitation.revoke": REVOKE_MATRIX,
  "member.change_role": CHANGE_ROLE_MATRIX,
  "member.export": MEMBER_EXPORT_MATRIX,
  "workspace.export": WORKSPACE_EXPORT_MATRIX,
  "profile.view": PROFILE_VIEW_MATRIX,
  "passkey.add": OWN_MATRIX,
  "passkey.remove": PASSKEY_REMOVE,
  "setting.change": SETTING_MATRIX,
};

describe("matrix coverage", () => {
  it("every workspace action has a literal row (keyed table)", () => {
    expect(Object.keys(WORKSPACE_MATRIX).sort()).toEqual([...WORKSPACE_ACTIONS].sort());
  });

  it("every other action has a non-empty literal table", () => {
    for (const [action, table] of Object.entries(TABLE_FOR)) {
      expect(Object.keys(table).length, action).toBeGreaterThan(0);
    }
  });

  it("the role tables have a row for every actor role", () => {
    for (const table of [MEMBER_ADMIN_MATRIX, CHANGE_ROLE_MATRIX, MEMBER_EXPORT_MATRIX, OWN_MATRIX, JOB_VIEW_MATRIX]) {
      expect(Object.keys(table).sort()).toEqual([...ACTOR_ROLES].sort());
    }
  });
});

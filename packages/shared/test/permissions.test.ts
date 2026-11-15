import { describe, expect, it } from "vitest";
import {
  decide,
  denialMessage,
  highestResourceRole,
  MEMBER_ADMIN_ACTIONS,
  SELF_ACTIONS,
  WORKSPACE_ACTIONS,
  WORKSPACE_ROLES,
  type Actor,
  type DenialReason,
  type PermissionCheck,
  type WorkspaceRole,
} from "../src/permissions";

/**
 * The permission matrix test (permissions §11). Every action × actor role × target is checked against
 * an expected table transcribed from permissions §4.6 and §6, written out literally rather than derived
 * from the engine's logic. It grows per milestone: M1a covers workspace roles and the role-based admin
 * powers; M1e adds groups and profiles; M3a channels; M4 calls; M5a calendars; M6a documents.
 *
 * `✓` allowed, otherwise the expected denial reason.
 */
type Expect = "✓" | DenialReason;

const ACTOR_ROLES = ["owner", "admin", "member", "guest"] as const satisfies readonly WorkspaceRole[];
const TARGET_ROLES = ["owner", "admin", "member"] as const satisfies readonly WorkspaceRole[];

const actor = (role: WorkspaceRole, status: Actor["status"] = "active", userId = `actor-${role}`): Actor => ({
  userId,
  role,
  status,
});

function outcome(a: Actor, check: PermissionCheck): Expect {
  const decision = decide(a, check);
  return decision.allowed ? "✓" : decision.reason;
}

// permissions §4.6 rows that depend on role alone.
const WORKSPACE_MATRIX: Record<(typeof WORKSPACE_ACTIONS)[number], Record<(typeof ACTOR_ROLES)[number], Expect>> = {
  "directory.view": { owner: "✓", admin: "✓", member: "✓", guest: "not_permitted" },
  "admin.open": { owner: "✓", admin: "✓", member: "not_permitted", guest: "not_permitted" },
  "audit.view": { owner: "✓", admin: "✓", member: "not_permitted", guest: "not_permitted" },
  "groups.manage": { owner: "✓", admin: "✓", member: "not_permitted", guest: "not_permitted" },
};

// "Invite with role member / admin" (§4.6, §6): admins invite members; only owners invite admins.
const INVITE_MATRIX: Record<WorkspaceRole, Record<(typeof ACTOR_ROLES)[number], Expect>> = {
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

// "Change someone's email · issue a recovery link · disable · re-enable · delete · sign out all
// sessions" (§4.6, §6): admins on members only; owners on anyone. Several active owners exist here.
const MEMBER_ADMIN_MATRIX: Record<(typeof ACTOR_ROLES)[number], Record<(typeof TARGET_ROLES)[number], Expect>> = {
  owner: { owner: "✓", admin: "✓", member: "✓" },
  admin: { owner: "owner_required", admin: "owner_required", member: "✓" },
  member: { owner: "not_permitted", admin: "not_permitted", member: "not_permitted" },
  guest: { owner: "not_permitted", admin: "not_permitted", member: "not_permitted" },
};

// "Change role to member or admin" (§4.6): owners only.
const CHANGE_ROLE_MATRIX: Record<(typeof ACTOR_ROLES)[number], Expect> = {
  owner: "✓",
  admin: "owner_required",
  member: "not_permitted",
  guest: "not_permitted",
};

// Platform §7 "Who can change".
const SETTING_MATRIX: Record<"admin" | "owner", Record<(typeof ACTOR_ROLES)[number], Expect>> = {
  admin: { owner: "✓", admin: "✓", member: "not_permitted", guest: "not_permitted" },
  owner: { owner: "✓", admin: "owner_required", member: "not_permitted", guest: "not_permitted" },
};

describe("permission matrix: workspace roles (M1a)", () => {
  for (const action of WORKSPACE_ACTIONS) {
    for (const role of ACTOR_ROLES) {
      it(`${role}: ${action} → ${WORKSPACE_MATRIX[action][role]}`, () => {
        expect(outcome(actor(role), { action })).toBe(WORKSPACE_MATRIX[action][role]);
      });
    }
  }

  for (const inviteRole of WORKSPACE_ROLES) {
    for (const role of ACTOR_ROLES) {
      it(`${role}: invite as ${inviteRole} → ${INVITE_MATRIX[inviteRole][role]}`, () => {
        expect(outcome(actor(role), { action: "invitation.create", role: inviteRole })).toBe(
          INVITE_MATRIX[inviteRole][role],
        );
      });
    }
  }

  for (const action of MEMBER_ADMIN_ACTIONS) {
    for (const role of ACTOR_ROLES) {
      for (const targetRole of TARGET_ROLES) {
        it(`${role}: ${action} on an active ${targetRole} → ${MEMBER_ADMIN_MATRIX[role][targetRole]}`, () => {
          const check: PermissionCheck = {
            action,
            target: { userId: `target-${targetRole}`, role: targetRole, status: "active" },
            activeOwnerCount: 3,
          };
          expect(outcome(actor(role), check)).toBe(MEMBER_ADMIN_MATRIX[role][targetRole]);
        });
      }
    }
  }

  for (const role of ACTOR_ROLES) {
    for (const targetRole of TARGET_ROLES) {
      for (const newRole of ["owner", "admin", "member"] as const) {
        it(`${role}: change a ${targetRole} to ${newRole} → ${CHANGE_ROLE_MATRIX[role]}`, () => {
          const check: PermissionCheck = {
            action: "member.change_role",
            target: { userId: "t", role: targetRole, status: "active" },
            newRole,
            activeOwnerCount: 3,
          };
          expect(outcome(actor(role), check)).toBe(CHANGE_ROLE_MATRIX[role]);
        });
      }
    }
  }

  for (const action of SELF_ACTIONS) {
    for (const role of ACTOR_ROLES) {
      it(`${role}: ${action} on their own → ✓, on someone else's → not_own`, () => {
        const a = actor(role);
        expect(outcome(a, { action, ownerId: a.userId })).toBe("✓");
        expect(outcome(a, { action, ownerId: "someone-else" })).toBe("not_own");
      });
    }
  }

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

describe("admin-power limits (permissions §6)", () => {
  const soleOwner = { userId: "o1", role: "owner" as const, status: "active" as const };

  it("the last active owner can't be disabled, deleted or demoted, even by themselves", () => {
    const self = actor("owner", "active", "o1");
    expect(outcome(self, { action: "member.disable", target: soleOwner, activeOwnerCount: 1 })).toBe("last_owner");
    expect(outcome(self, { action: "member.delete", target: soleOwner, activeOwnerCount: 1 })).toBe("last_owner");
    for (const newRole of ["admin", "member"] as const) {
      expect(outcome(self, { action: "member.change_role", target: soleOwner, newRole, activeOwnerCount: 1 })).toBe(
        "last_owner",
      );
    }
    // Keeping them an owner is fine, and so are actions that don't remove an owner.
    expect(
      outcome(self, { action: "member.change_role", target: soleOwner, newRole: "owner", activeOwnerCount: 1 }),
    ).toBe("✓");
    for (const action of [
      "member.enable",
      "member.sign_out_all",
      "member.change_email",
      "member.issue_recovery_link",
    ] as const) {
      expect(outcome(self, { action, target: soleOwner, activeOwnerCount: 1 })).toBe("✓");
    }
  });

  it("with a second active owner, an owner can be disabled, deleted or demoted", () => {
    const other = actor("owner", "active", "o2");
    expect(outcome(other, { action: "member.disable", target: soleOwner, activeOwnerCount: 2 })).toBe("✓");
    expect(outcome(other, { action: "member.delete", target: soleOwner, activeOwnerCount: 2 })).toBe("✓");
    expect(
      outcome(other, { action: "member.change_role", target: soleOwner, newRole: "admin", activeOwnerCount: 2 }),
    ).toBe("✓");
  });

  it("a disabled owner doesn't count as the last active owner", () => {
    const owner = actor("owner");
    const disabledOwner = { userId: "o3", role: "owner" as const, status: "disabled" as const };
    expect(outcome(owner, { action: "member.delete", target: disabledOwner, activeOwnerCount: 1 })).toBe("✓");
  });

  it("an admin acting on themselves is acting on an admin: an owner must do it", () => {
    const admin = actor("admin", "active", "a1");
    const self = { userId: "a1", role: "admin" as const, status: "active" as const };
    expect(outcome(admin, { action: "member.disable", target: self, activeOwnerCount: 1 })).toBe("owner_required");
  });

  it("guest is never assignable", () => {
    expect(
      outcome(actor("owner"), {
        action: "member.change_role",
        target: { userId: "m", role: "member", status: "active" },
        newRole: "guest",
        activeOwnerCount: 2,
      }),
    ).toBe("role_not_assignable");
  });

  it("disabled and deleted actors are refused everything, own devices included", () => {
    for (const status of ["disabled", "deleted"] as const) {
      for (const role of ACTOR_ROLES) {
        const a = actor(role, status);
        expect(outcome(a, { action: "directory.view" })).toBe("inactive");
        expect(outcome(a, { action: "devices.view", ownerId: a.userId })).toBe("inactive");
        expect(
          outcome(a, {
            action: "member.disable",
            target: { userId: "m", role: "member", status: "active" },
            activeOwnerCount: 2,
          }),
        ).toBe("inactive");
      }
    }
  });

  it("names the owner requirement plainly (Identity §8)", () => {
    expect(denialMessage("owner_required")).toBe("An owner must do this.");
  });
});

describe("union rule building block (permissions §5.1)", () => {
  it("takes the highest role from any path and has no deny", () => {
    expect(highestResourceRole(["viewer", "editor", null])).toBe("editor");
    expect(highestResourceRole(["freebusy", "commenter"])).toBe("commenter");
    expect(highestResourceRole(["manager", "owner"])).toBe("owner");
    expect(highestResourceRole([null, undefined])).toBeNull();
    expect(highestResourceRole([])).toBeNull();
  });
});

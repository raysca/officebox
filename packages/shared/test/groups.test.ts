import { describe, expect, it } from "vitest";
import {
  adminMembersQuerySchema,
  createGroupBodySchema,
  createInvitationBodySchema,
  MAX_INVITATION_GROUPS,
  patchMemberBodySchema,
  putGroupMemberBodySchema,
  updateGroupBodySchema,
} from "../src";

/** M1e schemas: groups, the member list query and member changes (Identity §4.9, §6; Admin §5). */

const ID = "01J00000000000000000000000";

describe("group bodies", () => {
  it("trims names, normalises handles, limits lengths", () => {
    const parsed = createGroupBodySchema.parse({ name: "  Design  ", handle: " @Design ", description: " x " });
    expect(parsed).toEqual({ name: "Design", handle: "design", description: "x" });
    expect(createGroupBodySchema.safeParse({ name: "", handle: "design" }).success).toBe(false);
    expect(createGroupBodySchema.safeParse({ name: "a".repeat(65), handle: "design" }).success).toBe(false);
    expect(createGroupBodySchema.safeParse({ name: "D", handle: "design", extra: 1 }).success).toBe(false);
    expect(createGroupBodySchema.safeParse({ name: "D", handle: "d", managerIds: ["nope"] }).success).toBe(false);
  });

  it("an update needs at least one field", () => {
    expect(updateGroupBodySchema.safeParse({}).success).toBe(false);
    expect(updateGroupBodySchema.safeParse({ description: null }).success).toBe(true);
  });

  it("a membership PUT defaults to member and knows only manager and member", () => {
    expect(putGroupMemberBodySchema.parse({})).toEqual({ role: "member" });
    expect(putGroupMemberBodySchema.safeParse({ role: "owner" }).success).toBe(false);
  });

  it("invitations carry at most MAX_INVITATION_GROUPS group IDs", () => {
    const base = { email: "a@example.com", role: "member", sendEmail: false };
    expect(createInvitationBodySchema.safeParse({ ...base, groupIds: [ID] }).success).toBe(true);
    const many = Array.from({ length: MAX_INVITATION_GROUPS + 1 }, () => ID);
    expect(createInvitationBodySchema.safeParse({ ...base, groupIds: many }).success).toBe(false);
  });
});

describe("member changes (PATCH /admin/members/:id)", () => {
  it("is exactly one of email, role or status", () => {
    expect(patchMemberBodySchema.safeParse({ email: "a@example.com" }).success).toBe(true);
    expect(patchMemberBodySchema.safeParse({ role: "owner" }).success).toBe(true);
    expect(patchMemberBodySchema.safeParse({ status: "disabled" }).success).toBe(true);
    for (const body of [{}, { role: "guest" }, { status: "deleted" }, { role: "admin", status: "active" }]) {
      expect(patchMemberBodySchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });

  it("the member list query knows its filters", () => {
    expect(adminMembersQuerySchema.parse({ status: "invited", lastActive: "never" })).toMatchObject({
      status: "invited",
      lastActive: "never",
    });
    expect(adminMembersQuerySchema.safeParse({ role: "guest" }).success).toBe(false);
    expect(adminMembersQuerySchema.safeParse({ sort: "name" }).success).toBe(false);
  });
});

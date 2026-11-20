import { describe, expect, it } from "vitest";
import {
  decide,
  decideAuthority,
  domainOriginSchema,
  emailChangeConfirmBodySchema,
  isLoopbackHost,
  ownerRecoveryBodySchema,
  patchMemberBodySchema,
  publicStatusSchema,
  recoveryLinkBodySchema,
  securityNoticeDetailsSchema,
  startDomainMoveBodySchema,
} from "../src";

/** Pure M1c schema rules (Identity §4.4, §4.6, §4.11). */

describe("domain move origins (Identity §4.4; default rules)", () => {
  it("normalises a bare https origin, with or without a trailing slash or port", () => {
    expect(domainOriginSchema.parse("https://work.example.com")).toBe("https://work.example.com");
    expect(domainOriginSchema.parse(" https://Work.Example.com/ ")).toBe("https://work.example.com");
    expect(domainOriginSchema.parse("https://work.example.com:8443")).toBe("https://work.example.com:8443");
    expect(domainOriginSchema.parse("https://work.example.com:443")).toBe("https://work.example.com");
  });

  it("allows http only on loopback names (local runs)", () => {
    expect(domainOriginSchema.parse("http://localhost:8788")).toBe("http://localhost:8788");
    expect(domainOriginSchema.parse("http://moved.localhost:8788")).toBe("http://moved.localhost:8788");
    expect(domainOriginSchema.safeParse("http://work.example.com").success).toBe(false);
  });

  it.each([
    "work.example.com",
    "https://work.example.com/path",
    "https://work.example.com/?q",
    "https://work.example.com/#frag",
    "https://work.example.com?",
    "https://user@work.example.com",
    "https://user:pw@work.example.com",
    "https://192.0.2.1",
    "https://[2001:db8::1]",
    "https://intranet",
    "ftp://work.example.com",
    "javascript:alert(1)",
    "",
  ])("refuses %j", (value) => {
    expect(domainOriginSchema.safeParse(value).success).toBe(false);
  });

  it("the start body is strict", () => {
    expect(startDomainMoveBodySchema.safeParse({ origin: "https://a.example.com", extra: 1 }).success).toBe(false);
  });

  it("loopback names", () => {
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("a.b.localhost.")).toBe(true);
    expect(isLoopbackHost("localhost.example.com")).toBe(false);
    expect(isLoopbackHost("notlocalhost")).toBe(false);
  });
});

describe("token bodies and member changes", () => {
  it("link tokens travel only as base64url in strict JSON bodies", () => {
    const token = "A".repeat(43);
    for (const schema of [recoveryLinkBodySchema, emailChangeConfirmBodySchema]) {
      expect(schema.safeParse({ token }).success).toBe(true);
      expect(schema.safeParse({ token: "short" }).success).toBe(false);
      expect(schema.safeParse({ token: `${token}/..` }).success).toBe(false);
      expect(schema.safeParse({ token, more: true }).success).toBe(false);
    }
  });

  it("owner recovery takes the secret and one owner's email", () => {
    expect(ownerRecoveryBodySchema.safeParse({ token: "x", email: "owner@example.com" }).success).toBe(true);
    expect(ownerRecoveryBodySchema.safeParse({ token: "x" }).success).toBe(false);
    expect(ownerRecoveryBodySchema.safeParse({ token: "", email: "owner@example.com" }).success).toBe(false);
  });

  it("M1c's member change accepts only an email (role and status arrive with M1e)", () => {
    expect(patchMemberBodySchema.safeParse({ email: "new@example.com" }).success).toBe(true);
    expect(patchMemberBodySchema.safeParse({ email: "new@example.com", role: "admin" }).success).toBe(false);
    expect(patchMemberBodySchema.safeParse({ email: "nope" }).success).toBe(false);
  });

  it("notice details and the public status accept the M1c fields, which stay optional", () => {
    expect(
      securityNoticeDetailsSchema.parse({
        actorName: "Sam",
        newEmail: "a@example.com",
        origin: "https://x.example.com",
      }),
    ).toMatchObject({ actorName: "Sam" });
    expect(securityNoticeDetailsSchema.parse({})).toEqual({});
    expect(publicStatusSchema.parse({ magicLinks: false })).toEqual({ magicLinks: false });
    expect(publicStatusSchema.parse({ magicLinks: true, recoveryNotice: { at: 1 } }).recoveryNotice).toEqual({ at: 1 });
  });
});

describe("decideAuthority (re-checking an earlier authorization without step-up)", () => {
  const target = (role: "owner" | "admin" | "member") => ({ userId: "t", role, status: "active" as const });
  const actor = (role: "owner" | "admin" | "member", status: "active" | "disabled" = "active") => ({
    userId: "a",
    role,
    status,
    session: null,
  });
  it("follows the rule but never asks for step-up", () => {
    const check = (role: "owner" | "admin" | "member") =>
      ({ action: "member.issue_recovery_link", target: target(role), activeOwnerCount: 2 }) as const;
    expect(decideAuthority(actor("admin"), check("member")).ok).toBe(true);
    expect(decideAuthority(actor("admin"), check("admin"))).toEqual({ ok: false, error: "owner_required" });
    expect(decideAuthority(actor("member"), check("member"))).toEqual({ ok: false, error: "not_permitted" });
    expect(decideAuthority(actor("admin", "disabled"), check("member"))).toEqual({ ok: false, error: "inactive" });
    expect(decideAuthority(actor("owner"), check("owner")).ok).toBe(true);
    // decide, with no session, would refuse for step-up.
    expect(decide(actor("owner"), check("owner"), Date.now())).toEqual({ ok: false, error: "reauth_required" });
  });
});

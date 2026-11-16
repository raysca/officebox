import { describe, expect, it } from "vitest";
import {
  ERROR_CODES,
  SETUP_OPEN_WINDOW_MS,
  setupBodySchema,
  setupEnrolmentSchema,
  setupStatusSchema,
  settingsListSchema,
} from "../src";

/** Quick start schemas (M1b-1; Identity §4.1, §6; Platform §16). */
describe("setup schemas (M1b-1)", () => {
  const owner = { workspaceName: "Acme", ownerName: "Sam Lee", ownerHandle: "sam", ownerEmail: "sam@example.com" };

  it("a claim may leave the token out (the open window) but never send unknown fields", () => {
    expect(setupBodySchema.safeParse(owner).success).toBe(true);
    expect(setupBodySchema.safeParse({ ...owner, token: "" }).success).toBe(true);
    expect(setupBodySchema.safeParse({ ...owner, token: "x".repeat(513) }).success).toBe(false);
    expect(setupBodySchema.safeParse({ ...owner, mode: "open" }).success).toBe(false);
  });

  it("the status carries the services with fixed problem codes only, and the mode", () => {
    const services = [{ id: "r2", ok: false, problem: "missing" }];
    expect(
      setupStatusSchema.safeParse({
        setupRequired: true,
        tokenSource: "generated",
        claimed: false,
        services,
        mode: "token",
      }).success,
    ).toBe(true);
    const open = {
      setupRequired: true,
      tokenSource: "generated",
      claimed: false,
      services: [],
      mode: "open",
      openUntil: 1,
    };
    expect(setupStatusSchema.safeParse(open).success).toBe(true);
    for (const bad of [
      { id: "r2", ok: false, problem: "bucket officebox-files missing" },
      { id: "kv", ok: true },
    ]) {
      expect(setupStatusSchema.safeParse({ ...open, services: [bad] }).success).toBe(false);
    }
  });

  it("the enrolment answer may carry the resume code; the window is an hour; the error codes exist", () => {
    expect(
      setupEnrolmentSchema.parse({ ownerEmail: "a", enrolmentExpiresInSeconds: 1, resumeCode: "c" }).resumeCode,
    ).toBe("c");
    expect(SETUP_OPEN_WINDOW_MS).toBe(3_600_000);
    expect(ERROR_CODES).toContain("setup_token_required");
    expect(ERROR_CODES).toContain("setup_services_failing");
  });

  it("settings show each key's source, never a value", () => {
    const base = { settings: [], email: { driver: "none", configured: false, missing: [] } };
    expect(
      settingsListSchema.safeParse({
        ...base,
        signInKeys: { betterAuthSecret: "generated", tokenHashKey: "worker_secret" },
      }).success,
    ).toBe(true);
    expect(
      settingsListSchema.safeParse({ ...base, signInKeys: { betterAuthSecret: "abc", tokenHashKey: "generated" } })
        .success,
    ).toBe(false);
  });
});

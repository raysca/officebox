import { describe, expect, it } from "vitest";
import {
  handleSchema,
  MAX_PASSWORD_LENGTH,
  newPasswordSchema,
  passwordProblem,
  passwordSignInBodySchema,
  setupBodySchema,
} from "../src/identity";

const validSetup = {
  token: "t".repeat(40),
  workspaceName: "  Acme  ",
  ownerName: "Sam Lee",
  ownerHandle: "Sam.Lee",
  ownerEmail: "  Sam@Example.COM ",
  password: "correct horse battery",
};

describe("password policy (Identity §4.4)", () => {
  it("needs at least 10 characters, counted as code points, with no composition rules", () => {
    expect(passwordProblem("short")).toBe("too_short");
    expect(passwordProblem("a".repeat(9))).toBe("too_short");
    expect(passwordProblem("abcdefghik")).toBeNull();
    // Nine emoji are nine characters, not eighteen UTF-16 units.
    expect(passwordProblem("😀".repeat(9))).toBe("too_short");
    expect(passwordProblem("😀".repeat(10))).toBeNull();
  });

  it("refuses common passwords, ignoring case, and over-long ones", () => {
    expect(passwordProblem("password123")).toBe("common");
    expect(passwordProblem("QwertyUIOP")).toBe("common");
    expect(passwordProblem("x".repeat(MAX_PASSWORD_LENGTH + 1))).toBe("too_long");
  });

  it("is enforced by the schema without trimming", () => {
    expect(newPasswordSchema.safeParse("1234567890").success).toBe(false);
    expect(newPasswordSchema.parse("  spaced out  ")).toBe("  spaced out  ");
  });

  it("raises the minimum when asked", () => {
    expect(passwordProblem("abcdefghijk", 12)).toBe("too_short");
  });
});

describe("handles (Identity §4.8)", () => {
  it("lower-cases and accepts 2–32 allowed characters starting with a letter or digit", () => {
    expect(handleSchema.parse(" Sam.Lee ")).toBe("sam.lee");
    expect(handleSchema.safeParse("a").success).toBe(false);
    expect(handleSchema.safeParse("a".repeat(33)).success).toBe(false);
    expect(handleSchema.safeParse(".sam").success).toBe(false);
    expect(handleSchema.safeParse("sam lee").success).toBe(false);
    expect(handleSchema.safeParse("9lives").success).toBe(true);
  });

  it("refuses reserved words", () => {
    for (const word of ["admin", "Everyone", "officebox", "here"])
      expect(handleSchema.safeParse(word).success).toBe(false);
  });
});

describe("setup and sign-in bodies", () => {
  it("normalises setup fields", () => {
    expect(setupBodySchema.parse(validSetup)).toEqual({
      ...validSetup,
      workspaceName: "Acme",
      ownerHandle: "sam.lee",
      ownerEmail: "sam@example.com",
    });
  });

  it("refuses unknown fields, bad emails and weak passwords", () => {
    expect(setupBodySchema.safeParse({ ...validSetup, role: "owner" }).success).toBe(false);
    expect(setupBodySchema.safeParse({ ...validSetup, ownerEmail: "not-an-email" }).success).toBe(false);
    expect(setupBodySchema.safeParse({ ...validSetup, password: "1234567890" }).success).toBe(false);
    expect(setupBodySchema.safeParse({ ...validSetup, ownerName: "   " }).success).toBe(false);
  });

  it("doesn't apply the new-password policy at sign-in", () => {
    expect(passwordSignInBodySchema.safeParse({ email: "a@b.co", password: "short" }).success).toBe(true);
    expect(passwordSignInBodySchema.safeParse({ email: "a@b.co", password: "" }).success).toBe(false);
  });
});

describe("Unicode normalisation", () => {
  it("NFC-normalises passwords at setup and sign-in, and emails", () => {
    const decomposed = "cafe\u0301 au lait!"; // e + combining acute
    const composed = "caf\u00e9 au lait!";
    expect(newPasswordSchema.parse(decomposed)).toBe(composed);
    expect(passwordSignInBodySchema.parse({ email: "a@b.co", password: decomposed }).password).toBe(composed);
  });
});

import { describe, it, expect } from "vitest";
import {
  checkPassword,
  isStrongPassword,
  PASSWORD_MIN_LENGTH,
  passwordStrength,
} from "./password-policy";

describe("checkPassword (US-367 client mirror of the GoTrue policy)", () => {
  it("rejects too-short passwords", () => {
    const r = checkPassword("Ab1xyz");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain(String(PASSWORD_MIN_LENGTH));
  });

  it("requires a lower-case letter", () => {
    expect(checkPassword("ABCDEFGH12").ok).toBe(false);
  });

  it("requires an upper-case letter", () => {
    expect(checkPassword("abcdefgh12").ok).toBe(false);
  });

  it("requires a digit", () => {
    expect(checkPassword("AbcdefghIJ").ok).toBe(false);
  });

  it("accepts a compliant password", () => {
    expect(isStrongPassword("Abcdefgh12")).toBe(true);
    expect(checkPassword("Abcdefgh12").reason).toBeNull();
  });
});

describe("passwordStrength", () => {
  it("scores empty as 0 and a strong password higher", () => {
    expect(passwordStrength("")).toBe(0);
    expect(passwordStrength("Abcdefgh12")).toBeGreaterThanOrEqual(2);
    expect(passwordStrength("Abcdefghijklmn12!")).toBeGreaterThanOrEqual(3);
  });
});

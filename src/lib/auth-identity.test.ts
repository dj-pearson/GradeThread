import { describe, it, expect } from "vitest";
import {
  isIdentityLinkingError,
  SIGN_IN_FAILED_MESSAGE,
  OAUTH_LINKING_MESSAGE,
  USE_ORIGINAL_METHOD_HINT,
} from "./auth-identity";

describe("isIdentityLinkingError (US-380 OAuth callback detection)", () => {
  it("detects GoTrue identity-already-exists codes", () => {
    expect(isIdentityLinkingError("identity_already_exists", null)).toBe(true);
    expect(isIdentityLinkingError("user_already_exists", null)).toBe(true);
    expect(isIdentityLinkingError("email_exists", null)).toBe(true);
  });

  it("detects linking phrases in the human-readable description", () => {
    expect(
      isIdentityLinkingError("server_error", "Manual linking is disabled"),
    ).toBe(true);
    expect(
      isIdentityLinkingError(
        "access_denied",
        "A user with this email address has already been registered",
      ),
    ).toBe(true);
    expect(
      isIdentityLinkingError(null, "Multiple accounts found for this email"),
    ).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isIdentityLinkingError("IDENTITY_ALREADY_EXISTS", null)).toBe(true);
  });

  it("does NOT flag unrelated provider errors", () => {
    expect(isIdentityLinkingError("access_denied", "User cancelled")).toBe(false);
    expect(isIdentityLinkingError("server_error", "Temporary failure")).toBe(false);
    expect(isIdentityLinkingError(null, null)).toBe(false);
    expect(isIdentityLinkingError(undefined, undefined)).toBe(false);
  });
});

describe("US-380 guidance messages", () => {
  it("the sign-in failure message stays generic (US-369) yet hints at the original method", () => {
    expect(SIGN_IN_FAILED_MESSAGE).toContain(USE_ORIGINAL_METHOD_HINT);
    expect(SIGN_IN_FAILED_MESSAGE.toLowerCase()).toContain("google");
    // Must NOT confirm account existence (no enumeration).
    expect(SIGN_IN_FAILED_MESSAGE.toLowerCase()).not.toContain("no account");
  });

  it("the OAuth linking message points users at their original method", () => {
    expect(OAUTH_LINKING_MESSAGE.toLowerCase()).toContain("original sign-in method");
  });
});

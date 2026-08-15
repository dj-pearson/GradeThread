import { beforeEach, describe, expect, it } from "vitest";
import { hasPkceVerifier, isCrossDeviceConfirmation } from "../auth-pkce";

// GT-001. The whole value of this helper is telling two states apart that look
// identical on screen: a confirmation link that is merely slow, and one that can
// never complete in this browser. Getting it wrong in either direction is worse
// than not having it - a false positive sends a healthy sign-in to a recovery
// page, and a false negative restores the fifteen-second dead end.

const VERIFIER_KEY = "sb-api-auth-token-code-verifier";

describe("hasPkceVerifier", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it("is false on a browser that never started a signup", () => {
    expect(hasPkceVerifier()).toBe(false);
  });

  it("finds a verifier in localStorage", () => {
    localStorage.setItem(VERIFIER_KEY, "abc123");
    expect(hasPkceVerifier()).toBe(true);
  });

  it("finds one in sessionStorage too", () => {
    // The "shared device" preference routes the session there (hybridStorage).
    sessionStorage.setItem(VERIFIER_KEY, "abc123");
    expect(hasPkceVerifier()).toBe(true);
  });

  it("matches on the suffix, not on a project ref we guessed", () => {
    // Self-hosted: the ref is the first host label, so a key rebuilt from the
    // URL would be wrong for everybody and route every user to recovery.
    localStorage.setItem("sb-somethingelse-auth-token-code-verifier", "abc123");
    expect(hasPkceVerifier()).toBe(true);
  });

  it("ignores the session token, which is not a verifier", () => {
    localStorage.setItem("sb-api-auth-token", JSON.stringify({ access_token: "x" }));
    expect(hasPkceVerifier()).toBe(false);
  });

  it("treats an empty verifier as absent", () => {
    localStorage.setItem(VERIFIER_KEY, "");
    expect(hasPkceVerifier()).toBe(false);
  });
});

describe("isCrossDeviceConfirmation", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it("is true for a code this browser cannot spend", () => {
    expect(isCrossDeviceConfirmation("?code=abc")).toBe(true);
  });

  it("is false while the exchange is merely in flight", () => {
    localStorage.setItem(VERIFIER_KEY, "abc123");
    expect(isCrossDeviceConfirmation("?code=abc")).toBe(false);
  });

  it("is false with no code at all", () => {
    // An OAuth error landing, or a bare visit. Not an email confirmation, so
    // the recovery copy would be a lie.
    expect(isCrossDeviceConfirmation("")).toBe(false);
    expect(isCrossDeviceConfirmation("?error=access_denied")).toBe(false);
  });
});

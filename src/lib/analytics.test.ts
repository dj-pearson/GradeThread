import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  acceptConsent,
  declineConsent,
  getStoredConsent,
} from "./analytics";

// The cookie banner's whole purpose is GDPR/CCPA compliance: nothing analytics
// should run until the user opts in, and the choice must persist. These guard
// that contract.
describe("analytics consent gating", () => {
  beforeEach(() => {
    localStorage.clear();
    // gtag is defined in index.html at runtime; stub it so consent updates
    // don't throw under jsdom.
    (window as unknown as { gtag?: (...a: unknown[]) => void }).gtag = vi.fn();
  });

  it("returns null before any choice is made (banner should show)", () => {
    expect(getStoredConsent()).toBeNull();
  });

  it("persists 'granted' and flips Google Consent Mode on accept", () => {
    acceptConsent();
    expect(getStoredConsent()).toBe("granted");
    expect(window.gtag).toHaveBeenCalledWith("consent", "update", {
      analytics_storage: "granted",
    });
  });

  it("persists 'denied' and does NOT grant analytics on decline", () => {
    declineConsent();
    expect(getStoredConsent()).toBe("denied");
    expect(window.gtag).not.toHaveBeenCalled();
  });

  it("ignores garbage values in storage", () => {
    localStorage.setItem("gt_cookie_consent", "maybe");
    expect(getStoredConsent()).toBeNull();
  });
});

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  acceptAll,
  getConsent,
  hasConsentDecision,
  rejectAll,
  saveConsent,
} from "./analytics";

// The cookie banner's whole purpose is GDPR/CCPA compliance: nothing
// non-essential runs until the visitor opts in, consent is stored per category,
// and the choice persists. These guard that contract.
describe("analytics per-category consent gating", () => {
  beforeEach(() => {
    localStorage.clear();
    // gtag is defined in index.html at runtime; stub it so consent updates
    // don't throw under jsdom.
    (window as unknown as { gtag?: (...a: unknown[]) => void }).gtag = vi.fn();
  });

  it("returns null before any choice is made (banner should show)", () => {
    expect(getConsent()).toBeNull();
    expect(hasConsentDecision()).toBe(false);
  });

  it("acceptAll grants both categories and flips every Consent Mode signal", () => {
    acceptAll();
    expect(getConsent()).toEqual({ analytics: true, marketing: true });
    expect(hasConsentDecision()).toBe(true);
    expect(window.gtag).toHaveBeenCalledWith("consent", "update", {
      analytics_storage: "granted",
      ad_storage: "granted",
      ad_user_data: "granted",
      ad_personalization: "granted",
    });
  });

  it("rejectAll denies both categories but still records the decision", () => {
    rejectAll();
    expect(getConsent()).toEqual({ analytics: false, marketing: false });
    expect(hasConsentDecision()).toBe(true);
    expect(window.gtag).toHaveBeenCalledWith("consent", "update", {
      analytics_storage: "denied",
      ad_storage: "denied",
      ad_user_data: "denied",
      ad_personalization: "denied",
    });
  });

  it("saveConsent honors a granular (analytics-only) choice", () => {
    saveConsent({ analytics: true, marketing: false });
    expect(getConsent()).toEqual({ analytics: true, marketing: false });
    expect(window.gtag).toHaveBeenCalledWith("consent", "update", {
      analytics_storage: "granted",
      ad_storage: "denied",
      ad_user_data: "denied",
      ad_personalization: "denied",
    });
  });

  it("migrates the legacy binary 'granted' value to both categories", () => {
    localStorage.setItem("gt_cookie_consent", "granted");
    expect(getConsent()).toEqual({ analytics: true, marketing: true });
  });

  it("migrates the legacy binary 'denied' value to both-off", () => {
    localStorage.setItem("gt_cookie_consent", "denied");
    expect(getConsent()).toEqual({ analytics: false, marketing: false });
  });

  it("ignores garbage values in storage", () => {
    localStorage.setItem("gt_cookie_consent", "{not json");
    expect(getConsent()).toBeNull();
  });
});

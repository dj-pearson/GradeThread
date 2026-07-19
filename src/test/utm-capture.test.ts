// US-2101: UTM channel attribution capture.
//
// Click ids made PAID Google traffic attributable. Everything else — organic,
// email, social, and the whole SEO/content investment — was not. We WRITE utm
// tags into our own outbound links (the trial drip tags
// utm_source=drip&utm_campaign=trial_conversion) and discarded them the instant
// the visitor arrived, so there was no way to measure whether any content work
// landed.

import { describe, expect, it, beforeEach, vi, afterEach } from "vitest";
import {
  captureUtms,
  parseUtms,
  normalizeUtm,
  getStoredUtm,
  markUtmPersisted,
  UTM_PARAMS,
} from "@/lib/ad-attribution";

const T1 = "2026-07-19T10:00:00.000Z";
const T2 = "2026-07-20T10:00:00.000Z";

beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe("US-2101: UTM parsing", () => {
  it("captures all five standard params", () => {
    const set = parseUtms(
      "?utm_source=newsletter&utm_medium=email&utm_campaign=july&utm_term=denim&utm_content=cta1",
      T1,
    );
    expect(set).toMatchObject({
      utm_source: "newsletter",
      utm_medium: "email",
      utm_campaign: "july",
      utm_term: "denim",
      utm_content: "cta1",
      landingAt: T1,
    });
  });

  it("returns null when no UTM is present, so untagged visits store nothing", () => {
    expect(parseUtms("?ref=abc&gclid=xyz", T1)).toBeNull();
    expect(parseUtms("", T1)).toBeNull();
  });

  it("captures a partial tag set", () => {
    // Real drip links carry source+campaign but no term/content.
    const set = parseUtms("?utm_source=drip&utm_campaign=trial_conversion", T1);
    expect(set).toMatchObject({ utm_source: "drip", utm_campaign: "trial_conversion" });
    expect(set!.utm_term).toBeUndefined();
  });

  it("rejects empty and oversized values", () => {
    expect(normalizeUtm("  ")).toBeNull();
    expect(normalizeUtm("x".repeat(257))).toBeNull();
    expect(normalizeUtm("  ok  ")).toBe("ok");
  });
});

describe("US-2101 AC4: consent gating", () => {
  it("stores NOTHING without analytics consent", () => {
    captureUtms("?utm_source=newsletter", T1, false);
    expect(getStoredUtm()).toBeNull();
  });

  it("fails CLOSED when no consent decision has been made", () => {
    // No decision is not permission. This is the property the cookie banner
    // exists to enforce, so it must not depend on a default being read as
    // "true" anywhere.
    localStorage.removeItem("gt_cookie_consent");
    captureUtms("?utm_source=newsletter", T1);
    expect(getStoredUtm()).toBeNull();
  });

  it("stores once analytics consent is granted", () => {
    captureUtms("?utm_source=newsletter", T1, true);
    expect(getStoredUtm()?.first.utm_source).toBe("newsletter");
  });
});

describe("US-2101 AC2: first-touch is never overwritten", () => {
  it("keeps the ORIGINAL channel and updates last-touch", () => {
    captureUtms("?utm_source=organic&utm_medium=search", T1, true);
    captureUtms("?utm_source=drip&utm_medium=email", T2, true);

    const stored = getStoredUtm()!;
    expect(stored.first.utm_source, "first touch was overwritten").toBe("organic");
    expect(stored.first.landingAt).toBe(T1);
    expect(stored.last.utm_source).toBe("drip");
    expect(stored.last.landingAt).toBe(T2);
  });

  it("an UNTAGGED later visit does not clobber either touch", () => {
    // Someone arrives from a newsletter, then navigates back later with no
    // tags. Treating that as a new channel would erase the real attribution.
    captureUtms("?utm_source=newsletter", T1, true);
    captureUtms("", T2, true);
    const stored = getStoredUtm()!;
    expect(stored.first.utm_source).toBe("newsletter");
    expect(stored.last.utm_source).toBe("newsletter");
  });

  it("a re-capture resets persisted so the new touch still syncs", () => {
    captureUtms("?utm_source=organic", T1, true);
    markUtmPersisted();
    expect(getStoredUtm()!.persisted).toBe(true);
    captureUtms("?utm_source=drip", T2, true);
    expect(
      getStoredUtm()!.persisted,
      "last-touch changed but would never be re-sent",
    ).toBe(false);
  });
});

describe("US-2101 AC3: survives the auth round trip", () => {
  it("persists in localStorage, not memory or the URL", () => {
    // The OAuth/PKCE round trip leaves and returns to the same origin, so
    // origin-scoped storage survives it; in-memory state would not.
    captureUtms("?utm_source=newsletter", T1, true);
    const raw = localStorage.getItem("gt_utm_attribution");
    expect(raw, "not in origin-scoped storage — would not survive OAuth").toBeTruthy();
    expect(JSON.parse(raw!).first.utm_source).toBe("newsletter");
  });

  it("survives corrupt storage without throwing", () => {
    localStorage.setItem("gt_utm_attribution", "{not json");
    expect(() => captureUtms("?utm_source=x", T1, true)).not.toThrow();
    expect(getStoredUtm()?.first.utm_source).toBe("x");
  });
});

describe("US-2101: the drip links we already emit are capturable", () => {
  it("captures the exact tags 00271_drip_activation_sequence.sql writes", () => {
    // The story's point: we were tagging our own emails and then throwing the
    // tags away on arrival.
    captureUtms("?utm_source=drip&utm_campaign=trial_conversion", T1, true);
    const f = getStoredUtm()!.first;
    expect(f.utm_source).toBe("drip");
    expect(f.utm_campaign).toBe("trial_conversion");
  });

  it("UTM_PARAMS covers the standard five", () => {
    expect([...UTM_PARAMS]).toEqual([
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
    ]);
  });
});

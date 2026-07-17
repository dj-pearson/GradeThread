// US-1876: unit tests for the Lister background navigation guard
// (extension/lister-guard.js). The extension has no test harness of its own, so
// these load the pure UMD guard (it assigns to globalThis when `self` is absent)
// and prove the properties that close the XSS-driven arbitrary-navigation
// primitive: origin is checked via sender.origin, list URLs are pinned to the
// bundled config, and delist URLs must be https + host-match the platform.

import { describe, it, expect, beforeAll } from "vitest";

interface ListerGuard {
  hostOf(v: unknown): string | null;
  hostMatches(host: string | null, domain: string): boolean;
  senderHost(sender: unknown): string | null;
  isOriginAllowed(sender: unknown): boolean;
  newListingUrlFor(selectors: unknown, platform: string): string | null;
  isAllowedDelistUrl(selectors: unknown, platform: string, url: unknown): boolean;
  isLiveListingUrl(selectors: unknown, platform: string, url: unknown): boolean;
}

let guard: ListerGuard;

// Mirror of the bundled selectors shape the worker passes in.
const SELECTORS = {
  poshmark: { newListingUrl: "https://poshmark.com/create-listing", hosts: ["poshmark.com"] },
  mercari: { newListingUrl: "https://www.mercari.com/sell/", hosts: ["mercari.com"] },
  grailed: { newListingUrl: "https://www.grailed.com/sell/", hosts: ["grailed.com"] },
};

beforeAll(async () => {
  // The guard is a vanilla-JS UMD file (extension/ has no allowJs in tsconfig.app),
  // imported only for its globalThis side effect; its runtime API is asserted via
  // the ListerGuard interface above, so the module itself needs no static types.
  // @ts-expect-error — untyped .js side-effect import
  await import("../../extension-unified/lister/lister-guard.js");
  guard = (globalThis as unknown as { GT_LISTER_GUARD: ListerGuard }).GT_LISTER_GUARD;
});

describe("isOriginAllowed (AC4)", () => {
  it("accepts gradethread.com and its subdomains via sender.origin", () => {
    expect(guard.isOriginAllowed({ origin: "https://gradethread.com" })).toBe(true);
    expect(guard.isOriginAllowed({ origin: "https://app.gradethread.com" })).toBe(true);
  });

  it("falls back to sender.url when origin is absent", () => {
    expect(guard.isOriginAllowed({ url: "https://app.gradethread.com/dashboard" })).toBe(true);
    expect(guard.isOriginAllowed({ url: "https://evil.com/x" })).toBe(false);
  });

  it("prefers sender.origin over a spoofable sender.url", () => {
    // origin is the browser-attested value — it must win over url.
    expect(guard.isOriginAllowed({ origin: "https://evil.com", url: "https://gradethread.com" })).toBe(false);
    expect(guard.isOriginAllowed({ origin: "https://app.gradethread.com", url: "https://evil.com" })).toBe(true);
  });

  it("rejects look-alike and unparseable origins", () => {
    expect(guard.isOriginAllowed({ origin: "https://gradethread.com.evil.com" })).toBe(false);
    expect(guard.isOriginAllowed({ origin: "https://notgradethread.com" })).toBe(false);
    expect(guard.isOriginAllowed({})).toBe(false);
    expect(guard.isOriginAllowed(null)).toBe(false);
  });
});

describe("newListingUrlFor (AC1 — list URL pinned to config)", () => {
  it("returns the config URL for a known platform, ignoring any message URL", () => {
    expect(guard.newListingUrlFor(SELECTORS, "poshmark")).toBe("https://poshmark.com/create-listing");
    // The function has NO parameter for a message-supplied URL — pinning by design.
    expect(guard.newListingUrlFor.length).toBe(2);
  });

  it("returns null for an unknown or misconfigured platform", () => {
    expect(guard.newListingUrlFor(SELECTORS, "ebay")).toBeNull();
    expect(guard.newListingUrlFor({ poshmark: {} }, "poshmark")).toBeNull();
    expect(guard.newListingUrlFor({ poshmark: { newListingUrl: "http://poshmark.com/x" } }, "poshmark")).toBeNull();
  });
});

describe("isAllowedDelistUrl (AC1 — delist URL host-matched)", () => {
  it("accepts an https URL on the platform's domain (incl. subdomains)", () => {
    expect(guard.isAllowedDelistUrl(SELECTORS, "poshmark", "https://poshmark.com/listing/abc")).toBe(true);
    expect(guard.isAllowedDelistUrl(SELECTORS, "poshmark", "https://www.poshmark.com/listing/abc")).toBe(true);
  });

  it("rejects non-https, off-platform, and cross-platform hosts", () => {
    expect(guard.isAllowedDelistUrl(SELECTORS, "poshmark", "http://poshmark.com/listing/abc")).toBe(false);
    expect(guard.isAllowedDelistUrl(SELECTORS, "poshmark", "https://evil.com/listing/abc")).toBe(false);
    // A poshmark job may not open a grailed URL.
    expect(guard.isAllowedDelistUrl(SELECTORS, "poshmark", "https://www.grailed.com/x")).toBe(false);
    // The classic bypass: attacker host that merely CONTAINS the domain.
    expect(guard.isAllowedDelistUrl(SELECTORS, "poshmark", "https://poshmark.com.evil.com/x")).toBe(false);
  });

  it("rejects malformed input and unknown platforms", () => {
    expect(guard.isAllowedDelistUrl(SELECTORS, "poshmark", "not a url")).toBe(false);
    expect(guard.isAllowedDelistUrl(SELECTORS, "poshmark", null)).toBe(false);
    expect(guard.isAllowedDelistUrl(SELECTORS, "ebay", "https://ebay.com/x")).toBe(false);
  });
});


// ── US-1877 (AC1): live-listing URL capture ────────────────────────────────
//
// After a fill, the background watches the tab for the URL the marketplace
// navigates to when the seller SUBMITS. That capture promotes the row from draft
// to active and records the URL the delist queue later opens.
//
// So a false positive is not cosmetic — it is the phantom-listing bug US-1877
// exists to remove, wearing a plausible URL. The guard is strict on BOTH axes.
describe("isLiveListingUrl (US-1877 AC1)", () => {
  const SEL = {
    poshmark: {
      hosts: ["poshmark.com"],
      liveListingUrlPattern: "^https://[^/]*poshmark\.(com|ca)/listing/[^/]+",
    },
    mercari: {
      hosts: ["mercari.com"],
      liveListingUrlPattern: "^https://[^/]*mercari\.com/(us/)?item/[^/]+",
    },
    grailed: {
      hosts: ["grailed.com"],
      liveListingUrlPattern: "^https://[^/]*grailed\.com/listings/[^/]+",
    },
  };

  it("captures a real live listing on each platform", () => {
    expect(guard.isLiveListingUrl(SEL, "poshmark", "https://poshmark.com/listing/Nike-Tee-abc")).toBe(true);
    expect(guard.isLiveListingUrl(SEL, "mercari", "https://www.mercari.com/us/item/m123/")).toBe(true);
    expect(guard.isLiveListingUrl(SEL, "grailed", "https://www.grailed.com/listings/9-tee")).toBe(true);
  });

  it("NEVER captures the create-listing page it was opened on", () => {
    // The tab starts on the form. If this matched, every fill would instantly
    // "capture" the form URL and mark the listing live — the exact phantom.
    expect(guard.isLiveListingUrl(SEL, "poshmark", "https://poshmark.com/create-listing")).toBe(false);
    expect(guard.isLiveListingUrl(SEL, "mercari", "https://www.mercari.com/sell/")).toBe(false);
    expect(guard.isLiveListingUrl(SEL, "grailed", "https://www.grailed.com/sell/")).toBe(false);
  });

  it("NEVER captures a foreign host, however listing-shaped its path", () => {
    // The seller clicks an ad or an outbound link mid-flow.
    expect(guard.isLiveListingUrl(SEL, "poshmark", "https://evil.com/listing/x")).toBe(false);
    expect(guard.isLiveListingUrl(SEL, "grailed", "https://poshmark.com/listing/x")).toBe(false);
  });

  it("requires https and a real url", () => {
    expect(guard.isLiveListingUrl(SEL, "poshmark", "http://poshmark.com/listing/x")).toBe(false);
    expect(guard.isLiveListingUrl(SEL, "poshmark", "")).toBe(false);
    expect(guard.isLiveListingUrl(SEL, "poshmark", null)).toBe(false);
  });

  it("fails closed on a platform with no pattern, or a malformed one", () => {
    // A remote config could ship either. Failing closed means the seller falls back
    // to "I published it" — never a wrong URL written onto their listing.
    expect(guard.isLiveListingUrl(SEL, "depop", "https://depop.com/products/x")).toBe(false);
    expect(
      guard.isLiveListingUrl(
        { x: { hosts: ["x.com"], liveListingUrlPattern: "([unclosed" } },
        "x",
        "https://x.com/anything",
      ),
    ).toBe(false);
  });
});

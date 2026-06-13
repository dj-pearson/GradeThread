import { describe, expect, it } from "vitest";
import {
  API_CROSS_LISTING_PLATFORMS,
  EXTENSION_CROSS_LISTING_PLATFORMS,
  LISTING_PLATFORMS,
  LIVE_CROSS_LISTING_PLATFORMS,
  MARKETPLACE_MECHANISM,
} from "@/lib/constants";

// US-717: the composer + Marketplaces UI read MARKETPLACE_MECHANISM to show each
// channel's REAL mechanism (API vs browser-extension) — these guards keep the
// map honest and the two cross-list groupings consistent with it.

describe("MARKETPLACE_MECHANISM", () => {
  it("classifies every listing platform", () => {
    for (const p of LISTING_PLATFORMS) {
      expect(MARKETPLACE_MECHANISM[p]).toBeDefined();
    }
  });

  it("routes eBay/Shopify/Depop through the API", () => {
    expect(MARKETPLACE_MECHANISM.ebay).toBe("api");
    expect(MARKETPLACE_MECHANISM.shopify).toBe("api");
    expect(MARKETPLACE_MECHANISM.depop).toBe("api");
  });

  it("routes Poshmark/Mercari/Grailed through the extension", () => {
    expect(MARKETPLACE_MECHANISM.poshmark).toBe("extension");
    expect(MARKETPLACE_MECHANISM.mercari).toBe("extension");
    expect(MARKETPLACE_MECHANISM.grailed).toBe("extension");
  });

  it("every API cross-list platform is mechanism=api", () => {
    for (const p of API_CROSS_LISTING_PLATFORMS) {
      expect(MARKETPLACE_MECHANISM[p]).toBe("api");
    }
  });

  it("every extension cross-list platform is mechanism=extension", () => {
    for (const p of EXTENSION_CROSS_LISTING_PLATFORMS) {
      expect(MARKETPLACE_MECHANISM[p]).toBe("extension");
    }
  });

  it("the API and extension groups don't overlap", () => {
    for (const p of EXTENSION_CROSS_LISTING_PLATFORMS) {
      expect(API_CROSS_LISTING_PLATFORMS as readonly string[]).not.toContain(p);
    }
  });

  it("Depop is now a live API cross-list platform (US-714)", () => {
    expect(LIVE_CROSS_LISTING_PLATFORMS as readonly string[]).toContain("depop");
  });
});

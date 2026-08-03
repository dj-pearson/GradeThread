import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  API_CROSS_LISTING_PLATFORMS,
  EXTENSION_CROSS_LISTING_PLATFORMS,
  FLIPDESK_PLANS,
  LISTING_PLATFORMS,
  LIVE_CROSS_LISTING_PLATFORMS,
  MARKETPLACE_MECHANISM,
  MARKETPLACE_TIER,
  MARKETPLACE_TIER_LABEL,
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
    // Depop stays mechanism=api on purpose: the mechanism says HOW a channel
    // would be reached, and Depop's adapter really is a server-side API
    // connector. Whether it is switched on is MARKETPLACE_TIER's job, and that
    // still reads api_pending. Conflating the two is what US-2327 unpicked.
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

  // US-2327: this used to assert the opposite — that Depop IS live. The
  // assertion was true of the constant and false of the product: the connector
  // defaults to DISABLED, so on a stock deployment nothing about Depop works.
  // A test that pins a claim the code cannot honour makes the claim harder to
  // fix, not safer.
  it("Depop is NOT advertised as live — the connector defaults off (US-2327)", () => {
    expect(LIVE_CROSS_LISTING_PLATFORMS as readonly string[]).not.toContain("depop");
  });

  it("Whatnot is not reached by any mechanism (US-2327)", () => {
    // Every adapter method is notImplemented and the API was modelled with no
    // public docs, so "api" was the least supported claim in constants.ts.
    expect(MARKETPLACE_MECHANISM.whatnot).toBe("none");
  });
});

// US-2327 AC3: the frontend's "live" claim has to match what the SERVER can
// actually do. Nothing in the UI reads these constants today, which is the only
// reason the wrong values were harmless — the next consumer would have
// inherited them. So the claim is tied to the adapters themselves rather than
// to another constant that could drift alongside it.
describe("the live list matches the adapters (US-2327)", () => {
  const ADAPTERS = resolve(
    process.cwd(),
    "services/edge-functions/src/lib/marketplace-adapters",
  );

  it("every LIVE platform can actually PUBLISH", () => {
    // Scoped to publish deliberately, and the scoping is a finding rather than
    // a convenience: this assertion first failed on Shopify, whose adapter
    // stubs syncListings and syncOrders while publish is real. "Live
    // cross-listing" is a claim about PUSHING a listing out, so Shopify
    // belongs in the list — but it cannot read anything back, which is a
    // separate and unadvertised gap recorded on US-2327.
    for (const p of LIVE_CROSS_LISTING_PLATFORMS) {
      const src = readFileSync(resolve(ADAPTERS, `${p}.ts`), "utf8");
      expect(
        src,
        `${p} is advertised as live but its publish path is a stub`,
      ).not.toMatch(/publish:[^,]*notImplemented\(/);
    }
  });

  it("a platform with a stubbed adapter can never be live", () => {
    // The inverse, so the guard catches the failure from both directions: a
    // half-built adapter being promoted, and a live platform regressing to a
    // stub. Whatnot is the worked example.
    for (const p of ["whatnot"] as const) {
      const src = readFileSync(resolve(ADAPTERS, `${p}.ts`), "utf8");
      expect(src).toMatch(/publish:[^,]*notImplemented\(/);
      expect(LIVE_CROSS_LISTING_PLATFORMS as readonly string[]).not.toContain(p);
    }
  });

  it("live implies tier 'api' — the two layers cannot disagree again", () => {
    // The specific defect: LIVE_CROSS_LISTING_PLATFORMS said Depop was live
    // while MARKETPLACE_TIER said api_pending, and nothing tied them together.
    for (const p of LIVE_CROSS_LISTING_PLATFORMS) {
      expect(MARKETPLACE_TIER[p], `${p} is listed live but its tier is not api`)
        .toBe("api");
    }
  });
});

// US-718: the presentation tier is the single source of truth the Marketplaces
// UI (web + iOS) reads. These guards keep it honest — no channel is advertised
// above the integration that actually ships at launch.
describe("MARKETPLACE_TIER (US-718)", () => {
  it("classifies every listing platform with a labelled tier", () => {
    for (const p of LISTING_PLATFORMS) {
      const tier = MARKETPLACE_TIER[p];
      expect(tier).toBeDefined();
      expect(MARKETPLACE_TIER_LABEL[tier]).toBeTruthy();
    }
  });

  it("only the live API connectors are tier 'api' (eBay + Shopify)", () => {
    const apiTier = LISTING_PLATFORMS.filter(
      (p) => MARKETPLACE_TIER[p] === "api",
    );
    expect(apiTier.sort()).toEqual(["ebay", "shopify"]);
  });

  it("Depop is api_pending — built but not advertised as live (US-713/714)", () => {
    expect(MARKETPLACE_TIER.depop).toBe("api_pending");
  });

  it("Poshmark/Mercari/Grailed are the extension tier (US-716)", () => {
    expect(MARKETPLACE_TIER.poshmark).toBe("extension");
    expect(MARKETPLACE_TIER.mercari).toBe("extension");
    expect(MARKETPLACE_TIER.grailed).toBe("extension");
  });

  it("a channel's mechanism is consistent with its tier", () => {
    for (const p of LISTING_PLATFORMS) {
      const tier = MARKETPLACE_TIER[p];
      const mech = MARKETPLACE_MECHANISM[p];
      if (tier === "api" || tier === "api_pending") expect(mech).toBe("api");
      if (tier === "extension") expect(mech).toBe("extension");
      if (tier === "coming_soon") expect(mech).toBe("none");
    }
  });
});

// US-718 AC2: plan copy must not advertise non-live API integrations and the
// cap must reflect what actually works (paid tiers can connect >1 API channel).
describe("FlipDesk plan honesty (US-718)", () => {
  it("no plan advertises Poshmark/Mercari/Depop/Etsy as live API integrations", () => {
    for (const plan of Object.values(FLIPDESK_PLANS)) {
      for (const feature of plan.features) {
        // The only legitimate mention of these channels is the extension bullet.
        const isExtensionBullet = /Lister extension/i.test(feature);
        if (isExtensionBullet) continue;
        expect(feature).not.toMatch(/\b(poshmark|mercari|depop|etsy)\b/i);
      }
    }
  });

  it("paid tiers allow more than one marketplace connection (cross-list works)", () => {
    expect(FLIPDESK_PLANS.starter.marketplacesCap).toBe(-1);
    expect(FLIPDESK_PLANS.pro.marketplacesCap).toBe(-1);
    expect(FLIPDESK_PLANS.business.marketplacesCap).toBe(-1);
  });

  it("Free stays eBay-only (single connection) as the upsell", () => {
    expect(FLIPDESK_PLANS.free.marketplacesCap).toBe(1);
  });
});

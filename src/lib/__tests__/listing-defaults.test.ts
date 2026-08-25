import { describe, it, expect } from "vitest";
import {
  resolveSeedAuctionDuration,
  resolveSeedBestOffer,
  resolveSeedBestOfferEnabled,
  resolveSeedFormat,
  resolveSeedQuantity,
  seedBestOfferCents,
  type SeedListingRow,
} from "@/lib/listing-defaults";
import {
  PLATFORM_LISTING_DEFAULTS,
  type SellerListingDefaults,
} from "@/hooks/use-seller-listing-defaults";

const defaults = (patch: Partial<SellerListingDefaults> = {}): SellerListingDefaults => ({
  ...PLATFORM_LISTING_DEFAULTS,
  ...patch,
});

describe("listing defaults — a seller with no opinion gets today's behaviour", () => {
  it("seeds fixed price, 7-day auction, quantity 1, Best Offer off", () => {
    const d = defaults();
    expect(resolveSeedFormat(null, d)).toBe("fixed_price");
    expect(resolveSeedAuctionDuration(null, d)).toBe("DAYS_7");
    expect(resolveSeedQuantity(null, d, "fixed_price")).toBe(1);
    expect(resolveSeedBestOfferEnabled(null, d, "fixed_price")).toBe(false);
  });

  it("survives defaults that never loaded", () => {
    expect(resolveSeedFormat(null, null)).toBe("fixed_price");
    expect(resolveSeedAuctionDuration(null, undefined)).toBe("DAYS_7");
    expect(resolveSeedQuantity(null, null, "fixed_price")).toBe(1);
    expect(resolveSeedBestOfferEnabled(null, null, "fixed_price")).toBe(false);
  });
});

describe("listing defaults — a new draft follows the seller", () => {
  it("opens as an auction at the seller's duration", () => {
    const d = defaults({
      default_listing_format: "auction",
      default_auction_duration: "DAYS_10",
    });
    expect(resolveSeedFormat(null, d)).toBe("auction");
    expect(resolveSeedAuctionDuration(null, d)).toBe("DAYS_10");
  });

  it("ignores a duration eBay does not accept", () => {
    const d = defaults({ default_auction_duration: "DAYS_2" });
    expect(resolveSeedAuctionDuration(null, d)).toBe("DAYS_7");
  });

  it("seeds the seller's quantity on fixed price only", () => {
    const d = defaults({ default_listing_quantity: 5 });
    expect(resolveSeedQuantity(null, d, "fixed_price")).toBe(5);
    // An auction is single-quantity; a default of 5 must not show in the box.
    expect(resolveSeedQuantity(null, d, "auction")).toBe(1);
  });

  it("keeps Best Offer on auctions a separate decision", () => {
    const d = defaults({
      default_best_offer_enabled: true,
      default_best_offer_on_auction: false,
    });
    expect(resolveSeedBestOfferEnabled(null, d, "fixed_price")).toBe(true);
    expect(resolveSeedBestOfferEnabled(null, d, "auction")).toBe(false);
  });
});

describe("listing defaults — a saved listing always wins", () => {
  const saved: SeedListingRow = {
    listing_format: "fixed_price",
    auction_duration: "DAYS_3",
    best_offer_enabled: false,
    best_offer_auto_accept_cents: 4200,
    best_offer_auto_decline_cents: 3000,
    quantity: 2,
  };

  it("does not re-seed a deliberate Best Offer OFF", () => {
    const d = defaults({ default_best_offer_enabled: true });
    // The regression this file exists for: `?? default` treats a saved false as
    // absent and turns Best Offer back on behind the seller.
    expect(resolveSeedBestOfferEnabled(saved, d, "fixed_price")).toBe(false);
  });

  it("passes stored cents through untouched", () => {
    const d = defaults({
      default_best_offer_enabled: true,
      default_best_offer_accept_pct: 90,
      default_best_offer_decline_pct: 50,
    });
    const seed = resolveSeedBestOffer(saved, d, "fixed_price", 10_000);
    expect(seed.acceptCents).toBe(4200);
    expect(seed.declineCents).toBe(3000);
  });

  it("keeps the saved format, duration and quantity", () => {
    const d = defaults({
      default_listing_format: "auction",
      default_auction_duration: "DAYS_10",
      default_listing_quantity: 9,
    });
    expect(resolveSeedFormat(saved, d)).toBe("fixed_price");
    expect(resolveSeedAuctionDuration(saved, d)).toBe("DAYS_3");
    expect(resolveSeedQuantity(saved, d, "fixed_price")).toBe(2);
  });
});

describe("percent-of-price thresholds", () => {
  it("converts against the resolved price", () => {
    expect(seedBestOfferCents(90, 10_000)).toBe(9_000);
    expect(seedBestOfferCents(65, 1_299)).toBe(844);
  });

  it("drops a percent with no price to apply it to", () => {
    // US-2405 in a new costume: a threshold derived from a zero price is a
    // number that outlives the price it came from.
    expect(seedBestOfferCents(90, 0)).toBeNull();
    expect(seedBestOfferCents(90, Number.NaN)).toBeNull();
  });

  it("rejects out-of-range percentages", () => {
    expect(seedBestOfferCents(0, 10_000)).toBeNull();
    expect(seedBestOfferCents(100, 10_000)).toBeNull();
    expect(seedBestOfferCents(null, 10_000)).toBeNull();
  });

  it("produces nothing when Best Offer seeds off", () => {
    const d = defaults({
      default_best_offer_enabled: false,
      default_best_offer_accept_pct: 90,
    });
    const seed = resolveSeedBestOffer(null, d, "fixed_price", 10_000);
    expect(seed).toEqual({ enabled: false, acceptCents: null, declineCents: null });
  });

  it("seeds both thresholds for a new draft when Best Offer is on", () => {
    const d = defaults({
      default_best_offer_enabled: true,
      default_best_offer_accept_pct: 90,
      default_best_offer_decline_pct: 60,
    });
    const seed = resolveSeedBestOffer(null, d, "fixed_price", 5_000);
    expect(seed).toEqual({ enabled: true, acceptCents: 4_500, declineCents: 3_000 });
  });
});

import { describe, expect, it } from "vitest";
import {
  draftPriceFrom,
  draftPriceState,
  gradedUpdateOffer,
  isSellerOverride,
  overrideAuditRow,
  priceProvenanceFor,
} from "@/lib/draft-price";

// US-9205 AC5: the three states, graded, ungraded and overridden, plus the
// provenance a save writes for each.

const gradedRec = {
  recommendedCents: 3450,
  gradeValue: 8.5,
  soldBacked: true,
  sufficient: true,
  compSet: { count: 12 },
  sellThrough: { daysLow: 9, daysHigh: 21, label: "moderate" },
};
const medianRec = { ...gradedRec, gradeValue: null, sellThrough: { daysLow: 0, daysHigh: 0, label: "unknown" } };

describe("graded", () => {
  it("prefills the graded price with grade, comps and days to sell", () => {
    const p = draftPriceFrom(gradedRec, 8.5);
    expect(p).toEqual({ cents: 3450, basis: "graded", why: "Grade 8.5, 12 sold comps, 9 to 21 days to sell." });
  });
  it("saving the prefill records graded provenance and no audit row", () => {
    const p = draftPriceFrom(gradedRec, 8.5);
    expect(priceProvenanceFor(3450, p)).toEqual({ price_set_by: "graded", graded_price_cents: 3450, graded_price_why: p!.why });
    expect(overrideAuditRow({ userId: "u", listingId: "l", inventoryItemId: "i", typedCents: 3450, graded: p })).toBeNull();
    expect(draftPriceState({ listing_price: 34.5, price_set_by: "graded" })).toBe("graded");
  });
});

describe("ungraded", () => {
  it("prefills the comp median and says there is no grade yet", () => {
    const p = draftPriceFrom(medianRec, null);
    expect(p?.basis).toBe("comp_median");
    expect(p?.why).toBe("Comp median from 12 sold comps. No grade yet; a grade can move this.");
    expect(priceProvenanceFor(3450, p).price_set_by).toBe("comp_median");
    expect(draftPriceState({ listing_price: 34.5, price_set_by: "comp_median" })).toBe("ungraded");
  });
  it("offers the graded price once the grade lands, never applies it", () => {
    const offer = gradedUpdateOffer({ listing_price: 34.5, price_set_by: "comp_median" }, { ...gradedRec, recommendedCents: 3900 }, 8.5);
    expect(offer?.cents).toBe(3900);
    expect(gradedUpdateOffer({ listing_price: 39, price_set_by: "comp_median" }, { ...gradedRec, recommendedCents: 3900 }, 8.5)).toBeNull();
    expect(gradedUpdateOffer({ listing_price: 34.5, price_set_by: "graded" }, gradedRec, 8.5)).toBeNull();
    expect(gradedUpdateOffer({ listing_price: 34.5, price_set_by: "comp_median" }, medianRec, null)).toBeNull();
  });
  it("nothing to price from leaves the field alone", () => {
    expect(draftPriceFrom(null, 8)).toBeNull();
    expect(draftPriceFrom({ recommendedCents: null }, 8)).toBeNull();
    expect(draftPriceState({ listing_price: null, price_set_by: null })).toBe("unpriced");
    expect(draftPriceState({ listing_price: 20, price_set_by: null })).toBe("ungraded");
  });
});

describe("overridden", () => {
  it("a typed price that differs from the prefill is the seller's", () => {
    const p = draftPriceFrom(gradedRec, 8.5);
    expect(isSellerOverride(2999, p)).toBe(true);
    expect(isSellerOverride(3450, p)).toBe(false);
    expect(isSellerOverride(2999, null)).toBe(true);
    expect(isSellerOverride(null, p)).toBe(false);
  });
  it("the save keeps the graded price beside the seller's and writes the audit row", () => {
    const p = draftPriceFrom(gradedRec, 8.5);
    expect(priceProvenanceFor(2999, p)).toEqual({ price_set_by: "seller", graded_price_cents: 3450, graded_price_why: p!.why });
    expect(overrideAuditRow({ userId: "u", listingId: "l", inventoryItemId: "i", typedCents: 2999, graded: p })).toEqual({
      user_id: "u",
      listing_id: "l",
      inventory_item_id: "i",
      old_price_cents: 3450,
      new_price_cents: 2999,
      reason: "seller_override",
      ebay_synced: false,
    });
    expect(draftPriceState({ listing_price: 29.99, price_set_by: "seller" })).toBe("overridden");
  });
  it("an override of a comp-median prefill has no graded price to audit against", () => {
    const p = draftPriceFrom(medianRec, null);
    expect(priceProvenanceFor(2999, p)).toEqual({ price_set_by: "seller", graded_price_cents: null, graded_price_why: null });
    expect(overrideAuditRow({ userId: "u", listingId: "l", inventoryItemId: null, typedCents: 2999, graded: p })).toBeNull();
  });
});

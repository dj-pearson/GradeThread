// US-2247/US-2248/US-2249/US-2250/US-2251: the composer's save payloads.
//
// These tests exist because the composer's live-listing save had drifted a
// dozen columns behind its draft save, silently discarding promote/Best Offer/
// format/primary-photo edits with a success toast, and because the Storage & SKU
// card's separate Save meant "Save draft" threw away a SKU typed seconds
// earlier. The parity assertion below is the guard: any column added to the
// draft path that isn't lifecycle metadata must appear on the live path too.
import { describe, it, expect } from "vitest";
import {
  buildListingFields,
  buildDraftListingPayload,
  buildLiveListingPatch,
  buildItemPatch,
  buildFormatPayload,
  resolveQuantity,
  type ComposerListingState,
  type ComposerItemState,
} from "@/lib/composer-save";

const listingState = (
  over: Partial<ComposerListingState> = {},
): ComposerListingState => ({
  title: "  Nike Vintage Hoodie Large  ",
  description: "  A hoodie.  ",
  ebayCondition: "USED_EXCELLENT",
  conditionDesc: "  Light wear.  ",
  resolvedPrice: 48,
  resolvedCategoryId: "57988",
  resolvedAspects: { Brand: ["Nike"], Size: ["L"] },
  resolvedSources: { Brand: "manual" },
  scheduledPublishAt: "2026-08-01T23:00:00.000Z",
  primaryPhotoId: "photo-1",
  promoteEnabled: true,
  promoMode: "cps",
  promoRate: "4.5",
  listingFormat: {
    format: "fixed_price",
    auctionStartPrice: "",
    auctionReservePrice: "",
    auctionBuyItNowPrice: "",
    auctionDuration: "DAYS_7",
    variations: null,
  },
  bestOfferEnabled: true,
  bestOfferAcceptCents: 4400,
  bestOfferDeclineCents: 3000,
  quantity: "3",
  shippingPolicyId: "fp-1",
  paymentPolicyId: "pp-1",
  returnPolicyId: "rp-1",
  ...over,
});

const itemState = (over: Partial<ComposerItemState> = {}): ComposerItemState => ({
  resolvedCategoryId: "57988",
  resolvedAspects: { Brand: ["Nike"] },
  resolvedSources: { Brand: "manual" },
  measurements: { chest: 22 },
  effectiveCost: 8.5,
  sourcedBy: "  Dj  ",
  acquiredDate: "2026-07-01",
  categoryTouched: false,
  itemCategory: "clothing",
  storageSku: "  FD-1a2b  ",
  storageLocation: "  Tote A3  ",
  storageContainer: "  Bin 7  ",
  resolvedStatus: "drafted",
  ...over,
});

describe("buildListingFields", () => {
  it("trims text and stores blanks as null", () => {
    const f = buildListingFields(
      listingState({ description: "   ", conditionDesc: "  ", ebayCondition: "" }),
    );
    expect(f.listing_title).toBe("Nike Vintage Hoodie Large");
    expect(f.listing_description).toBeNull();
    expect(f.ebay_condition).toBeNull();
    expect(f.ebay_condition_description).toBeNull();
  });

  it("marks a saved price as human-reviewed", () => {
    expect(buildListingFields(listingState()).price_is_estimated).toBe(false);
  });

  it("keeps promo_opt_out in lockstep with the promote override", () => {
    expect(buildListingFields(listingState()).promote_override).toBe(true);
    expect(buildListingFields(listingState()).promo_opt_out).toBe(false);
    const off = buildListingFields(listingState({ promoteEnabled: false }));
    expect(off.promote_override).toBe(false);
    expect(off.promo_opt_out).toBe(true);
  });

  it("stores an ad rate only in CPS mode (CPC/Smart bid per click)", () => {
    expect(buildListingFields(listingState()).promo_rate_pct).toBe(4.5);
    for (const mode of ["cpc", "smart"] as const) {
      expect(
        buildListingFields(listingState({ promoMode: mode })).promo_rate_pct,
      ).toBeNull();
    }
    // Disabled promotion never stores a rate, even in CPS mode.
    expect(
      buildListingFields(listingState({ promoteEnabled: false })).promo_rate_pct,
    ).toBeNull();
    // A blank or non-numeric rate stores NULL rather than NaN.
    expect(
      buildListingFields(listingState({ promoRate: "" })).promo_rate_pct,
    ).toBeNull();
    expect(
      buildListingFields(listingState({ promoRate: "abc" })).promo_rate_pct,
    ).toBeNull();
  });

  it("drops Best Offer thresholds when Best Offer is off", () => {
    const off = buildListingFields(listingState({ bestOfferEnabled: false }));
    expect(off.best_offer_enabled).toBe(false);
    expect(off.best_offer_auto_accept_cents).toBeNull();
    expect(off.best_offer_auto_decline_cents).toBeNull();
  });

  // US-2382: the grade-card switch was REMOVED, not wired, so neither column
  // may be written by any save path. The teeth are in no-dead-column-writes.
  it("writes neither badge_enabled nor slab_image_mode", () => {
    const f = buildListingFields(listingState()) as Record<string, unknown>;
    expect("badge_enabled" in f).toBe(false);
    expect("slab_image_mode" in f).toBe(false);
  });

  // US-2251: publish falls back to the account default when these are NULL, so
  // "Use account default" has to round-trip as NULL rather than be omitted.
  it("persists business policies, including a null reset to the account default", () => {
    const f = buildListingFields(listingState());
    expect(f.shipping_policy_id).toBe("fp-1");
    expect(f.payment_policy_id).toBe("pp-1");
    expect(f.return_policy_id).toBe("rp-1");
    const reset = buildListingFields(
      listingState({
        shippingPolicyId: null,
        paymentPolicyId: null,
        returnPolicyId: null,
      }),
    );
    expect(reset).toHaveProperty("shipping_policy_id", null);
    expect(reset).toHaveProperty("payment_policy_id", null);
    expect(reset).toHaveProperty("return_policy_id", null);
  });

  it("never carries the lifecycle columns a live/sold save must not touch", () => {
    const f = buildListingFields(listingState());
    for (const col of [
      "listing_status",
      "is_active",
      "inventory_item_id",
      "platform",
      "reviewed_at",
      "scheduled_publish_at",
    ]) {
      expect(f).not.toHaveProperty(col);
    }
  });
});

describe("resolveQuantity (US-2250)", () => {
  it("parses the input, defaulting to 1", () => {
    expect(resolveQuantity(listingState({ quantity: "5" }))).toBe(5);
    for (const bad of ["", "0", "-2", "abc", "2.7abc"]) {
      const got = resolveQuantity(listingState({ quantity: bad }));
      expect(got).toBeGreaterThanOrEqual(1);
    }
    expect(resolveQuantity(listingState({ quantity: "" }))).toBe(1);
    expect(resolveQuantity(listingState({ quantity: "0" }))).toBe(1);
    expect(resolveQuantity(listingState({ quantity: "-2" }))).toBe(1);
  });

  it("forces 1 for an auction regardless of the input", () => {
    const s = listingState({ quantity: "9" });
    s.listingFormat = { ...s.listingFormat, format: "auction" };
    expect(resolveQuantity(s)).toBe(1);
  });

  it("sums the variation matrix instead of trusting the box", () => {
    const s = listingState({ quantity: "1" });
    s.listingFormat = {
      ...s.listingFormat,
      variations: {
        specifications: ["Size"],
        variants: [
          { aspects: { Size: "M" }, quantity: 2, price_cents: null, sku_suffix: null },
          { aspects: { Size: "L" }, quantity: 4, price_cents: null, sku_suffix: null },
        ],
      },
    };
    expect(resolveQuantity(s)).toBe(6);
  });
});

describe("buildFormatPayload (US-568)", () => {
  it("nulls auction terms for a fixed-price listing", () => {
    const p = buildFormatPayload(listingState().listingFormat);
    expect(p.listing_format).toBe("fixed_price");
    expect(p.auction_start_price_cents).toBeNull();
    expect(p.auction_duration).toBeNull();
  });

  it("converts auction dollars to cents and drops variations", () => {
    const p = buildFormatPayload({
      format: "auction",
      auctionStartPrice: "9.99",
      auctionReservePrice: "25",
      auctionBuyItNowPrice: "",
      auctionDuration: "DAYS_10",
      variations: {
        specifications: ["Size"],
        variants: [
          { aspects: { Size: "M" }, quantity: 1, price_cents: null, sku_suffix: null },
        ],
      },
    });
    expect(p.auction_start_price_cents).toBe(999);
    expect(p.auction_reserve_price_cents).toBe(2500);
    expect(p.auction_buy_it_now_price_cents).toBeNull();
    expect(p.auction_duration).toBe("DAYS_10");
    expect(p.variations).toBeNull();
  });
});

describe("buildDraftListingPayload", () => {
  it("stamps draft lifecycle columns on an insert", () => {
    const p = buildDraftListingPayload(listingState(), {
      inventoryItemId: "item-1",
      reviewedAt: "2026-07-29T12:00:00.000Z",
    });
    expect(p.inventory_item_id).toBe("item-1");
    expect(p.platform).toBe("ebay");
    expect(p.listing_status).toBe("draft");
    expect(p.is_active).toBe(false);
    expect(p.reviewed_at).toBe("2026-07-29T12:00:00.000Z");
    expect(p.scheduled_publish_at).toBe("2026-08-01T23:00:00.000Z");
  });

  // The editor opens at every status now, so hard-coding "draft" here would
  // demote an ended or sold listing on an ordinary save.
  it("preserves an existing non-draft status and leaves is_active alone", () => {
    const p = buildDraftListingPayload(listingState(), {
      inventoryItemId: "item-1",
      existingStatus: "ended",
      reviewedAt: "2026-07-29T12:00:00.000Z",
    });
    expect(p.listing_status).toBe("ended");
    expect(p).not.toHaveProperty("is_active");
  });
});

describe("buildLiveListingPatch (US-2248)", () => {
  // The regression this whole module is for: a seller changes the promote rate
  // and Best Offer floor on a live listing, saves, and gets a success toast
  // while the UPDATE never names those columns.
  it("carries the promote, Best Offer, format, quantity and primary-photo edits", () => {
    const p = buildLiveListingPatch(
      listingState({ promoRate: "7", bestOfferAcceptCents: 5000 }),
    );
    expect(p.promo_rate_pct).toBe(7);
    expect(p.promote_override).toBe(true);
    expect(p.best_offer_enabled).toBe(true);
    expect(p.best_offer_auto_accept_cents).toBe(5000);
    expect(p.listing_format).toBe("fixed_price");
    expect(p.primary_photo_id).toBe("photo-1");
    expect(p.quantity).toBe(3);
    expect("badge_enabled" in p).toBe(false);
    expect(p.shipping_policy_id).toBe("fp-1");
  });

  // The parity guard. Every content column on the draft path must exist on the
  // live path; only lifecycle metadata and the publish schedule may be
  // draft-only. A new field wired into one path and not the other fails here.
  it("matches the draft payload on every non-lifecycle column", () => {
    const state = listingState();
    const draft = buildDraftListingPayload(state, {
      inventoryItemId: "item-1",
      reviewedAt: "2026-07-29T12:00:00.000Z",
    });
    const live = buildLiveListingPatch(state);
    const draftOnly = new Set([
      "inventory_item_id",
      "platform",
      "listing_status",
      "is_active",
      "reviewed_at",
      "scheduled_publish_at",
    ]);
    const missing = Object.keys(draft).filter(
      (k) => !draftOnly.has(k) && !(k in live),
    );
    expect(missing).toEqual([]);
    // …and the shared columns must carry identical values, not merely exist.
    for (const k of Object.keys(live)) {
      expect(live[k as keyof typeof live]).toEqual(draft[k as keyof typeof draft]);
    }
  });

  it("omits the publish schedule — a live listing has already published", () => {
    expect(buildLiveListingPatch(listingState())).not.toHaveProperty(
      "scheduled_publish_at",
    );
  });
});

describe("buildItemPatch (US-2249)", () => {
  // The bug: Storage & SKU had its own Save, so typing a SKU and then clicking
  // the form's primary Save discarded it without a word.
  it("includes the storage fields the main Save used to drop", () => {
    const p = buildItemPatch(itemState());
    expect(p.sku).toBe("FD-1a2b");
    expect(p.location_bin).toBe("Tote A3");
    expect(p.container).toBe("Bin 7");
  });

  it("clears cleared storage fields to null rather than empty strings", () => {
    const p = buildItemPatch(
      itemState({ storageSku: "   ", storageLocation: "", storageContainer: "  " }),
    );
    expect(p.sku).toBeNull();
    expect(p.location_bin).toBeNull();
    expect(p.container).toBeNull();
  });

  it("writes the cost basis, including back to null when cleared", () => {
    expect(buildItemPatch(itemState()).acquired_price).toBe(8.5);
    expect(buildItemPatch(itemState({ effectiveCost: null })).acquired_price).toBeNull();
  });

  it("only writes item_category when the seller picked it by hand", () => {
    expect(buildItemPatch(itemState())).not.toHaveProperty("item_category");
    expect(
      buildItemPatch(itemState({ categoryTouched: true })).item_category,
    ).toBe("clothing");
    expect(
      buildItemPatch(itemState({ categoryTouched: true, itemCategory: "" }))
        .item_category,
    ).toBeNull();
  });

  it("stores an empty measurement map as null", () => {
    expect(buildItemPatch(itemState({ measurements: {} })).measurements).toBeNull();
    expect(buildItemPatch(itemState()).measurements).toEqual({ chest: 22 });
  });

  it("lets the caller's derived patches (cascade, write-back) win", () => {
    const p = buildItemPatch(itemState(), {
      item_category: "shoes",
      garment_type: "footwear",
      brand: "Nike",
    });
    expect(p.item_category).toBe("shoes");
    expect(p.garment_type).toBe("footwear");
    expect(p.brand).toBe("Nike");
  });
});

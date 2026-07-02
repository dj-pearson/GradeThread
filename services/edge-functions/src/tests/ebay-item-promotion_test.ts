// deno-lint-ignore-file no-explicit-any
// US-1448 chunk 2: item_promotion body-builder unit tests. Pure — no network,
// no DB. Validates the per-type request bodies against eBay's documented
// ItemPromotion schema and the required-field guards.

import { assertEquals, assertThrows } from "@std/assert";

Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
Deno.env.set("EBAY_MARKETPLACE_ID", "EBAY_US");

const mk = await import("../lib/ebay-marketing.ts");

Deno.test("VOLUME_DISCOUNT: per-item %, numberOfItems, no image required", () => {
  const body = mk.buildItemPromotionBody({
    type: "VOLUME_DISCOUNT",
    name: "Buy 2 save",
    listingIds: ["111", "222"],
    percentOff: 15,
    buyQuantity: 3,
  }) as Record<string, any>;
  assertEquals(body.promotionType, "VOLUME_DISCOUNT");
  assertEquals(body.marketplaceId, "EBAY_US");
  assertEquals(body.promotionStatus, "RUNNING");
  assertEquals(body.inventoryCriterion.listingIds, ["111", "222"]);
  assertEquals(body.discountRules[0].discountBenefit, { percentageOffItem: "15.0" });
  assertEquals(body.discountRules[0].discountSpecification, { numberOfItems: 3 });
  assertEquals("promotionImageUrl" in body, false); // not valid for VOLUME_DISCOUNT
  assertEquals("couponConfiguration" in body, false);
});

Deno.test("VOLUME_DISCOUNT: buyQuantity floors at 2", () => {
  const body = mk.buildItemPromotionBody({
    type: "VOLUME_DISCOUNT",
    name: "vol",
    listingIds: ["1"],
    percentOff: 10,
    buyQuantity: 1,
  }) as Record<string, any>;
  assertEquals(body.discountRules[0].discountSpecification.numberOfItems, 2);
});

Deno.test("ORDER_DISCOUNT: %-off-order + minAmount + image", () => {
  const body = mk.buildItemPromotionBody({
    type: "ORDER_DISCOUNT",
    name: "Spend $50 save 10%",
    listingIds: ["abc"],
    percentOff: 10,
    minSpend: { value: "50.00", currency: "USD" },
    promotionImageUrl: "https://img.example/banner.jpg",
    startDate: "2026-08-01T00:00:00.000Z",
  }) as Record<string, any>;
  assertEquals(body.promotionType, "ORDER_DISCOUNT");
  assertEquals(body.promotionStatus, "SCHEDULED"); // future start
  assertEquals(body.discountRules[0].discountBenefit, { percentageOffOrder: "10.0" });
  assertEquals(body.discountRules[0].discountSpecification, {
    minAmount: { value: "50.00", currency: "USD" },
  });
  assertEquals(body.promotionImageUrl, "https://img.example/banner.jpg");
  assertEquals(body.startDate, "2026-08-01T00:00:00.000Z");
});

Deno.test("ORDER_DISCOUNT: missing image / minSpend throws", () => {
  assertThrows(() =>
    mk.buildItemPromotionBody({
      type: "ORDER_DISCOUNT",
      name: "x",
      listingIds: ["1"],
      percentOff: 10,
      minSpend: { value: "50", currency: "USD" },
    }), Error, "promotionImageUrl");
  assertThrows(() =>
    mk.buildItemPromotionBody({
      type: "ORDER_DISCOUNT",
      name: "x",
      listingIds: ["1"],
      percentOff: 10,
      promotionImageUrl: "https://img/x.jpg",
    }), Error, "minSpend");
});

Deno.test("CODED_COUPON: couponConfiguration + image; validates code", () => {
  const body = mk.buildItemPromotionBody({
    type: "CODED_COUPON",
    name: "SAVE10",
    listingIds: ["1"],
    percentOff: 10,
    couponCode: "SAVE10NOW",
    promotionImageUrl: "https://img/x.jpg",
  }) as Record<string, any>;
  assertEquals(body.promotionType, "CODED_COUPON");
  assertEquals(body.couponConfiguration, {
    couponType: "PUBLIC_CODED_COUPON",
    couponCode: "SAVE10NOW",
  });
  assertEquals(body.discountRules[0].discountBenefit, { percentageOffItem: "10.0" });

  // bad code (too short / non-alphanumeric) throws
  assertThrows(() =>
    mk.buildItemPromotionBody({
      type: "CODED_COUPON",
      name: "x",
      listingIds: ["1"],
      percentOff: 10,
      couponCode: "SHORT",
      promotionImageUrl: "https://img/x.jpg",
    }), Error, "couponCode");
});

Deno.test("percent is clamped to the shared markdown bounds (5–70)", () => {
  const hi = mk.buildItemPromotionBody({
    type: "VOLUME_DISCOUNT",
    name: "x",
    listingIds: ["1"],
    percentOff: 200,
  }) as Record<string, any>;
  assertEquals(hi.discountRules[0].discountBenefit.percentageOffItem, "70.0");
  const lo = mk.buildItemPromotionBody({
    type: "VOLUME_DISCOUNT",
    name: "x",
    listingIds: ["1"],
    percentOff: 1,
  }) as Record<string, any>;
  assertEquals(lo.discountRules[0].discountBenefit.percentageOffItem, "5.0");
});

Deno.test("empty name / no listings throws", () => {
  assertThrows(() =>
    mk.buildItemPromotionBody({
      type: "VOLUME_DISCOUNT",
      name: "  ",
      listingIds: ["1"],
      percentOff: 10,
    }), Error, "name");
  assertThrows(() =>
    mk.buildItemPromotionBody({
      type: "VOLUME_DISCOUNT",
      name: "x",
      listingIds: [],
      percentOff: 10,
    }), Error, "listing");
});

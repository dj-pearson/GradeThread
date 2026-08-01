import "./_env.ts";
import { assertEquals } from "@std/assert";
import {
  buildMarkdownPromotionBody,
  clampMarkdownPct,
  isPromoActive,
  MAX_MARKDOWN_PCT,
  MIN_MARKDOWN_PCT,
  type PromotedListingRow,
  promotionIdFromLocation,
  summarizePromotedListings,
} from "../lib/ebay-marketing.ts";

Deno.test("clampMarkdownPct bounds the discount", () => {
  assertEquals(clampMarkdownPct(0), MIN_MARKDOWN_PCT);
  assertEquals(clampMarkdownPct(999), MAX_MARKDOWN_PCT);
  assertEquals(clampMarkdownPct(15), 15);
  assertEquals(clampMarkdownPct(Number.NaN), MIN_MARKDOWN_PCT);
});

Deno.test("buildMarkdownPromotionBody targets the one listing, RUNNING by default", () => {
  const b = buildMarkdownPromotionBody({ ebayListingId: "1100123", percentOff: 15 });
  assertEquals(b.promotionStatus, "RUNNING");
  assertEquals(b.applyDiscountToAllInventory, false);
  assertEquals(b.inventoryCriterion.listingIds, ["1100123"]);
  assertEquals(b.discountRules[0].discountBenefit.percentageOffItem, "15.0");
  assertEquals(b.startDate, undefined);
});

Deno.test("buildMarkdownPromotionBody schedules when a start date is given", () => {
  const b = buildMarkdownPromotionBody({
    ebayListingId: "1100123",
    percentOff: 80, // clamps to MAX
    startDate: "2026-07-01T00:00:00Z",
    endDate: "2026-07-08T00:00:00Z",
  });
  assertEquals(b.promotionStatus, "SCHEDULED");
  assertEquals(b.startDate, "2026-07-01T00:00:00Z");
  assertEquals(b.endDate, "2026-07-08T00:00:00Z");
  assertEquals(b.discountRules[0].discountBenefit.percentageOffItem, MAX_MARKDOWN_PCT.toFixed(1));
});

Deno.test("isPromoActive treats active/RUNNING (any case) as live", () => {
  assertEquals(isPromoActive("active"), true);
  assertEquals(isPromoActive("RUNNING"), true);
  assertEquals(isPromoActive("Running"), true);
  assertEquals(isPromoActive("PAUSED"), false);
  assertEquals(isPromoActive("failed"), false);
  assertEquals(isPromoActive(null), false);
  assertEquals(isPromoActive(undefined), false);
});

Deno.test("summarizePromotedListings rolls up totals + CPS-attributed sales", () => {
  const row = (over: Partial<PromotedListingRow>): PromotedListingRow => ({
    id: "l",
    listing_title: null,
    listing_url: null,
    listing_price: null,
    listing_status: null,
    promo_status: null,
    promo_rate_pct: null,
    promo_ad_fees_cents: null,
    promo_synced_at: null,
    ...over,
  });
  const summary = summarizePromotedListings([
    row({ id: "a", promo_status: "active", promo_ad_fees_cents: 250 }),
    row({ id: "b", promo_status: "RUNNING", promo_ad_fees_cents: 0 }),
    row({ id: "c", promo_status: "failed", promo_ad_fees_cents: null }),
    row({ id: "d", promo_status: "PAUSED", promo_ad_fees_cents: 100 }),
  ]);
  assertEquals(summary.total, 4);
  assertEquals(summary.active, 2); // active + RUNNING
  assertEquals(summary.ad_fees_cents, 350); // 250 + 100
  assertEquals(summary.attributed_sales, 2); // only the fee-bearing rows
});

Deno.test("summarizePromotedListings handles an empty catalog", () => {
  assertEquals(summarizePromotedListings([]), {
    total: 0,
    active: 0,
    ad_fees_cents: 0,
    attributed_sales: 0,
  });
});

Deno.test("promotionIdFromLocation extracts the trailing id", () => {
  assertEquals(
    promotionIdFromLocation(
      "https://api.ebay.com/sell/marketing/v1/item_price_markdown_promotion/5********0",
    ),
    "5********0",
  );
  assertEquals(
    promotionIdFromLocation("/sell/marketing/v1/item_price_markdown_promotion/abc123?x=1"),
    "abc123",
  );
  assertEquals(promotionIdFromLocation(null), null);
});

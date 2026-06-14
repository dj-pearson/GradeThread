import { assertEquals } from "@std/assert";
import {
  buildMarkdownPromotionBody,
  clampMarkdownPct,
  MAX_MARKDOWN_PCT,
  MIN_MARKDOWN_PCT,
  promotionIdFromLocation,
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

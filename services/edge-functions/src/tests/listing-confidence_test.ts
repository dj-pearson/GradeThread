// US-541: the needs-review triage rule. A generated draft is flagged when the
// overall confidence is low OR any per-aspect confidence is low.
//
// ai-listing.ts imports the service-role supabase client at load, so set dummy
// env BEFORE the dynamic import (same pattern as the other edge tests).
//   deno test --allow-env src/tests/listing-confidence_test.ts
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  listingNeedsReview,
  LISTING_REVIEW_CONFIDENCE,
  priceConfidenceClearsEstimated,
  PRICE_ESTIMATED_CONFIDENCE_THRESHOLD,
  shouldAdoptGeneratedTitle,
} = await import("../lib/ai-listing.ts");

Deno.test("high overall + high aspects → no review", () => {
  assertEquals(listingNeedsReview(0.95, { Brand: 0.9, Size: 0.85 }), false);
});

Deno.test("low overall confidence → review", () => {
  assert(listingNeedsReview(0.5, { Brand: 0.95 }));
});

Deno.test("any low per-aspect confidence → review", () => {
  assert(listingNeedsReview(0.95, { Brand: 0.95, Material: 0.4 }));
});

Deno.test("no aspect confidences falls back to overall only", () => {
  assertEquals(listingNeedsReview(0.95, {}), false);
  assert(listingNeedsReview(0.6, {}));
});

Deno.test("boundary: exactly at threshold is NOT low", () => {
  assertEquals(
    listingNeedsReview(LISTING_REVIEW_CONFIDENCE, { Brand: LISTING_REVIEW_CONFIDENCE }),
    false,
  );
});

Deno.test("threshold is a sensible default", () => {
  assert(LISTING_REVIEW_CONFIDENCE > 0.5 && LISTING_REVIEW_CONFIDENCE <= 0.8);
});

// US-956: high-confidence prices clear the estimated flag.
Deno.test("price at/above threshold clears estimated", () => {
  assert(priceConfidenceClearsEstimated(0.95));
  assert(priceConfidenceClearsEstimated(PRICE_ESTIMATED_CONFIDENCE_THRESHOLD));
});

Deno.test("price below threshold stays estimated", () => {
  assertEquals(priceConfidenceClearsEstimated(0.84), false);
  assertEquals(priceConfidenceClearsEstimated(0.6), false);
});

Deno.test("null price confidence stays estimated", () => {
  assertEquals(priceConfidenceClearsEstimated(null), false);
});

Deno.test("price-estimated threshold is a sensible default", () => {
  assert(
    PRICE_ESTIMATED_CONFIDENCE_THRESHOLD > LISTING_REVIEW_CONFIDENCE &&
      PRICE_ESTIMATED_CONFIDENCE_THRESHOLD <= 1,
  );
});

// ── Generated-title write-back to the item (Inventory/Drafts "Item 12" fix) ──
// AutoLister seeds items as "Item N"; once generation produces a real title it
// folds into inventory_items.title — but never over a seller-typed one.

Deno.test("title adopt: placeholder 'Item N' is replaced", () => {
  assertEquals(shouldAdoptGeneratedTitle("Item 12", "Nike Polo L"), true);
  assertEquals(shouldAdoptGeneratedTitle("item 3", "Nike Polo L"), true);
});

Deno.test("title adopt: blank / Untitled is replaced", () => {
  assertEquals(shouldAdoptGeneratedTitle("", "Nike Polo L"), true);
  assertEquals(shouldAdoptGeneratedTitle(null, "Nike Polo L"), true);
  assertEquals(shouldAdoptGeneratedTitle("Untitled draft", "Nike Polo L"), true);
});

Deno.test("title adopt: a seller-typed title is NEVER clobbered", () => {
  assertEquals(shouldAdoptGeneratedTitle("Vintage Levi's 501", "AI title"), false);
  assertEquals(shouldAdoptGeneratedTitle("Item 12 special", "AI title"), false);
});

Deno.test("title adopt: no generated title → no write", () => {
  assertEquals(shouldAdoptGeneratedTitle("Item 12", ""), false);
  assertEquals(shouldAdoptGeneratedTitle("Item 12", null), false);
});

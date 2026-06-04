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

const { listingNeedsReview, LISTING_REVIEW_CONFIDENCE } = await import(
  "../lib/ai-listing.ts"
);

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

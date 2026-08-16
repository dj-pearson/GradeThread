import { assertEquals } from "@std/assert";

// listing-lifecycle.ts builds the service-role supabase client at load, so dummy
// env before the dynamic import (the repo's usual pattern for these).
Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);
const { isListingLive, liveBlockReason } = await import(
  "../lib/listing-lifecycle.ts"
);

// US-2657: a seller could not delete a duplicate item. The page said DRAFT and
// the server said "this item has a live listing", with nothing naming which
// listing or why — and the item could not be ended either, because End only
// renders for a listing whose status is 'active'. Stuck between two refusals.
//
// The rule itself was fine; it existed in three different versions and explained
// itself in none of them. These pin the one shared version and, crucially, the
// REASON, which is what the refusal now shows the seller.

const row = (over: Partial<Parameters<typeof liveBlockReason>[0]> = {}) => ({
  listing_status: null,
  platform_offer_id: null,
  platform_listing_id: null,
  synced_to_ebay_at: null,
  ...over,
});

Deno.test("terminal statuses never block a delete", () => {
  for (const status of ["ended", "sold"]) {
    // Even carrying every marketplace id — the listing is over.
    assertEquals(
      liveBlockReason(
        row({
          listing_status: status,
          platform_offer_id: "off-1",
          platform_listing_id: "1234",
          synced_to_ebay_at: "2026-08-01T00:00:00Z",
        }),
      ),
      null,
      `${status} should not block`,
    );
  }
});

Deno.test("an active lifecycle status blocks, and says so", () => {
  assertEquals(liveBlockReason(row({ listing_status: "active" })), "active_status");
  assertEquals(liveBlockReason(row({ listing_status: "relisted" })), "active_status");
  // Covers a manually-marked-listed row that never carried an eBay id.
  assertEquals(isListingLive(row({ listing_status: "active" })), true);
});

Deno.test("a real draft — one that never reached a marketplace — is deletable", () => {
  assertEquals(liveBlockReason(row({ listing_status: "draft" })), null);
  assertEquals(isListingLive(row({ listing_status: "draft" })), false);
  assertEquals(liveBlockReason(row()), null);
});

Deno.test("a PUBLISHED draft blocks with its own distinct reason", () => {
  // The case behind the report: reads DRAFT on screen, blocks the delete. The
  // separate reason is what lets the refusal explain itself instead of telling a
  // seller looking at a draft that they have a live listing.
  for (
    const over of [
      { platform_offer_id: "off-1" },
      { platform_listing_id: "1234" },
      { synced_to_ebay_at: "2026-08-01T00:00:00Z" },
    ]
  ) {
    assertEquals(
      liveBlockReason(row({ listing_status: "draft", ...over })),
      "published_draft",
      `${JSON.stringify(over)} should block as a published draft`,
    );
  }
});

Deno.test("an unknown status falls back to whether it reached a marketplace", () => {
  assertEquals(liveBlockReason(row({ listing_status: "something_new" })), null);
  assertEquals(
    liveBlockReason(row({ listing_status: "something_new", platform_listing_id: "9" })),
    "published_draft",
  );
});

Deno.test("isListingLive agrees with liveBlockReason, always", () => {
  const cases = [
    row(),
    row({ listing_status: "active" }),
    row({ listing_status: "ended", platform_listing_id: "1" }),
    row({ listing_status: "draft", synced_to_ebay_at: "2026-01-01T00:00:00Z" }),
    row({ listing_status: "sold" }),
  ];
  for (const c of cases) {
    assertEquals(isListingLive(c), liveBlockReason(c) !== null);
  }
});

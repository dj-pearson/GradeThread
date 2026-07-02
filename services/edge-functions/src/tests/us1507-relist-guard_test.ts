// US-1507: the /listings/:id/relist guard refuses to relist an eBay-ORIGINATED
// (imported) listing. The handler derives the origin from the SAME provenance
// signals loadListingOwned selects, exactly as the revise guard (US-1080) does,
// and rejects with 409 when it resolves to "ebay". This locks the decision logic
// so a future change can't silently re-open the duplicate-live-listing path.
//
// Pure module — no env, no network (the route-level 409 is exercised by the
// env-gated tenant-isolation suite when TEST_EDGE_BASE_URL is configured).

import { assertEquals } from "@std/assert";
import { deriveListingOrigin } from "../lib/sync-precedence.ts";

// The exact signal shape the relist handler passes (no listing_origin override →
// derive from batch_id / synced_to_ebay_at / platform_listing_id).
function relistGuardOrigin(row: {
  platform_listing_id: string | null;
  batch_id: string | null;
  synced_to_ebay_at: string | null;
}): "ebay" | "gradethread" {
  return deriveListingOrigin({
    platform: "ebay",
    platform_listing_id: row.platform_listing_id,
    batch_id: row.batch_id,
    synced_to_ebay_at: row.synced_to_ebay_at,
  });
}

Deno.test("relist guard: an imported eBay listing resolves to 'ebay' (relist REFUSED)", () => {
  // Imported/eBay-native: has a platform_listing_id but was never published from
  // FlipDesk (no batch_id, no synced_to_ebay_at) — the withdraw has no offer id,
  // so relisting would strand the live listing and corrupt the mirror.
  assertEquals(
    relistGuardOrigin({
      platform_listing_id: "1122334455",
      batch_id: null,
      synced_to_ebay_at: null,
    }),
    "ebay",
  );
});

Deno.test("relist guard: a FlipDesk-published listing resolves to 'gradethread' (relist ALLOWED)", () => {
  // Published from FlipDesk → synced_to_ebay_at is stamped at publish time.
  assertEquals(
    relistGuardOrigin({
      platform_listing_id: "9988776655",
      batch_id: null,
      synced_to_ebay_at: "2026-06-01T00:00:00Z",
    }),
    "gradethread",
  );
  // AutoLister batch-published drafts carry a batch_id.
  assertEquals(
    relistGuardOrigin({
      platform_listing_id: null,
      batch_id: "batch-1",
      synced_to_ebay_at: null,
    }),
    "gradethread",
  );
});

// A stored listing_origin (persisted since 00232, and now selected by
// loadListingOwned) is authoritative when present — belt-and-suspenders that an
// imported row is 'ebay' even if a future signal tweak regressed the derivation.
Deno.test("relist guard: an explicit listing_origin='ebay' is honored", () => {
  assertEquals(
    deriveListingOrigin({
      listing_origin: "ebay",
      platform: "ebay",
      platform_listing_id: "5",
      batch_id: "b",
      synced_to_ebay_at: "2026-06-01T00:00:00Z",
    }),
    "ebay",
  );
});

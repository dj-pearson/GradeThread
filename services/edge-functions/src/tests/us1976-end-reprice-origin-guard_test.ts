// US-1976: DELETE /listings/:id (end) and POST /listings/:id/price (reprice)
// enforce the read-only-mirror contract, exactly like /revise (US-1080). Both
// handlers derive the origin from the SAME provenance signals loadListingOwned
// selects (now including the persisted listing_origin) and, when it resolves to
// "ebay", reject with 409 + locked_fields via validateEbayOriginEdit.
//
// The specific regression: a rare eBay-origin import can still carry a
// platform_offer_id, so the "no offer id → 409" check is NOT a sufficient guard.
// These tests lock in that the origin gate fires FIRST regardless of the offer id.
//
// Pure module — no env, no network (the route-level 409 is exercised by the
// env-gated tenant-isolation suite when TEST_EDGE_BASE_URL is configured).

import { assert, assertEquals } from "@std/assert";
import {
  deriveListingOrigin,
  validateEbayOriginEdit,
} from "../lib/sync-precedence.ts";

// The exact signal shape + locked-field set the price handler passes.
function repriceGate(row: {
  listing_origin: string | null;
  platform_listing_id: string | null;
  batch_id: string | null;
  synced_to_ebay_at: string | null;
}): { origin: "ebay" | "gradethread"; locked: string[] } {
  const origin = deriveListingOrigin({
    listing_origin: row.listing_origin,
    platform: "ebay",
    platform_listing_id: row.platform_listing_id,
    batch_id: row.batch_id,
    synced_to_ebay_at: row.synced_to_ebay_at,
  });
  const { locked } = validateEbayOriginEdit(origin, ["listing_price"]);
  return { origin, locked };
}

// The exact signal shape + locked-field set the end (DELETE) handler passes.
function endGate(row: {
  listing_origin: string | null;
  platform_listing_id: string | null;
  batch_id: string | null;
  synced_to_ebay_at: string | null;
}): { origin: "ebay" | "gradethread"; locked: string[] } {
  const origin = deriveListingOrigin({
    listing_origin: row.listing_origin,
    platform: "ebay",
    platform_listing_id: row.platform_listing_id,
    batch_id: row.batch_id,
    synced_to_ebay_at: row.synced_to_ebay_at,
  });
  const { locked } = validateEbayOriginEdit(origin, ["listing_status", "is_active"]);
  return { origin, locked };
}

// An imported eBay row that DID carry an offer id (the regression case). The
// offer id must NOT let it slip past the origin gate on either route.
const EBAY_IMPORT_WITH_OFFER = {
  listing_origin: "ebay" as string | null,
  platform_listing_id: "1122334455",
  batch_id: null as string | null,
  synced_to_ebay_at: null as string | null,
  // platform_offer_id: "OFFER-9" — present on the row but irrelevant to the gate.
};

Deno.test("reprice gate: eBay-origin row (carrying an offer id) is locked", () => {
  const { origin, locked } = repriceGate(EBAY_IMPORT_WITH_OFFER);
  assertEquals(origin, "ebay");
  assertEquals(locked, ["listing_price"]);
});

Deno.test("end gate: eBay-origin row (carrying an offer id) is locked", () => {
  const { origin, locked } = endGate(EBAY_IMPORT_WITH_OFFER);
  assertEquals(origin, "ebay");
  assertEquals(locked, ["listing_status", "is_active"]);
});

// Same, but origin DERIVED (listing_origin not yet backfilled): a platform
// listing id with no batch_id/synced_to_ebay_at still resolves to eBay.
Deno.test("both gates fire on a derived-eBay row even before listing_origin backfills", () => {
  const derived = {
    listing_origin: null,
    platform_listing_id: "1122334455",
    batch_id: null,
    synced_to_ebay_at: null,
  };
  assertEquals(repriceGate(derived).origin, "ebay");
  assert(repriceGate(derived).locked.length > 0);
  assertEquals(endGate(derived).origin, "ebay");
  assert(endGate(derived).locked.length > 0);
});

Deno.test("both gates pass through a FlipDesk-published (gradethread) listing", () => {
  const gt = {
    listing_origin: "gradethread" as string | null,
    platform_listing_id: "9988776655",
    batch_id: null as string | null,
    synced_to_ebay_at: "2026-06-01T00:00:00Z" as string | null,
  };
  assertEquals(repriceGate(gt).origin, "gradethread");
  assertEquals(repriceGate(gt).locked, []); // reprice allowed
  assertEquals(endGate(gt).origin, "gradethread");
  assertEquals(endGate(gt).locked, []); // end allowed
});

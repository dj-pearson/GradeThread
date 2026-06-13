// US-149: the stub adapters must keep the cross-push contract — they return a
// structured 501 (NOT throw) so the endpoint can create the local listings
// row and report "publish pending" per platform.
//
// Deliberately imports the stubs directly (not the registry): the registry
// pulls in the eBay adapter → flipdesk-ebay.ts → the service-role Supabase
// client, which needs env vars this test shouldn't depend on.

import { assert, assertEquals } from "@std/assert";
import { poshmarkAdapter } from "../lib/marketplace-adapters/poshmark.ts";
import { mercariAdapter } from "../lib/marketplace-adapters/mercari.ts";
import { depopAdapter } from "../lib/marketplace-adapters/depop.ts";
import {
  CROSS_LISTING_PLATFORMS,
  isCrossListingPlatform,
} from "../lib/marketplace-adapters/types.ts";

const STUBS = [poshmarkAdapter, mercariAdapter, depopAdapter];

Deno.test("stub adapters return a structured 501 from publish and end", async () => {
  for (const adapter of STUBS) {
    for (const result of [
      await adapter.publish({
        ownerId: "owner",
        inventoryItemId: "item",
        listingRowId: "row",
        price: 25,
      }),
      await adapter.end({
        ownerId: "owner",
        listingRowId: "row",
        platformOfferId: null,
        platformListingId: null,
      }),
    ]) {
      assertEquals(result.ok, false);
      if (!result.ok) {
        assertEquals(result.status, 501);
        assert(result.error.includes(adapter.platform));
      }
    }
  }
});

Deno.test("cross-listing platform guard accepts the dispatch platforms only", () => {
  for (const p of CROSS_LISTING_PLATFORMS) {
    assert(isCrossListingPlatform(p));
  }
  // US-599: shopify is now a real dispatch platform.
  assert(isCrossListingPlatform("shopify"));
  assert(!isCrossListingPlatform("grailed"));
  assert(!isCrossListingPlatform(""));
});

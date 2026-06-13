// US-708 (supersedes US-149): every stub adapter implements the FULL
// MarketplaceAdapter contract — its connection/listing/sync methods return a
// structured 501 (NOT throw) so the dispatcher can mint the local `listings`
// row and report "publish pending" per platform, while mapDraftToListing is
// real (pure) so the sibling row maps correctly the moment the platform is
// selected.
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

Deno.test("stub adapters return a structured 501 from every wired-only method", async () => {
  for (const adapter of STUBS) {
    const results = [
      await adapter.connect({ ownerId: "owner", state: "s" }),
      await adapter.refreshToken({ ownerId: "owner" }),
      await adapter.publish({
        ownerId: "owner",
        inventoryItemId: "item",
        listingRowId: "row",
        price: 25,
      }),
      await adapter.updateListing({
        ownerId: "owner",
        inventoryItemId: "item",
        listingRowId: "row",
        price: 25,
      }),
      await adapter.delist({
        ownerId: "owner",
        listingRowId: "row",
        platformOfferId: null,
        platformListingId: null,
      }),
      await adapter.syncListings({ ownerId: "owner" }),
      await adapter.syncOrders({ ownerId: "owner" }),
    ];
    for (const result of results) {
      assertEquals(result.ok, false);
      if (!result.ok) {
        assertEquals(result.status, 501);
        assert(result.error.includes(adapter.platform));
      }
    }
  }
});

Deno.test("stub mapDraftToListing is real — maps the shared draft to the sibling row", () => {
  const mapped = poshmarkAdapter.mapDraftToListing({
    source: {
      listing_title: "Vintage Levi's 501 jeans",
      listing_description: "Great condition denim.",
    },
    price: 42,
    variant: null,
  });
  assertEquals(mapped.listing_price, 42);
  assert(mapped.listing_title && mapped.listing_title.length > 0);
});

Deno.test("cross-listing platform guard accepts the dispatch platforms only", () => {
  for (const p of CROSS_LISTING_PLATFORMS) {
    assert(isCrossListingPlatform(p));
  }
  // US-599: shopify is now a real dispatch platform.
  assert(isCrossListingPlatform("shopify"));
  // US-708: the guard is what resolveAdapter uses to reject unknown platforms
  // (returning null → typed NotImplemented) instead of a silent eBay fallthrough.
  assert(!isCrossListingPlatform("grailed"));
  assert(!isCrossListingPlatform(""));
});

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
import {
  CROSS_LISTING_PLATFORMS,
  isCrossListingPlatform,
} from "../lib/marketplace-adapters/types.ts";

// US-713: depop.ts now imports the service-role client (its connect/refresh are
// real), so set dummy env BEFORE the dynamic import (mirrors shopify-orders_test).
// DEPOP_ENABLED is left unset so the connector reports "disabled" here.
Deno.env.set(
  "SUPABASE_URL",
  Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321",
);
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);
const { depopAdapter } = await import("../lib/marketplace-adapters/depop.ts");

// poshmark + mercari are still full stubs: every connection/listing/sync method
// returns the typed 501.
const FULL_STUBS = [poshmarkAdapter, mercariAdapter];

Deno.test("stub adapters return a structured 501 from every wired-only method", async () => {
  for (const adapter of FULL_STUBS) {
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

// US-713: the Depop connection half (connect/refreshToken) is wired but gated —
// with DEPOP_ENABLED off it reports 503 (not a fake connect flow), while the
// US-714 listing methods still return the typed 501.
Deno.test("depop connect/refresh are gated (503) while disabled; listing methods 501", async () => {
  const connect = await depopAdapter.connect({ ownerId: "owner", state: "s" });
  assertEquals(connect.ok, false);
  if (!connect.ok) assertEquals(connect.status, 503);

  const refresh = await depopAdapter.refreshToken({ ownerId: "owner" });
  assertEquals(refresh.ok, false);
  if (!refresh.ok) assertEquals(refresh.status, 503);

  const listingMethods = [
    await depopAdapter.publish({
      ownerId: "owner",
      inventoryItemId: "item",
      listingRowId: "row",
      price: 25,
    }),
    await depopAdapter.delist({
      ownerId: "owner",
      listingRowId: "row",
      platformOfferId: null,
      platformListingId: null,
    }),
    await depopAdapter.syncOrders({ ownerId: "owner" }),
  ];
  for (const result of listingMethods) {
    assertEquals(result.ok, false);
    if (!result.ok) {
      assertEquals(result.status, 501);
      assert(result.error.includes("depop"));
    }
  }
});

// mapDraftToListing stays pure/real even while connect is gated. Depop has no
// title field (titleMaxLength === null), so listing_title is intentionally null
// and the copy is carried on the description.
Deno.test("depop mapDraftToListing maps the shared draft to the sibling row", () => {
  const mapped = depopAdapter.mapDraftToListing({
    source: {
      listing_title: "Vintage Carhartt jacket",
      listing_description: "Worn-in workwear.",
    },
    price: 60,
    variant: null,
  });
  assertEquals(mapped.listing_price, 60);
  assertEquals(mapped.listing_title, null);
  assert(
    mapped.listing_description != null &&
      mapped.listing_description.length > 0,
  );
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

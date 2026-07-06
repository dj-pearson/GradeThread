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
// US-1659: etsy.ts imports the service-role client (its connect/refresh are real),
// so it's dynamic-imported after the dummy env too. ETSY_ENABLED is left unset so
// the connector reports "disabled" here.
const { etsyAdapter } = await import("../lib/marketplace-adapters/etsy.ts");

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

// US-714: the Depop LISTING half (publish/update/delist/syncOrders) is now wired
// too — but EVERYTHING stays gated behind isDepopEnabled(). With DEPOP_ENABLED
// off, every method (connection AND listing) reports 503 (partner access
// pending), so there is no fake flow before the connector is turned on.
Deno.test("depop is fully gated (503) while disabled — connection AND listing methods", async () => {
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
    await depopAdapter.updateListing({
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
    if (!result.ok) assertEquals(result.status, 503);
  }

  // syncListings is a no-op success (orders carry the sale signal), even gated —
  // it performs no Depop access, so it doesn't 503.
  const syncListings = await depopAdapter.syncListings({ ownerId: "owner" });
  assertEquals(syncListings.ok, true);
});

// US-1659/1660: Etsy is a real API marketplace — connect/refresh AND the listing/
// receipt path (publish/update/delist/syncOrders) are all gated at 503 while
// disabled, so there is no fake flow. syncListings is a no-op success (receipts
// carry the sale signal) and performs no Etsy access, so it doesn't 503.
Deno.test("etsy is fully gated (503) while disabled — connection AND listing methods", async () => {
  const connect = await etsyAdapter.connect({ ownerId: "owner", state: "s" });
  assertEquals(connect.ok, false);
  if (!connect.ok) assertEquals(connect.status, 503);

  const refresh = await etsyAdapter.refreshToken({ ownerId: "owner" });
  assertEquals(refresh.ok, false);
  if (!refresh.ok) assertEquals(refresh.status, 503);

  const listingMethods = [
    await etsyAdapter.publish({
      ownerId: "owner",
      inventoryItemId: "item",
      listingRowId: "row",
      price: 25,
    }),
    await etsyAdapter.updateListing({
      ownerId: "owner",
      inventoryItemId: "item",
      listingRowId: "row",
      price: 25,
    }),
    await etsyAdapter.delist({
      ownerId: "owner",
      listingRowId: "row",
      platformOfferId: null,
      platformListingId: null,
    }),
    await etsyAdapter.syncOrders({ ownerId: "owner" }),
  ];
  for (const result of listingMethods) {
    assertEquals(result.ok, false);
    if (!result.ok) assertEquals(result.status, 503);
  }

  const syncListings = await etsyAdapter.syncListings({ ownerId: "owner" });
  assertEquals(syncListings.ok, true);
});

// US-1659: Etsy HAS a title field (titleMaxLength 140), so unlike Depop the
// mapped sibling carries a non-null title. mapDraftToListing stays pure/real
// even while connect is gated.
Deno.test("etsy mapDraftToListing carries a title (140-char field)", () => {
  const mapped = etsyAdapter.mapDraftToListing({
    source: {
      listing_title: "Handmade wool scarf",
      listing_description: "Cozy hand-knit scarf.",
    },
    price: 30,
    variant: null,
  });
  assertEquals(mapped.listing_price, 30);
  assert(mapped.listing_title && mapped.listing_title.length > 0);
  assertEquals(etsyAdapter.platform, "etsy");
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

// US-718 AC4: no code path treats a non-eBay platform as eBay. At the adapter
// level that means each non-eBay adapter reports its OWN platform identity — a
// silent eBay fallthrough would surface here as adapter.platform === "ebay".
Deno.test("non-eBay adapters report their own platform — never eBay", () => {
  assertEquals(poshmarkAdapter.platform, "poshmark");
  assertEquals(mercariAdapter.platform, "mercari");
  assertEquals(depopAdapter.platform, "depop");
  for (const adapter of [poshmarkAdapter, mercariAdapter, depopAdapter]) {
    assert(adapter.platform !== "ebay");
  }
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

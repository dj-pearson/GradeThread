// US-2164 / US-2165 — what actually happens to each sibling's UPSTREAM listing
// when the garment sells somewhere else.
//
// cross-listing-sale_test.ts covers the pure planner (which siblings to pull).
// This covers the dispatch that pulls them, which is where the oversell bug
// lived: Etsy matched no branch, so a live Etsy listing survived the sale of the
// garment it described, and the local row was marked "ended" anyway.
//
// The property under test is a CLASSIFICATION, not a call. "We could not end it"
// must never be reported as "ended" — that is the whole story. The marketplace
// calls are injected, so every arm is asserted without a network or a DB.

import { assert, assertEquals } from "@std/assert";
import {
  attemptUpstreamDelist,
  type DelistDeps,
  type SiblingRow,
} from "../lib/cross-listings.ts";

function row(over: Partial<SiblingRow> = {}): SiblingRow {
  return {
    id: "listing-1",
    platform: "etsy",
    platform_offer_id: null,
    platform_listing_id: "etsy-123",
    listing_status: "active",
    inventory_items: { user_id: "owner-1", sku: "SKU-1" },
    ...over,
  };
}

/** Deps that fail loudly if an arm calls something it shouldn't. */
function deps(over: Partial<DelistDeps> = {}): DelistDeps {
  const nope = (what: string) => () => {
    throw new Error(`unexpected call: ${what}`);
  };
  return {
    withdrawOffer: nope("withdrawOffer") as DelistDeps["withdrawOffer"],
    isOfferAlreadyEndedError: () => false,
    isNoEbayConnectionError: () => false,
    getShopifyConnection: nope(
      "getShopifyConnection",
    ) as unknown as DelistDeps["getShopifyConnection"],
    deleteProductGraphql: nope(
      "deleteProductGraphql",
    ) as DelistDeps["deleteProductGraphql"],
    getDepopConnection: nope(
      "getDepopConnection",
    ) as unknown as DelistDeps["getDepopConnection"],
    deleteDepopProduct: nope("deleteDepopProduct") as DelistDeps["deleteDepopProduct"],
    isEtsyEnabled: () => true,
    getEtsyConnection: nope(
      "getEtsyConnection",
    ) as unknown as DelistDeps["getEtsyConnection"],
    setEtsyListingState: nope(
      "setEtsyListingState",
    ) as DelistDeps["setEtsyListingState"],
    ...over,
  };
}

// ── US-2164 (AC5): Etsy ─────────────────────────────────────────────

Deno.test("US-2164: an Etsy sibling is inactivated upstream on a sibling sale", () => {
  const calls: Array<[string, string, string, string]> = [];
  return attemptUpstreamDelist(
    "owner-1",
    row(),
    deps({
      getEtsyConnection: () =>
        Promise.resolve({ token: "tok", shopId: "shop-9" }),
      setEtsyListingState: (token, shopId, listingId, state) => {
        calls.push([token, shopId, listingId, state]);
        return Promise.resolve();
      },
    }),
  ).then((outcome) => {
    assertEquals(outcome.kind, "ended");
    // The listing must be set INACTIVE — the delist verb Etsy actually has.
    assertEquals(calls, [["tok", "shop-9", "etsy-123", "inactive"]]);
  });
});

Deno.test("US-2164: a DISABLED Etsy connector is unresolved, never a clean end", () => {
  // The heart of AC5. A disabled connector must not degrade to a silent
  // success — the Etsy listing is still live and buyable, so the row has to
  // carry the US-2165 marker and the seller has to be told.
  return attemptUpstreamDelist(
    "owner-1",
    row(),
    // isEtsyEnabled false, and every marketplace call is a throw-if-called, so
    // this also proves we never attempt the call behind a disabled flag.
    deps({ isEtsyEnabled: () => false }),
  ).then((outcome) => {
    assertEquals(outcome.kind, "unresolved");
    assert(
      outcome.kind === "unresolved" && /etsy/i.test(outcome.reason),
      "the reason must name the marketplace",
    );
  });
});

Deno.test("US-2164: a DISCONNECTED Etsy account is unresolved", () => {
  return attemptUpstreamDelist(
    "owner-1",
    row(),
    deps({ getEtsyConnection: () => Promise.resolve(null) }),
  ).then((outcome) => assertEquals(outcome.kind, "unresolved"));
});

Deno.test("US-2164: an Etsy connection with no shop id is unresolved", () => {
  return attemptUpstreamDelist(
    "owner-1",
    row(),
    deps({
      getEtsyConnection: () => Promise.resolve({ token: "tok", shopId: null }),
    }),
  ).then((outcome) => assertEquals(outcome.kind, "unresolved"));
});

Deno.test("US-2164: an Etsy rejection is unresolved and carries the reason", () => {
  return attemptUpstreamDelist(
    "owner-1",
    row(),
    deps({
      getEtsyConnection: () => Promise.resolve({ token: "t", shopId: "s" }),
      setEtsyListingState: () => Promise.reject(new Error("etsy 500")),
    }),
  ).then((outcome) => {
    assertEquals(outcome.kind, "unresolved");
    assert(outcome.kind === "unresolved" && outcome.reason.includes("etsy 500"));
  });
});

Deno.test("US-2164: an Etsy row that was never published is nothing_live", () => {
  // Not a failure: a draft sibling has nothing live to pull, so it must NOT
  // raise the badge. That distinction is what keeps the marker meaningful.
  return attemptUpstreamDelist(
    "owner-1",
    row({ platform_listing_id: null }),
    deps({ isEtsyEnabled: () => false }), // would be unresolved if it got that far
  ).then((outcome) => assertEquals(outcome.kind, "nothing_live"));
});

// ── US-2165: every other arm classifies honestly ────────────────────

Deno.test("US-2165: whatnot is unresolved, and the reason names it", () => {
  // whatnot has no delist channel (its listing path is 501 pending US-1662), so
  // it must earn the marker rather than a silent local end.
  return attemptUpstreamDelist(
    "owner-1",
    row({ platform: "whatnot" }),
    deps(),
  ).then((outcome) => {
    assertEquals(outcome.kind, "unresolved");
    assert(outcome.kind === "unresolved" && outcome.reason.includes("whatnot"));
  });
});

Deno.test("US-2165: an extension marketplace is queued, not ended", () => {
  for (const platform of ["poshmark", "mercari", "grailed"]) {
    attemptUpstreamDelist("owner-1", row({ platform }), deps()).then((o) =>
      assertEquals(o.kind, "queued", platform)
    );
  }
});

Deno.test("US-2165: an eBay withdraw failure is unresolved, not a silent end", () => {
  // The wider fix: before US-2165 this console.warn-ed and marked the row ended.
  return attemptUpstreamDelist(
    "owner-1",
    row({ platform: "ebay", platform_offer_id: "offer-1" }),
    deps({
      withdrawOffer: () => Promise.reject(new Error("ebay 503")),
    }),
  ).then((outcome) => {
    assertEquals(outcome.kind, "unresolved");
    assert(outcome.kind === "unresolved" && outcome.reason.includes("ebay 503"));
  });
});

Deno.test("US-2165: an ALREADY-ended eBay offer is ended, not a false alarm", () => {
  // A withdraw legitimately fails when the offer is already gone. Flagging those
  // would put a "may still be live" banner on ordinary stale rows, which is how
  // a warning becomes noise people stop reading.
  return attemptUpstreamDelist(
    "owner-1",
    row({ platform: "ebay", platform_offer_id: "offer-1" }),
    deps({
      withdrawOffer: () => Promise.reject(new Error("already ended")),
      isOfferAlreadyEndedError: () => true,
    }),
  ).then((outcome) => assertEquals(outcome.kind, "ended"));
});

Deno.test("US-2165: a disconnected eBay account is unresolved and says so", () => {
  return attemptUpstreamDelist(
    "owner-1",
    row({ platform: "ebay", platform_offer_id: "offer-1" }),
    deps({
      withdrawOffer: () => Promise.reject(new Error("no connection")),
      isNoEbayConnectionError: () => true,
    }),
  ).then((outcome) => {
    assertEquals(outcome.kind, "unresolved");
    assert(outcome.kind === "unresolved" && /connected/i.test(outcome.reason));
  });
});

Deno.test("US-2165: a Shopify delete failure is unresolved", () => {
  return attemptUpstreamDelist(
    "owner-1",
    row({ platform: "shopify", platform_listing_id: "gid://p/1" }),
    deps({
      getShopifyConnection: () => Promise.resolve({ shop: "s", token: "t" }),
      deleteProductGraphql: () => Promise.reject(new Error("shopify 422")),
    }),
  ).then((outcome) => {
    assertEquals(outcome.kind, "unresolved");
    assert(outcome.kind === "unresolved" && outcome.reason.includes("shopify 422"));
  });
});

Deno.test("US-2165: a Depop row with no SKU is nothing_live, not unresolved", () => {
  // Depop is SKU-addressed, so no SKU means nothing was ever live there.
  return attemptUpstreamDelist(
    "owner-1",
    row({
      platform: "depop",
      inventory_items: { user_id: "owner-1", sku: null },
    }),
    deps(),
  ).then((outcome) => assertEquals(outcome.kind, "nothing_live"));
});

Deno.test("US-2165: a successful Shopify and Depop delete is ended", () => {
  const shopify = attemptUpstreamDelist(
    "owner-1",
    row({ platform: "shopify", platform_listing_id: "gid://p/1" }),
    deps({
      getShopifyConnection: () => Promise.resolve({ shop: "s", token: "t" }),
      deleteProductGraphql: () => Promise.resolve(),
    }),
  ).then((o) => assertEquals(o.kind, "ended"));
  const depop = attemptUpstreamDelist(
    "owner-1",
    row({ platform: "depop" }),
    deps({
      getDepopConnection: () => Promise.resolve({ token: "t" }),
      deleteDepopProduct: () => Promise.resolve(),
    }),
  ).then((o) => assertEquals(o.kind, "ended"));
  return Promise.all([shopify, depop]);
});

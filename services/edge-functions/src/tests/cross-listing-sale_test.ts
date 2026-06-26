// US-1290: cross-channel quantity sync — delist on sale across marketplaces.
// The DB-touching execution (autoEndCrossListings + the oversell surfacing) is
// covered by the tenant-isolation suite; here we lock the PURE planner that
// decides which siblings to delist and which reveal a simultaneous-sale oversell.

import { assert, assertEquals } from "@std/assert";
import {
  delistMethodFor,
  planCrossListingSale,
} from "../lib/cross-listing-sale.ts";

interface Sib {
  id: string;
  platform: string;
  listing_status: string;
}

Deno.test("a sale on eBay delists the Shopify mirror (AC4)", () => {
  // eBay listing "e1" just sold; the Shopify sibling "s1" is still live.
  const siblings: Sib[] = [
    { id: "e1", platform: "ebay", listing_status: "sold" },
    { id: "s1", platform: "shopify", listing_status: "active" },
  ];
  const { toDelist, oversold } = planCrossListingSale("e1", siblings);

  assertEquals(toDelist.map((s) => s.id), ["s1"]);
  assertEquals(toDelist[0]!.platform, "shopify");
  assertEquals(delistMethodFor(toDelist[0]!.platform), "shopify_api");
  // The Shopify mirror is still live, not a double sale.
  assertEquals(oversold, []);
});

Deno.test("delists live siblings across all three API marketplaces", () => {
  const siblings: Sib[] = [
    { id: "sold", platform: "ebay", listing_status: "sold" },
    { id: "shop", platform: "shopify", listing_status: "active" },
    { id: "dep", platform: "depop", listing_status: "active" },
    { id: "draft", platform: "ebay", listing_status: "draft" },
  ];
  const { toDelist, oversold } = planCrossListingSale("sold", siblings);
  assertEquals(new Set(toDelist.map((s) => s.id)), new Set(["shop", "dep", "draft"]));
  assertEquals(oversold, []);
});

Deno.test("a sibling already sold on another channel is an oversell, never delisted (AC3)", () => {
  // Both the eBay listing AND the Shopify sibling are 'sold' — the same physical
  // garment sold twice. The Shopify row must surface as oversold, NOT be ended.
  const siblings: Sib[] = [
    { id: "s1", platform: "shopify", listing_status: "sold" },
    { id: "p1", platform: "poshmark", listing_status: "active" },
  ];
  const { toDelist, oversold } = planCrossListingSale("e1", siblings);
  assertEquals(oversold.map((s) => s.id), ["s1"]);
  // The still-live Poshmark sibling is delisted; the sold Shopify one is not.
  assertEquals(toDelist.map((s) => s.id), ["p1"]);
  assert(!toDelist.some((s) => s.id === "s1"));
});

Deno.test("the just-sold listing and already-ended siblings are ignored", () => {
  const siblings: Sib[] = [
    { id: "self", platform: "ebay", listing_status: "sold" },
    { id: "ended", platform: "shopify", listing_status: "ended" },
    { id: "live", platform: "depop", listing_status: "active" },
  ];
  // "self" is the triggering listing — excluded by id even though it's 'sold'.
  const { toDelist, oversold } = planCrossListingSale("self", siblings);
  assertEquals(toDelist.map((s) => s.id), ["live"]);
  assertEquals(oversold, []);
});

Deno.test("delistMethodFor maps each platform to its delist channel", () => {
  assertEquals(delistMethodFor("ebay"), "ebay_api");
  assertEquals(delistMethodFor("shopify"), "shopify_api");
  assertEquals(delistMethodFor("depop"), "depop_api");
  // Extension-only marketplaces (no server write API).
  assertEquals(delistMethodFor("poshmark"), "extension");
  assertEquals(delistMethodFor("mercari"), "extension");
  assertEquals(delistMethodFor("grailed"), "extension");
  // Unknown platform — local row ended, no upstream call.
  assertEquals(delistMethodFor("etsy"), "unsupported");
});

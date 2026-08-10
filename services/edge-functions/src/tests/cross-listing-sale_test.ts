// US-1290: cross-channel quantity sync — delist on sale across marketplaces.
// The DB-touching execution (autoEndCrossListings + the oversell surfacing) is
// covered by the tenant-isolation suite; here we lock the PURE planner that
// decides which siblings to delist and which reveal a simultaneous-sale oversell.

import { assert, assertEquals } from "@std/assert";
import {
  delistMethodFor,
  planCrossListingSale,
} from "../lib/cross-listing-sale.ts";
import { CROSS_LISTING_PLATFORMS } from "../lib/marketplace-adapters/types.ts";

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
  // US-2164: Etsy has a real delist API (setEtsyListingState → 'inactive'). It
  // used to resolve to 'unsupported', which meant a sibling sale marked the
  // local row ended while the Etsy listing stayed live and purchasable.
  assertEquals(delistMethodFor("etsy"), "etsy_api");
  // Extension-only marketplaces (no server write API).
  assertEquals(delistMethodFor("poshmark"), "extension");
  assertEquals(delistMethodFor("mercari"), "extension");
  assertEquals(delistMethodFor("grailed"), "extension");
  // US-2479 / US-2480. Neither was in the set, so both resolved to
  // 'unsupported' — and Vinted was already advertised to sellers as an
  // extension channel while Facebook was about to be. An advertised channel
  // whose siblings are never delisted is the oversell this module exists to
  // prevent, arriving through the one door nobody had closed.
  assertEquals(delistMethodFor("vinted"), "extension");
  assertEquals(delistMethodFor("facebook"), "extension");
});

Deno.test("every cross-listing platform has a delist channel, or is a known gap", () => {
  // US-2165: the regression guard behind the marker. Etsy was silently
  // unsupported for as long as it took someone to read the auto-end loop line by
  // line; this fails the moment a platform joins CROSS_LISTING_PLATFORMS without
  // a delist channel, and forces the addition to be a deliberate choice.
  //
  // whatnot is the one accepted gap: its listing path is still 501 pending
  // US-1662, so there is genuinely nothing to call. It resolves to 'unsupported'
  // and therefore takes the marker + notify path rather than a silent local end.
  const KNOWN_UNSUPPORTED = new Set(["whatnot"]);

  for (const platform of CROSS_LISTING_PLATFORMS) {
    const method = delistMethodFor(platform);
    if (KNOWN_UNSUPPORTED.has(platform)) {
      assertEquals(
        method,
        "unsupported",
        `${platform} is listed as a known gap but now resolves to ${method} — ` +
          "remove it from KNOWN_UNSUPPORTED",
      );
      continue;
    }
    assert(
      method !== "unsupported",
      `${platform} has no delist channel: a sibling sale would leave its ` +
        "listing live. Wire one, or add it to KNOWN_UNSUPPORTED with a reason.",
    );
  }
});

Deno.test("an unsupported platform is still planned for delist, not skipped", () => {
  // The planner must hand whatnot to the executor even though no API can end it
  // — that is what gets the US-2165 marker stamped and the seller notified. A
  // planner that filtered unsupported platforms out would restore the silent
  // oversell from the other direction.
  const siblings: Sib[] = [
    { id: "e1", platform: "ebay", listing_status: "sold" },
    { id: "w1", platform: "whatnot", listing_status: "active" },
  ];
  const { toDelist, oversold } = planCrossListingSale("e1", siblings);

  assertEquals(toDelist.map((s) => s.id), ["w1"]);
  assertEquals(delistMethodFor(toDelist[0]!.platform), "unsupported");
  assertEquals(oversold, []);
});

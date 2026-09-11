// US-3096: the content a `list` job carries, and the one way it can drift.
//
// A cross-post queued from a phone used to reach the desktop with `payload: {}`
// and open a blank marketplace form while reporting success. The server fills
// the row at claim time now, and `buildListPayload` is the pure half of that.
//
// The load-bearing test here is the FIRST one. `GT.runFlow` in
// extension-unified/lister/common.js reads one payload shape, and there are two
// places that build it: `buildListerPayload` in the browser
// (src/lib/lister-extension.ts) and this function on the server. A key that
// exists in one and not the other is a field the extension silently leaves
// blank on exactly one of the two paths — which is the failure that shipped.
// So the key sets are compared against the web source itself rather than
// against a list retyped here, because a retyped list drifts with the code and
// nobody notices.

import { assert, assertEquals } from "@std/assert";
import {
  buildListPayload,
  LIST_REFUSAL_REASON,
  mergeHydratedPayload,
  orderedListPhotos,
  revisePriceFor,
  type BuildListPayloadInput,
} from "../lib/extension-queue.ts";

const ITEM = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "Patagonia Better Sweater",
  brand: "Patagonia",
  color: "Navy",
  size: "M",
};

function input(over: Partial<BuildListPayloadInput> = {}): BuildListPayloadInput {
  return {
    platform: "poshmark",
    itemId: ITEM.id,
    item: ITEM,
    photos: [
      { id: "p1", photo_url: "https://ex.test/1.jpg", sort_order: 0 },
      { id: "p2", photo_url: "https://ex.test/2.jpg", sort_order: 1 },
      { id: "p3", photo_url: "https://ex.test/3.jpg", sort_order: 2 },
    ],
    platformFields: null,
    draft: null,
    // US-2736: no sibling row by default; the cases that care set it.
    channelPrice: null,
    maxPhotos: 16,
    // US-2739: the fixture platform is Poshmark, which prices in whole dollars.
    priceStep: 1,
    platformLabel: "Poshmark",
    ...over,
  };
}

Deno.test("the server payload has exactly the web payload's keys", async () => {
  // Read the browser builder's return object out of the source. Parsing the
  // file is deliberate: an import is impossible across the two module graphs,
  // and a hand-copied list is the thing that goes stale.
  const web = await Deno.readTextFile(
    new URL("../../../../src/lib/lister-extension.ts", import.meta.url),
  );
  const start = web.indexOf("export function buildListerPayload");
  assert(start > -1, "buildListerPayload has been renamed — this guard is now blind");
  // From its `return {` to the matching `\n  };`. NOT to the first `\n}`: the
  // function's own options parameter is an inline type literal, so that lands
  // on `}): ListerPayload {` and yields an empty body and a green test.
  const returnStart = web.indexOf("return {", start);
  assert(returnStart > -1, "buildListerPayload no longer returns an object literal");
  const returnEnd = web.indexOf("\n  };", returnStart);
  assert(returnEnd > returnStart, "could not find the end of the returned literal");

  const webKeys = new Set<string>();
  for (const line of web.slice(returnStart, returnEnd).split("\n")) {
    // `[,:]` because a key can be shorthand: `maxPhotos` is a local const on
    // the web side and appears as `maxPhotos,` with no colon at all.
    const m = line.match(/^\s{4}([a-zA-Z]+)[,:]/);
    if (m?.[1]) webKeys.add(m[1]);
  }
  // `locale` is spread conditionally on the web (`...(opts.locale ? … : {})`)
  // and stamped by the enqueue route on the server (US-2777), so it is not a
  // key either builder always emits.
  webKeys.delete("locale");
  assert(webKeys.size > 10, `only found ${webKeys.size} keys — the parse broke`);

  const serverKeys = new Set(Object.keys(buildListPayload(input())));
  assertEquals(
    [...serverKeys].sort(),
    [...webKeys].sort(),
    "the two payload builders have drifted — the extension reads ONE shape",
  );
});

Deno.test("kit variant values win, and the condition label is unwrapped", () => {
  const out = buildListPayload(input({
    platformFields: {
      title: "Patagonia Better Sweater, women's M, navy",
      description: "Worn twice. No pilling.",
      condition: { value: "EUC", label: "EUC (Excellent Used Condition)" },
      category: "Women > Sweaters",
      brand: "Patagonia",
      color: "Navy",
      size: "M",
      price: 68,
      tags: ["patagonia", "fleece"],
    },
    draft: {
      listing_title: "the eBay title nobody wants on Poshmark",
      listing_description: "eBay body",
      listing_price: 75,
      primary_photo_id: null,
    },
  }));

  assertEquals(out.title, "Patagonia Better Sweater, women's M, navy");
  assertEquals(out.description, "Worn twice. No pilling.");
  assertEquals(out.price, "68", "the kit's price beats the eBay draft's");
  assertEquals(out.condition, "EUC (Excellent Used Condition)");
  assertEquals(out.tags, ["patagonia", "fleece"]);
  assertEquals(out.platformLabel, "Poshmark");
});

Deno.test("with no kit variant it falls back to the draft, then the item", () => {
  // The seller who skipped the Listing Kit still gets their own words. Before
  // this, they got a blank form.
  const out = buildListPayload(input({
    draft: {
      listing_title: "Patagonia Better Sweater fleece",
      listing_description: "Great shape.",
      listing_price: 75,
      primary_photo_id: null,
    },
  }));
  assertEquals(out.title, "Patagonia Better Sweater fleece");
  assertEquals(out.description, "Great shape.");
  assertEquals(out.price, "75");
  assertEquals(out.brand, "Patagonia", "item facts fill what the draft has no column for");
  assertEquals(out.size, "M");

  // No draft at all: the item's own title is the last honest source.
  const bare = buildListPayload(input());
  assertEquals(bare.title, "Patagonia Better Sweater");
  assertEquals(bare.description, "");
  assertEquals(bare.price, "", "a price nobody set is blank, never a guess");
});

Deno.test("originalPrice is never inferred", () => {
  // Poshmark's "original price" is a claim about retail. Deriving it from a
  // purchase price would put a number the seller never typed on a live listing.
  const out = buildListPayload(input({
    platformFields: { title: "x", price: 68 },
  }));
  assertEquals(out.originalPrice, "");
});

Deno.test("photos are cover-first, then sort_order, capped at the platform's max", () => {
  const photos = [
    { id: "p1", photo_url: "a", sort_order: 0 },
    { id: "p2", photo_url: "b", sort_order: 1 },
    { id: "p3", photo_url: "c", sort_order: 2 },
  ];
  assertEquals(
    orderedListPhotos(photos, "p3", 10).map((p) => p.photo_url),
    ["c", "a", "b"],
    "the seller's chosen cover leads",
  );
  assertEquals(
    orderedListPhotos(photos, null, 2).map((p) => p.photo_url),
    ["a", "b"],
    "the cap trims the tail, not the middle",
  );
  assertEquals(orderedListPhotos(photos, "nope", 10).length, 3, "an unknown cover id is ignored");

  const out = buildListPayload(input({
    maxPhotos: 2,
    draft: {
      listing_title: null,
      listing_description: null,
      listing_price: null,
      primary_photo_id: "p3",
    },
  }));
  assertEquals(out.photoUrls, ["https://ex.test/3.jpg", "https://ex.test/1.jpg"]);
  assertEquals(out.maxPhotos, 2);
});

Deno.test("a client-supplied key survives hydration", () => {
  // US-2777's locale is the one the phone legitimately carries today, and the
  // per-platform price from the push-to picker is the next one. A merge that
  // let the server win would make the field unusable for anything, forever.
  const merged = mergeHydratedPayload(
    { locale: "vinted.fr", price: "55" },
    { locale: "vinted.com", price: "68", title: "hydrated" },
  );
  assertEquals(merged.locale, "vinted.fr");
  assertEquals(merged.price, "55");
  assertEquals(merged.title, "hydrated", "keys the client did not send still land");
});

Deno.test("both refusals name the fix, not just the fault", () => {
  for (const reason of Object.values(LIST_REFUSAL_REASON)) {
    assert(reason.length > 40, "a one-word refusal is the sentence people uninstall over");
    assert(
      !/error|failed|invalid/i.test(reason),
      "these are facts about the seller's inventory, not error codes",
    );
  }
  assert(/queue it again/i.test(LIST_REFUSAL_REASON.no_photos));
});

// ─── The MeasureCard stays home (owner decision, 2026-09-07) ───────

Deno.test("the MeasureCard frame and its generated render never reach a marketplace", () => {
  const photos = [
    { id: "p1", photo_url: "front", sort_order: 0, photo_type: "front", photo_role: null },
    // The calibration frame: the garment flat with the branded card beside it.
    { id: "p2", photo_url: "card", sort_order: 1, photo_type: "measurement", photo_role: null },
    // The generated annotated render — lines and inch labels burned in.
    {
      id: "p3",
      photo_url: "overlay",
      sort_order: 2,
      photo_type: "measurement_overlay",
      photo_role: null,
    },
    { id: "p4", photo_url: "back", sort_order: 3, photo_type: "back", photo_role: null },
  ];
  assertEquals(
    orderedListPhotos(photos, null, 12).map((p) => p.photo_url),
    ["front", "back"],
  );
});

Deno.test("a tape close-up the seller published deliberately still goes", () => {
  // US-2462: 'measurement' WITH a role is a tape shot, not the card.
  const photos = [
    { id: "p1", photo_url: "front", sort_order: 0, photo_type: "front", photo_role: null },
    {
      id: "p2",
      photo_url: "chest",
      sort_order: 1,
      photo_type: "measurement",
      photo_role: "measurement_chest",
    },
  ];
  assertEquals(
    orderedListPhotos(photos, null, 12).map((p) => p.photo_url),
    ["front", "chest"],
  );
});

Deno.test("an excluded photo does not spend one of the platform's slots", () => {
  // Dropped BEFORE the cap. Counting the card against a 2-photo limit would
  // cost the seller a real listing image.
  const photos = [
    { id: "p1", photo_url: "card", sort_order: 0, photo_type: "measurement", photo_role: null },
    { id: "p2", photo_url: "front", sort_order: 1, photo_type: "front", photo_role: null },
    { id: "p3", photo_url: "back", sort_order: 2, photo_type: "back", photo_role: null },
  ];
  assertEquals(
    orderedListPhotos(photos, null, 2).map((p) => p.photo_url),
    ["front", "back"],
  );
});

Deno.test("a photo with no type at all still lists", () => {
  // Rows that predate the type column, and every caller that does not select
  // it. Dropping these would empty the payload and refuse the cross-post.
  const photos = [{ id: "p1", photo_url: "a", sort_order: 0 }];
  assertEquals(orderedListPhotos(photos, null, 12).length, 1);
});

Deno.test("a freshly rendered description wins over the stored variant", () => {
  const out = buildListPayload(input({
    platformFields: { title: "x", description: "yesterday's words" },
    renderedDescription: "today's words, with today's measurements",
  }));
  assertEquals(out.description, "today's words, with today's measurements");

  // And when the render could not be done, the stored words still go out — a
  // cross-post with old wording beats no cross-post.
  const fallback = buildListPayload(input({
    platformFields: { title: "x", description: "yesterday's words" },
    renderedDescription: null,
  }));
  assertEquals(fallback.description, "yesterday's words");
});

// ── US-2739: the units the marketplace's own price input accepts ───────────
//
// MEASURED FAILURE, not a theory. Before this, `buildListPayload` wrote
// `String(priceNumber)` and nothing on the server knew Poshmark prices in whole
// dollars — the stepping lived in the browser's Listing Kit and only there. So
// a cross-post queued from the phone reached the desktop carrying "32.49" and
// the extension typed it into an input that is inputmode="numeric"
// pattern="[0-9]*", which cannot hold a decimal point. The desk path sent "32"
// for the same item. Two builders of one payload shape, one of them right.
Deno.test("a queued Poshmark price is sent in whole dollars", () => {
  const out = buildListPayload(input({
    platform: "poshmark",
    priceStep: 1,
    platformFields: { title: "x", price: 32.49 },
  }));
  assertEquals(out.price, "32", "Poshmark's price input cannot hold a decimal point");

  // NEAREST, not floored. Flooring takes 51c off the seller on every cross-post.
  assertEquals(
    buildListPayload(input({
      platform: "poshmark",
      priceStep: 1,
      platformFields: { title: "x", price: 32.51 },
    })).price,
    "33",
  );

  // The eBay draft fallback goes through the same boundary — it was the other
  // way a cents price reached a whole-dollar marketplace.
  assertEquals(
    buildListPayload(input({
      platform: "poshmark",
      priceStep: 1,
      platformFields: null,
      draft: {
        listing_title: "t",
        listing_description: "d",
        listing_price: 74.5,
        primary_photo_id: null,
      },
    })).price,
    "75",
    "a repriced draft is stepped too, not just a kit variant",
  );

  // Never below one step, and never invented.
  assertEquals(
    buildListPayload(input({
      platform: "poshmark",
      priceStep: 1,
      platformFields: { title: "x", price: 0.4 },
    })).price,
    "1",
    "a 40c item becomes $1, never $0",
  );
  assertEquals(
    buildListPayload(input({ platform: "poshmark", priceStep: 1 })).price,
    "",
    "no price is still no price",
  );
});

Deno.test("a marketplace with no step keeps its cents", () => {
  // eBay and Mercari price in cents and must not be rounded. Exact cents, not
  // a two-decimal figure that happens to look right.
  assertEquals(
    buildListPayload(input({
      platform: "ebay",
      priceStep: 0,
      platformLabel: "eBay",
      platformFields: { title: "x", price: 32.49 },
    })).price,
    "32.49",
  );
  // And the string is built from cents rather than String(number), so a float
  // tail can never reach a price field: String(0.1 + 0.2) is
  // "0.30000000000000004".
  assertEquals(
    buildListPayload(input({
      platform: "ebay",
      priceStep: 0,
      platformLabel: "eBay",
      platformFields: { title: "x", price: 0.1 + 0.2 },
    })).price,
    "0.30",
  );
});

// ── US-2739: the revise half of the same boundary ──────────────────────────
//
// A `list` job crosses the units boundary in buildListPayload. A `revise`
// carries the price as a NUMBER off listings.listing_price and GT.runReviseFlow
// types String(payload.price) into the marketplace's editor. Repricing
// automation writes 32.49 to that column, so the unstepped version handed
// Poshmark's pattern="[0-9]*" field a decimal point.
Deno.test("a queued revise sends the price in the marketplace's units", () => {
  assertEquals(revisePriceFor("poshmark", 32.49), 32);
  assertEquals(revisePriceFor("poshmark", 32.51), 33, "nearest, not floored");
  assertEquals(revisePriceFor("vinted", 32.49), 32, "Vinted prices in whole units too");
  assertEquals(revisePriceFor("poshmark", 0.4), 1, "never below one step");

  // Everyone else keeps their cents, exactly.
  assertEquals(revisePriceFor("ebay", 32.49), 32.49);
  assertEquals(revisePriceFor("mercari", 32.49), 32.49);
  assertEquals(revisePriceFor("nonsense-platform", 32.49), 32.49);

  // No price is null, never a zero the editor would accept.
  assertEquals(revisePriceFor("poshmark", null), null);
  assertEquals(revisePriceFor("poshmark", undefined), null);
  assertEquals(revisePriceFor("poshmark", Number.NaN), null);
  assertEquals(revisePriceFor("poshmark", 0), 0, "a zero is a zero, not a step");
});

// ── US-2736: the channel's own price reaches the channel's own form ───────
//
// The queue read the eBay draft row and nothing else, so `price` came from the
// kit variant (a snapshot of the SHARED price when the kit last ran) or from
// eBay's own listing_price. A seller who priced Poshmark at $40 while eBay sat
// at $52 had their Poshmark sibling row recording 4000 cents and the extension
// typing 5200 into the form — the listing, the row and the payout disagreed
// three ways, and nothing anywhere said so.
Deno.test("US-2736: the sibling row's own price wins over the kit's and eBay's", () => {
  const withChannel = buildListPayload(input({
    platform: "poshmark",
    priceStep: 1,
    channelPrice: 40,
    platformFields: { title: "x", price: 52 },
    draft: {
      listing_title: "x",
      listing_description: "d",
      listing_price: 52,
      primary_photo_id: null,
    },
  }));
  assertEquals(withChannel.price, "40");

  // The same call with no sibling row is the OLD behaviour, kept for every
  // channel that has not been pushed yet: the kit variant's price.
  const noChannel = buildListPayload(input({
    platform: "poshmark",
    priceStep: 1,
    channelPrice: null,
    platformFields: { title: "x", price: 52 },
  }));
  assertEquals(noChannel.price, "52");
});

Deno.test("US-2736: the channel price still crosses the unit boundary", () => {
  // 4049 cents on the sibling row, and Poshmark can hold 4000.
  assertEquals(
    buildListPayload(input({ platform: "poshmark", priceStep: 1, channelPrice: 40.49 })).price,
    "40",
  );
  // Mercari keeps its cents.
  assertEquals(
    buildListPayload(input({ platform: "mercari", priceStep: 0, channelPrice: 40.49 })).price,
    "40.49",
  );
});

Deno.test("US-2736: a stale 0 on a sibling row does not shadow a real price", () => {
  const out = buildListPayload(input({
    platform: "poshmark",
    priceStep: 1,
    channelPrice: 0,
    platformFields: { title: "x", price: 52 },
  }));
  assertEquals(out.price, "52", "first POSITIVE, not first non-null");
});

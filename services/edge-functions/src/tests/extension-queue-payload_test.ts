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
    maxPhotos: 16,
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

// US-2780: more than one angle of the same garment.
//
// THE CASE THIS EXISTS FOR, from vault/30-platform/ebay-visual-search.md: a
// teal sleeveless tank, flatlay, no brand mark anywhere in the photo, returned
// five Lululemon tanks. It may be right. eBay expressed no doubt and the photo
// cannot settle it.
//
// A second angle can. What this must NOT do is turn that into a filter — the
// model can see the photos and this module cannot, so a weakly-supported
// candidate is offered WITH its number, never suppressed.

import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import {
  MAX_VISUAL_PHOTOS,
  pickVisualImageIndices,
} from "../lib/prospect-identify.ts";
import { buildCandidateBlock } from "../lib/visual-candidates.ts";
import {
  mergeSearches,
  runVisualPass,
} from "../lib/visual-identify-pass.ts";
import { MAX_ASPECT_READS } from "../lib/visual-aspect-consensus.ts";
import type { BrowseComp, BrowseCompsResult } from "../lib/ebay-client.ts";

// ── Which photos get searched ────────────────────────────────────────────────

Deno.test("garment shots are preferred, one per role, capped", () => {
  const idx = pickVisualImageIndices([
    "detail",
    "front",
    "tag",
    "back",
    "flatlay",
    "measurement",
  ]);
  // front, back, flatlay - the three the spike measured best on. `tag` is
  // eligible but loses to a garment shot, because a hem tag carrying only a
  // logo returned Athleta leggings for a Faherty polo.
  assertEquals(idx, [1, 3, 4]);
  assert(idx.length <= MAX_VISUAL_PHOTOS);
});

Deno.test("a second shot in the same role is not a second opinion", () => {
  // Two front shots of one garment are one angle photographed twice. They
  // would agree with each other and the agreement would mean nothing.
  assertEquals(pickVisualImageIndices(["front", "front", "front"]), [0]);
});

Deno.test("tag fills in only when there are not enough garment shots", () => {
  assertEquals(pickVisualImageIndices(["front", "tag", "label"]), [0, 1, 2]);
});

Deno.test("unknown roles are never searched, however many there are", () => {
  // Unknown means NO, per roleCanIdentify. A photo nobody labelled is likelier
  // to be a detail shot, and the cost of guessing wrong is a confident wrong
  // answer rather than a miss.
  assertEquals(pickVisualImageIndices([undefined, "", "mystery", null]), []);
  assertEquals(pickVisualImageIndices(["detail", "measurement", "defect"]), []);
});

Deno.test("one usable photo behaves exactly as it did before", () => {
  assertEquals(pickVisualImageIndices(["front", "detail", "defect"]), [0]);
});

Deno.test("no photos at all is no search, not a search on index 0", () => {
  assertEquals(pickVisualImageIndices([]), []);
});

// ── How the agreement is reported ────────────────────────────────────────────

Deno.test("the block states how many photos backed the value", () => {
  const text = buildCandidateBlock([
    {
      field: "brand",
      value: "Lululemon",
      support: 5,
      outOf: 5,
      photosAgreeing: 1,
      photosSearched: 3,
    },
  ]);
  assertEquals(text.includes("declared by 5 of 5 similar listings"), true);
  // The teal-tank number. Five listings agreeing off ONE angle is a different
  // claim from five agreeing off three, and the block has to say which.
  assertEquals(text.includes("on 1 of 3 photos searched"), true);
});

Deno.test("a one-photo candidate is still offered", () => {
  // Suppressing it would be this module deciding on the model's behalf, which
  // is what the whole adjudication block exists to avoid.
  const text = buildCandidateBlock([
    {
      field: "brand",
      value: "Lululemon",
      support: 5,
      outOf: 5,
      photosAgreeing: 1,
      photosSearched: 3,
    },
  ]);
  assert(text.includes("Lululemon"));
});

Deno.test("without photo counts the block reads exactly as it did", () => {
  // US-2778 candidates carry no photo counts. Their block must not grow an
  // empty clause, or every existing prompt changes for no reason.
  const text = buildCandidateBlock([
    { field: "brand", value: "Lululemon", support: 5, outOf: 5 },
  ]);
  assertEquals(text.includes("photos searched"), false);
  assert(text.includes("declared by 5 of 5 similar listings"));
});

Deno.test("a single searched photo adds no clause either", () => {
  // "on 1 of 1 photos searched" is noise: it is the only thing it could say.
  const text = buildCandidateBlock([
    {
      field: "brand",
      value: "Lululemon",
      support: 5,
      outOf: 5,
      photosAgreeing: 1,
      photosSearched: 1,
    },
  ]);
  assertEquals(text.includes("photos searched"), false);
});

// ── Merging what several angles found ────────────────────────────────────────

function comp(itemId: string, leaf = "155226"): BrowseComp {
  return {
    itemId,
    title: `listing ${itemId}`,
    price: 45,
    currency: "USD",
    imageUrl: null,
    itemWebUrl: null,
    condition: "Pre-owned",
    buyingOptions: [],
    // US-3098: stated explicitly; null means "this source cannot say", which
    // is not the same fact as free shipping.
    shippingCents: null,
    categories: [{ categoryId: leaf, categoryName: "Hoodies" }],
    leafCategoryIds: [leaf],
  };
}

function results(items: BrowseComp[]): BrowseCompsResult {
  return {
    items,
    total: items.length,
    stats: { count: items.length, currency: "USD", min: null, p25: null, median: null, p75: null, max: null },
    categoryVotes: [],
    leafCategoryVotes: items.length
      ? [{ categoryId: "155226", categoryName: "Hoodies", count: items.length }]
      : [],
  };
}

Deno.test("a listing several angles found outranks one a single angle found", () => {
  // This ordering decides which listings get one of the scarce aspect reads.
  const merged = mergeSearches([
    results([comp("solo-a"), comp("shared")]),
    results([comp("shared"), comp("solo-b")]),
  ]);
  assertEquals(merged.comps[0]!.itemId, "shared");
  assertEquals(merged.photosByItemId.get("shared")!.size, 2);
  assertEquals(merged.photosWithResults, 2);
});

Deno.test("a photo that returned nothing is not counted as a photo that looked", () => {
  // A timed-out search is not an angle that disagreed. Reporting "1 of 3" when
  // two calls failed would read as a weak candidate, not as a thin sample.
  const merged = mergeSearches([results([comp("a")]), null, results([])]);
  assertEquals(merged.photosWithResults, 1);
});

Deno.test("the category vote adds across angles", () => {
  const merged = mergeSearches([results([comp("a"), comp("b")]), results([comp("c")])]);
  assertEquals(merged.leafCategoryVotes[0]!.count, 3);
});

// ── The read budget, and what agreement gets reported ────────────────────────

Deno.test("aspect reads are capped across ALL photos, not per photo", async () => {
  let readCount = 0;
  await runVisualPass({
    imageBase64: "a",
    imageRole: "front",
    extraImagesBase64: ["b", "c"],
    enabled: () => true,
    searchByImage: () =>
      Promise.resolve(
        results(Array.from({ length: 12 }, (_, i) => comp(`item-${i}`))),
      ),
    gatherAspects: (args) => {
      // The real gatherer reads at most MAX_ASPECT_READS of what it is handed.
      // What is asserted here is that the PASS does not call it three times,
      // which is how a total budget becomes a per-photo one.
      readCount++;
      assert(args.comps.length > 0);
      return Promise.resolve({
        aspects: {},
        listingsRead: Math.min(MAX_ASPECT_READS, args.comps.length),
        ownListingsExcluded: 0,
        readFailures: 0,
      });
    },
  });
  assertEquals(readCount, 1, "three searches, ONE aspect-read budget");
});

Deno.test("a value two angles found is reported as 2 of 3", async () => {
  const perPhoto: Record<string, BrowseComp[]> = {
    front: [comp("both-1"), comp("both-2")],
    back: [comp("both-1")],
    // The third angle found something else entirely.
    flat: [comp("other-1")],
  };
  const res = await runVisualPass({
    imageBase64: "front",
    imageRole: "front",
    extraImagesBase64: ["back", "flat"],
    enabled: () => true,
    searchByImage: ({ imageBase64 }) =>
      Promise.resolve(results(perPhoto[imageBase64] ?? [])),
    gatherAspects: () =>
      Promise.resolve({
        aspects: {
          Brand: {
            value: "Lululemon",
            support: 2,
            declared: 3,
            candidates: [{ value: "Lululemon", count: 2 }],
            winningListingIds: ["both-1", "both-2"],
          },
        },
        listingsRead: 3,
        ownListingsExcluded: 0,
        readFailures: 0,
      }),
  });

  const brand = res.candidates.find((c) => c.field === "brand")!;
  assertEquals(brand.photosSearched, 3);
  // both-1 came back on front AND back; both-2 only on front. Two distinct
  // angles surfaced the listings that carried the winning value.
  assertEquals(brand.photosAgreeing, 2);
});

Deno.test("every search failing is an outage, not an empty market", async () => {
  const res = await runVisualPass({
    imageBase64: "a",
    imageRole: "front",
    extraImagesBase64: ["b"],
    enabled: () => true,
    searchByImage: () => Promise.reject(new Error("502")),
  });
  // no_matches would file an eBay incident under "nothing looks like this
  // garment" on the US-2779 report, which is where the provider gets judged.
  assertEquals(res.declined, "error");
});

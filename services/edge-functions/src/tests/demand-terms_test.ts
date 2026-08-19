// US-546 (AC2 + AC3): demand-term mining from eBay comp titles, and the A/B
// title-variant sell-through summary. Both are pure — tested with no eBay/AI.

import { assertEquals } from "@std/assert";

// demand-terms.ts -> ebay-client -> supabase, which throw at init without env.
// Dummy-env then dynamic-import (mirrors sold-comps_test.ts). These tests cover
// the PURE miner + sell-through math; the Browse I/O path degrades to [].
Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  LIFT_SMOOTHING,
  mineDemandTerms,
  mineDemandTermsFromTitles,
  mineDemandTermsWithLift,
  summarizeTitleVariantSellThrough,
} = await import("../lib/demand-terms.ts");
const { MIN_SOLD_COMPS } = await import("../lib/sold-comps.ts");
const { getEbaySearchDemandTerms, getEbaySearchDemandTermsDetailed } = await import(
  "../lib/demand-terms.ts"
);

Deno.test("mines recurring significant terms, ranked by document frequency", () => {
  const titles = [
    "Nike Air Max 90 Mens Running Shoes White",
    "Nike Air Max 90 Essential White Sneakers",
    "Nike Air Max 270 Black Running Shoes",
  ];
  // brand "nike" is a seed (excluded). "air max", "running", "shoes", "white",
  // "max", "90", "running shoes" recur >= 2 titles.
  const terms = mineDemandTermsFromTitles(titles, { seedTerms: ["Nike"] });
  assertEquals(terms.includes("air max"), true);
  assertEquals(terms.includes("nike"), false); // seed excluded
  assertEquals(terms.includes("running shoes"), true);
});

Deno.test("excludes stopwords and condition/marketing boilerplate", () => {
  const titles = [
    "NWT Vintage Levis Denim Jacket Great Condition Fast Shipping",
    "Vintage Levis Denim Jacket New With Tags Authentic",
  ];
  const terms = mineDemandTermsFromTitles(titles, { seedTerms: ["Levis"] });
  // "denim", "jacket", "denim jacket" survive; boilerplate does not.
  assertEquals(terms.includes("denim jacket"), true);
  for (const junk of ["nwt", "vintage", "great", "condition", "fast", "shipping", "new", "authentic"]) {
    assertEquals(terms.includes(junk), false);
  }
});

Deno.test("a one-off term below minCount is not treated as demand", () => {
  const titles = [
    "Adidas Track Jacket Retro",
    "Adidas Track Pants Navy",
  ];
  // "track" recurs (2), "jacket"/"pants"/"retro"/"navy" appear once.
  const terms = mineDemandTermsFromTitles(titles, { seedTerms: ["Adidas"], minCount: 2 });
  assertEquals(terms.includes("track"), true);
  assertEquals(terms.includes("retro"), false);
  assertEquals(terms.includes("navy"), false);
});

Deno.test("counts each term once per title (document frequency, not raw)", () => {
  const titles = [
    "Coat Coat Coat Coat Warm",
    "Coat Parka Warm",
  ];
  const ranked = mineDemandTerms(titles, { minCount: 2 });
  const coat = ranked.find((t) => t.term === "coat");
  assertEquals(coat?.count, 2); // 2 titles, not 5 occurrences
});

Deno.test("respects the max cap and empty input", () => {
  assertEquals(mineDemandTermsFromTitles([]), []);
  const titles = Array.from({ length: 20 }, (_, i) => `Gildan Tee Cotton Shirt Soft Crew ${i % 2}`);
  const terms = mineDemandTermsFromTitles(titles, { max: 3 });
  assertEquals(terms.length <= 3, true);
});

Deno.test("sell-through summary rolls listings up per active variant label", () => {
  const summary = summarizeTitleVariantSellThrough([
    { activeLabel: "A", sold: true },
    { activeLabel: "A", sold: false },
    { activeLabel: "B", sold: true },
    { activeLabel: "B", sold: true },
  ]);
  const a = summary.find((s) => s.label === "A")!;
  const b = summary.find((s) => s.label === "B")!;
  assertEquals(a.listings, 2);
  assertEquals(a.sold, 1);
  assertEquals(a.sellThrough, 0.5);
  assertEquals(b.sellThrough, 1);
  // Sorted by sell-through desc → B (the winner) first.
  assertEquals(summary[0]!.label, "B");
});

Deno.test("sell-through summary defaults a blank label to A", () => {
  const summary = summarizeTitleVariantSellThrough([
    { activeLabel: "", sold: false },
  ]);
  assertEquals(summary[0]!.label, "A");
});

// ---------------------------------------------------------------------------
// US-2675: sold-versus-active lift
//
// The bug being fixed is a direction error, not an arithmetic one. Ranking by
// frequency in ACTIVE listings ranks by the wording of inventory that has NOT
// sold, so the miner was teaching titles the vocabulary of unsold stock and
// calling it demand.
//
// Every case below is fixture arrays in, terms out. No eBay, no network, no
// clock: the same purity contract mineDemandTerms already had.
// ---------------------------------------------------------------------------

function bySource(terms: Array<{ term: string; source: string }>, source: string): string[] {
  return terms.filter((t) => t.source === source).map((t) => t.term);
}

function rank(terms: Array<{ term: string }>, term: string): number {
  return terms.findIndex((t) => t.term === term);
}

Deno.test("AC3: at equal frequency a sold term outranks an active-only term", () => {
  // "gorpcore" and "streetwear" each appear in exactly 3 of 6 titles. The only
  // difference between them is which corpus they appear in.
  const sold = [
    "Patagonia Fleece Gorpcore Pullover",
    "Patagonia Snap T Gorpcore Fleece",
    "Patagonia Retro Gorpcore Jacket",
    "Patagonia Nano Puff Hooded",
    "Patagonia Better Sweater Full Zip",
    "Patagonia Synchilla Snap Pullover",
  ];
  const active = [
    "Patagonia Fleece Streetwear Pullover",
    "Patagonia Snap T Streetwear Fleece",
    "Patagonia Retro Streetwear Jacket",
    "Patagonia Nano Puff Hooded",
    "Patagonia Better Sweater Full Zip",
    "Patagonia Synchilla Snap Pullover",
  ];

  const terms = mineDemandTermsWithLift(sold, active, { seedTerms: ["Patagonia"], max: 30 });
  const g = rank(terms, "gorpcore");
  const st = rank(terms, "streetwear");

  assertEquals(g >= 0, true, "the sold-only term was dropped entirely");
  assertEquals(st >= 0, true, "the active-only term was dropped entirely");
  assertEquals(g < st, true, "gorpcore ranked " + g + ", streetwear ranked " + st);
});

Deno.test("a sold-only term is labelled sold, an active-only term active", () => {
  const sold = ["Carhartt Detroit Jacket Blanket Lined", "Carhartt Detroit Blanket Lined Coat"];
  const active = ["Carhartt Chore Coat Duck Canvas", "Carhartt Chore Duck Canvas Jacket"];
  const terms = mineDemandTermsWithLift(sold, active, {
    seedTerms: ["Carhartt"],
    minSoldTitles: 2,
    max: 30,
  });

  assertEquals(bySource(terms, "sold").includes("blanket"), true);
  assertEquals(bySource(terms, "active").includes("chore"), true);
  // And nothing is labelled sold that only ever appeared in active titles.
  assertEquals(bySource(terms, "sold").includes("chore"), false);
});

Deno.test("a term equally common in BOTH corpora has a lift of exactly 1", () => {
  const sold = ["Levis 501 Denim Jeans", "Levis 505 Denim Jeans", "Levis 550 Denim Jeans"];
  const active = ["Levis 512 Denim Jeans", "Levis 514 Denim Jeans", "Levis 517 Denim Jeans"];
  const terms = mineDemandTermsWithLift(sold, active, { seedTerms: ["Levis"], max: 30 });
  const denim = terms.find((t) => t.term === "denim");
  assertEquals(denim !== undefined, true);
  assertEquals(denim!.lift, 1, "a term equally common in both corpora is not lifted");
});

Deno.test("AC4: too few sold titles falls back to the active-only ranking", () => {
  const sold = ["Nike Air Max Rare Colourway"]; // 1 title, below MIN_SOLD_COMPS
  const active = [
    "Nike Air Max 90 White Sneakers",
    "Nike Air Max 90 Essential Sneakers",
    "Nike Air Max 270 Black Sneakers",
  ];
  const terms = mineDemandTermsWithLift(sold, active, { seedTerms: ["Nike"], max: 30 });

  assertEquals(terms.length > 0, true, "the fallback returned nothing");
  // Every term is labelled active: nothing may claim sold backing here.
  assertEquals(bySource(terms, "sold"), []);
  // The lone sold title must not leak in through the fallback either.
  assertEquals(terms.some((t) => t.term === "colourway"), false);
  // And the fallback is the old behaviour, not a re-implementation of it.
  assertEquals(
    terms.map((t) => t.term),
    mineDemandTerms(active, { seedTerms: ["Nike"], max: 30 }).map((t) => t.term),
  );
});

Deno.test("the fallback threshold IS MIN_SOLD_COMPS, not a second copy of it", () => {
  const active = ["A Chore Coat Duck", "B Chore Coat Duck", "C Chore Coat Duck"];
  const sold = Array.from({ length: MIN_SOLD_COMPS }, (_, i) => "S" + i + " Blanket Lined Jacket");

  // Exactly at the floor: the lift runs, so sold terms appear.
  const at = mineDemandTermsWithLift(sold, active, { max: 30 });
  assertEquals(bySource(at, "sold").length > 0, true, "at the floor the lift did not run");

  // One short: fallback, so nothing is sold-labelled.
  const below = mineDemandTermsWithLift(sold.slice(0, MIN_SOLD_COMPS - 1), active, { max: 30 });
  assertEquals(bySource(below, "sold"), []);
});

Deno.test("empty sold titles falls back rather than dividing by zero", () => {
  const active = ["Nike Air Max 90 White", "Nike Air Max 90 Black", "Nike Air Max 95 White"];
  const terms = mineDemandTermsWithLift([], active, { seedTerms: ["Nike"], max: 30 });
  assertEquals(bySource(terms, "sold"), []);
  assertEquals(terms.every((t) => Number.isFinite(t.lift ?? 1)), true);
});

Deno.test("empty ACTIVE titles still ranks the sold ones, finitely", () => {
  // The other half of AC5: Browse failing must not delete the sold signal we
  // did manage to get.
  const sold = ["Nike Dunk Low Panda", "Nike Dunk Low Panda White", "Nike Dunk Panda Retro"];
  const terms = mineDemandTermsWithLift(sold, [], { seedTerms: ["Nike"], max: 30 });
  assertEquals(terms.length > 0, true);
  assertEquals(bySource(terms, "active"), []);
  assertEquals(terms.every((t) => Number.isFinite(t.lift ?? 0)), true);
});

Deno.test("both corpora empty returns an empty list, not a crash", () => {
  assertEquals(mineDemandTermsWithLift([], [], {}), []);
});

Deno.test("a one-off term is still excluded, per corpus rather than summed", () => {
  // "unicorn" appears once in sold and once in active. Summing the two would
  // clear the default minCount of 2; counting per corpus correctly does not.
  const sold = ["Nike Dunk Low Panda", "Nike Dunk Low Panda", "Nike Dunk Unicorn Retro"];
  const active = ["Nike Dunk High Black", "Nike Dunk High Black", "Nike Dunk Unicorn Sample"];
  const terms = mineDemandTermsWithLift(sold, active, { seedTerms: ["Nike"], max: 50 });
  assertEquals(terms.some((t) => t.term === "unicorn"), false);
});

Deno.test("smoothing keeps a rare sold term from outranking a dominant one", () => {
  // Without smoothing, "fluke" (2 of 20 sold, 0 active) divides by a rate of
  // zero and wins outright. This is the case LIFT_SMOOTHING exists for.
  const sold = [
    ...Array.from({ length: 18 }, (_, i) => "Item" + i + " Blanket Lined Detroit"),
    "Item18 Blanket Lined Fluke Fluke",
    "Item19 Blanket Lined Fluke Fluke",
  ];
  const active = Array.from({ length: 20 }, (_, i) => "Item" + i + " Chore Coat Duck");
  const terms = mineDemandTermsWithLift(sold, active, { max: 50 });
  assertEquals(
    rank(terms, "blanket") < rank(terms, "fluke"),
    true,
    "a 2-of-20 term outranked an 18-of-20 term",
  );
});

Deno.test("the single-corpus miner labels its terms active and sets no lift", () => {
  const terms = mineDemandTerms(["Nike Air Max White", "Nike Air Max Black"], {
    seedTerms: ["Nike"],
  });
  assertEquals(terms.every((t) => t.source === "active"), true);
  assertEquals(terms.every((t) => t.lift === undefined), true);
});

Deno.test("LIFT_SMOOTHING is a real number the ratio can actually use", () => {
  assertEquals(LIFT_SMOOTHING > 0 && LIFT_SMOOTHING < 1, true);
});

// ---------------------------------------------------------------------------
// AC5: the wrapper never throws, whatever eBay does
//
// These run with no eBay credentials and no network, so BOTH comp fetches fail
// for real rather than through a mock. That is the whole point: the contract is
// that a keyword nicety can never take listing generation down with it, and the
// honest way to check it is to let the calls actually fail.
// ---------------------------------------------------------------------------

Deno.test("AC5: both comp fetches failing returns [] instead of throwing", async () => {
  const terms = await getEbaySearchDemandTermsDetailed({
    brand: "Carhartt",
    categoryId: "57988",
    query: "Detroit Jacket",
    size: "L",
  });
  assertEquals(terms, []);
});

Deno.test("AC5: the flat wrapper degrades the same way", async () => {
  assertEquals(
    await getEbaySearchDemandTerms({ brand: "Carhartt", categoryId: "57988" }),
    [],
  );
});

Deno.test("AC5: no brand, query or category short-circuits without a call", async () => {
  assertEquals(await getEbaySearchDemandTermsDetailed({}), []);
  assertEquals(await getEbaySearchDemandTermsDetailed({ brand: "   " }), []);
});

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
  mineDemandTerms,
  mineDemandTermsFromTitles,
  summarizeTitleVariantSellThrough,
} = await import("../lib/demand-terms.ts");

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

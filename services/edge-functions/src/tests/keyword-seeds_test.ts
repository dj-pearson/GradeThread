import { assert, assertEquals } from "@std/assert";
import { DEFAULT_SEED_KEYWORDS } from "../lib/keyword-research.ts";

// US-9027, 2026-08-28. Two Keyword Planner pulls, 776 keywords between them,
// sized the entire authentication cluster at ONE keyword and 50/mo — while
// /tools/authenticity-check was the best-converting page on the site at 10.98%
// CTR. An autocomplete harvest then found 945 distinct authentication queries
// across 20 brands.
//
// The pulls were not wrong. They were never asked, because the seed list had no
// authentication root in it. A keyword tool can only find neighbours of what you
// give it, so an absent seed is an invisible cluster and there is no error
// message for it. These tests make the four known gaps load-bearing.

Deno.test("every cluster the 2026-08 gap analysis found has a seed", () => {
  const seeds = DEFAULT_SEED_KEYWORDS.join(" | ").toLowerCase();
  // One probe per cluster, phrased as the root rather than as an exact seed, so
  // the seeds can be reworded without the test becoming a copy of the list.
  const clusters: Array<[string, RegExp]> = [
    ["authentication", /authentic|fake/],
    ["reseller tax and bookkeeping", /tax|bookkeep/],
    ["what is my X worth", /worth|value/],
    ["platform how-to", /how to sell|how to list/],
  ];
  for (const [name, probe] of clusters) {
    assert(probe.test(seeds), `no seed covers the ${name} cluster`);
  }
});

Deno.test("the original product seeds are still there", () => {
  // The gap seeds are an addition, not a replacement. Losing the grading and
  // FlipDesk roots would trade one blind spot for another.
  for (const original of [
    "clothing condition grading",
    "used clothing grade",
    "ebay listing tool",
    "reseller inventory software",
    "thrift flipping",
    "garment condition report",
    "resale certificate",
  ]) {
    assert(
      DEFAULT_SEED_KEYWORDS.includes(original),
      `original seed dropped: ${original}`,
    );
  }
});

Deno.test("seeds are unique, trimmed and lowercase", () => {
  // A duplicate seed spends an API call to learn nothing, and Keyword Planner
  // is metered per request.
  assertEquals(
    new Set(DEFAULT_SEED_KEYWORDS).size,
    DEFAULT_SEED_KEYWORDS.length,
    "duplicate seed",
  );
  for (const s of DEFAULT_SEED_KEYWORDS) {
    assertEquals(s, s.trim(), `seed has surrounding whitespace: "${s}"`);
    assertEquals(s, s.toLowerCase(), `seed is not lowercase: "${s}"`);
    assert(s.length > 3, `seed too short to be a root: "${s}"`);
  }
});

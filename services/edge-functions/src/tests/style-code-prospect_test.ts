// US-2786: the uncurated-brand survey.
//
// Two cases carry most of the weight. The gate one, because a survey that runs
// before the curated pool is used up spends budget on strangers while a
// never-crawled brand that might be the best one sits there. And the
// known-brand one, because a candidate row for a brand we already crawl is a
// second record of the same brand with worse numbers.

// US-2379: FIRST import, before anything that reaches lib/supabase.ts. This
// module reads env at import time, so a test file that pulls it in without
// _env.ts first only passes when some earlier file happened to load it - which
// makes the suite order-dependent and this file individually unrunnable.
import "./_env.ts";
import { assertEquals } from "@std/assert";
import type { DiscoveryStateRow } from "../lib/style-code-discovery.ts";
import {
  harvestSighting,
  poolExhausted,
  poolProgress,
  type ProspectSighting,
  tallyCandidates,
} from "../lib/style-code-prospect.ts";
import {
  EXHAUSTED_EMPTY_PASSES,
  MAX_DISCOVERY_OFFSET,
} from "../lib/style-code-discovery.ts";

const canon = (raw: string) => raw.toUpperCase().replace(/[^A-Z0-9]/g, "");

function state(
  key: string,
  over: Partial<DiscoveryStateRow> = {},
): DiscoveryStateRow {
  return {
    brand_key: key,
    page_offset: 0,
    last_run_at: "2026-08-01T00:00:00.000Z",
    empty_passes: 0,
    ...over,
  };
}

function listing(aspects: Record<string, string>, itemId = "v1") {
  return {
    itemId,
    title: "A perfectly ordinary listing title",
    aspects,
    url: `https://ebay.com/itm/${itemId}`,
  };
}

// ── the gate ────────────────────────────────────────────────────────────────

Deno.test("US-2786: an empty pool is not an exhausted pool", () => {
  // Nothing crawled yet reads as "every brand is done" to a naive `every`.
  assertEquals(poolExhausted([]), false);
});

Deno.test("US-2786: one never-crawled brand keeps the pool unexhausted", () => {
  // That brand may be the best one in the list. Surveying strangers before
  // looking at it is the expensive way to find that out.
  assertEquals(
    poolExhausted([
      state("a", { empty_passes: EXHAUSTED_EMPTY_PASSES }),
      state("b", { last_run_at: null }),
    ]),
    false,
  );
});

Deno.test("US-2786: a crawled brand still yielding keeps the pool unexhausted", () => {
  assertEquals(
    poolExhausted([
      state("a", { empty_passes: EXHAUSTED_EMPTY_PASSES }),
      state("b", { empty_passes: 0 }),
    ]),
    false,
  );
});

Deno.test("US-2786: every brand wrapped or gone flat is exhausted", () => {
  assertEquals(
    poolExhausted([
      state("a", { empty_passes: EXHAUSTED_EMPTY_PASSES }),
      state("b", { page_offset: MAX_DISCOVERY_OFFSET }),
    ]),
    true,
  );
});

Deno.test("US-2786: progress counts against the WHOLE pool, not the crawled part", () => {
  // 2 rows out of 230 brands is 2/230 done, not 2/2. Reporting the latter is
  // how a survey gate looks satisfied on the day it is least satisfied.
  assertEquals(
    poolProgress(
      [
        state("a", { empty_passes: EXHAUSTED_EMPTY_PASSES }),
        state("b", { empty_passes: 0 }),
      ],
      230,
    ),
    { crawled: 2, exhausted: 1, total: 230 },
  );
});

// ── harvestSighting ─────────────────────────────────────────────────────────

Deno.test("US-2786: a listing with a brand and a declared code counts both", () => {
  const s = harvestSighting({
    listing: listing({ Brand: "Arc'teryx", "Style Code": "X000006236" }),
    canonicalize: canon,
    ownItemIds: new Set(),
  });

  assertEquals(s?.brandLabel, "Arc'teryx");
  assertEquals(s?.declaredCode, true);
  assertEquals(s?.codeRaw, "X000006236");
});

Deno.test("US-2786: a listing with a brand and NO code still counts as surveyed", () => {
  // This is the denominator. Dropping it would make every brand look like a
  // 100% code-fill brand.
  const s = harvestSighting({
    listing: listing({ Brand: "Arc'teryx" }),
    canonicalize: canon,
    ownItemIds: new Set(),
  });

  assertEquals(s?.brandLabel, "Arc'teryx");
  assertEquals(s?.declaredCode, false);
  assertEquals(s?.codeRaw, null);
});

Deno.test("US-2786: a listing naming no brand is not evidence about anything", () => {
  assertEquals(
    harvestSighting({
      listing: listing({ "Style Code": "X000006236" }),
      canonicalize: canon,
      ownItemIds: new Set(),
    }),
    null,
  );
});

Deno.test("US-2786: Unbranded is an eBay value, not a brand", () => {
  for (const value of ["Unbranded", "unbranded", "Handmade", "None"]) {
    assertEquals(
      harvestSighting({
        listing: listing({ Brand: value }),
        canonicalize: canon,
        ownItemIds: new Set(),
      }),
      null,
      value,
    );
  }
});

Deno.test("US-2786: a code too short to be an identity does not count as declared", () => {
  const s = harvestSighting({
    listing: listing({ Brand: "Arc'teryx", MPN: "A1" }),
    canonicalize: canon,
    ownItemIds: new Set(),
  });

  assertEquals(s?.declaredCode, false);
});

Deno.test("US-2786: our own listing is not surveyed", () => {
  assertEquals(
    harvestSighting({
      listing: listing({ Brand: "Arc'teryx", MPN: "X000006236" }, "mine"),
      canonicalize: canon,
      ownItemIds: new Set(["mine"]),
    }),
    null,
  );
});

// ── tallyCandidates ─────────────────────────────────────────────────────────

function sighting(over: Partial<ProspectSighting> = {}): ProspectSighting {
  return {
    brandLabel: "Arc'teryx",
    declaredCode: false,
    codeRaw: null,
    name: null,
    title: "A perfectly ordinary listing title",
    url: null,
    ...over,
  };
}

const keyFor = (label: string) =>
  label.toLowerCase().replace(/[^a-z0-9]/g, "") || null;

Deno.test("US-2786: a brand we already curate never becomes a candidate", () => {
  const out = tallyCandidates({
    sightings: [sighting({ brandLabel: "Carhartt" })],
    brandKeyFor: keyFor,
    knownBrandKeys: new Set(["carhartt"]),
  });

  assertEquals(out, []);
});

Deno.test("US-2786: sightings of one brand collapse to one tally", () => {
  const out = tallyCandidates({
    sightings: [
      sighting({ declaredCode: true }),
      sighting({ declaredCode: false }),
      sighting({ declaredCode: true }),
    ],
    brandKeyFor: keyFor,
    knownBrandKeys: new Set(),
  });

  assertEquals(out.length, 1);
  assertEquals(out[0]!.listingsSeen, 3);
  assertEquals(out[0]!.listingsWithCode, 2);
});

Deno.test("US-2786: the longest label wins, because the crawl searches on it", () => {
  // "AF" is not a query that finds Abercrombie.
  const out = tallyCandidates({
    sightings: [
      sighting({ brandLabel: "Arcteryx" }),
      sighting({ brandLabel: "Arcteryx Veilance" }),
    ],
    brandKeyFor: () => "arcteryx",
    knownBrandKeys: new Set(),
  });

  assertEquals(out[0]!.brandLabel, "Arcteryx Veilance");
});

Deno.test("US-2786: the best code-fill RATE leads, not the biggest brand", () => {
  const out = tallyCandidates({
    sightings: [
      // Big and barren: 1 of 4.
      ...Array.from({ length: 4 }, (_, i) =>
        sighting({ brandLabel: "Big Brand", declaredCode: i === 0 })),
      // Small and diligent: 2 of 2.
      sighting({ brandLabel: "Small Brand", declaredCode: true }),
      sighting({ brandLabel: "Small Brand", declaredCode: true }),
    ],
    brandKeyFor: keyFor,
    knownBrandKeys: new Set(),
  });

  assertEquals(out.map((c) => c.brandLabel), ["Small Brand", "Big Brand"]);
});

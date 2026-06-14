// US-879: unit tests for the GSC closed-loop PURE selectors. No Supabase /
// Deno.env / clock — the aggregation, striking-distance scoring, content-gap and
// title/meta detection all run on fixtures:
//   deno test src/tests/content-search-signals_test.ts

import { assert, assertEquals } from "@std/assert";
import {
  aggregatePageSignals,
  aggregateQuerySignals,
  DEFAULT_STRIKING_OPTS,
  findContentGaps,
  findTitleMetaOpportunities,
  isQueryCovered,
  type PageSignal,
  positionFit,
  type RawSignalRow,
  strikingScore,
  toTitleCase,
} from "../lib/content-search-signals.ts";

function row(p: Partial<RawSignalRow>): RawSignalRow {
  return {
    query: null,
    page: null,
    impressions: 0,
    clicks: 0,
    position: 0,
    date: "2026-06-01",
    ...p,
  };
}

// ── aggregateQuerySignals ────────────────────────────────────────

Deno.test("aggregateQuerySignals sums impressions/clicks and impression-weights position", () => {
  const out = aggregateQuerySignals([
    row({ query: "Wool Coat", impressions: 100, clicks: 2, position: 10 }),
    row({ query: "wool coat", impressions: 300, clicks: 10, position: 6 }),
    row({ query: "denim", impressions: 50, clicks: 1, position: 4 }),
  ]);
  // sorted by impressions desc → wool coat (400) first
  assertEquals(out[0].query, "wool coat");
  assertEquals(out[0].impressions, 400);
  assertEquals(out[0].clicks, 12);
  assertEquals(out[0].ctr, 12 / 400);
  // weighted position = (100*10 + 300*6)/400 = 2800/400 = 7
  assertEquals(out[0].position, 7);
  assertEquals(out[1].query, "denim");
});

Deno.test("aggregateQuerySignals skips null/blank queries and zero-impression ctr", () => {
  const out = aggregateQuerySignals([
    row({ query: null, impressions: 999 }),
    row({ query: "  ", impressions: 5 }),
    row({ query: "x", impressions: 0, clicks: 0, position: 9 }),
  ]);
  assertEquals(out.length, 1);
  assertEquals(out[0].query, "x");
  assertEquals(out[0].ctr, 0);
  assertEquals(out[0].position, 0);
});

// ── aggregatePageSignals + striking distance ─────────────────────

Deno.test("aggregatePageSignals splits impressions recent vs older by midpoint", () => {
  const out = aggregatePageSignals([
    row({ page: "/blog/a", impressions: 40, position: 11, date: "2026-06-10" }),
    row({ page: "/blog/a", impressions: 10, position: 11, date: "2026-05-20" }),
  ], "2026-06-01");
  assertEquals(out.length, 1);
  assertEquals(out[0].impressionsRecent, 40);
  assertEquals(out[0].impressionsOlder, 10);
});

Deno.test("positionFit is 1 in the sweet band, 0 outside, tapered between", () => {
  const o = DEFAULT_STRIKING_OPTS; // min5 max20 sweet8..12
  assertEquals(positionFit(10, o), 1);
  assertEquals(positionFit(8, o), 1);
  assertEquals(positionFit(12, o), 1);
  assertEquals(positionFit(4, o), 0); // below min
  assertEquals(positionFit(21, o), 0); // above max
  // halfway from min(5) to sweetLow(8): position 6.5 → 0.5
  assertEquals(positionFit(6.5, o), 0.5);
  // halfway from sweetHigh(12) to max(20): position 16 → 0.5
  assertEquals(positionFit(16, o), 0.5);
});

Deno.test("strikingScore requires volume floor AND rising impressions", () => {
  const base: PageSignal = {
    page: "/blog/a",
    impressions: 100,
    clicks: 3,
    position: 10,
    impressionsRecent: 70,
    impressionsOlder: 30,
  };
  assertEquals(strikingScore(base), 1); // rising, in band, enough volume
  // not rising
  assertEquals(strikingScore({ ...base, impressionsRecent: 30, impressionsOlder: 70 }), 0);
  // below volume floor
  assertEquals(strikingScore({ ...base, impressions: 10, impressionsRecent: 7, impressionsOlder: 3 }), 0);
  // out of position band
  assertEquals(strikingScore({ ...base, position: 2 }), 0);
});

// ── content gaps ─────────────────────────────────────────────────

Deno.test("isQueryCovered matches via containment either direction", () => {
  const covered = new Set(["wool coat care", "denim"]);
  assert(isQueryCovered("wool coat", covered)); // query inside a covered kw
  assert(isQueryCovered("denim jacket", covered)); // covered kw inside query
  assert(!isQueryCovered("leather boots", covered));
});

Deno.test("findContentGaps returns high-impression uncovered queries, busiest first", () => {
  const signals = aggregateQuerySignals([
    row({ query: "leather boots", impressions: 500, clicks: 1, position: 12 }),
    row({ query: "wool coat", impressions: 800, clicks: 30, position: 5 }),
    row({ query: "rare term", impressions: 5, position: 9 }),
  ]);
  const covered = new Set(["wool coat"]);
  const gaps = findContentGaps(signals, covered, { minImpressions: 30, limit: 10 });
  assertEquals(gaps.length, 1); // wool coat covered, rare term below floor
  assertEquals(gaps[0].query, "leather boots");
});

Deno.test("findContentGaps honors the limit", () => {
  const signals = aggregateQuerySignals([
    row({ query: "a term", impressions: 100, position: 10 }),
    row({ query: "b term", impressions: 90, position: 10 }),
    row({ query: "c term", impressions: 80, position: 10 }),
  ]);
  const gaps = findContentGaps(signals, new Set(), { minImpressions: 30, limit: 2 });
  assertEquals(gaps.length, 2);
  assertEquals(gaps[0].query, "a term");
});

// ── title/meta opportunities ─────────────────────────────────────

Deno.test("findTitleMetaOpportunities flags high-impression low-CTR page-1 queries", () => {
  const signals = aggregateQuerySignals([
    // high impressions, low ctr (2/1000 = 0.002), good position → opportunity
    row({ query: "consign clothes", impressions: 1000, clicks: 2, position: 6 }),
    // high ctr → not an opportunity
    row({ query: "good ctr", impressions: 1000, clicks: 200, position: 6 }),
    // low impressions → ignored
    row({ query: "tiny", impressions: 10, clicks: 0, position: 6 }),
    // buried position → ignored
    row({ query: "buried", impressions: 1000, clicks: 1, position: 40 }),
  ]);
  const ops = findTitleMetaOpportunities(signals, {
    minImpressions: 50,
    maxCtr: 0.02,
    maxPosition: 15,
    limit: 10,
  });
  assertEquals(ops.map((o) => o.query), ["consign clothes"]);
});

Deno.test("toTitleCase normalizes whitespace and capitalizes", () => {
  assertEquals(toTitleCase("  wool   coat care "), "Wool Coat Care");
});

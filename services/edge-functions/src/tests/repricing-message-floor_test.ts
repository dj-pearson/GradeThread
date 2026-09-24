// Pricing plan P5: a STALE nudge states the cut it actually suggests, and no
// nudge ever suggests a price under the listing's floor.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { computeSuggestion, type RepriceInput } from "../lib/repricing.ts";

function input(over: Partial<RepriceInput>): RepriceInput {
  return {
    currentPriceCents: 10000,
    gradeValue: null,
    // A $20 market: grade-6 positions at about $19.43.
    stats: { count: 12, min: 14, p25: 18, median: 20, p75: 22.9, max: 26 },
    listingAgeDays: 45,
    watchers: 0,
    views: 0,
    ...over,
  };
}

Deno.test("P5: a $100 listing in a $20 market says the real cut, not 8%", () => {
  const s = computeSuggestion(input({}));
  assertEquals(s.reasonCode, "STALE");
  const pct = Math.round(((10000 - s.suggestedPriceCents) / 10000) * 100);
  assert(pct >= 80, `expected a cut of 80% or more, got ${pct}%`);
  assertStringIncludes(s.message, `Drop ${pct}%`);
  assert(!s.message.includes("8%") || pct === 8, s.message);
});

Deno.test("P5: a $60 floor clamps the stale nudge to $60", () => {
  const s = computeSuggestion(input({ floorCents: 6000 }));
  assertEquals(s.reasonCode, "STALE");
  assertEquals(s.suggestedPriceCents, 6000);
  assertStringIncludes(s.message, "Drop 40% to $60.00");
});

Deno.test("P5: a floor clamps an overpriced nudge too, and says so", () => {
  const s = computeSuggestion(input({ listingAgeDays: 2, floorCents: 6000 }));
  assertEquals(s.reasonCode, "OVERPRICED");
  assertEquals(s.suggestedPriceCents, 6000);
  assertStringIncludes(s.message, "your floor is $60.00");
});

Deno.test("P5: a floor at or above the current price gives no nudge", () => {
  for (const floorCents of [10000, 12000]) {
    for (const listingAgeDays of [2, 45]) {
      const s = computeSuggestion(input({ floorCents, listingAgeDays }));
      assertEquals(s.reasonCode, "OK", `floor ${floorCents}, age ${listingAgeDays}`);
      assertEquals(s.suggestedPriceCents, 10000);
    }
  }
});

Deno.test("P5: no engine message carries an em dash", () => {
  const cases: Array<Partial<RepriceInput>> = [
    {},
    { floorCents: 6000 },
    { listingAgeDays: 2 },
    { listingAgeDays: 2, floorCents: 6000 },
    { floorCents: 12000 },
    { currentPriceCents: 1000, listingAgeDays: 2 },
    { watchers: 5, impressions: 900, views: 80, clickThroughRate: 0.05, listingAgeDays: 20 },
    { stats: { count: 1, min: null, p25: null, median: null, p75: null, max: null } },
    { currentPriceCents: 2000, listingAgeDays: 2 },
  ];
  for (const c of cases) {
    const s = computeSuggestion(input(c));
    assert(!s.message.includes("—"), `em dash in: ${s.message}`);
  }
});

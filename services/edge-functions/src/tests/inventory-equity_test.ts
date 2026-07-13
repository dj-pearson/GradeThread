// US-1869: inventory equity liquidation-value model — pure math tests.
import { assert, assertEquals } from "@std/assert";
import {
  aggregateEquity,
  gradeBand,
  liquidationValue,
  marketMedianFromComps,
  stalenessFactor,
  velocityFactor,
} from "../lib/inventory-equity.ts";

// ── market median from cached comps ────────────────────────────────

Deno.test("median from comps needs >=3 and ignores non-positive", () => {
  assertEquals(marketMedianFromComps([{ cents: 100 }, { cents: 200 }]), null);
  assertEquals(marketMedianFromComps([{ cents: 100 }, { cents: 300 }, { cents: 200 }]), 200);
  assertEquals(
    marketMedianFromComps([{ cents: 100 }, { cents: 200 }, { cents: 300 }, { cents: 400 }]),
    250, // even count → mean of the two middles
  );
  assertEquals(marketMedianFromComps([{ cents: 0 }, { cents: -5 }, { cents: 100 }]), null);
});

// ── haircut factors are conservative (≤ 1, monotone) ───────────────

Deno.test("velocity factor: faster sells discount less; unknown is conservative", () => {
  assertEquals(velocityFactor(10), 1.0);
  assertEquals(velocityFactor(45), 0.95);
  assertEquals(velocityFactor(75), 0.9);
  assertEquals(velocityFactor(120), 0.8);
  assertEquals(velocityFactor(400), 0.7);
  assertEquals(velocityFactor(null), 0.85);
  // monotone non-increasing
  const xs = [10, 45, 75, 120, 400].map(velocityFactor);
  for (let i = 1; i < xs.length; i++) assert(xs[i] <= xs[i - 1]);
});

Deno.test("staleness factor: older listings discount harder; fresh/null = 1", () => {
  assertEquals(stalenessFactor(null), 1.0);
  assertEquals(stalenessFactor(10), 1.0);
  assertEquals(stalenessFactor(45), 0.97);
  assertEquals(stalenessFactor(75), 0.92);
  assertEquals(stalenessFactor(150), 0.85);
  assertEquals(stalenessFactor(365), 0.75);
});

// ── liquidation value: haircut math + band ─────────────────────────

Deno.test("liquidation applies both haircuts and never inflates", () => {
  const r = liquidationValue({
    marketMedianCents: 10_000,
    marketConfidence: 1,
    gradeValue: 8,
    personalSellThroughDays: 45, // 0.95
    daysListed: 45, // 0.97
  });
  assert(r.valued);
  assertEquals(r.liquidationCents, Math.round(10_000 * 0.95 * 0.97)); // 9215
  assert(r.liquidationCents! <= 10_000); // conservative
  // full market confidence → tightest band (±10%)
  assertEquals(r.lowCents, Math.round(9215 * 0.9));
  assertEquals(r.highCents, Math.round(9215 * 1.1));
});

Deno.test("low market confidence widens the band", () => {
  const hi = liquidationValue({ marketMedianCents: 10_000, marketConfidence: 1, gradeValue: 7, personalSellThroughDays: 20, daysListed: 0 });
  const lo = liquidationValue({ marketMedianCents: 10_000, marketConfidence: 0.2, gradeValue: 7, personalSellThroughDays: 20, daysListed: 0 });
  const hiWidth = hi.highCents! - hi.lowCents!;
  const loWidth = lo.highCents! - lo.lowCents!;
  assert(loWidth > hiWidth);
});

Deno.test("unknown velocity discounts the output confidence", () => {
  const known = liquidationValue({ marketMedianCents: 5000, marketConfidence: 0.8, gradeValue: 7, personalSellThroughDays: 30, daysListed: 0 });
  const unknown = liquidationValue({ marketMedianCents: 5000, marketConfidence: 0.8, gradeValue: 7, personalSellThroughDays: null, daysListed: 0 });
  assert(unknown.confidence < known.confidence);
  assertEquals(known.confidence, 0.8);
});

// ── exclusion paths (never guessed) ────────────────────────────────

Deno.test("ungraded item is excluded (no_grade)", () => {
  const r = liquidationValue({ marketMedianCents: 5000, marketConfidence: 0.8, gradeValue: null, personalSellThroughDays: 30, daysListed: 0 });
  assertEquals(r.valued, false);
  assertEquals(r.reason, "no_grade");
  assertEquals(r.liquidationCents, null);
});

Deno.test("item without usable comps is excluded (no_comps)", () => {
  const r = liquidationValue({ marketMedianCents: null, marketConfidence: 0, gradeValue: 8, personalSellThroughDays: 30, daysListed: 0 });
  assertEquals(r.valued, false);
  assertEquals(r.reason, "no_comps");
});

// ── grade band + aggregate ─────────────────────────────────────────

Deno.test("gradeBand buckets", () => {
  assertEquals(gradeBand(null), "ungraded");
  assertEquals(gradeBand(9.5), "9.0-10");
  assertEquals(gradeBand(7.2), "7.0-8.9");
  assertEquals(gradeBand(5.0), "5.0-6.9");
  assertEquals(gradeBand(3.5), "under-5");
});

Deno.test("aggregate: valued items sum to total, unvalued only counted", () => {
  const items = [
    { liquidation: liquidationValue({ marketMedianCents: 10_000, marketConfidence: 1, gradeValue: 9, personalSellThroughDays: 20, daysListed: 0 }), category: "Dresses", gradeValue: 9 },
    { liquidation: liquidationValue({ marketMedianCents: 4000, marketConfidence: 1, gradeValue: 6, personalSellThroughDays: 20, daysListed: 0 }), category: "Dresses", gradeValue: 6 },
    { liquidation: liquidationValue({ marketMedianCents: null, marketConfidence: 0, gradeValue: 8, personalSellThroughDays: 20, daysListed: 0 }), category: "Shoes", gradeValue: 8 },
    { liquidation: liquidationValue({ marketMedianCents: 5000, marketConfidence: 1, gradeValue: null, personalSellThroughDays: 20, daysListed: 0 }), category: "Shoes", gradeValue: null },
  ];
  const agg = aggregateEquity(items);
  assertEquals(agg.valuedCount, 2);
  assertEquals(agg.unvaluedCount, 2);
  assertEquals(agg.unvaluedByReason.no_comps, 1);
  assertEquals(agg.unvaluedByReason.no_grade, 1);
  const expected = items[0]!.liquidation.liquidationCents! + items[1]!.liquidation.liquidationCents!;
  assertEquals(agg.totalEquityCents, expected);
  assertEquals(agg.byCategory["Dresses"]!.count, 2);
  assertEquals(agg.byCategory["Dresses"]!.cents, expected);
  assertEquals(agg.byGradeBand["9.0-10"]!.count, 1);
  assertEquals(agg.byGradeBand["5.0-6.9"]!.count, 1);
  // unvalued never lands in a bucket
  assertEquals(agg.byCategory["Shoes"], undefined);
});

Deno.test("aggregate: empty inventory is a zeroed aggregate", () => {
  const agg = aggregateEquity([]);
  assertEquals(agg.totalEquityCents, 0);
  assertEquals(agg.valuedCount, 0);
  assertEquals(agg.unvaluedCount, 0);
});

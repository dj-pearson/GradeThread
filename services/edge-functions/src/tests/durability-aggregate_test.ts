// US-1773: cross-garment durability aggregation — pure engine.
// durability-aggregate.ts imports supabase at load, so prime env + dynamic-import.
import { assert, assertEquals } from "@std/assert";
import type { ConditionCurvePoint } from "../lib/passport-curve.ts";

Deno.env.set("SUPABASE_URL", "https://example.test");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "dummy");

const {
  aggregateDurabilityForClass,
  conditionBand,
  skuClassKey,
  skuClassLabel,
  DURABILITY_MIN_GARMENTS,
  DURABILITY_MIN_REGRADED,
} = await import("../lib/durability-aggregate.ts");

// Build a curve point with an overall + uniform factor value, N days after t0.
function pt(overall: number, factor: number, dayOffset: number): ConditionCurvePoint {
  const graded_at = new Date(Date.UTC(2026, 0, 1 + dayOffset)).toISOString();
  const factors = {
    fabric_condition_score: factor,
    structural_integrity_score: factor,
    cosmetic_appearance_score: factor,
    functional_elements_score: factor,
    odor_cleanliness_score: factor,
  };
  return {
    certificate: null,
    graded_at,
    overall,
    grade_tier: null,
    confidence_label: null,
    factors,
    overall_delta: null,
    factor_deltas: {
      fabric_condition_score: null,
      structural_integrity_score: null,
      cosmetic_appearance_score: null,
      functional_elements_score: null,
      odor_cleanliness_score: null,
    },
  };
}

// A regraded garment: graded at day 0 then day 30, losing `drop` overall/factor points.
function regraded(startOverall: number, drop: number): ConditionCurvePoint[] {
  return [pt(startOverall, startOverall, 0), pt(startOverall - drop, startOverall - drop, 30)];
}

// ── conditionBand ───────────────────────────────────────────────────────────
Deno.test("conditionBand: buckets by overall", () => {
  assertEquals(conditionBand(9), "excellent");
  assertEquals(conditionBand(6), "good");
  assertEquals(conditionBand(3), "fair");
  assertEquals(conditionBand(null), null);
});

// ── skuClassKey / label ─────────────────────────────────────────────────────
Deno.test("skuClassKey: brand::type lowercased; empty without a brand", () => {
  assertEquals(skuClassKey({ brand: "Gucci", garment_type: "Outerwear" }), "gucci::outerwear");
  assertEquals(skuClassKey({ garment_type: "top" }), "");
  assertEquals(skuClassLabel({ brand: "Gucci", garment_type: "Outerwear" }), "Gucci Outerwear");
});

// ── decay + retention ───────────────────────────────────────────────────────
Deno.test("aggregate: overall decay, retention, per-factor decay over regraded garments", () => {
  const curves = [regraded(8, 1), regraded(9, 2), regraded(7, 0)]; // drops 1, 2, 0
  const m = aggregateDurabilityForClass(curves, []);
  assertEquals(m.regraded_count, 3);
  assertEquals(m.avg_overall_decay, 1); // mean(1,2,0)
  // retention = last/first: 7/8, 7/9, 7/7 → mean ≈ 0.8843
  assert(m.avg_retention! > 0.88 && m.avg_retention! < 0.89, `retention was ${m.avg_retention}`);
  assertEquals(m.avg_span_days, 30);
  assertEquals(m.per_factor_decay.fabric_condition_score, 1);
});

Deno.test("aggregate: single-grade garments don't count as regraded", () => {
  const curves = [[pt(8, 8, 0)], [pt(7, 7, 0)]];
  const m = aggregateDurabilityForClass(curves, []);
  assertEquals(m.regraded_count, 0);
  assertEquals(m.avg_overall_decay, null);
  assertEquals(Object.keys(m.per_factor_decay).length, 0);
});

// ── sample gate ─────────────────────────────────────────────────────────────
Deno.test("aggregate: sufficient requires the garment AND regrade floors", () => {
  // Enough garments but too few regrades → not sufficient.
  const fewRegrades = [
    ...Array.from({ length: DURABILITY_MIN_GARMENTS }, () => [pt(8, 8, 0)]),
    regraded(8, 1),
  ];
  assertEquals(aggregateDurabilityForClass(fewRegrades, []).sufficient, false);

  // Enough of both → sufficient.
  const enough = [
    ...Array.from({ length: DURABILITY_MIN_GARMENTS }, () => [pt(8, 8, 0)]),
    ...Array.from({ length: DURABILITY_MIN_REGRADED }, () => regraded(8, 1)),
  ];
  const m = aggregateDurabilityForClass(enough, []);
  assert(m.garment_count >= DURABILITY_MIN_GARMENTS);
  assert(m.regraded_count >= DURABILITY_MIN_REGRADED);
  assertEquals(m.sufficient, true);
});

// ── resale ──────────────────────────────────────────────────────────────────
Deno.test("aggregate: resale median + by-band gate on MIN_SALES", () => {
  const sales = [
    { priceCents: 1000, band: "excellent" as const },
    { priceCents: 2000, band: "excellent" as const },
    { priceCents: 3000, band: "good" as const },
    { priceCents: 4000, band: "good" as const },
    { priceCents: 5000, band: "fair" as const },
  ];
  const m = aggregateDurabilityForClass([regraded(8, 1)], sales);
  assertEquals(m.resale_sample, 5);
  assertEquals(m.resale_median_cents, 3000);
  assertEquals(m.resale_by_band.excellent, 1500); // median(1000,2000)
  assertEquals(m.resale_by_band.good, 3500);
});

Deno.test("aggregate: too few sales → no resale numbers", () => {
  const m = aggregateDurabilityForClass([regraded(8, 1)], [{ priceCents: 999, band: "good" }]);
  assertEquals(m.resale_sample, 1);
  assertEquals(m.resale_median_cents, null);
  assertEquals(Object.keys(m.resale_by_band).length, 0);
});

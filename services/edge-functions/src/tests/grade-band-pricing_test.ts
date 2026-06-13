// US-594: sold-comp, grade-banded pricing engine. The engine's I/O wrapper
// (recommendGradeBandedPrice) pulls eBay/sold/active comps; the PURE core
// (positionRealizedByGrade / assembleRecommendation) is what we unit-test here.
// grade-band-pricing.ts -> sold-comps -> ebay-client + supabase (both throw at
// init w/o env), so dummy-env then dynamic-import (mirrors sold-comps_test.ts).
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { positionRealizedByGrade, assembleRecommendation } = await import(
  "../lib/grade-band-pricing.ts"
);
const { realizedRangeFromPrices } = await import("../lib/sold-comps.ts");

// A realized comp set: p25=$20, median=$40, p75=$80 (private_sales source).
function realizedFixture() {
  const r = realizedRangeFromPrices([10, 20, 30, 40, 60, 80, 120]);
  assert(r !== null, "fixture should produce a realized range");
  return r!;
}

Deno.test("positionRealizedByGrade: grade ≥ 8.5 takes the median (never above market)", () => {
  const r = realizedFixture();
  assertEquals(positionRealizedByGrade(r, 9.0), r.medianCents);
  assertEquals(positionRealizedByGrade(r, 8.5), r.medianCents);
});

Deno.test("positionRealizedByGrade: higher grade in the used band → higher price", () => {
  const r = realizedFixture();
  const low = positionRealizedByGrade(r, 5.0)!;
  const mid = positionRealizedByGrade(r, 6.5)!;
  const high = positionRealizedByGrade(r, 8.0)!;
  assert(low < mid, "grade 5 should price below grade 6.5");
  assert(mid < high, "grade 6.5 should price below grade 8");
  // grade 5 anchors at the low quartile; grade 8 climbs toward the high quartile.
  assertEquals(low, r.lowCents);
  assert(high <= r.highCents!);
});

Deno.test("positionRealizedByGrade: below grade 5 dips beneath the low quartile", () => {
  const r = realizedFixture();
  const g4 = positionRealizedByGrade(r, 4.0)!;
  assert(g4 < r.lowCents!, "a grade-4 item should price below the p25 floor");
  assert(g4 > 0);
});

Deno.test("positionRealizedByGrade: null median → null", () => {
  const r = { ...realizedFixture(), medianCents: null };
  assertEquals(positionRealizedByGrade(r, 7.0), null);
});

Deno.test("assembleRecommendation: realized comps win and are flagged sold-backed", () => {
  const realized = realizedFixture();
  const rec = assembleRecommendation({ realized, activeValue: null, gradeValue: 7.0 });
  assertEquals(rec.soldBacked, true);
  assertEquals(rec.sufficient, true);
  assertEquals(rec.basis, "private_sales");
  assert(rec.recommendedCents !== null);
  assertEquals(rec.compSet.source, "private_sales");
  assertEquals(rec.compSet.count, realized.count);
  // confidence carries through from the realized comp set unchanged.
  assertEquals(rec.confidence, realized.confidence);
  // sell-through is computed (a real label, not "unknown").
  assert(rec.sellThrough.label !== "unknown");
});

Deno.test("assembleRecommendation: realized preferred over active when both present", () => {
  const realized = realizedFixture();
  const activeValue = {
    lowCents: 9999, medianCents: 99999, highCents: 999999,
    sampleSize: 40, confidence: 0.9, sufficient: true, currency: "USD",
  };
  const rec = assembleRecommendation({ realized, activeValue, gradeValue: 7.0 });
  assertEquals(rec.basis, "private_sales");
  assertEquals(rec.soldBacked, true);
  assert(rec.recommendedCents! < 99999, "should ignore the inflated active asks");
});

Deno.test("assembleRecommendation: falls back to active asks, flagged as an estimate", () => {
  const activeValue = {
    lowCents: 2000, medianCents: 4000, highCents: 8000,
    sampleSize: 12, confidence: 0.9, sufficient: true, currency: "USD",
  };
  const rec = assembleRecommendation({ realized: null, activeValue, gradeValue: 7.0 });
  assertEquals(rec.soldBacked, false);
  assertEquals(rec.basis, "active_estimated");
  assertEquals(rec.recommendedCents, 4000);
  // active confidence is dampened below the raw value-range confidence.
  assert(rec.confidence < activeValue.confidence);
  assertEquals(rec.compSet.source, "active_estimated");
});

Deno.test("assembleRecommendation: no comps at all → insufficient, no invented price", () => {
  const rec = assembleRecommendation({ realized: null, activeValue: null, gradeValue: 7.0 });
  assertEquals(rec.sufficient, false);
  assertEquals(rec.recommendedCents, null);
  assertEquals(rec.confidence, 0);
  assertEquals(rec.sellThrough.label, "unknown");
});

Deno.test("assembleRecommendation: insufficient active range stays insufficient", () => {
  const activeValue = {
    lowCents: null, medianCents: null, highCents: null,
    sampleSize: 1, confidence: 0.15, sufficient: false, currency: "USD",
  };
  const rec = assembleRecommendation({ realized: null, activeValue, gradeValue: 7.0 });
  assertEquals(rec.sufficient, false);
  assertEquals(rec.recommendedCents, null);
});

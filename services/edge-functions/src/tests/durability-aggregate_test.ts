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
  // US-2317: the read caps, so the ordering property below is asserted against
  // the real values rather than a copy of them.
  GARMENT_SCAN_CAP,
  GRADE_SCAN_CAP,
  SOLD_EVENT_SCAN_CAP,
} = await import("../lib/durability-aggregate.ts");

// Build a curve point with an overall + uniform factor value, N days after t0.
function pt(
  overall: number,
  factor: number,
  dayOffset: number,
): ConditionCurvePoint {
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
  return [
    pt(startOverall, startOverall, 0),
    pt(startOverall - drop, startOverall - drop, 30),
  ];
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
  assertEquals(
    skuClassKey({ brand: "Gucci", garment_type: "Outerwear" }),
    "gucci::outerwear",
  );
  assertEquals(skuClassKey({ garment_type: "top" }), "");
  assertEquals(
    skuClassLabel({ brand: "Gucci", garment_type: "Outerwear" }),
    "Gucci Outerwear",
  );
});

// ── decay + retention ───────────────────────────────────────────────────────
Deno.test("aggregate: overall decay, retention, per-factor decay over regraded garments", () => {
  const curves = [regraded(8, 1), regraded(9, 2), regraded(7, 0)]; // drops 1, 2, 0
  const m = aggregateDurabilityForClass(curves, []);
  assertEquals(m.regraded_count, 3);
  assertEquals(m.avg_overall_decay, 1); // mean(1,2,0)
  // retention = last/first: 7/8, 7/9, 7/7 → mean ≈ 0.8843
  assert(
    m.avg_retention! > 0.88 && m.avg_retention! < 0.89,
    `retention was ${m.avg_retention}`,
  );
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
  const m = aggregateDurabilityForClass([regraded(8, 1)], [{
    priceCents: 999,
    band: "good",
  }]);
  assertEquals(m.resale_sample, 1);
  assertEquals(m.resale_median_cents, null);
  assertEquals(Object.keys(m.resale_by_band).length, 0);
});

// ── US-1774: brand slug (URL key for /durability/<slug>) ─────────────────────
const { brandSlug } = await import("../lib/durability-index.ts");

Deno.test("brandSlug: URL-safe, lowercased, collapses non-alphanumerics", () => {
  assertEquals(brandSlug("Gucci"), "gucci");
  assertEquals(brandSlug("The North Face"), "the-north-face");
  assertEquals(brandSlug("  Levi's  "), "levi-s");
  assertEquals(brandSlug("A&F"), "a-f");
});

// ── US-2317: the three reads are bounded, and say so when they clip ──
//
// computeDurabilityAggregates loaded garments, public_grade_reports and
// garment_events with NO .limit(), no time window and no cap — and materialized
// all three into JS Maps simultaneously, so peak memory was the sum of all
// three on append-only tables. Every sibling job already declared a cap; this
// was the outlier.
//
// The cap alone is not the fix. A silently short read would compute durability
// rankings over a subset and publish them looking complete — the failure
// vault/10-ops/postgrest-row-cap.md exists for. So truncation is REPORTED.

Deno.test("US-2317: every unbounded read now declares a cap", async () => {
  const src = await Deno.readTextFile(
    new URL("../lib/durability-aggregate.ts", import.meta.url),
  );
  // Each of the three reads must carry a .limit(...) with a named constant.
  for (
    const [table, cap] of [
      ["garments", "GARMENT_SCAN_CAP"],
      ["public_grade_reports", "GRADE_SCAN_CAP"],
      ["garment_events", "SOLD_EVENT_SCAN_CAP"],
    ] as const
  ) {
    const at = src.indexOf(`.from("${table}")`);
    assert(at > 0, `read of ${table} not found`);
    const window = src.slice(at, at + 600);
    assert(window.includes(`.limit(${cap})`), `${table}: read has no ${cap}`);
    // A cap with no ordering makes WHICH rows survive arbitrary and unstable
    // between runs — the same defect recorded against buyer-digest in US-2319.
    assert(
      window.includes(".order("),
      `${table}: capped read has no explicit order`,
    );
  }
});

Deno.test("US-2317: a read that comes back AT its cap is reported as truncated", async () => {
  const src = await Deno.readTextFile(
    new URL("../lib/durability-aggregate.ts", import.meta.url),
  );
  for (
    const cap of ["GARMENT_SCAN_CAP", "GRADE_SCAN_CAP", "SOLD_EVENT_SCAN_CAP"]
  ) {
    // Plain string checks, not a constructed RegExp. The heredoc that wrote
    // this file ate the backslashes out of the pattern, leaving `\s` as a bare
    // `s` and an unbalanced `\)` — so the assertion threw instead of failing
    // informatively. The cap names contain no metacharacters; a regex bought
    // nothing here except a way for the test itself to break.
    assert(
      src.includes(`>= ${cap}`) && src.includes("truncated.push"),
      `${cap}: hitting the cap is not recorded in truncated[]`,
    );
  }
  assert(
    src.includes("truncated: string[]"),
    "the result must carry which tables clipped, not just a boolean",
  );
  assert(
    /console\.warn\([\s\S]{0,200}truncated/.test(src),
    "a truncated run must be loud — it still upserts, so it looks complete",
  );
});

Deno.test("US-2317: the caps are ordered so the largest table is not the tightest", () => {
  // A sanity property rather than a magic number: grades and sold events are
  // per-garment, so their caps must not be BELOW the garment cap or the join
  // starves before the garment list does.
  assert(GRADE_SCAN_CAP >= GARMENT_SCAN_CAP);
  assert(SOLD_EVENT_SCAN_CAP >= GARMENT_SCAN_CAP);
});

// US-1104: Garment Passport resale-value & depreciation forecast. Pure — no DB.
//
// Covers the honesty guarantees in the AC: graceful degradation when sparse,
// condition-adjusted pricing, a fitted depreciation trend when the cohort is rich
// enough, and a default prior (with lower confidence) when it isn't.

import { assert, assertEquals } from "@std/assert";
import {
  type DepreciationForecast,
  forecastDepreciation,
  MIN_SPARSE_OBS,
  type SaleObservation,
} from "../lib/passport-forecast.ts";

const SKU = { brand: "Nike", garment_type: "hoodie", category: "tops" };

function obs(over: Partial<SaleObservation> = {}): SaleObservation {
  return { salePriceCents: 5000, gradeAtSale: 8, soldAt: "2026-01-15", daysToSell: 14, ...over };
}

Deno.test("insufficient cohort → null estimate, never a fabrication", () => {
  const f = forecastDepreciation({ currentGrade: 8, skuClass: SKU }, [obs(), obs()]);
  assertEquals(f.dataQuality, "insufficient");
  assertEquals(f.listPriceCents, null);
  assertEquals(f.resaleValue12moCents, null);
  assertEquals(f.confidence, 0);
  assertEquals(f.isEstimate, true);
});

Deno.test("a junk-priced observation is ignored (drops below the floor)", () => {
  const f = forecastDepreciation({ currentGrade: 8, skuClass: SKU }, [
    obs({ salePriceCents: 0 }),
    obs({ salePriceCents: -100 }),
    obs(),
  ]);
  // Only 1 valid → below MIN_SPARSE_OBS.
  assert(MIN_SPARSE_OBS > 1);
  assertEquals(f.dataQuality, "insufficient");
  assertEquals(f.sampleSize, 1);
});

Deno.test("sparse cohort → forecast with the default rate + lower confidence", () => {
  // 4 sales, no real date spread → can't fit a trend → default 15%/yr.
  const cohort = [1, 2, 3, 4].map((d) =>
    obs({ salePriceCents: 5000, soldAt: `2026-01-0${d}`, daysToSell: 14 })
  );
  const f = forecastDepreciation({ currentGrade: 7, skuClass: SKU }, cohort);
  assertEquals(f.dataQuality, "sparse");
  assertEquals(f.listPriceCents, 5000);
  assertEquals(f.expectedDaysToSell, 14);
  assertEquals(f.annualDepreciationPct, 15); // default prior
  assertEquals(f.resaleValue12moCents, 4250); // 5000 * 0.85
  assert(f.confidence > 0 && f.confidence < 0.6);
});

Deno.test("sufficient cohort with a declining trend → fitted depreciation", () => {
  // 8 monthly sales decaying ~15%/yr; subject at grade 8 (cohort all grade 8).
  const cohort: SaleObservation[] = [];
  for (let m = 0; m < 8; m++) {
    cohort.push(obs({
      salePriceCents: Math.round(10000 * Math.pow(0.85, m / 11)),
      gradeAtSale: 8,
      soldAt: `2025-${String(1 + m).padStart(2, "0")}-15`,
      daysToSell: 20 + m,
    }));
  }
  const f = forecastDepreciation({ currentGrade: 8, skuClass: SKU }, cohort);
  assertEquals(f.dataQuality, "sufficient");
  assert(f.annualDepreciationPct! > 10 && f.annualDepreciationPct! < 25, `dep ${f.annualDepreciationPct}`);
  assert(f.resaleValue12moCents! < f.listPriceCents!, "12-month value should be below list for a depreciating SKU");
  assert(f.confidence > 0.6, `confidence ${f.confidence}`);
  // Interval brackets the point estimate.
  assert(f.resaleValue12moInterval!.lowCents <= f.resaleValue12moCents!);
  assert(f.resaleValue12moInterval!.highCents >= f.resaleValue12moCents!);
});

Deno.test("condition adjustment: a lower-grade subject is valued below the cohort median", () => {
  // Price rises strongly with grade across the cohort; subject grade is low.
  const cohort: SaleObservation[] = [
    obs({ salePriceCents: 4000, gradeAtSale: 5 }),
    obs({ salePriceCents: 6000, gradeAtSale: 7 }),
    obs({ salePriceCents: 8000, gradeAtSale: 9 }),
    obs({ salePriceCents: 9000, gradeAtSale: 10 }),
  ];
  const median = 7000; // (6000+8000)/2
  const low = forecastDepreciation({ currentGrade: 5, skuClass: SKU }, cohort);
  assert(low.listPriceCents! < median, `low-grade ${low.listPriceCents} should be < ${median}`);
  const high = forecastDepreciation({ currentGrade: 10, skuClass: SKU }, cohort);
  assert(high.listPriceCents! > median, `high-grade ${high.listPriceCents} should be > ${median}`);
});

Deno.test("never extrapolates outside the observed price envelope", () => {
  const cohort: SaleObservation[] = [
    obs({ salePriceCents: 4000, gradeAtSale: 6 }),
    obs({ salePriceCents: 5000, gradeAtSale: 7 }),
    obs({ salePriceCents: 6000, gradeAtSale: 8 }),
  ];
  // A wildly out-of-range grade must clamp into [4000, 6000].
  const f: DepreciationForecast = forecastDepreciation({ currentGrade: 0, skuClass: SKU }, cohort);
  assert(f.listPriceCents! >= 4000 && f.listPriceCents! <= 6000, `clamped ${f.listPriceCents}`);
});

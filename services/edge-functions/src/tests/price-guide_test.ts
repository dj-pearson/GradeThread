// US-1285: unit tests for the Resale Condition Index price-guide folding.
//
// foldCurveToBands / buildPriceGuideEntry / the sandbox builders are pure, but
// price-guide.ts imports the service-role supabase client at load (via
// condition-index.ts), so set dummy env BEFORE the dynamic import (mirrors
// resale-condition_test.ts).
//
//   deno test --allow-env src/tests/price-guide_test.ts

import { assert, assertEquals } from "@std/assert";
import { describeValueBasis } from "../lib/value-disclosure.ts";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  foldCurveToBands,
  buildPriceGuideEntry,
  sandboxPriceGuideEntry,
  sandboxPriceGuideCatalog,
} = await import("../lib/price-guide.ts");

type Point = Parameters<typeof foldCurveToBands>[0][number];
type ResaleBand = Parameters<typeof foldCurveToBands>[2][number];

function point(grade: number, mid: number, sample = 5): Point {
  return {
    grade,
    lowCents: Math.round(mid * 0.8),
    medianCents: mid,
    highCents: Math.round(mid * 1.2),
    sampleSize: sample,
  };
}

function resaleBand(key: ResaleBand["key"], sellThrough: number | null, days: number | null): ResaleBand {
  return {
    key,
    label: key,
    fulfilled_sales: 0,
    returns: 0,
    return_rate: null,
    listed: 0,
    sold: 0,
    sell_through: sellThrough,
    median_days_to_sell: days,
    median_sale_price: null,
  };
}

Deno.test("foldCurveToBands buckets grade points into the three bands", () => {
  const points = [
    point(9.5, 10000), // high
    point(8.5, 9000), // high
    point(8, 7000), // mid
    point(7, 6000), // mid
    point(6, 4000), // low
    point(4, 2000), // low
  ];
  const resale = [
    resaleBand("high", 0.8, 10),
    resaleBand("mid", 0.6, 18),
    resaleBand("low", 0.4, 30),
  ];
  const bands = foldCurveToBands(points, "USD", resale);
  assertEquals(bands.length, 3);
  assertEquals(bands.map((b) => b.band), ["high", "mid", "low"]);

  const high = bands[0]!;
  // value range spans the band's points (min low … max high), median of medians.
  assertEquals(high.valueLowCents, Math.round(9000 * 0.8));
  assertEquals(high.valueHighCents, Math.round(10000 * 1.2));
  assertEquals(high.valueMedianCents, (10000 + 9000) / 2);
  assertEquals(high.valueSampleSize, 10);
  // platform-wide sell-through attached from the matching resale band.
  assertEquals(high.sellThrough, 0.8);
  assertEquals(high.medianDaysToSell, 10);
});

Deno.test("foldCurveToBands omits bands with no sufficient points (no data → not shown)", () => {
  // Only high-band points present → mid/low must NOT appear.
  const points = [point(9, 12000), point(8.5, 11000)];
  const bands = foldCurveToBands(points, "USD", []);
  assertEquals(bands.length, 1);
  assertEquals(bands[0]!.band, "high");
  // No resale band supplied → sell-through is null, value range still publishes.
  assertEquals(bands[0]!.sellThrough, null);
  assertEquals(bands[0]!.medianDaysToSell, null);
  assert(bands[0]!.valueMedianCents !== null);
});

Deno.test("buildPriceGuideEntry carries curve identity + scope marker", () => {
  const curve = {
    slug: "patagonia-jackets",
    label: "Patagonia Jackets",
    brand: "Patagonia",
    categoryId: "57988",
    currency: "USD",
    points: [point(9, 15000), point(7, 9000)],
    totalSampleSize: 40,
    refreshedAt: "2026-06-20T00:00:00.000Z",
    provenance: "seeded" as const,
    // US-2850: the DTO carries its own worded provenance line, built the same
    // way condition-index builds it, so the fixture is a real curve.
    disclosure: describeValueBasis({
      source: "comp_median",
      sufficient: true,
      sampleSize: 40,
      medianCents: 15000,
      currency: "USD",
    }),
  };
  const entry = buildPriceGuideEntry(curve, [resaleBand("high", 0.7, 12)]);
  assertEquals(entry.slug, "patagonia-jackets");
  assertEquals(entry.brand, "Patagonia");
  assertEquals(entry.sellThroughScope, "platform");
  assertEquals(entry.bands.map((b) => b.band), ["high", "mid"]);
  assertEquals(entry.bands[0]!.sellThrough, 0.7);
});

Deno.test("sandboxPriceGuideEntry is deterministic and value descends by band", () => {
  const a = sandboxPriceGuideEntry("levis-501-jeans");
  const b = sandboxPriceGuideEntry("levis-501-jeans");
  assertEquals(a, b); // deterministic for the same slug
  assertEquals(a.bands.length, 3);
  // Higher condition → higher value and higher sell-through.
  assert(a.bands[0]!.valueMedianCents! > a.bands[1]!.valueMedianCents!);
  assert(a.bands[1]!.valueMedianCents! > a.bands[2]!.valueMedianCents!);
  assert(a.bands[0]!.sellThrough! > a.bands[2]!.sellThrough!);
  // different slug → different anchor (very high probability).
  const c = sandboxPriceGuideEntry("nike-vintage-tees");
  assert(c.bands[0]!.valueMedianCents !== a.bands[0]!.valueMedianCents);
});

Deno.test("sandboxPriceGuideCatalog returns a non-empty sample", () => {
  const items = sandboxPriceGuideCatalog();
  assert(items.length >= 1);
  assertEquals(items[0]!.slug, "sample-item");
});

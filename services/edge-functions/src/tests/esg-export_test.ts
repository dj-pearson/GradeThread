// US-1788: brand ESG export — pure aggregation + CSV.
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", "https://example.test");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "dummy");

const { aggregateBrandImpact, toEsgCsv, ESG_MIN_GRADES_PER_BRAND } = await import("../lib/esg-export.ts");

const est = (co2e: number, water: number, landfill: number) => ({
  estimate: true as const,
  co2e_kg: co2e,
  water_liters: water,
  landfill_kg: landfill,
  source: "s",
  version: "v",
  methodology: "m",
});
const IMPACT = {
  tops: est(2.5, 2500, 0.2),
  bottoms: est(12, 3500, 0.6),
};

Deno.test("aggregateBrandImpact: sums per-brand impact, sorted by graded volume", () => {
  const rows = [
    ...Array.from({ length: 6 }, () => ({ brand: "Alpha", garment_type: "tops" })),
    ...Array.from({ length: 4 }, () => ({ brand: "Alpha", garment_type: "bottoms" })),
    ...Array.from({ length: 5 }, () => ({ brand: "Beta", garment_type: "tops" })),
  ];
  const out = aggregateBrandImpact(rows, IMPACT);
  assertEquals(out.length, 2);
  assertEquals(out[0].brand, "Alpha"); // 10 graded > Beta's 5
  assertEquals(out[0].graded_count, 10);
  assertEquals(out[0].co2e_kg, 63); // 2.5*6 + 12*4 = 63
  assertEquals(out[1].brand, "Beta");
});

Deno.test("aggregateBrandImpact: a brand below the grade floor is withheld (anonymity gate)", () => {
  const rows = [
    ...Array.from({ length: ESG_MIN_GRADES_PER_BRAND - 1 }, () => ({ brand: "Thin", garment_type: "tops" })),
  ];
  assertEquals(aggregateBrandImpact(rows, IMPACT).length, 0);
});

Deno.test("aggregateBrandImpact: skips rows missing brand or type", () => {
  const rows = [
    ...Array.from({ length: 6 }, () => ({ brand: "Alpha", garment_type: "tops" })),
    { brand: null, garment_type: "tops" },
    { brand: "Alpha", garment_type: null },
  ];
  const out = aggregateBrandImpact(rows, IMPACT);
  assertEquals(out[0].graded_count, 6);
});

Deno.test("toEsgCsv: header + methodology comment + quoted brand with comma", () => {
  const csv = toEsgCsv([{ brand: "A, Inc", graded_count: 6, co2e_kg: 15, water_liters: 15000, landfill_kg: 1.2 }]);
  assert(csv.startsWith("# GradeThread ESG export"));
  assert(csv.includes("brand,graded_count,co2e_kg_avoided,water_liters_avoided,landfill_kg_diverted"));
  assert(csv.includes('"A, Inc",6,15,15000,1.2'));
});

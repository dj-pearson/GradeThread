// US-1786: circularity impact estimate — pure math + fallback shape.
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", "https://example.test");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "dummy");

const {
  estimateFromFactor,
  FALLBACK_FACTORS,
  IMPACT_METHODOLOGY,
} = await import("../lib/impact-estimate.ts");

function factor(over: Record<string, unknown> = {}) {
  return {
    garment_type: "bottoms",
    material: "default",
    co2e_kg: 12,
    water_liters: 3500,
    weight_kg: 0.6,
    source: "test source",
    version: "2026-07",
    ...over,
  };
}

Deno.test("estimateFromFactor: labels an estimate, rounds sensibly, carries source", () => {
  const e = estimateFromFactor(factor());
  assertEquals(e.estimate, true);
  assertEquals(e.co2e_kg, 12);
  assertEquals(e.water_liters, 3500);
  assertEquals(e.landfill_kg, 0.6);
  assertEquals(e.source, "test source");
  assertEquals(e.methodology, IMPACT_METHODOLOGY);
});

Deno.test("estimateFromFactor: scales by quantity and rounds (no false precision)", () => {
  const e = estimateFromFactor(factor({ co2e_kg: 2.53, water_liters: 2497, weight_kg: 0.204 }), 3);
  assertEquals(e.co2e_kg, 7.6); // 2.53*3 = 7.59 → 7.6
  assertEquals(e.water_liters, 7490); // 2497*3 = 7491 → nearest 10
  assertEquals(e.landfill_kg, 0.61); // 0.204*3 = 0.612 → 0.61
});

Deno.test("estimateFromFactor: a non-positive quantity is treated as 1", () => {
  const e = estimateFromFactor(factor(), 0);
  assertEquals(e.co2e_kg, 12);
});

Deno.test("FALLBACK_FACTORS: covers every garment_type with a source", () => {
  for (const type of ["tops", "bottoms", "outerwear", "dresses", "footwear", "accessories"]) {
    const f = FALLBACK_FACTORS[type];
    assert(f, `missing fallback for ${type}`);
    assert(f.co2e_kg > 0 && f.water_liters > 0 && f.weight_kg > 0);
    assert(f.source.length > 0);
  }
});

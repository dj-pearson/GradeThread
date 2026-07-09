// US-1787: client-side closet impact aggregation.
import { describe, expect, it } from "vitest";
import { sumImpacts, formatCo2e, formatWater } from "@/lib/impact";

const est = (co2e: number, water: number, landfill: number) => ({
  estimate: true as const,
  co2e_kg: co2e,
  water_liters: water,
  landfill_kg: landfill,
  source: "s",
  version: "v",
  methodology: "m",
});

describe("sumImpacts", () => {
  it("sums estimates × counts and rounds", () => {
    const t = sumImpacts([
      { estimate: est(2.5, 2500, 0.2), count: 4 },
      { estimate: est(12, 3500, 0.6), count: 2 },
    ]);
    expect(t.garment_count).toBe(6);
    expect(t.co2e_kg).toBe(34);
    expect(t.water_liters).toBe(17000);
    expect(t.landfill_kg).toBe(2);
  });
  it("empty → zeros", () => {
    expect(sumImpacts([]).garment_count).toBe(0);
  });
});

describe("formatting", () => {
  it("scales large CO2e to tonnes and water to k L", () => {
    expect(formatCo2e(1500)).toBe("1.5 t CO₂e");
    expect(formatCo2e(40)).toBe("40 kg CO₂e");
    expect(formatWater(17000)).toBe("17k L water");
  });
});

import { describe, it, expect } from "vitest";
import {
  DIM_DIVISOR,
  FLAT_RATE_OPTIONS,
  GROUND_ADVANTAGE_BY_POUND,
  GROUND_ADVANTAGE_UNDER_1LB,
  PRIORITY_MAIL_BY_POUND,
  USPS_RATES_EFFECTIVE_FROM,
  billableWeight,
  estimateZone,
  quoteShipping,
  roundDimension,
} from "../usps-rate-schedule";
import { zip3Centroid } from "../zip3-centroids";

describe("rate tables", () => {
  it("carries an effective date", () => {
    expect(USPS_RATES_EFFECTIVE_FROM).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("covers 1 to 70 lb in eight zones for both services", () => {
    expect(GROUND_ADVANTAGE_BY_POUND).toHaveLength(70);
    expect(PRIORITY_MAIL_BY_POUND).toHaveLength(70);
    for (const row of [...GROUND_ADVANTAGE_BY_POUND, ...PRIORITY_MAIL_BY_POUND]) {
      expect(row).toHaveLength(8);
      expect(row.every((p) => p > 0)).toBe(true);
    }
    expect(GROUND_ADVANTAGE_UNDER_1LB).toHaveLength(8);
  });

  it("matches the confirmed values in docs/seo/usps-rate-schedule-CONFIRMED.csv", () => {
    // Sentinels. If a rate edit lands without a source, one of these fails.
    expect(GROUND_ADVANTAGE_BY_POUND[0]).toEqual([7.61, 7.68, 8.0, 8.15, 8.74, 9.63, 9.98, 10.67]);
    expect(GROUND_ADVANTAGE_UNDER_1LB[0]).toBe(6.93);
    expect(FLAT_RATE_OPTIONS.find((o) => o.key === "padded-envelope")?.price).toBe(11.99);
    expect(FLAT_RATE_OPTIONS.find((o) => o.key === "medium-box")?.price).toBe(21.17);
  });

  it("prices go up with distance in every weight row", () => {
    for (const row of GROUND_ADVANTAGE_BY_POUND) {
      for (let z = 1; z < row.length; z++) expect(row[z]!).toBeGreaterThanOrEqual(row[z - 1]!);
    }
  });

  it("keeps the sub-pound rate below the 1 lb rate, which is the cliff at 16 oz", () => {
    for (let z = 0; z < 8; z++) {
      expect(GROUND_ADVANTAGE_UNDER_1LB[z]!).toBeLessThan(GROUND_ADVANTAGE_BY_POUND[0]![z]!);
    }
  });
});

describe("dimensional weight", () => {
  it("rounds every fractional dimension up before measuring", () => {
    expect(roundDimension(10.1)).toBe(11);
    expect(roundDimension(12)).toBe(12);
  });

  it("ignores dimensions below one cubic foot", () => {
    // 12 x 9 x 4 = 432 cu in, well under 1728.
    const w = billableWeight({ weightOz: 20, lengthIn: 12, widthIn: 9, heightIn: 4 });
    expect(w.dimLb).toBeNull();
    expect(w.dimApplies).toBe(false);
    expect(w.billableLb).toBe(2);
  });

  it("charges dimensional weight on a big light box, which is the case sellers get wrong", () => {
    // A puffer jacket: 18 x 14 x 10 = 2,520 cu in, 2 lb on the scale.
    const w = billableWeight({ weightOz: 32, lengthIn: 18, widthIn: 14, heightIn: 10 });
    expect(w.actualLb).toBe(2);
    expect(w.cubicInches).toBe(2520);
    expect(w.dimLb).toBe(Math.ceil(2520 / DIM_DIVISOR)); // 19 lb
    expect(w.dimApplies).toBe(true);
    expect(w.billableLb).toBe(19);

    const quote = quoteShipping({ weightOz: 32, lengthIn: 18, widthIn: 14, heightIn: 10 }, 4);
    const ga = quote.services.find((s) => s.key === "ground-advantage");
    // Billed at 19 lb, not 2 lb: $19.36 rather than $8.51 in Zone 4.
    expect(ga?.price).toBe(GROUND_ADVANTAGE_BY_POUND[18]![3]);
    expect(ga?.price).toBeGreaterThan(GROUND_ADVANTAGE_BY_POUND[1]![3]!);
  });

  it("applies the rounding before the cubic-foot test, so 11.5 inches is 12", () => {
    // 11.5^3 = 1,520 cu in and would escape the test; 12^3 = 1,728 does not
    // exceed it either, so the next inch up is where it bites.
    const under = billableWeight({ weightOz: 16, lengthIn: 11.5, widthIn: 11.5, heightIn: 11.5 });
    expect(under.cubicInches).toBe(1728);
    expect(under.dimLb).toBeNull();
    const over = billableWeight({ weightOz: 16, lengthIn: 12.1, widthIn: 12, heightIn: 12 });
    expect(over.cubicInches).toBe(13 * 12 * 12);
    expect(over.dimLb).not.toBeNull();
  });
});

describe("flat rate versus weight based", () => {
  it("flat rate wins on a heavy coast-to-coast package", () => {
    // 6 lb medium box to Zone 8: weight-based Ground Advantage is $20.68.
    const quote = quoteShipping({ weightOz: 96, lengthIn: 11, widthIn: 8.5, heightIn: 5.5 }, 8);
    expect(quote.cheapestFlatRate?.price).toBe(21.17);
    expect(quote.cheapestWeightBased?.price).toBe(20.68);
    // Ground Advantage still edges it, which is the honest answer at 6 lb.
    expect(quote.cheapest?.key).toBe("ground-advantage");
  });

  it("flat rate wins outright once the package is heavy enough", () => {
    // 12 lb in the same medium box to Zone 8.
    const quote = quoteShipping({ weightOz: 192, lengthIn: 11, widthIn: 8.5, heightIn: 5.5 }, 8);
    expect(quote.cheapest?.flatRate?.key).toBe("medium-box");
    expect(quote.cheapest?.price).toBe(21.17);
    expect(quote.cheapestWeightBased!.price).toBeGreaterThan(21.17);
  });

  it("loses on a light local package, where Ground Advantage is half the price", () => {
    const quote = quoteShipping({ weightOz: 10, lengthIn: 12, widthIn: 9, heightIn: 0.7 }, 1);
    expect(quote.cheapest?.key).toBe("ground-advantage");
    expect(quote.cheapest?.price).toBe(6.93);
    expect(quote.cheapestFlatRate!.price).toBeGreaterThan(11);
  });

  it("does not offer a flat-rate container the package cannot fit in", () => {
    const quote = quoteShipping({ weightOz: 160, lengthIn: 20, widthIn: 16, heightIn: 12 }, 5);
    expect(quote.services.some((s) => s.flatRate)).toBe(false);
  });
});

describe("zone estimation", () => {
  it("puts Manhattan to Brooklyn in Zone 1 and Manhattan to Los Angeles in Zone 8", () => {
    expect(estimateZone("10001", "11201", zip3Centroid)?.zone).toBe(1);
    expect(estimateZone("10001", "90210", zip3Centroid)?.zone).toBe(8);
  });

  it("returns null rather than guessing on an unknown prefix", () => {
    expect(estimateZone("00000", "90210", zip3Centroid)).toBeNull();
    expect(estimateZone("abc", "90210", zip3Centroid)).toBeNull();
  });

  it("reads a real centroid for a known prefix", () => {
    const chicago = zip3Centroid("606");
    expect(chicago!.lat).toBeCloseTo(41.83, 1);
    expect(chicago!.lon).toBeCloseTo(-87.68, 1);
  });
});

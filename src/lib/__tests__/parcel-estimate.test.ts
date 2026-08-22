// US-2790: the predicted parcel, and the mirror that must not drift.
//
// The estimator exists because listing-profit.ts takes a shippingCost "if
// known" and it is almost never known — autolister-bulk-edit.tsx passes none,
// so "floor at 30% margin" across 40 drafts prices every one as if postage
// were free. These cases pin the SHAPE of the answer rather than the exact
// numbers, because the numbers are seeded estimates and the feedback loop is
// what will make them real. A test that froze them would make correcting them
// a test edit, which is how a seeded number becomes a permanent one.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { GARMENT_CATEGORIES } from "@/lib/constants";
import type { GarmentCategory } from "@/types/database";
import {
  BASE_WEIGHT_OZ,
  DIM_DIVISOR,
  DIM_THRESHOLD_CU_IN,
  dimensionalWeightOz,
  dimensionalWeightOzForCubicInches,
  estimateParcel,
  PACK_DIMENSIONS,
  PACKAGING_WEIGHT_OZ,
  type ParcelGarmentCategory,
} from "../parcel-estimate";

// ── The category union cannot drift from the database enum ────────────────
//
// parcel-estimate.ts declares its own union rather than importing
// GarmentCategory, because it is mirrored into the Deno tree and `deno check`
// cannot resolve the `@/` alias even for a type-only import. That freedom is
// exactly what would let the two lists diverge, so they are pinned here, on
// the web side, where the canonical type is available.
//
// Assignability is asserted BOTH ways deliberately. One direction alone would
// let a category be added to the database enum and silently fall through to
// `other` — shipping a t-shirt's weight for a wedding dress and reporting it
// as a category-based estimate.
type Assert<T extends true> = T;
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
export type CategoriesMatch = Assert<Equal<ParcelGarmentCategory, GarmentCategory>>;

describe("estimateParcel weight", () => {
  it("returns the category base weight plus packaging when nothing else is known", () => {
    const r = estimateParcel({
      garmentCategory: "t-shirt",
      material: null,
      measurements: null,
      size: null,
    });
    // 5.5 oz base + 0.5 oz small poly mailer.
    expect(r.weightOz).toBeCloseTo(6.0, 2);
    expect(r.confidence).toBe("rough");
    expect(r.basis).toEqual(["category"]);
  });

  it("scales up for a large chest measurement", () => {
    const small = estimateParcel({
      garmentCategory: "t-shirt",
      material: "cotton",
      measurements: { chest: 19 },
      size: null,
    });
    const large = estimateParcel({
      garmentCategory: "t-shirt",
      material: "cotton",
      measurements: { chest: 26 },
      size: null,
    });
    expect(large.weightOz).toBeGreaterThan(small.weightOz);
    expect(large.confidence).toBe("good");
    expect(large.basis).toEqual(["category", "measurements", "material"]);
  });

  it("makes denim heavier than the same garment in poly", () => {
    const denim = estimateParcel({
      garmentCategory: "jeans",
      material: "denim",
      measurements: null,
      size: null,
    });
    const poly = estimateParcel({
      garmentCategory: "jeans",
      material: "polyester",
      measurements: null,
      size: null,
    });
    expect(denim.weightOz).toBeGreaterThan(poly.weightOz);
  });

  it("clamps an absurd measurement instead of returning a fantasy weight", () => {
    const r = estimateParcel({
      garmentCategory: "t-shirt",
      material: null,
      measurements: { chest: 400 },
      size: null,
    });
    // Clamped at 1.45x base, plus packaging. Never unbounded.
    expect(r.weightOz).toBeLessThan(10);
  });

  it("ignores an unrecognized material rather than guessing", () => {
    const known = estimateParcel({
      garmentCategory: "shirt",
      material: null,
      measurements: null,
      size: null,
    });
    const weird = estimateParcel({
      garmentCategory: "shirt",
      material: "moon fibre",
      measurements: null,
      size: null,
    });
    expect(weird.weightOz).toBeCloseTo(known.weightOz, 2);
  });
});

describe("US-2790: the inputs it must not trust", () => {
  it("reads a measurement stored as a string, because the jsonb holds both", () => {
    // The column is jsonb and sellers' values arrive as "26" as often as 26.
    // Number.parseFloat handles it; the point is that it is not silently
    // dropped, which would quietly downgrade confidence to "rough".
    const asString = estimateParcel({
      garmentCategory: "t-shirt",
      material: "cotton",
      measurements: { chest: "26" },
      size: null,
    });
    const asNumber = estimateParcel({
      garmentCategory: "t-shirt",
      material: "cotton",
      measurements: { chest: 26 },
      size: null,
    });
    expect(asString.weightOz).toBeCloseTo(asNumber.weightOz, 6);
    expect(asString.basis).toContain("measurements");
  });

  it("treats a zero, negative or unparseable measurement as absent, not as a size", () => {
    // Zero is the dangerous one: a naive Number() makes it a real value, and a
    // ratio of 0/21 would clamp to 0.75 and return a CONFIDENT under-estimate.
    for (const chest of [0, -4, "", "  ", "abc"] as Array<number | string>) {
      const r = estimateParcel({
        garmentCategory: "t-shirt",
        material: "cotton",
        measurements: { chest },
        size: null,
      });
      expect(r.basis, `chest ${JSON.stringify(chest)}`).not.toContain("measurements");
      expect(r.confidence, `chest ${JSON.stringify(chest)}`).toBe("rough");
    }
  });

  it("measures trousers at the waist, not the chest", () => {
    // A chest measurement on jeans is not a signal about jeans. Reading it
    // would make an unrelated number move the weight.
    const withChest = estimateParcel({
      garmentCategory: "jeans",
      material: "denim",
      measurements: { chest: 40 },
      size: null,
    });
    const withWaist = estimateParcel({
      garmentCategory: "jeans",
      material: "denim",
      measurements: { waist: 34 },
      size: null,
    });
    expect(withChest.basis).not.toContain("measurements");
    expect(withWaist.basis).toContain("measurements");
  });

  it("falls back to the `other` base weight for a null category rather than throwing", () => {
    const r = estimateParcel({
      garmentCategory: null,
      material: null,
      measurements: null,
      size: null,
    });
    expect(r.weightOz).toBeCloseTo(12 + PACKAGING_WEIGHT_OZ.mailer_small, 2);
    expect(r.basis).toEqual([]);
    expect(r.confidence).toBe("rough");
  });

  it("is deterministic — the same input twice gives the same answer", () => {
    // Stated as a case because the module's header promises it: this runs on
    // every keystroke in the composer and the number gets stored and compared
    // against a real shipment later.
    const input = {
      garmentCategory: "coat" as const,
      material: "wool",
      measurements: { chest: 24 },
      size: null,
    };
    expect(estimateParcel(input)).toEqual(estimateParcel(input));
  });

  it("prefers the longer material name — polyester is not poly-anything", () => {
    // MATERIAL_MULTIPLIERS is ordered longest-first for exactly this. If a
    // shorter needle were matched first, "polyester" would take the wrong
    // multiplier and nothing would look wrong.
    const poly = estimateParcel({
      garmentCategory: "shirt",
      material: "100% polyester",
      measurements: null,
      size: null,
    });
    const cotton = estimateParcel({
      garmentCategory: "shirt",
      material: "100% cotton",
      measurements: null,
      size: null,
    });
    expect(poly.weightOz).toBeLessThan(cotton.weightOz);
  });
});

describe("US-2790: the edge mirror does not drift", () => {
  // The Deno edge cannot import from src/, so this module is duplicated
  // VERBATIM. The copies are held byte-identical here, following the pattern
  // src/lib/ebay-fees.ts already uses — a divergence is silent otherwise, and
  // the two runtimes would price the same parcel differently.
  const here = resolve(process.cwd(), "src/lib/parcel-estimate.ts");
  const mirror = resolve(
    process.cwd(),
    "services/edge-functions/src/lib/parcel-estimate.ts",
  );

  it("services/edge-functions copy is byte-identical to the canonical file", () => {
    expect(readFileSync(mirror, "utf8")).toBe(readFileSync(here, "utf8"));
  });

  it("the mirrored module imports nothing, so Deno can typecheck it", () => {
    // The reason the byte-identical copy is possible at all. A single import —
    // even `import type` — makes `deno check` fail on the `@/` alias, which is
    // how the first draft of this module broke. Asserted rather than trusted,
    // because the failure appears in a different runtime from the edit.
    const src = readFileSync(here, "utf8");
    const importLines = src
      .split("\n")
      .filter((l) => /^\s*import\b/.test(l) && !l.trimStart().startsWith("//"));
    expect(importLines, "parcel-estimate.ts must stay import-free").toEqual([]);
  });

  it("every database category has a weight, checked at runtime as well as by type", () => {
    // The type assertion at the top of this file catches a drift at compile
    // time. This catches the same thing from the constants list, which is what
    // the UI actually iterates — a category present in the type but missing a
    // weight would be `undefined * factor` and produce NaN ounces.
    for (const cat of GARMENT_CATEGORIES) {
      expect(BASE_WEIGHT_OZ[cat as ParcelGarmentCategory], `no weight for ${cat}`)
        .toBeGreaterThan(0);
    }
    expect(Object.keys(BASE_WEIGHT_OZ).sort()).toEqual([...GARMENT_CATEGORIES].sort());
  });
});

describe("US-2790: pack selection", () => {
  it("puts footwear in a box, not a mailer", () => {
    const r = estimateParcel({
      garmentCategory: "boots",
      material: null,
      measurements: null,
      size: null,
    });
    expect(r.pack).toBe("box_medium");
  });

  it("puts a t-shirt in a small mailer", () => {
    const r = estimateParcel({
      garmentCategory: "t-shirt",
      material: null,
      measurements: null,
      size: null,
    });
    expect(r.pack).toBe("mailer_small");
  });

  it("upgrades to a large mailer once the garment is bulky", () => {
    const r = estimateParcel({
      garmentCategory: "coat",
      material: "wool",
      measurements: null,
      size: null,
    });
    expect(r.pack).toBe("mailer_large");
  });

  it("EVERY boxed category is boxed, not just the two spot-checked", () => {
    // Sabotage found this: removing "sneakers" from BOXED changed nothing,
    // because the cases below happen to use boots and sandals.
    for (const cat of ["sneakers", "boots", "sandals", "bag"] as const) {
      const r = estimateParcel({
        garmentCategory: cat,
        material: null,
        measurements: null,
        size: null,
      });
      expect(r.pack, `${cat} should be boxed`).toMatch(/^box_/);
    }
  });

  it("a lighter boot still gets the small box", () => {
    const r = estimateParcel({
      garmentCategory: "sandals",
      material: null,
      measurements: null,
      size: null,
    });
    expect(r.pack).toBe("box_small");
  });
});

describe("US-2790: dimensional weight, against the published USPS rule", () => {
  // Divisor 139, threshold 1,728 cubic inches, rounded UP to whole pounds.
  // Read 2026-08-22 from USPS's own Domestic Mail Manual (Priority DMM 123 and
  // Ground Advantage DMM 283) and recorded in
  // docs/shipping/usps-dim-weight-CONFIRMED.csv. The design draft said 166,
  // which is the UPS/FedEx divisor.

  it("uses 139 and a one-cubic-foot threshold, not the UPS numbers", () => {
    expect(DIM_DIVISOR).toBe(139);
    expect(DIM_THRESHOLD_CU_IN).toBe(1728);
  });

  it("⚠ NO CURRENT PACK TRIPS THE RULE — every one is under a cubic foot", () => {
    // This is the finding, pinned so it cannot change silently. The seeded
    // pack sizes top out at box_medium (16 x 12 x 8 = 1,536 cu in), which is
    // BELOW the 1,728 threshold, so dimensional weight never engages today.
    //
    // That is correct behaviour for these sizes — USPS genuinely bills a
    // sub-cubic-foot parcel on actual weight — and it means the "bulky and
    // light" case the spec calls out as where sellers lose the most is NOT yet
    // covered. Making it engage needs a real pack size read off a real box,
    // not a number invented to satisfy a test.
    for (const pack of Object.keys(PACK_DIMENSIONS) as Array<keyof typeof PACK_DIMENSIONS>) {
      const d = PACK_DIMENSIONS[pack];
      const cubic = d.lengthIn * d.widthIn * d.heightIn;
      expect(cubic, `${pack} is ${cubic} cu in`).toBeLessThanOrEqual(DIM_THRESHOLD_CU_IN);
      expect(dimensionalWeightOz(pack), `${pack}`).toBe(0);
    }
  });

  it("no estimate reports a dimensional basis while that holds", () => {
    for (const cat of GARMENT_CATEGORIES) {
      const r = estimateParcel({
        garmentCategory: cat as ParcelGarmentCategory,
        material: "down",
        measurements: null,
        size: null,
      });
      expect(r.basis, `${cat}`).not.toContain("dimensional");
      expect(r.billableWeightOz, `${cat}`).toBeCloseTo(r.weightOz, 6);
    }
  });

  it("CALLS the rule at a size that trips it, rather than re-deriving it", () => {
    // 3,840 cu in / 139 = 27.6 lb, rounded up to 28 lb = 448 oz.
    // With the design's 166 it would be 24 lb — 4 lb light, and light is the
    // direction that costs the seller.
    expect(dimensionalWeightOzForCubicInches(20 * 16 * 12)).toBe(448);
  });

  it("rounds UP to whole pounds before converting, as published", () => {
    // 1,729 cu in / 139 = 12.44 lb. Published rule rounds up to 13 lb = 208 oz.
    // Rounding in OUNCES instead gives 199 and under-reports by 9. This case
    // calls the function, so replacing the ceiling with a round fails here —
    // it did not when the expectation re-computed the formula itself.
    expect(dimensionalWeightOzForCubicInches(1729)).toBe(208);
  });

  it("the threshold is strict — exactly one cubic foot bills on actual weight", () => {
    // Published as "exceeding 1 cubic foot", so 1,728 is out and 1,729 is in.
    // An inclusive comparison here would silently start billing a whole class
    // of parcels on size.
    expect(dimensionalWeightOzForCubicInches(DIM_THRESHOLD_CU_IN)).toBe(0);
    expect(dimensionalWeightOzForCubicInches(DIM_THRESHOLD_CU_IN + 1)).toBeGreaterThan(0);
  });

  it("refuses a nonsense volume rather than returning NaN ounces", () => {
    for (const cu of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = dimensionalWeightOzForCubicInches(cu);
      expect(Number.isFinite(r) || r === 0, `cu ${cu}`).toBe(true);
    }
    expect(dimensionalWeightOzForCubicInches(Number.NaN)).toBe(0);
  });
});

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
  estimateParcel,
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

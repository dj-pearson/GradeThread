import { describe, expect, it } from "vitest";
import {
  buildSizeConflicts,
  sizeBandPairKey,
  sizeBandPairs,
  sizeWarningsFrom,
  type SizeCheckableDraft,
} from "@/pages/flipdesk/autolister/group-warnings";
import type { SizeBandsResponse } from "@/lib/size-check";

// US-2919: the AutoLister queue's size-versus-measurements warning.
//
// The property that matters on a batch screen is RESTRAINT. A queue that flags
// forty drafts has said nothing; the point is to name the two or three whose
// size disagrees with their own numbers and leave the rest alone.

function bandsFor(over: Partial<SizeBandsResponse> = {}): SizeBandsResponse {
  return {
    tier: "brand",
    brandLabel: "Lululemon",
    department: "Men",
    garment: "Tops",
    sourceUrl: null,
    sizeSystem: "alpha",
    sizeClass: "standard",
    measurementBasis: "body",
    rows: [
      { size: "XS", index: 0, bands: { chest: [18, 22.5] } },
      { size: "S", index: 1, bands: { chest: [19, 23.5] } },
      { size: "M", index: 2, bands: { chest: [20.5, 25] } },
      { size: "L", index: 3, bands: { chest: [22, 26.5] } },
      { size: "XL", index: 4, bands: { chest: [23.5, 28] } },
      { size: "XXL", index: 5, bands: { chest: [25, 29.5] } },
    ],
    ...over,
  };
}

function draft(over: Partial<SizeCheckableDraft> = {}): SizeCheckableDraft {
  return {
    itemId: "i1",
    name: "Lululemon Metal Vent Tech",
    brand: "Lululemon",
    garment: "tee",
    gender: "Men",
    size: "L",
    measurements: { chest: 23 },
    ...over,
  };
}

const PAIR = sizeBandPairKey("Lululemon", "tee", "Men");
const BANDS = { [PAIR]: bandsFor() };

describe("a batch of three where exactly one is mis-sized", () => {
  const drafts = [
    draft({ itemId: "i1", name: "Correct L", size: "L", measurements: { chest: 23 } }),
    // 17.5 in flat is below every size Lululemon makes — this is the one.
    draft({ itemId: "i2", name: "Mislabelled L", size: "L", measurements: { chest: 17.5 } }),
    draft({ itemId: "i3", name: "Correct M", size: "M", measurements: { chest: 22 } }),
  ];

  it("produces exactly one conflict", () => {
    const conflicts = buildSizeConflicts(drafts, BANDS);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.itemId).toBe("i2");
    expect(conflicts[0]?.impliedSize).toBe("smaller than XS");
    expect(conflicts[0]?.labelled).toBe("L");
  });

  it("produces exactly one warning, naming the item and both sizes", () => {
    const warnings = sizeWarningsFrom(buildSizeConflicts(drafts, BANDS));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.key).toBe("size-i2");
    expect(warnings[0]?.groupId).toBe("i2");
    expect(warnings[0]?.label).toContain("Mislabelled L");
    expect(warnings[0]?.label).toContain("labelled L");
    expect(warnings[0]?.label).toContain("smaller than XS");
  });
});

describe("silence", () => {
  it("an item with no chart at any tier produces no warning and no empty state", () => {
    const conflicts = buildSizeConflicts(
      [draft({ brand: "Nobody", measurements: { chest: 17.5 } })],
      {},
    );
    expect(conflicts).toEqual([]);
    expect(sizeWarningsFrom(conflicts)).toEqual([]);
  });

  it("an item with no size or no measurements produces nothing", () => {
    expect(buildSizeConflicts([draft({ size: null })], BANDS)).toEqual([]);
    expect(buildSizeConflicts([draft({ measurements: null })], BANDS)).toEqual([]);
    expect(buildSizeConflicts([draft({ measurements: {} })], BANDS)).toEqual([]);
  });

  it("a size nothing in the chart matches is not judged", () => {
    expect(buildSizeConflicts([draft({ size: "42R" })], BANDS)).toEqual([]);
  });

  it("a generic chart needs two steps before it speaks", () => {
    const generic = { [PAIR]: bandsFor({ tier: "generic" }) };
    // 20.5 in labelled L is one row down: loud on a brand chart, quiet here.
    const oneStep = [draft({ measurements: { chest: 20.5 } })];
    expect(buildSizeConflicts(oneStep, BANDS)).toHaveLength(1);
    expect(buildSizeConflicts(oneStep, generic)).toEqual([]);
  });
});

describe("one request per distinct brand + garment pair", () => {
  it("a 40-item batch of 6 brands asks for 6 tables", () => {
    const brands = ["Lululemon", "Nike", "Patagonia", "Vuori", "Alo", "Athleta"];
    const batch = Array.from({ length: 40 }, (_, i) =>
      draft({ itemId: `i${i}`, brand: brands[i % brands.length]! }),
    );
    expect(sizeBandPairs(batch)).toHaveLength(6);
  });

  it("the same brand in two garments is two tables, not one", () => {
    const batch = [
      draft({ itemId: "a", garment: "tee" }),
      draft({ itemId: "b", garment: "jeans" }),
    ];
    expect(sizeBandPairs(batch)).toHaveLength(2);
  });

  it("drafts that cannot be judged issue no request at all", () => {
    const batch = [
      draft({ itemId: "a", size: null }),
      draft({ itemId: "b", measurements: {} }),
      draft({ itemId: "c", garment: null }),
    ];
    expect(sizeBandPairs(batch)).toEqual([]);
  });
});

describe("the one-click fix", () => {
  it("offers a size the brand makes", () => {
    const conflicts = buildSizeConflicts(
      [draft({ size: "XXL", measurements: { chest: 22.5 } })],
      BANDS,
    );
    expect(conflicts[0]?.fix).toBe(conflicts[0]?.impliedSize);
  });

  it("offers nothing when the measurements land off the end of the chart", () => {
    const conflicts = buildSizeConflicts(
      [draft({ measurements: { chest: 17.5 } })],
      BANDS,
    );
    expect(conflicts[0]?.impliedSize).toBe("smaller than XS");
    expect(conflicts[0]?.fix).toBeNull();
  });
});

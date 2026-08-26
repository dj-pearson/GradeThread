import { describe, it, expect } from "vitest";
import {
  checkSize,
  discrepancyNote,
  fixableSize,
  resolveSizeRow,
  tierNote,
  toleranceFor,
  type SizeBandRow,
} from "@/lib/size-check";

// US-2918: the browser lookup, run against the SAME two fixture cases as
// services/edge-functions/src/tests/size-check_test.ts,
// ios/GradeThreadTests/SizeCheckTests.swift and the Android suite.
// src/test/size-check-fixture-parity.test.ts fails if any of the four drifts.
//
// The band tables below are what GET /api/flipdesk/size-bands returns for these
// two queries — body chest converted to flat as (body + ease) / 2, low edge on
// slim ease and high edge on relaxed.

/** Lululemon men's tops, chest 33-35 / 35-37 / 38-40 / 41-43 / 44-46 / 47-49. */
const LULULEMON_MENS_TOPS: SizeBandRow[] = [
  { size: "XS", index: 0, bands: { chest: [18, 22.5] } },
  { size: "S", index: 1, bands: { chest: [19, 23.5] } },
  { size: "M", index: 2, bands: { chest: [20.5, 25] } },
  { size: "L", index: 3, bands: { chest: [22, 26.5] } },
  { size: "XL", index: 4, bands: { chest: [23.5, 28] } },
  { size: "XXL", index: 5, bands: { chest: [25, 29.5] } },
];

/** Generic men's alpha tops — the fallback when a brand has no chart. */
const GENERIC_MENS_TOPS: SizeBandRow[] = [
  { size: "S", index: 0, bands: { chest: [19, 23.5] } },
  { size: "M", index: 1, bands: { chest: [20.5, 25] } },
  { size: "L", index: 2, bands: { chest: [22, 26.5] } },
  { size: "XL", index: 3, bands: { chest: [23.5, 28] } },
  { size: "XXL", index: 4, bands: { chest: [25, 29.5] } },
];

describe("the motivating case", () => {
  it("a 17.5 in flat chest labelled Large fires", () => {
    const rowIndex = resolveSizeRow(LULULEMON_MENS_TOPS, "Large");
    expect(rowIndex).toBe(3);
    const verdict = checkSize({
      bands: LULULEMON_MENS_TOPS,
      rowIndex,
      measurements: { chest: 17.5 },
      tier: "brand",
    });
    expect(verdict.status).toBe("off");
    expect(verdict.stepsOff).toBeGreaterThanOrEqual(2);
    expect(verdict.impliedSize).toBe("smaller than XS");
    expect(verdict.key).toBe("chest");
    expect(verdict.expected).toEqual([22, 26.5]);
  });

  it("names both numbers in the note", () => {
    const verdict = checkSize({
      bands: LULULEMON_MENS_TOPS,
      rowIndex: 3,
      measurements: { chest: 17.5 },
      tier: "brand",
    });
    expect(discrepancyNote(verdict, "Large")).toBe(
      "Measurements point to smaller than XS, not Large. " +
        "A Large usually measures 22 to 26.5 in here.",
    );
  });

  it("offers no one-click fix for a size the brand does not make", () => {
    const verdict = checkSize({
      bands: LULULEMON_MENS_TOPS,
      rowIndex: 3,
      measurements: { chest: 17.5 },
      tier: "brand",
    });
    expect(fixableSize(verdict)).toBeNull();
  });
});

describe("the no-false-alarm case", () => {
  it("a real 22 in men's tee labelled L stays quiet", () => {
    const rowIndex = resolveSizeRow(GENERIC_MENS_TOPS, "L");
    expect(rowIndex).toBe(2);
    const verdict = checkSize({
      bands: GENERIC_MENS_TOPS,
      rowIndex,
      measurements: { chest: 22 },
      tier: "generic",
    });
    expect(verdict.status).toBe("ok");
    expect(verdict.stepsOff).toBe(0);
  });
});

describe("tolerance", () => {
  it("is one step on a real chart and two on a generic one", () => {
    expect(toleranceFor("verified")).toBe(1);
    expect(toleranceFor("brand")).toBe(1);
    expect(toleranceFor("generic")).toBe(2);
  });

  it("a one-step disagreement fires on a brand chart and not on a generic one", () => {
    const input = {
      bands: GENERIC_MENS_TOPS,
      rowIndex: 2,
      measurements: { chest: 20.5 },
    };
    expect(checkSize({ ...input, tier: "brand" }).stepsOff).toBe(1);
    expect(checkSize({ ...input, tier: "brand" }).status).toBe("off");
    expect(checkSize({ ...input, tier: "generic" }).status).toBe("ok");
  });
});

describe("label matching", () => {
  it("resolves the spellings sellers actually use", () => {
    expect(resolveSizeRow(LULULEMON_MENS_TOPS, "Large")).toBe(3);
    expect(resolveSizeRow(LULULEMON_MENS_TOPS, "l")).toBe(3);
    expect(resolveSizeRow(LULULEMON_MENS_TOPS, "  L  ")).toBe(3);
    expect(resolveSizeRow(LULULEMON_MENS_TOPS, "2XL")).toBe(5);
    expect(resolveSizeRow(LULULEMON_MENS_TOPS, "extra small")).toBe(0);
  });

  it("returns null on no match, never index 0", () => {
    expect(resolveSizeRow(LULULEMON_MENS_TOPS, "42R")).toBeNull();
    expect(resolveSizeRow(LULULEMON_MENS_TOPS, "")).toBeNull();
    expect(resolveSizeRow(LULULEMON_MENS_TOPS, null)).toBeNull();
  });

  it("a bare 12 is not a UK 12", () => {
    const uk: SizeBandRow[] = [
      { size: "UK 10 / S", index: 0, bands: { waist: [14, 16] } },
      { size: "UK 12 / M", index: 1, bands: { waist: [15, 17] } },
    ];
    expect(resolveSizeRow(uk, "M")).toBe(1);
    expect(resolveSizeRow(uk, "UK 12")).toBe(1);
    expect(resolveSizeRow(uk, "12")).toBeNull();
  });
});

describe("unknown", () => {
  it("says nothing when the size cannot be placed or nothing compares", () => {
    const cases = [
      { rowIndex: null, measurements: { chest: 21 }, tier: "brand" as const },
      { rowIndex: 2, measurements: {}, tier: "brand" as const },
      { rowIndex: 2, measurements: { chest: 21 }, tier: "none" as const },
    ];
    for (const c of cases) {
      expect(checkSize({ bands: GENERIC_MENS_TOPS, ...c }).status).toBe("unknown");
    }
    expect(
      checkSize({ bands: [], rowIndex: 0, measurements: { chest: 21 }, tier: "brand" }).status,
    ).toBe("unknown");
  });
});

describe("copy", () => {
  it("a generic chart says out loud that it is an estimate", () => {
    expect(tierNote("generic", "Lululemon")).toBe(
      "Estimate only — no Lululemon chart on file.",
    );
    expect(tierNote("generic", null)).toBe("Estimate only — no brand chart on file.");
    expect(tierNote("brand", "Lululemon")).toBeNull();
    expect(tierNote("verified", "Lululemon")).toBeNull();
  });

  it("offers the implied size as a one-click fix when the brand makes it", () => {
    const verdict = checkSize({
      bands: LULULEMON_MENS_TOPS,
      rowIndex: 5,
      measurements: { chest: 22.5 },
      tier: "brand",
    });
    expect(verdict.status).toBe("off");
    expect(fixableSize(verdict)).toBe(verdict.impliedSize);
  });
});

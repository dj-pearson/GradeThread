// US-2823. Three things here are worth a test and the rest is arithmetic.
//
// 1. The empty-needle trap. "" is a substring of everything, so a defect with
//    no text would read as disclosed on every listing that has a description.
// 2. A null rate is "not enough sales", not 0. Treating it as 0 makes every
//    thin band look perfect, and a perfect band wins the "best band" slot and
//    then divides into everything.
// 3. Dividing by a zero rate. A defect the seller always discloses correctly
//    has a 0% disclosed rate, and the multiplier against it is infinity.

import { describe, expect, it } from "vitest";
import {
  EMPTY_ATTRIBUTION,
  hasNoFindings,
  isDisclosed,
  worstFactor,
  worstUndisclosedDefect,
  type DefectDisclosureRow,
  type FactorBand,
  type FactorRow,
  type GradeFactor,
  type ReturnAttribution,
} from "@/lib/return-attribution";

function band(
  b: FactorBand["band"],
  fulfilled: number,
  returns: number,
  rate: number | null,
): FactorBand {
  return { band: b, label: b, fulfilled, returns, rate };
}

function factor(f: GradeFactor, bands: FactorBand[]): FactorRow {
  return { factor: f, bands };
}

function report(over: Partial<ReturnAttribution> = {}): ReturnAttribution {
  return { ...EMPTY_ATTRIBUTION, ...over };
}

function defectRow(
  over: Partial<DefectDisclosureRow> & { defect: string },
): DefectDisclosureRow {
  return {
    severity: "moderate",
    disclosedCount: 40,
    disclosedReturns: 2,
    disclosedRate: 0.05,
    undisclosedCount: 30,
    undisclosedReturns: 6,
    undisclosedRate: 0.2,
    ...over,
  };
}

describe("isDisclosed", () => {
  it("a photo tagged defect discloses it on its own", () => {
    expect(isDisclosed({ defect: "pilling" }, null, true)).toBe(true);
    expect(isDisclosed({ defect: "pilling" }, "clean, no flaws", true)).toBe(true);
  });

  it("matches the defect_type with underscores read as spaces", () => {
    expect(
      isDisclosed(
        { defect_type: "seam_separation" },
        "Small SEAM SEPARATION at the left cuff.",
        false,
      ),
    ).toBe(true);
  });

  it("matches the free-text defect, case-insensitively", () => {
    expect(
      isDisclosed({ defect: "Pilling" }, "some pilling under the arms", false),
    ).toBe(true);
  });

  it("a blank needle is NOT a match", () => {
    // The trap: "" is a substring of every string. A defect carrying no text at
    // all would otherwise be marked disclosed by any listing with a
    // description, which is the exact opposite of the truth.
    expect(isDisclosed({ defect: "", defect_type: "" }, "a long description", false)).toBe(false);
    expect(isDisclosed({}, "a long description", false)).toBe(false);
    expect(isDisclosed({ defect: "   " }, "a long description", false)).toBe(false);
  });

  it("no description means not disclosed", () => {
    expect(isDisclosed({ defect: "hole" }, null, false)).toBe(false);
    expect(isDisclosed({ defect: "hole" }, "", false)).toBe(false);
  });

  it("a description that does not mention it is not disclosure", () => {
    expect(
      isDisclosed({ defect: "hole" }, "Great condition, fast shipping.", false),
    ).toBe(false);
  });
});

describe("worstFactor", () => {
  it("finds the factor whose low band returns worst relative to its best", () => {
    const r = report({
      factors: [
        factor("fabric", [band("low", 40, 2, 0.05), band("high", 60, 3, 0.05)]),
        factor("odor", [band("low", 30, 9, 0.3), band("high", 50, 2, 0.04)]),
      ],
    });
    const w = worstFactor(r);
    expect(w?.factor).toBe("odor");
    expect(w?.multiplier).toBeCloseTo(7.5, 6);
  });

  it("ignores bands with a null rate rather than reading them as zero", () => {
    // The low band has 3 sales and no returns, so the RPC sent rate: null. A
    // reader that treated that as 0 would make it the BEST band and then divide
    // the high band's rate by zero.
    const r = report({
      factors: [
        factor("fabric", [
          band("low", 3, 0, null),
          band("high", 80, 4, 0.05),
        ]),
      ],
    });
    expect(worstFactor(r)).toBeNull();
  });

  it("skips a factor whose best band is a real zero, not silently dividing", () => {
    const r = report({
      factors: [
        factor("cosmetic", [band("low", 40, 5, 0.125), band("high", 60, 0, 0)]),
      ],
    });
    expect(worstFactor(r)).toBeNull();
  });

  it("ignores the ungraded band", () => {
    const r = report({
      factors: [
        factor("fabric", [
          band("ungraded", 90, 20, 0.222),
          band("high", 60, 3, 0.05),
        ]),
      ],
    });
    // Only one rated non-ungraded band is left, so there is nothing to compare.
    expect(worstFactor(r)).toBeNull();
  });

  it("is null on an empty report", () => {
    expect(worstFactor(EMPTY_ATTRIBUTION)).toBeNull();
  });
});

describe("worstUndisclosedDefect", () => {
  it("finds where not disclosing costs the most", () => {
    const r = report({
      defects: [
        defectRow({ defect: "pilling", disclosedRate: 0.05, undisclosedRate: 0.1 }),
        defectRow({ defect: "hole", disclosedRate: 0.04, undisclosedRate: 0.24 }),
      ],
    });
    const w = worstUndisclosedDefect(r);
    expect(w?.row.defect).toBe("hole");
    expect(w?.multiplier).toBeCloseTo(6, 6);
  });

  it("refuses to divide by a zero disclosed rate", () => {
    // A defect always disclosed properly has a 0% disclosed return rate. The
    // multiplier against it is infinity, which is not a finding.
    const r = report({
      defects: [defectRow({ defect: "stain", disclosedRate: 0, undisclosedRate: 0.3 })],
    });
    expect(worstUndisclosedDefect(r)).toBeNull();
  });

  it("needs a real rate on BOTH sides", () => {
    const r = report({
      defects: [
        defectRow({ defect: "fade", disclosedRate: null }),
        defectRow({ defect: "tear", undisclosedRate: null }),
      ],
    });
    expect(worstUndisclosedDefect(r)).toBeNull();
  });

  it("reports nothing when disclosure does not help", () => {
    const r = report({
      defects: [
        defectRow({ defect: "pilling", disclosedRate: 0.2, undisclosedRate: 0.1 }),
      ],
    });
    expect(worstUndisclosedDefect(r)).toBeNull();
  });
});

describe("hasNoFindings", () => {
  it("is true when neither half produced anything", () => {
    expect(hasNoFindings(EMPTY_ATTRIBUTION)).toBe(true);
  });

  it("is false as soon as one half does", () => {
    const r = report({
      factors: [
        factor("odor", [band("low", 30, 9, 0.3), band("high", 50, 2, 0.04)]),
      ],
    });
    expect(hasNoFindings(r)).toBe(false);
  });
});

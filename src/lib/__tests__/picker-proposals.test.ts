import { describe, it, expect } from "vitest";
import { proposePickers, type PickerProposal } from "@/lib/picker-proposals";
import { MARKETPLACE_SPECS } from "@/lib/marketplace-specs";
import { mapEbayCondition } from "@/lib/ebay-prefill";

// US-3210 AC2. The mapper is pure, so this drives it directly rather than
// through a browser. What it must never do is guess: `none` is a result.

const graded = (gradeValue: number) => ({ gradeValue, size: "M", color: "Navy" });
const by = (rows: PickerProposal[], field: string) => rows.find((r) => r.field === field)!;

describe("picker proposals (US-3210)", () => {
  it("covers exactly the pickers each platform declares manual", () => {
    // Driven from marketplace-specs.ts, so a picker added there cannot be
    // silently skipped here.
    for (const platform of ["poshmark", "mercari"] as const) {
      const declared = MARKETPLACE_SPECS[platform].manualFields ?? [];
      expect(declared.length, `${platform} declares no manual fields`).toBeGreaterThan(0);
      expect(proposePickers(platform, graded(8)).map((r) => r.field)).toEqual([...declared]);
    }
  });

  it("never returns a value with confidence none, or a null with any other", () => {
    // The invariant the whole design rests on. A `none` carrying a value would
    // be a guess the lister then types in.
    for (const platform of ["poshmark", "mercari"] as const) {
      for (const src of [graded(10), graded(8), graded(3), {}]) {
        for (const r of proposePickers(platform, src)) {
          if (r.confidence === "none") expect(r.value, `${platform}.${r.field}`).toBeNull();
          else expect(r.value, `${platform}.${r.field}`).not.toBeNull();
          expect(r.why.length, `${platform}.${r.field} has no reason`).toBeGreaterThan(0);
        }
      }
    }
  });

  it("refuses category on both platforms, and says what is missing", () => {
    // The expensive guess. Category is REQUIRED on both and a wrong one
    // mis-files the listing where nobody browsing sees it, while looking
    // handled. This stays none until AC6's captured option lists exist.
    for (const platform of ["poshmark", "mercari"] as const) {
      const cat = by(proposePickers(platform, { ...graded(8), ebayCategoryPath: ["Clothing", "Men", "Shirts"] }), "category");
      expect(cat.confidence).toBe("none");
      expect(cat.value).toBeNull();
      // The eBay path is echoed rather than dropped, so the writeback records
      // what a mapping would have had to work from.
      expect(cat.why).toContain("Clothing > Men > Shirts");
    }
  });

  it("sets Poshmark's tags flag both ways, and only guesses when it cannot know", () => {
    expect(by(proposePickers("poshmark", graded(10)), "nwt")).toMatchObject({ value: "true", confidence: "exact" });
    // FALSE IS A REAL ANSWER. A graded item that is not NWT is definitely not
    // NWT, so this is exact rather than left for the seller.
    expect(by(proposePickers("poshmark", graded(7)), "nwt")).toMatchObject({ value: "false", confidence: "exact" });
    expect(by(proposePickers("poshmark", {}), "nwt")).toMatchObject({ value: null, confidence: "none" });
    // A tier claiming NWT counts even with no numeric grade.
    expect(by(proposePickers("poshmark", { gradeTier: "NWT" }), "nwt")).toMatchObject({ value: "true" });
  });

  it("maps Mercari condition to values Mercari actually offers", () => {
    const offered = new Set(MARKETPLACE_SPECS.mercari.conditions.map((c) => c.value));
    for (const g of [10, 9.8, 9.0, 8.0, 7.5, 6.0, 5.0, 4.5, 2.0]) {
      const c = by(proposePickers("mercari", graded(g)), "condition");
      expect(offered.has(c.value!), `grade ${g} proposed "${c.value}", which Mercari does not offer`).toBe(true);
    }
    expect(by(proposePickers("mercari", {}), "condition")).toMatchObject({ confidence: "none" });
  });

  it("does not describe the same item as two different conditions across platforms", () => {
    // The seller comparing their own two listings is exactly who notices. The
    // bands are shared with mapEbayCondition rather than invented, so New here
    // and NEW there have to agree.
    for (const g of [10, 9.8, 9.0, 8.0, 6.0, 4.0]) {
      const mercariNew = by(proposePickers("mercari", graded(g)), "condition").value === "New";
      const poshmarkNwt = by(proposePickers("poshmark", graded(g)), "nwt").value === "true";
      const ebayNew = mapEbayCondition(g, null) === "NEW";
      expect(mercariNew, `grade ${g}: Mercari and eBay disagree about New`).toBe(ebayNew);
      expect(poshmarkNwt, `grade ${g}: Poshmark and eBay disagree about New`).toBe(ebayNew);
    }
  });

  it("proposes an odd size rather than refusing it", () => {
    // Refusing "32x34" because it is not in a hardcoded set would be this
    // module guessing about a form it cannot see. The lister matches and
    // reports a miss; that is how the miss gets measured.
    expect(by(proposePickers("poshmark", { size: "M" }), "size")).toMatchObject({ value: "M", confidence: "exact" });
    expect(by(proposePickers("poshmark", { size: "32x34" }), "size")).toMatchObject({ value: "32x34", confidence: "likely" });
    expect(by(proposePickers("poshmark", { size: "   " }), "size")).toMatchObject({ value: null, confidence: "none" });
  });

  it("treats a brand colourway as likely, not exact", () => {
    const c = by(proposePickers("poshmark", { color: "Deep Ocean" }), "color");
    expect(c).toMatchObject({ value: "Deep Ocean", confidence: "likely" });
    expect(by(proposePickers("poshmark", {}), "color")).toMatchObject({ confidence: "none" });
  });
});

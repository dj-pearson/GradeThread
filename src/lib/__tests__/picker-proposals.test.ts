import { describe, it, expect } from "vitest";
import {
  matchOption,
  proposePickers,
  resolvePicker,
  type PickerProposal,
} from "@/lib/picker-proposals";
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

describe("matching a proposal against a live option list (US-3210 AC3)", () => {
  const POSHMARK_CONDITION = ["NWT (New With Tags)", "NWOT (New Without Tags)", "EUC", "GUC"];

  it("ignores case, punctuation and spacing, and nothing else", () => {
    expect(matchOption("nwt", POSHMARK_CONDITION)).toBe("NWT (New With Tags)");
    expect(matchOption("EUC", POSHMARK_CONDITION)).toBe("EUC");
    expect(matchOption("Like  new", ["Like new", "New"])).toBe("Like new");
  });

  it("prefers an exact option over one that merely starts with it", () => {
    // "Blue" against a list holding both must not resolve to "Blue Green".
    expect(matchOption("Blue", ["Blue", "Blue Green", "Light Blue"])).toBe("Blue");
  });

  it("refuses an ambiguous match rather than taking the first", () => {
    // Taking the first is exactly how a wrong pick gets made silently, which is
    // what AC3 names. Two candidates means the seller decides.
    expect(matchOption("Blue", ["Light Blue", "Navy Blue"])).toBeNull();
    expect(matchOption("M", ["M / 8", "M / 10"])).toBeNull();
  });

  it("returns null rather than throwing on an empty list or an empty value", () => {
    expect(matchOption("M", [])).toBeNull();
    expect(matchOption("   ", ["M"])).toBeNull();
  });
});

describe("resolving a picker against the live form (US-3210 AC3, AC7)", () => {
  const proposal = (over: Partial<PickerProposal> = {}): PickerProposal => ({
    field: "size",
    value: "M",
    confidence: "exact",
    why: "test",
    ...over,
  });

  it("selects the matching option", () => {
    expect(resolvePicker(proposal(), ["S", "M", "L"])).toMatchObject({
      outcome: "selected",
      matched: "M",
    });
  });

  it("reports an option it cannot find instead of picking something else", () => {
    expect(resolvePicker(proposal({ value: "32x34" }), ["S", "M", "L"])).toMatchObject({
      outcome: "option-not-found",
      matched: null,
    });
  });

  it("leaves a none proposal alone", () => {
    expect(
      resolvePicker(proposal({ value: null, confidence: "none" }), ["S", "M"]),
    ).toMatchObject({ outcome: "left-blank", matched: null });
  });

  it("never overwrites a field the seller already set", () => {
    // AC7, and the check comes FIRST: a pick that is "right" is still wrong if
    // it replaces a human's answer. Even an exact proposal stands down.
    const r = resolvePicker(proposal(), ["S", "M", "L"], "L");
    expect(r.outcome).toBe("left-blank");
    expect(r.matched).toBeNull();
    expect(r.why).toContain("already chose");
  });

  it("treats a whitespace-only current value as unset", () => {
    expect(resolvePicker(proposal(), ["S", "M", "L"], "   ")).toMatchObject({
      outcome: "selected",
    });
  });

  it("carries the proposal's own fields through, so the writeback can report them", () => {
    // AC4 wants proposed value, confidence and outcome in one payload.
    const r = resolvePicker(proposal({ confidence: "likely" }), ["S", "M", "L"]);
    expect(r).toMatchObject({ field: "size", value: "M", confidence: "likely", outcome: "selected" });
  });
});

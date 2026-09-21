import { describe, it, expect } from "vitest";
import {
  isPickerPlatform,
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

// ── US-3210 AC4, first half: this mapper now has a production caller ─────────
//
// It did not, until 2026-09-18, and `node scripts/check-web-unwired.mjs` said
// so: "src/lib/picker-proposals.ts imported only by picker-proposals.test.ts".
// That gate's own allowlist forbids exactly this shape -- "an implementation
// nobody calls is a feature that does not run" -- so allowlisting it was not an
// option and wiring it was.
//
// The caller is the Listing Kit's manual-fields notice, which used to say
// "You'll set these on Poshmark yourself: Category, Size, Color, NWT" and now
// adds what to pick for the three of those four this mapper can answer.

describe("isPickerPlatform", () => {
  it("accepts the two platforms with a picker contract", () => {
    expect(isPickerPlatform("poshmark")).toBe(true);
    expect(isPickerPlatform("mercari")).toBe(true);
  });

  it("refuses the platforms that have none", () => {
    // Grailed, Vinted and Facebook declare no manualFields, so proposing for
    // them would return an empty list that reads like "nothing to set".
    for (const p of ["grailed", "vinted", "facebook", "ebay", "depop", ""]) {
      expect(isPickerPlatform(p), `${p} has no picker contract`).toBe(false);
    }
  });

  it("covers every platform that declares manualFields, and only those", () => {
    // The real coupling. A third platform gaining manualFields without gaining
    // a rule here would get an empty proposal list and a notice that quietly
    // stopped suggesting anything.
    const declaring = Object.entries(MARKETPLACE_SPECS)
      .filter(([, spec]) => (spec.manualFields ?? []).length > 0)
      .map(([key]) => key)
      .sort();
    expect(declaring.filter(isPickerPlatform)).toEqual(declaring);
  });
});

describe("what the Listing Kit notice can say (US-3210 AC4)", () => {
  it("answers three of Poshmark's four pickers for a graded item", () => {
    const rows = proposePickers("poshmark", {
      gradeValue: 8.5,
      gradeTier: "Excellent",
      size: "M",
      color: "Navy",
    });
    const answered = rows.filter((r) => r.value !== null).map((r) => r.field);
    expect(answered.sort()).toEqual(["color", "nwt", "size"]);
    // And the fourth stays none, with a reason, rather than a guess.
    expect(by(rows, "category")).toMatchObject({ value: null, confidence: "none" });
  });

  it("says nothing about condition or NWT when the item has no grade", () => {
    // The notice reads gradeValue and gradeLabel off inventory_items. Before
    // US-3210 AC4 the kit's facts query selected neither, so an item with a
    // grade would still have come back unknowable here -- which is why the
    // wiring had to touch the query and not only the render.
    const posh = proposePickers("poshmark", { size: "M", color: "Navy" });
    expect(by(posh, "nwt")).toMatchObject({ value: null, confidence: "none" });
    const merc = proposePickers("mercari", { size: "M" });
    expect(by(merc, "condition")).toMatchObject({ value: null, confidence: "none" });
  });

  it("proposes nothing at all for an item with no facts, rather than blanks", () => {
    // Every proposal is `none`, so the notice adds no second sentence and the
    // seller sees exactly what they saw before this change.
    const rows = proposePickers("mercari", {});
    expect(rows.every((r) => r.value === null)).toBe(true);
  });
});

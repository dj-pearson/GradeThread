import { describe, expect, it } from "vitest";
import {
  EBAY_CONDITIONS,
  EBAY_CSA_CATEGORY,
  buildSoldSearchUrl,
  buildSoldSearches,
  normalizeTerms,
} from "@/lib/ebay-sold-search";
import { getCalculatorBySlug } from "@/lib/seo/calculators";
import { KEYWORD_TARGETS } from "@/lib/seo/keyword-targets";

// US-9021. The parameters asserted here were verified against live eBay on
// 2026-08-28 (a sold search for "patagonia synchilla fleece" under _sacat=11450
// returned 4,900+ results, 210 at LH_ItemCondition=1000 and 54 at 1500). A test
// that only asserted the builder's own output would prove the code is
// self-consistent and nothing about whether the link works.

describe("buildSoldSearchUrl", () => {
  it("sends both sold flags, not just LH_Complete", () => {
    const url = new URL(buildSoldSearchUrl("patagonia fleece"));
    // LH_Complete alone returns unsold endings too, which answers a different
    // and much less useful question.
    expect(url.searchParams.get("LH_Sold")).toBe("1");
    expect(url.searchParams.get("LH_Complete")).toBe("1");
  });

  it("scopes to Clothing, Shoes & Accessories", () => {
    const url = new URL(buildSoldSearchUrl("patagonia fleece"));
    expect(url.searchParams.get("_sacat")).toBe(EBAY_CSA_CATEGORY);
    expect(EBAY_CSA_CATEGORY).toBe("11450");
  });

  it("points at ebay's search endpoint", () => {
    const url = new URL(buildSoldSearchUrl("patagonia fleece"));
    expect(url.origin).toBe("https://www.ebay.com");
    expect(url.pathname).toBe("/sch/i.html");
  });

  it("omits the condition filter when no condition is chosen", () => {
    const url = new URL(buildSoldSearchUrl("patagonia fleece", ""));
    expect(url.searchParams.has("LH_ItemCondition")).toBe(false);
  });

  it("passes a chosen condition through", () => {
    const url = new URL(buildSoldSearchUrl("patagonia fleece", "3000"));
    expect(url.searchParams.get("LH_ItemCondition")).toBe("3000");
  });

  it("encodes the keywords rather than concatenating them raw", () => {
    const url = buildSoldSearchUrl("levi's 501 & 505");
    expect(url).not.toContain(" ");
    expect(new URL(url).searchParams.get("_nkw")).toBe("levi's 501 & 505");
  });

  it("offers only condition ids confirmed against live results", () => {
    // Guessing an id sends the visitor to an empty page and makes it look like
    // their search terms were wrong.
    expect(EBAY_CONDITIONS.map((c) => c.id)).toEqual(["", "3000", "1000", "1500"]);
  });
});

describe("normalizeTerms", () => {
  it("collapses whitespace", () => {
    expect(normalizeTerms("  Patagonia   Snap-T  ")).toBe("Patagonia Snap-T");
  });

  it("keeps hyphens and apostrophes, which carry meaning in garment names", () => {
    expect(normalizeTerms("Levi's Snap-T")).toBe("Levi's Snap-T");
  });

  it("drops punctuation eBay treats as noise", () => {
    expect(normalizeTerms("Patagonia, Synchilla (fleece)")).toBe("Patagonia Synchilla fleece");
  });

  it("returns empty for input that is only punctuation", () => {
    expect(normalizeTerms("  ...  ")).toBe("");
  });
});

describe("buildSoldSearches", () => {
  const base = { brand: "Patagonia", item: "Synchilla fleece", size: "Medium", conditionId: "3000" } as const;

  it("returns the three ladder rungs, narrowest first", () => {
    const s = buildSoldSearches(base);
    expect(s.map((x) => x.rung)).toEqual(["exact", "broadened", "brand_category"]);
    expect(s[0]!.keywords).toBe("Patagonia Synchilla fleece Medium");
    expect(s[1]!.keywords).toBe("Patagonia Synchilla fleece");
    expect(s[2]!.keywords).toBe("Patagonia");
  });

  it("drops the exact rung when no size makes it identical to broadened", () => {
    // Rendering two identical links would imply the seller checked two things
    // when they checked one.
    const s = buildSoldSearches({ ...base, size: "" });
    expect(s.map((x) => x.rung)).toEqual(["exact", "brand_category"]);
    expect(new Set(s.map((x) => x.keywords)).size).toBe(s.length);
  });

  it("never emits duplicate keyword sets", () => {
    const s = buildSoldSearches({ brand: "Patagonia", item: "Patagonia", size: "", conditionId: "" });
    expect(new Set(s.map((x) => x.keywords)).size).toBe(s.length);
  });

  it("returns nothing when there is neither a brand nor an item", () => {
    expect(buildSoldSearches({ brand: "", item: "", size: "L", conditionId: "3000" })).toEqual([]);
  });

  it("works from an item with no brand", () => {
    const s = buildSoldSearches({ brand: "", item: "carhartt detroit jacket", size: "", conditionId: "" });
    expect(s.length).toBeGreaterThan(0);
    expect(s[0]!.keywords).toBe("carhartt detroit jacket");
  });

  it("carries the chosen condition onto every rung", () => {
    for (const s of buildSoldSearches({ ...base, conditionId: "1000" })) {
      expect(new URL(s.url).searchParams.get("LH_ItemCondition")).toBe("1000");
    }
  });

  it("gives every rung a reason to be opened, not just a label", () => {
    for (const s of buildSoldSearches(base)) {
      expect(s.why.length).toBeGreaterThan(30);
    }
  });
});

describe("the page is registered", () => {
  it("is a live calculator with content and a handoff", () => {
    const calc = getCalculatorBySlug("ebay-sold-listings");
    expect(calc).toBeDefined();
    expect(calc!.status).toBe("live");
    expect(calc!.intro).toBeTruthy();
    expect(calc!.faqs?.length).toBeGreaterThanOrEqual(4);
    expect(calc!.handoff?.surface).toBe("comps");
  });

  it("never claims GradeThread knows the sold price", () => {
    // EBAY_MARKETPLACE_INSIGHTS has never been granted, so the page hands over
    // eBay's own results and must not imply it computed them. This is the same
    // rule value-disclosure.ts enforces in the edge service.
    const calc = getCalculatorBySlug("ebay-sold-listings")!;
    const copy = [calc.title, calc.description, calc.intro, calc.h1, calc.cardBlurb]
      .concat((calc.faqs ?? []).flatMap((f) => [f.q, f.a]))
      .join(" ")
      .toLowerCase();
    expect(copy).not.toContain("our sold data");
    expect(copy).not.toContain("we pull sold");
    expect(copy).not.toContain("gradethread sold");
  });

  it("owns the head keyword in the keyword registry", () => {
    const target = KEYWORD_TARGETS.find((t) => t.path === "/tools/ebay-sold-listings");
    expect(target).toBeDefined();
    expect(target!.primary).toBe("how to check sold items on ebay");
    // keyword-targets.test.ts enforces that the primary appears in the
    // registered title or description; assert it here too so a copy edit that
    // breaks the pairing fails in the file it belongs to.
    const calc = getCalculatorBySlug("ebay-sold-listings")!;
    expect(`${calc.title} ${calc.description}`.toLowerCase()).toContain(target!.primary);
  });
});

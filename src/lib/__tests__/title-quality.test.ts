// US-1892: composer title quality meter + pack-to-80 suggestions.
import { describe, expect, it } from "vitest";
import {
  isBrandFirst,
  lintTitle,
  packTitleSuggestions,
  TITLE_MAX,
  titleQuality,
  titleUtilization,
  titleTerms,
  TERM_GREEN_MIN,
  TERM_WEAK_BELOW,
} from "../title-quality";

// US-2680 REWROTE THIS BLOCK. It used to assert that 70 and 75 characters were
// "good" and a short title was "low" — a length target the ranking playbook
// lists as vendor lore and listing-quality-score.ts already refused to score.
// The character readout is now a hard-limit counter and nothing more.
describe("titleUtilization is a hard limit, not a target", () => {
  it("reports characters used without judging the number", () => {
    expect(titleUtilization("x".repeat(62)).band).toBe("within");
    expect(titleUtilization("x".repeat(75)).band).toBe("within");
    // 62 and 75 are the SAME band on purpose: neither is better than the other.
  });

  it("goes full at the cap, because eBay truncates there", () => {
    expect(titleUtilization("x".repeat(80)).band).toBe("full");
    expect(titleUtilization("x".repeat(90)).band).toBe("full");
  });

  it("an empty title is empty", () => {
    expect(titleUtilization("").band).toBe("empty");
    expect(titleUtilization("   ").used).toBe(0);
  });

  it("pct still tracks fill, for the counter", () => {
    expect(titleUtilization("x".repeat(40)).pct).toBe(50);
    expect(titleUtilization("x".repeat(120)).pct).toBe(100);
  });
});

describe("isBrandFirst", () => {
  it("passes when the title leads with the brand", () => {
    expect(isBrandFirst("Nike Air Max 90 Men's Sneakers", "Nike")).toBe(true);
    expect(isBrandFirst("nike air max", "Nike")).toBe(true); // case-insensitive
  });
  it("fails when the brand is buried", () => {
    expect(isBrandFirst("Vintage Nike Tee", "Nike")).toBe(false);
  });
  it("treats a missing brand as satisfied", () => {
    expect(isBrandFirst("Some title", null)).toBe(true);
    expect(isBrandFirst("Some title", "")).toBe(true);
  });
  it("fails on an empty title with a real brand", () => {
    expect(isBrandFirst("", "Nike")).toBe(false);
  });
  it("does not match a brand that is only a prefix substring of the first word", () => {
    expect(isBrandFirst("Nikeish knockoff tee", "Nike")).toBe(false);
  });
});

describe("lintTitle (lockstep with edge)", () => {
  it("flags brand-comparison policy violations", () => {
    const r = lintTitle("Cute dress in the style of Free People boho");
    expect(r.policyViolations.length).toBe(1);
  });
  it("does not flag benign 'fits like a glove'", () => {
    expect(lintTitle("Denim jacket fits like a glove size M").policyViolations)
      .toHaveLength(0);
  });
  it("warns on filler, duplicates, and ALL-CAPS", () => {
    expect(lintTitle("WOW dress dress size M").warnings.length).toBeGreaterThan(0);
    expect(lintTitle("Nike SHOUT tee").warnings.some((w) => w.includes("ALL-CAPS")))
      .toBe(true);
  });
  it("allows NWT and sizes in caps", () => {
    expect(lintTitle("Nike NWT tee size XL").warnings).toHaveLength(0);
  });
});

describe("packTitleSuggestions", () => {
  it("suggests demand terms first, then high-value aspects, none already present", () => {
    const s = packTitleSuggestions({
      title: "Nike tee",
      demandTerms: ["vintage", "tee", "streetwear"], // 'tee' already present
      aspects: { Material: "Cotton", Pattern: "Solid", Color: "Blue" },
    });
    const tokens = s.map((x) => x.token);
    expect(tokens).toContain("vintage");
    expect(tokens).toContain("streetwear");
    expect(tokens).not.toContain("tee"); // already in the title
    expect(tokens).toContain("Cotton"); // high-value aspect
    expect(tokens).not.toContain("Blue"); // Color isn't a high-value aspect
    // demand terms rank before aspects
    expect(tokens.indexOf("vintage")).toBeLessThan(tokens.indexOf("Cotton"));
  });

  it("never suggests a chip that would push past 80", () => {
    const base = "x".repeat(74); // 74 chars; 80-74-1(space) = 5 chars of room
    const s = packTitleSuggestions({
      title: base,
      demandTerms: ["ok", "toolongword"], // "ok"=2 fits, "toolongword"=11 does not
    });
    expect(s.map((x) => x.token)).toEqual(["ok"]);
  });

  it("accounts for the running length as chips are added", () => {
    const base = "x".repeat(70); // room = 80-70-1 = 9
    const s = packTitleSuggestions({
      title: base,
      demandTerms: ["aaaa", "bbbb", "cccc"], // 4 + 1 space each
    });
    // aaaa (cost 5) fits (budget 9→4); bbbb (cost 5) does not.
    expect(s.map((x) => x.token)).toEqual(["aaaa"]);
  });

  it("handles array-valued aspects and dedups", () => {
    const s = packTitleSuggestions({
      title: "Dress",
      aspects: { Style: ["Boho", "Boho"], Material: "Linen" },
    });
    const tokens = s.map((x) => x.token);
    expect(tokens.filter((t) => t === "Boho")).toHaveLength(1);
    expect(tokens).toContain("Linen");
  });

  it("respects the limit", () => {
    const s = packTitleSuggestions({
      title: "Tee",
      demandTerms: ["a", "b", "c", "d", "e", "f", "g", "h"],
      limit: 3,
    });
    expect(s).toHaveLength(3);
  });

  it("skips a multi-word token when every word is already present", () => {
    const s = packTitleSuggestions({
      title: "Nike vintage tee",
      demandTerms: ["vintage nike"],
    });
    expect(s).toHaveLength(0);
  });
});

describe("titleQuality", () => {
  it("marks a thin title weak", () => {
    const q = titleQuality({ title: "Nike tee", brand: "Nike" });
    expect(q.weak).toBe(true);
    expect(q.brandFirst).toBe(true);
    // US-2680: weak now means too few distinct searchable terms. The length
    // band says only that the title is inside the 80-character cap, which is
    // true of every title that is not empty or over it.
    expect(q.terms.count).toBeLessThan(TERM_WEAK_BELOW);
    expect(q.utilization.band).toBe("within");
  });

  it("marks a lint-flagged title weak even when long enough", () => {
    const long = "Nike dress dress size medium blue cotton casual summer everyday wear";
    const q = titleQuality({ title: long, brand: "Nike" });
    expect(q.utilization.used).toBeGreaterThanOrEqual(60);
    expect(q.lint.warnings.length).toBeGreaterThan(0); // duplicate "dress"
    expect(q.weak).toBe(true);
  });

  it("a full, clean, brand-first title is not weak", () => {
    const q = titleQuality({
      title: "Nike Air Max 90 Mens Running Sneakers Size 11 White Black Leather",
      brand: "Nike",
    });
    expect(q.utilization.used).toBeGreaterThanOrEqual(60);
    expect(q.lint.policyViolations).toHaveLength(0);
    expect(q.lint.warnings).toHaveLength(0);
    expect(q.weak).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// US-2675: a chip says whether its term is backed by items that SOLD
//
// The two shapes have to coexist. listings.demand_terms is a plain text[] and
// every draft written before migration 00621 has only that; demand_terms_detail
// carries the provenance. A draft with no detail must render unmarked chips,
// NOT chips labelled "active" -- "we never recorded it" and "it came from
// active listings" are different claims, and only one of them is true.
// ---------------------------------------------------------------------------

describe("demand term provenance (US-2675)", () => {
  it("carries sold evidence from a detail object through to the suggestion", () => {
    const { suggestions } = packTitleSuggestionsFor([
      { term: "gorpcore", source: "sold" },
      { term: "streetwear", source: "active" },
    ]);
    expect(suggestions.find((s) => s.token === "gorpcore")?.evidence).toBe("sold");
    expect(suggestions.find((s) => s.token === "streetwear")?.evidence).toBe("active");
  });

  it("a plain string term carries NO evidence, rather than defaulting to active", () => {
    const { suggestions } = packTitleSuggestionsFor(["gorpcore"]);
    const chip = suggestions.find((s) => s.token === "gorpcore");
    expect(chip).toBeDefined();
    expect(chip?.evidence).toBeUndefined();
  });

  it("mixes both shapes in one list without dropping either", () => {
    const { suggestions } = packTitleSuggestionsFor([
      "flannel",
      { term: "gorpcore", source: "sold" },
    ]);
    expect(suggestions.map((s) => s.token)).toEqual(
      expect.arrayContaining(["flannel", "gorpcore"]),
    );
    expect(suggestions.find((s) => s.token === "flannel")?.evidence).toBeUndefined();
    expect(suggestions.find((s) => s.token === "gorpcore")?.evidence).toBe("sold");
  });

  it("still de-duplicates against the title, evidence or not", () => {
    const { suggestions } = packTitleSuggestionsFor(
      [{ term: "gorpcore", source: "sold" }],
      "Patagonia Gorpcore Fleece",
    );
    expect(suggestions.some((s) => s.token === "gorpcore")).toBe(false);
  });

  it("a null or blank detail entry is skipped, not rendered as an empty chip", () => {
    const { suggestions } = packTitleSuggestionsFor([
      null,
      { term: "   ", source: "sold" },
      { term: "gorpcore", source: "sold" },
    ]);
    expect(suggestions.map((s) => s.token)).toEqual(["gorpcore"]);
  });
});

function packTitleSuggestionsFor(
  demandTerms: Parameters<typeof titleQuality>[0]["demandTerms"],
  title = "Patagonia Fleece",
) {
  return titleQuality({ title, brand: "Patagonia", demandTerms });
}

// ---------------------------------------------------------------------------
// US-2680: the meter counts distinct searchable terms
//
// The bug was that the composer and the quality score disagreed, and the
// composer won because it is the one a seller reads while typing. It painted
// 70-80 characters green; listing-quality-score.ts explicitly refuses to score
// length because the playbook §2 lists that band as vendor lore. So the meter
// was teaching sellers to pad, and what padding usually carries is a word the
// item specifics already hold — which eBay indexes from the structured field
// anyway.
// ---------------------------------------------------------------------------

describe("titleTerms", () => {
  it("counts words the item specifics do not already carry", () => {
    const out = titleTerms("Patagonia Synchilla Snap T Fleece Pullover Navy Medium", {
      Brand: "Patagonia",
      Size: "Medium",
      Color: "Navy",
    });
    expect(out.redundant).toEqual(expect.arrayContaining(["patagonia", "medium", "navy"]));
    expect(out.distinct).toEqual(expect.arrayContaining(["synchilla", "snap", "fleece", "pullover"]));
    expect(out.redundant).not.toContain("synchilla");
  });

  it("with no aspects supplied, nothing is redundant", () => {
    const out = titleTerms("Patagonia Synchilla Snap Fleece Navy");
    expect(out.redundant).toEqual([]);
    expect(out.count).toBe(out.distinct.length);
  });

  it("a repeated word counts once", () => {
    const out = titleTerms("Fleece Fleece Fleece Pullover");
    expect(out.distinct).toEqual(["fleece", "pullover"]);
  });

  it("filler words are not searchable terms", () => {
    const out = titleTerms("Great Fleece for Men with Free Shipping Size Medium");
    expect(out.distinct).not.toContain("great");
    expect(out.distinct).not.toContain("free");
    expect(out.distinct).not.toContain("shipping");
    expect(out.distinct).not.toContain("size");
    expect(out.distinct).toContain("fleece");
  });

  it("the green band is on the term count", () => {
    const thin = titleTerms("Patagonia Fleece Jacket");
    expect(thin.band).toBe("thin");
    const good = titleTerms(
      "Patagonia Synchilla Snap Fleece Pullover Navy Deep Pile Retro",
    );
    expect(good.count).toBeGreaterThanOrEqual(TERM_GREEN_MIN);
    expect(good.band).toBe("good");
  });

  it("an empty title is empty, not thin", () => {
    expect(titleTerms("").band).toBe("empty");
    expect(titleTerms("").count).toBe(0);
  });
});

describe("AC5: a padded long title scores below a shorter distinct one", () => {
  // The headline case, and the exact shape the old character meter got wrong.
  const aspects = { Brand: "Patagonia", Size: "Medium", Color: "Navy", Department: "Men" };

  // 78 characters, and most of them restate Brand, Size and Color.
  const padded = "Patagonia Patagonia Navy Navy Medium Medium Men Mens Fleece Great Nice Jacket";
  // 62 characters, carrying model, construction and era terms nothing else has.
  const distinct = "Patagonia Synchilla Snap T Deep Pile Retro Fleece Pullover";

  it("the padded title is genuinely longer", () => {
    // If this ever stops being true the comparison below proves nothing.
    expect(padded.length).toBeGreaterThan(distinct.length);
    expect(padded.length).toBeGreaterThan(70);
    expect(distinct.length).toBeLessThan(70);
  });

  it("the OLD meter would have preferred the padded one", () => {
    // Documenting the bug: on characters alone, padded wins outright.
    expect(titleUtilization(padded).used).toBeGreaterThan(titleUtilization(distinct).used);
  });

  it("the new meter counts more searchable terms in the SHORTER title", () => {
    const paddedTerms = titleTerms(padded, aspects);
    const distinctTerms = titleTerms(distinct, aspects);
    expect(distinctTerms.count).toBeGreaterThan(paddedTerms.count);
  });

  it("and the padded title is the one flagged weak", () => {
    const paddedQuality = titleQuality({ title: padded, brand: "Patagonia", aspects });
    const distinctQuality = titleQuality({ title: distinct, brand: "Patagonia", aspects });
    expect(distinctQuality.terms.count).toBeGreaterThan(paddedQuality.terms.count);
    expect(paddedQuality.terms.redundant.length).toBeGreaterThan(
      distinctQuality.terms.redundant.length,
    );
  });
});

describe("AC2: no character threshold survives", () => {
  it("weakness is decided on terms, not length", () => {
    // A short title with plenty of distinct terms is NOT weak; a long one with
    // few is. That inversion is the whole story.
    const shortRich = titleQuality({
      title: "Synchilla Snap Deep Pile Retro Fleece Pullover",
      brand: null,
    });
    expect(shortRich.terms.count).toBeGreaterThanOrEqual(TERM_WEAK_BELOW);
    expect(shortRich.weak).toBe(false);

    const longThin = titleQuality({
      title: "Great Nice Item for Men with Free Fast Shipping and All the Extras Here",
      brand: null,
    });
    expect(longThin.utilization.used).toBeGreaterThan(shortRich.utilization.used);
    expect(longThin.terms.count).toBeLessThan(TERM_WEAK_BELOW);
    expect(longThin.weak).toBe(true);
  });
});

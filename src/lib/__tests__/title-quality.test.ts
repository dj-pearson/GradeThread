// US-1892: composer title quality meter + pack-to-80 suggestions.
import { describe, expect, it } from "vitest";
import {
  isBrandFirst,
  lintTitle,
  packTitleSuggestions,
  TITLE_MAX,
  titleQuality,
  titleUtilization,
} from "../title-quality";

describe("titleUtilization", () => {
  it("reports the green band at 70–80 chars", () => {
    expect(titleUtilization("x".repeat(75)).band).toBe("good");
    expect(titleUtilization("x".repeat(70)).band).toBe("good");
  });
  it("flags a short title as low", () => {
    expect(titleUtilization("Nike tee").band).toBe("low");
  });
  it("flags an empty title", () => {
    expect(titleUtilization("").band).toBe("empty");
    expect(titleUtilization("   ").used).toBe(0);
  });
  it("caps at the max and reports 100% when full", () => {
    const u = titleUtilization("y".repeat(90));
    expect(u.pct).toBe(100);
    expect(u.band).toBe("full");
  });
  it("computes pct against the 80 default", () => {
    expect(titleUtilization("z".repeat(40)).pct).toBe(50);
    expect(titleUtilization("z".repeat(40)).max).toBe(TITLE_MAX);
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
  it("marks a short title weak", () => {
    const q = titleQuality({ title: "Nike tee", brand: "Nike" });
    expect(q.weak).toBe(true);
    expect(q.brandFirst).toBe(true);
    expect(q.utilization.band).toBe("low");
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

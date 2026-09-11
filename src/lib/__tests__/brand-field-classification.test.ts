// US-3307: the classification, and the two properties that make it worth having.
//
// 1. It is NAMED, never heuristic. Every real house that is also an ordinary
//    word has to survive it, or the "brands sellers hold" report starts losing
//    brands silently.
// 2. Unbranded, Unknown and empty are THREE states, not one. That is AC4, and it
//    is the only signal that says which items are worth going back to.
//
// The Node reader (scripts/lib/brand-field-classification.mjs) is exercised
// against the SAME case list it exports, so the two runtimes cannot drift.

import { describe, expect, it } from "vitest";
import {
  BRAND_FIELD_CLASSES,
  BRAND_FIELD_VALUES,
  brandFieldKey,
  classifyBrandField,
  hasNoRecordedMaker,
  isNonBrandValue,
  tallyBrandField,
} from "@/lib/brand-field-classification";
// A .mjs sibling, imported by vitest so both readers run over one case list.
import {
  PARITY_CASES,
  classifyBrandField as classifyNode,
} from "../../../scripts/lib/brand-field-classification.mjs";

describe("the shared brand-field classification", () => {
  it("classifies the measured prod values", () => {
    expect(classifyBrandField("Norman Rockwell").class).toBe("licensor");
    expect(classifyBrandField("Cashmere").class).toBe("material");
  });

  it("never swallows a real house that is also an ordinary word", () => {
    // Named in the brand-KB corpus and in this repo's own refusal notes. Losing
    // any one of these to a heuristic would be invisible.
    for (
      const house of [
        "MOTHER",
        "FRAME",
        "Quince",
        "Vince",
        "No Fear",
        "No Boundaries",
        "None of the Above",
        "NA-KD",
        "Naturalizer",
        "Unknown Pleasures",
        "Vintage Havana",
        "The Original Retro Brand",
        "Bella+Canvas",
        "Gildan",
        "Hanes",
      ]
    ) {
      expect(classifyBrandField(house).class, house).toBe("maker");
      expect(isNonBrandValue(house), house).toBe(false);
    }
  });

  it("matches on the exact normalized key, never a substring", () => {
    // The accented spelling strips to nothing; the plain one keeps its u.
    expect(brandFieldKey("Stussy")).toBe("stussy");
    expect(brandFieldKey("Stüssy")).toBe("stssy");
    expect(brandFieldKey("Mizzen+Main")).toBe("mizzenmain");
    // "cashmere" is classified; a brand that merely contains it is not.
    expect(classifyBrandField("Cashmere").class).toBe("material");
    expect(classifyBrandField("Naked Cashmere").class).toBe("maker");
    expect(classifyBrandField("White + Warren Cashmere").class).toBe("maker");
  });
});

describe("AC4: Unbranded, Unknown and empty are three different facts", () => {
  it("Unbranded is an ANSWER and records a maker verdict", () => {
    const v = classifyBrandField("Unbranded");
    expect(v.class).toBe("unbranded");
    expect(v.recordsMaker).toBe(true);
    expect(hasNoRecordedMaker("Unbranded")).toBe(false);
    // eBay ships Handmade the same way.
    expect(classifyBrandField("Handmade").class).toBe("unbranded");
  });

  it("Unknown is a non-answer and does not", () => {
    const v = classifyBrandField("Unknown");
    expect(v.class).toBe("unknown");
    expect(v.recordsMaker).toBe(false);
    expect(hasNoRecordedMaker("Unknown")).toBe(true);
  });

  it("an empty field is its own class, distinct from Unknown", () => {
    expect(classifyBrandField("").class).toBe("blank");
    expect(classifyBrandField(null).class).toBe("blank");
    expect(classifyBrandField("   ").class).toBe("blank");
    // Punctuation-only carries no more information than emptiness.
    expect(classifyBrandField("-").class).toBe("blank");
    expect(classifyBrandField("???").class).toBe("blank");
    expect(classifyBrandField("Unknown").class).not.toBe(
      classifyBrandField("").class,
    );
  });

  it("'no brand' is the RPC's coalesce of an empty column, so it means unknown", () => {
    // Not "unbranded": nothing typed it, the sell-through RPC generated it.
    expect(classifyBrandField("No Brand").class).toBe("unknown");
  });
});

describe("the tally reports both denominators", () => {
  const demand = [
    { brand: "Nike", count: 10 },
    { brand: "Norman Rockwell", count: 5 },
    { brand: "Cashmere", count: 3 },
    { brand: "Unbranded", count: 2 },
    { brand: "", count: 4 },
  ];

  it("counts distinct values and items separately", () => {
    const t = tallyBrandField(demand);
    expect(t.totalValues).toBe(5);
    expect(t.totalItems).toBe(24);
    // 3 of 5 values and 12 of 24 items have no maker. Those are very different
    // percentages, which is the point: US-3307's title quotes the first shape
    // and means the second.
    expect(t.valuesWithNoMaker).toBe(3);
    expect(t.itemsWithNoMaker).toBe(12);
  });

  it("never counts Unbranded as missing a maker", () => {
    const t = tallyBrandField([{ brand: "Unbranded", count: 7 }]);
    expect(t.itemsWithNoMaker).toBe(0);
    expect(t.valuesWithNoMaker).toBe(0);
  });

  it("class rows sum back to the totals", () => {
    const t = tallyBrandField(demand);
    expect(t.rows.reduce((s, r) => s + r.items, 0)).toBe(t.totalItems);
    expect(t.rows.reduce((s, r) => s + r.values, 0)).toBe(t.totalValues);
  });
});

describe("the data file itself", () => {
  it("gives every value a class that exists and a reason", () => {
    for (const v of BRAND_FIELD_VALUES) {
      expect(BRAND_FIELD_CLASSES[v.class], v.key).toBeTruthy();
      expect(v.reason.length, v.key).toBeGreaterThan(5);
      // A key that is not already normalized would never match anything.
      expect(brandFieldKey(v.key), v.key).toBe(v.key);
    }
  });

  it("has no duplicate keys", () => {
    const keys = BRAND_FIELD_VALUES.map((v) => v.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("gives every non-maker class seller-facing guidance", () => {
    for (const [name, meta] of Object.entries(BRAND_FIELD_CLASSES)) {
      if (meta.recordsMaker) expect(meta.guidance, name).toBeNull();
      else expect(meta.guidance, name).toBeTruthy();
    }
  });
});

describe("the Node reader and the TypeScript reader agree", () => {
  it("classifies every parity case identically", () => {
    for (const [value, expected] of PARITY_CASES) {
      expect(classifyBrandField(value).class, `ts:${value}`).toBe(expected);
      expect(classifyNode(value).class, `node:${value}`).toBe(expected);
    }
  });

  it("agrees on recordsMaker too, which is the AC4 bit", () => {
    for (const [value] of PARITY_CASES) {
      expect(classifyNode(value).recordsMaker, value).toBe(
        classifyBrandField(value).recordsMaker,
      );
    }
  });
});

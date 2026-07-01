// US-822: the web composer's aspect prefill is driven by the vendored
// single-source registry (ebay-aspect-registry.json). These mirror the edge
// resolver tests so a divergence in the web LOGIC (not just the data) is caught.
import { describe, it, expect } from "vitest";
import {
  deriveAspectsFromItem,
  inferDepartment,
  mapEbayCondition,
  projectColumnAspects,
  type ItemAspectSource,
} from "@/lib/ebay-prefill";
import type { EbayAspect } from "@/hooks/use-ebay";

const base: ItemAspectSource = {
  title: null,
  brand: null,
  size: null,
  color: null,
  material: null,
  style: null,
  description: null,
  condition_notes: null,
  item_category: "clothing",
  attributes: null,
};

const free = (name: string): EbayAspect => ({
  localizedAspectName: name,
  aspectConstraint: { aspectMode: "FREE_TEXT" },
});
const sel = (name: string, allowed: string[], multi = false): EbayAspect => ({
  localizedAspectName: name,
  aspectConstraint: {
    aspectMode: "SELECTION_ONLY",
    itemToAspectCardinality: multi ? "MULTI" : "SINGLE",
  },
  aspectValues: allowed.map((localizedValue) => ({ localizedValue })),
});

describe("deriveAspectsFromItem (US-822 web registry)", () => {
  it("fills the legacy columns and their synonyms", () => {
    const item: ItemAspectSource = {
      ...base,
      brand: "Nike",
      size: "M",
      color: "Blue",
      material: "Cotton",
      style: "Hoodie",
    };
    expect(
      deriveAspectsFromItem(item, [
        free("Brand"),
        free("Colour"),
        free("Fabric Type"),
        free("Type"),
      ], {}),
    ).toEqual({
      Brand: ["Nike"],
      Colour: ["Blue"],
      "Fabric Type": ["Cotton"],
      Type: ["Hoodie"],
    });
  });

  it("defaults Size Type to Regular for clothing only", () => {
    expect(deriveAspectsFromItem(base, [free("Size Type")], {})).toEqual({
      "Size Type": ["Regular"],
    });
    expect(
      deriveAspectsFromItem({ ...base, item_category: "shoes" }, [free("Size Type")], {}),
    ).toEqual({});
  });

  it("infers Department and validates SELECTION_ONLY", () => {
    const item = { ...base, title: "Men's Nike Hoodie" };
    expect(
      deriveAspectsFromItem(item, [sel("Department", ["Men", "Women"])], {}),
    ).toEqual({ Department: ["Men"] });
    expect(deriveAspectsFromItem(item, [sel("Department", ["Women"])], {})).toEqual({});
  });

  it("never overwrites a user-set aspect", () => {
    const item = { ...base, brand: "Nike" };
    expect(deriveAspectsFromItem(item, [free("Brand")], { Brand: ["Adidas"] })).toEqual({});
  });

  it("maps US-821 canonical attributes onto aspects", () => {
    const item: ItemAspectSource = {
      ...base,
      attributes: { sleeve_length: "Long Sleeve", vintage: "No", mpn: "ABC123" },
    };
    expect(
      deriveAspectsFromItem(item, [free("Sleeve Length"), free("Vintage"), free("MPN")], {}),
    ).toEqual({
      "Sleeve Length": ["Long Sleeve"],
      Vintage: ["No"],
      MPN: ["ABC123"],
    });
  });

  it("attribute department beats text inference", () => {
    const item = { ...base, title: "Men's Hoodie", attributes: { department: "Unisex Adult" } };
    expect(deriveAspectsFromItem(item, [free("Department")], {})).toEqual({
      Department: ["Unisex Adult"],
    });
  });

  it("features (multi) fills a MULTI aspect with all matching values", () => {
    const item: ItemAspectSource = {
      ...base,
      attributes: { features: ["Pockets", "Lined", "Nope"] },
    };
    expect(
      deriveAspectsFromItem(item, [sel("Features", ["Pockets", "Lined", "Hooded"], true)], {}),
    ).toEqual({ Features: ["Pockets", "Lined"] });
    // SINGLE cardinality → first value only.
    expect(
      deriveAspectsFromItem(item, [free("Features")], {}),
    ).toEqual({ Features: ["Pockets"] });
  });

  it("uses shoe-specific candidates only in the shoes vertical", () => {
    const shoes = { ...base, item_category: "shoes", size: "10", material: "Leather" };
    expect(
      deriveAspectsFromItem(shoes, [free("US Shoe Size"), free("Upper Material")], {}),
    ).toEqual({ "US Shoe Size": ["10"], "Upper Material": ["Leather"] });
    // Clothing never matches the shoe-only candidate.
    expect(
      deriveAspectsFromItem({ ...base, size: "M" }, [free("US Shoe Size")], {}),
    ).toEqual({});
  });
});

describe("projectColumnAspects (main-page columns own their aspects)", () => {
  const cols = (o: Partial<ItemAspectSource>) => ({
    brand: null,
    size: null,
    color: null,
    material: null,
    style: null,
    ...o,
  });

  it("overwrites the column-backed aspects and stamps inventory_derived", () => {
    const { aspects, sources } = projectColumnAspects(
      cols({ brand: "Nike", size: "M", color: "Blue", material: "Cotton", style: "Hoodie" }),
      { Brand: ["Adidas"] },
      { Brand: "manual" },
    );
    expect(aspects).toEqual({
      Brand: ["Nike"],
      Size: ["M"],
      Color: ["Blue"],
      Material: ["Cotton"],
      Style: ["Hoodie"],
    });
    // A manually-typed Brand loses to the column — the main page is authoritative.
    expect(sources.Brand).toBe("inventory_derived");
  });

  it("clears an aspect + its source when the backing column is blanked", () => {
    // Brand column blanked → Brand aspect dropped; Size column still holds "M"
    // → Size overwritten from the column (and its source becomes the derived
    // provenance, since the column now owns it).
    const { aspects, sources } = projectColumnAspects(
      cols({ brand: "  ", size: "M" }),
      { Brand: ["Nike"], Size: ["L"] },
      { Brand: "inventory_derived", Size: "manual" },
    );
    expect(aspects).toEqual({ Size: ["M"] });
    expect(sources).toEqual({ Size: "inventory_derived" });
  });

  it("leaves non-column aspects (AI / attribute / manual) untouched", () => {
    const { aspects, sources } = projectColumnAspects(
      cols({ brand: "Nike" }),
      { "Sleeve Length": ["Long Sleeve"], Department: ["Men"] },
      { "Sleeve Length": "ai_extracted", Department: "manual" },
    );
    expect(aspects).toEqual({
      "Sleeve Length": ["Long Sleeve"],
      Department: ["Men"],
      Brand: ["Nike"],
    });
    expect(sources["Sleeve Length"]).toBe("ai_extracted");
    expect(sources.Department).toBe("manual");
  });

  it("does not mutate the inputs", () => {
    const existing = { Brand: ["Adidas"] };
    const existingSources = { Brand: "manual" as const };
    projectColumnAspects(cols({ brand: "Nike" }), existing, existingSources);
    expect(existing).toEqual({ Brand: ["Adidas"] });
    expect(existingSources).toEqual({ Brand: "manual" });
  });
});

describe("inferDepartment", () => {
  it("orders specificity correctly", () => {
    expect(inferDepartment({ ...base, title: "Women's Coat" })).toBe("Women");
    expect(inferDepartment({ ...base, title: "Men's Coat" })).toBe("Men");
    expect(inferDepartment({ ...base, size: "Boys 10/12" })).toBe("Boys");
    expect(inferDepartment({ ...base, title: "plain tee" })).toBeNull();
  });
});

describe("mapEbayCondition", () => {
  it("maps grade ranges and NWT", () => {
    expect(mapEbayCondition(10, "NWT")).toBe("NEW");
    expect(mapEbayCondition(9.0, null)).toBe("LIKE_NEW");
    expect(mapEbayCondition(7.5, null)).toBe("USED_EXCELLENT");
    expect(mapEbayCondition(null, null)).toBe("USED_EXCELLENT");
  });
});

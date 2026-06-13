// US-822: the web composer's aspect prefill is driven by the vendored
// single-source registry (ebay-aspect-registry.json). These mirror the edge
// resolver tests so a divergence in the web LOGIC (not just the data) is caught.
import { describe, it, expect } from "vitest";
import {
  deriveAspectsFromItem,
  inferDepartment,
  mapEbayCondition,
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

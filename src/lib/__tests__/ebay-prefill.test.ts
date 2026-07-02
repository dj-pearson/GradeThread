// US-822: the web composer's aspect prefill is driven by the vendored
// single-source registry (ebay-aspect-registry.json). These mirror the edge
// resolver tests so a divergence in the web LOGIC (not just the data) is caught.
import { describe, it, expect } from "vitest";
import {
  deriveAspectsFromItem,
  inferDepartment,
  mapEbayCondition,
  projectAttributeAspects,
  projectColumnAspects,
  reverseProjectAspectColumns,
  syncedItemFieldFor,
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

describe("reverseProjectAspectColumns (specifics edits flow back to the item)", () => {
  it("manual aspect edit overwrites a differing column; unchanged ones skipped", () => {
    const { columns, attributes } = reverseProjectAspectColumns(
      { ...base, brand: "Nike", size: "M" },
      { Brand: ["Adidas"], Size: ["M"] },
      { Brand: "manual", Size: "manual" },
    );
    expect(columns).toEqual({ brand: "Adidas" });
    expect(attributes).toEqual({});
  });

  it("manual and AI values fill a blank column; AI never overwrites", () => {
    const filled = reverseProjectAspectColumns(
      base,
      { Brand: ["Levi's"], Colour: ["Indigo"] },
      { Brand: "manual", Colour: "ai_extracted" },
    );
    expect(filled.columns).toEqual({ brand: "Levi's", color: "Indigo" });
    const populated = reverseProjectAspectColumns(
      { ...base, brand: "Nike" },
      { Brand: ["Adidas"] },
      { Brand: "ai_extracted" },
    );
    expect(populated.columns).toEqual({});
  });

  it("derived / unattributed values never flow back", () => {
    // "Medium" is the normalized projection of size "M" — writing it back would
    // churn the column; an unattributed Brand could be a stale mirror.
    const { columns } = reverseProjectAspectColumns(
      { ...base, brand: "Nike", size: "M" },
      { Size: ["Medium"], Brand: ["Adidas"] },
      { Size: "inventory_derived" },
    );
    expect(columns).toEqual({});
  });

  it("per-vertical synonyms match (shoes: US Shoe Size → size column)", () => {
    const { columns } = reverseProjectAspectColumns(
      { ...base, item_category: "shoes", size: "9" },
      { "US Shoe Size": ["10"] },
      { "US Shoe Size": "manual" },
    );
    expect(columns).toEqual({ size: "10" });
  });

  it("attribute-backed aspects write back to canonical attribute keys", () => {
    const { columns, attributes } = reverseProjectAspectColumns(
      { ...base, attributes: { pattern: "Solid" } },
      {
        Department: ["Men"],
        Pattern: ["Striped"],
        Features: ["Pockets", "Lined"],
      },
      { Department: "manual", Pattern: "manual", Features: "ai_extracted" },
    );
    expect(columns).toEqual({});
    expect(attributes).toEqual({
      department: "Men",
      pattern: "Striped",
      features: ["Pockets", "Lined"], // multi entry keeps all values
    });
  });

  it("AI attribute values fill only blank attributes", () => {
    const { attributes } = reverseProjectAspectColumns(
      { ...base, attributes: { department: "Women" } },
      { Department: ["Men"] },
      { Department: "ai_extracted" },
    );
    expect(attributes).toEqual({});
  });

  it("blank/absent aspects never clear a field", () => {
    const { columns, attributes } = reverseProjectAspectColumns(
      { ...base, brand: "Nike" },
      { Brand: [" "] },
      { Brand: "manual" },
    );
    expect(columns).toEqual({});
    expect(attributes).toEqual({});
  });
});

describe("syncedItemFieldFor", () => {
  it("maps column-backed aspect names (incl. synonyms + verticals)", () => {
    expect(syncedItemFieldFor("Brand", "clothing")).toBe("brand");
    expect(syncedItemFieldFor("Colour", "clothing")).toBe("color");
    expect(syncedItemFieldFor("Fabric Type", "clothing")).toBe("material");
    expect(syncedItemFieldFor("US Shoe Size", "shoes")).toBe("size");
    // shoes-only candidate doesn't apply to clothing
    expect(syncedItemFieldFor("US Shoe Size", "clothing")).toBeNull();
  });

  it("maps attribute-backed aspects to their canonical keys", () => {
    expect(syncedItemFieldFor("Department", "clothing")).toBe("department");
    expect(syncedItemFieldFor("Care Instructions", "clothing")).toBe("garment_care");
  });

  it("returns null for unknown aspects", () => {
    expect(syncedItemFieldFor("Occasion", "clothing")).toBeNull();
  });
});

describe("projectAttributeAspects (item Details fields own their aspects)", () => {
  it("a changed attribute overwrites its aspect and stamps inventory_derived", () => {
    const { aspects, sources } = projectAttributeAspects(
      { department: "Men", features: ["Pockets", "Lined"] },
      { Department: ["Women"], Brand: ["Nike"] },
      { Department: "manual", Brand: "inventory_derived" },
    );
    expect(aspects).toEqual({
      Department: ["Men"],
      Features: ["Pockets", "Lined"],
      Brand: ["Nike"],
    });
    expect(sources.Department).toBe("inventory_derived");
    expect(sources.Brand).toBe("inventory_derived");
  });

  it("a cleared attribute drops its aspect + source", () => {
    const { aspects, sources } = projectAttributeAspects(
      { pattern: null },
      { Pattern: ["Striped"], Department: ["Men"] },
      { Pattern: "manual", Department: "ai_extracted" },
    );
    expect(aspects).toEqual({ Department: ["Men"] });
    expect(sources).toEqual({ Department: "ai_extracted" });
  });

  it("untouched attributes never move their aspects; inputs not mutated", () => {
    const existing = { Department: ["Men"] };
    const existingSources = { Department: "manual" as const };
    const { aspects } = projectAttributeAspects({}, existing, existingSources);
    expect(aspects).toEqual({ Department: ["Men"] });
    expect(existing).toEqual({ Department: ["Men"] });
    expect(existingSources).toEqual({ Department: "manual" });
  });

  it("unknown keys are ignored", () => {
    const { aspects } = projectAttributeAspects({ nonsense: "x" }, {}, {});
    expect(aspects).toEqual({});
  });
});

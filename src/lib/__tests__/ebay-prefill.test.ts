// US-822: the web composer's aspect prefill is driven by the vendored
// single-source registry (ebay-aspect-registry.json). These mirror the edge
// resolver tests so a divergence in the web LOGIC (not just the data) is caught.
import { describe, it, expect } from "vitest";
import {
  deriveAspectsFromItem,
  inferDepartment,
  mapEbayCondition,
  projectColumnAspectsForSpec,
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

// US-2381: the forward projection is spec-aware. A spec-less sibling used to
// live beside it and was deleted with its caller; these cases pin the behaviour
// that made the spec-aware one necessary — the spec's names are not the
// registry's first guess.
describe("projectColumnAspectsForSpec (composer, spec-aware)", () => {
  const cols = (o: Partial<ItemAspectSource>) => ({
    brand: null,
    size: null,
    color: null,
    material: null,
    style: null,
    item_category: "clothing" as string | null,
    ...o,
  });

  it("writes the name THIS category uses, not the registry's first", () => {
    // "Colour" and "Fabric Type" are the same fields under different names.
    // The spec-less projection would have written "Color" and "Material",
    // leaving the picker's real rows empty and adding two duplicates.
    const { aspects } = projectColumnAspectsForSpec(
      cols({ color: "Blue", material: "Cotton" }),
      [free("Colour"), free("Fabric Type")],
      {},
      {},
    );
    expect(aspects).toEqual({ Colour: ["Blue"], "Fabric Type": ["Cotton"] });
  });

  it("skips a field the category does not expose at all", () => {
    const { aspects, sources } = projectColumnAspectsForSpec(
      cols({ brand: "Nike", material: "Cotton" }),
      [free("Brand")], // no Material/Fabric Type in this category
      {},
      {},
    );
    expect(aspects).toEqual({ Brand: ["Nike"] });
    expect(sources).toEqual({ Brand: "inventory_derived" });
  });

  it("normalizes a SELECTION_ONLY value the way publish would", () => {
    const { aspects } = projectColumnAspectsForSpec(
      cols({ size: "M" }),
      [sel("Size", ["Small", "Medium", "Large"])],
      {},
      {},
    );
    expect(aspects).toEqual({ Size: ["Medium"] });
  });

  it("keeps the existing value when the column is not expressible here", () => {
    // "Chartreuse" matches nothing in the allowed list. Clearing a good value
    // on the strength of an unusable one would be the worse outcome.
    const { aspects, sources } = projectColumnAspectsForSpec(
      cols({ color: "Chartreuse" }),
      [sel("Color", ["Black", "Blue", "Green"])],
      { Color: ["Green"] },
      { Color: "manual" },
    );
    expect(aspects).toEqual({ Color: ["Green"] });
    expect(sources.Color).toBe("manual");
  });

  // This projection is OVERWRITE-ONLY. It used to delete the aspect here, which
  // is the whole reason the bug below could happen: a blank column does not mean
  // "the seller cleared it", it can equally mean "nothing ever filled it".
  // Blanking a column still drops its specific in AutoLister bulk edit, which
  // owns the column inputs and rebuilds the map with its own set-or-drop pass.
  it("keeps the aspect when its backing column is blank, and still overwrites from a filled one", () => {
    const { aspects, sources } = projectColumnAspectsForSpec(
      cols({ brand: "   ", size: "M" }),
      [free("Brand"), free("Size")],
      { Brand: ["Nike"], Size: ["L"] },
      { Brand: "inventory_derived", Size: "manual" },
    );
    expect(aspects).toEqual({ Brand: ["Nike"], Size: ["M"] });
    expect(sources.Brand).toBe("inventory_derived");
  });

  // THE REGRESSION. Reported from a live draft: Brand visibly filled in the
  // specifics editor, publish refusing with "Fill required eBay specifics:
  // Brand". The state that produces it — a value stamped `inventory_derived`
  // whose backing column is empty — is reachable whenever the item write of a
  // save fails on its own (a duplicate-SKU 409 rolls it back while the listing
  // row, written in the same handler, keeps the aspects). The reverse pass will
  // not rescue a derived value, so if this projection also deletes it, every
  // later save re-destroys a Brand the seller can plainly see.
  it("does not destroy a specific whose column write never landed", () => {
    const poisoned = { Brand: ["Nike"] };
    const asDerived = { Brand: "inventory_derived" as const };
    const emptyColumn = cols({ brand: null });

    // Precondition: the reverse pass declines this value, by design.
    expect(
      reverseProjectAspectColumns({ ...base }, poisoned, asDerived).columns.brand,
    ).toBeUndefined();

    // So the projection is the last thing standing between it and deletion.
    const once = projectColumnAspectsForSpec(
      emptyColumn,
      [free("Brand")],
      poisoned,
      asDerived,
    );
    expect(once.aspects.Brand).toEqual(["Nike"]);

    // And it stays stable across repeated saves rather than decaying.
    const twice = projectColumnAspectsForSpec(
      emptyColumn,
      [free("Brand")],
      once.aspects,
      once.sources,
    );
    expect(twice.aspects.Brand).toEqual(["Nike"]);
  });

  it("leaves attribute-, AI- and manually-set non-column aspects alone", () => {
    const { aspects, sources } = projectColumnAspectsForSpec(
      cols({ brand: "Nike" }),
      [free("Brand"), free("Sleeve Length"), free("Department")],
      { "Sleeve Length": ["Long Sleeve"], Department: ["Men"] },
      { "Sleeve Length": "ai_extracted", Department: "manual" },
    );
    expect(aspects["Sleeve Length"]).toEqual(["Long Sleeve"]);
    expect(sources.Department).toBe("manual");
  });

  it("does not mutate its inputs", () => {
    const existing = { Brand: ["Adidas"] };
    const existingSources = { Brand: "manual" as const };
    projectColumnAspectsForSpec(
      cols({ brand: "Nike" }),
      [free("Brand")],
      existing,
      existingSources,
    );
    expect(existing).toEqual({ Brand: ["Adidas"] });
    expect(existingSources).toEqual({ Brand: "manual" });
  });

  // The caller contract, asserted as behaviour: the composer runs the reverse
  // pass FIRST and feeds this the post-write-back columns. Run in that order a
  // manual edit survives; run the other way it is destroyed. This test pins the
  // order, because nothing in the type system can.
  it("preserves a manual specifics edit when fed the post-write-back columns", () => {
    const item = { ...base, brand: "Adidas" }; // stale column
    const aspects = { Brand: ["Nike"] }; // seller just typed this
    const sources = { Brand: "manual" as const };

    const wb = reverseProjectAspectColumns(item, aspects, sources);
    expect(wb.columns.brand).toBe("Nike"); // reverse rescues it into the column

    const projected = projectColumnAspectsForSpec(
      { ...item, ...wb.columns },
      [free("Brand")],
      aspects,
      sources,
    );
    expect(projected.aspects.Brand).toEqual(["Nike"]);

    // And the failure mode the ordering exists to prevent: projecting from the
    // PRE-write-back column silently reinstates the stale value.
    const wrongOrder = projectColumnAspectsForSpec(
      item,
      [free("Brand")],
      aspects,
      sources,
    );
    expect(wrongOrder.aspects.Brand).toEqual(["Adidas"]);
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

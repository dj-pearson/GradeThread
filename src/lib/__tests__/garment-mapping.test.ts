import { describe, it, expect } from "vitest";
import {
  deriveGarmentType,
  deriveGarmentDefaults,
  garmentPatchForCategoryChange,
} from "@/lib/garment-mapping";

describe("deriveGarmentType", () => {
  it("maps garment-graded item categories to a garment_type", () => {
    expect(deriveGarmentType("clothing")).toBe("tops");
    expect(deriveGarmentType("shoes")).toBe("footwear");
    expect(deriveGarmentType("bags")).toBe("accessories");
    expect(deriveGarmentType("accessories")).toBe("accessories");
  });

  it("is case/space insensitive", () => {
    expect(deriveGarmentType("  Clothing ")).toBe("tops");
  });

  it("returns null for non-garment categories and empty input", () => {
    expect(deriveGarmentType("electronics")).toBeNull();
    expect(deriveGarmentType("sports_cards")).toBeNull();
    expect(deriveGarmentType("other")).toBeNull();
    expect(deriveGarmentType("")).toBeNull();
    expect(deriveGarmentType(null)).toBeNull();
    expect(deriveGarmentType(undefined)).toBeNull();
  });
});

describe("deriveGarmentDefaults", () => {
  it("derives both fields from item_category when no explicit values", () => {
    expect(deriveGarmentDefaults("clothing")).toEqual({
      garment_type: "tops",
      garment_category: "other",
    });
  });

  it("prefers valid explicit (AI/user) values over the derived default", () => {
    expect(
      deriveGarmentDefaults("clothing", {
        garment_type: "bottoms",
        garment_category: "jeans",
      }),
    ).toEqual({ garment_type: "bottoms", garment_category: "jeans" });
  });

  it("ignores explicit values that aren't valid enum members", () => {
    expect(
      deriveGarmentDefaults("clothing", {
        garment_type: "not-a-type",
        garment_category: "bogus",
      }),
    ).toEqual({ garment_type: "tops", garment_category: "other" });
  });

  it("falls back to the derived garment_type when only the category is explicit", () => {
    expect(
      deriveGarmentDefaults("clothing", { garment_category: "hoodie" }),
    ).toEqual({ garment_type: "tops", garment_category: "hoodie" });
  });

  it("returns nulls for a non-garment category with no explicit values", () => {
    expect(deriveGarmentDefaults("electronics")).toEqual({
      garment_type: null,
      garment_category: null,
    });
  });

  it("still honours a valid explicit garment_type for an unmapped category", () => {
    expect(
      deriveGarmentDefaults("other", { garment_type: "dresses" }),
    ).toEqual({ garment_type: "dresses", garment_category: "dress" });
  });
});

// US-2384: both routes into a coarse-category change call this, so the rules
// live in one place and the two cannot drift apart again. The bug it closes was
// exactly that drift — the eBay-leaf route re-derived, the seller's own picker
// did not, and the item kept grading against its old family with both garment
// fields populated so nothing looked wrong.
describe("garmentPatchForCategoryChange", () => {
  it("re-derives when the coarse FAMILY changes", () => {
    expect(garmentPatchForCategoryChange("clothing", "shoes")).toEqual({
      garment_type: "footwear",
      // "other" is the deliberate non-overstating default for every type but
      // dresses — garment_category is a metadata label, not a rubric key.
      garment_category: "other",
    });
  });

  it("returns null for a same-family correction, keeping the seller's pick", () => {
    // bags, accessories, jewelry and watches all sit in the accessories family:
    // the garment axis genuinely does not move, so neither should we.
    expect(garmentPatchForCategoryChange("bags", "jewelry")).toBeNull();
    expect(garmentPatchForCategoryChange("clothing", "clothing")).toBeNull();
  });

  it("re-derives to nulls when the new category is not garment-graded", () => {
    // Not the same as "no change": the old garment is now wrong, so it has to
    // be cleared. Callers must SPREAD the result rather than drop nulls.
    expect(garmentPatchForCategoryChange("clothing", "other")).toEqual({
      garment_type: null,
      garment_category: null,
    });
    expect(garmentPatchForCategoryChange("clothing", null)).toEqual({
      garment_type: null,
      garment_category: null,
    });
  });

  it("re-derives when an ungraded category becomes garment-graded", () => {
    expect(garmentPatchForCategoryChange(null, "clothing")).toEqual({
      garment_type: "tops",
      garment_category: "other",
    });
  });

  it("agrees with deriveGarmentDefaults, so the two routes cannot disagree", () => {
    for (const next of ["clothing", "shoes", "bags", "other"]) {
      const patch = garmentPatchForCategoryChange("clothing", next);
      if (patch) expect(patch).toEqual(deriveGarmentDefaults(next));
    }
  });
});

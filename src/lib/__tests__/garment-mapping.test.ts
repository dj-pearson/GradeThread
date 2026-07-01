import { describe, it, expect } from "vitest";
import {
  deriveGarmentType,
  deriveGarmentDefaults,
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

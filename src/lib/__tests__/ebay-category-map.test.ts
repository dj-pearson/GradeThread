import { describe, expect, it } from "vitest";
import { ebayPathToItemCategory } from "@/lib/ebay-category-map";

const ROOT = "Clothing, Shoes & Accessories";

describe("ebayPathToItemCategory", () => {
  it("classifies shoes from the descendant segments (not the root)", () => {
    expect(
      ebayPathToItemCategory(`${ROOT} › Men › Men's Shoes › Athletic Shoes`),
    ).toBe("shoes");
  });

  it("does not let the root's 'Shoes' word misclassify apparel", () => {
    expect(
      ebayPathToItemCategory(
        `${ROOT} › Men › Men's Clothing › Casual Button-Down Shirts`,
      ),
    ).toBe("clothing");
  });

  it("classifies handbags as bags", () => {
    expect(
      ebayPathToItemCategory(`${ROOT} › Women › Women's Bags & Handbags`),
    ).toBe("bags");
  });

  it("classifies watches", () => {
    expect(
      ebayPathToItemCategory("Jewelry & Watches › Watches, Parts & Accessories › Wristwatches"),
    ).toBe("watches");
  });

  it("classifies fine/fashion jewelry", () => {
    expect(
      ebayPathToItemCategory("Jewelry & Watches › Fashion Jewelry › Necklaces & Pendants"),
    ).toBe("jewelry");
  });

  it("classifies dresses as clothing", () => {
    expect(ebayPathToItemCategory(`${ROOT} › Women › Women's Clothing › Dresses`)).toBe(
      "clothing",
    );
  });

  it("classifies standalone accessories (belts/hats)", () => {
    expect(
      ebayPathToItemCategory(`${ROOT} › Men › Men's Accessories › Belts`),
    ).toBe("accessories");
  });

  it("returns null for a non-fashion / unknown vertical", () => {
    expect(
      ebayPathToItemCategory("Cell Phones & Accessories › Cell Phones & Smartphones"),
    ).toBeNull();
    expect(ebayPathToItemCategory(null)).toBeNull();
    expect(ebayPathToItemCategory("")).toBeNull();
  });
});

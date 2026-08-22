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

  // US-2799: this case was called "(belts/hats)" and asserted only belts. The
  // name claimed the coverage; the assertion never had it, and hats were
  // returning the wrong answer underneath it the whole time.
  it("classifies standalone accessories (belts)", () => {
    expect(
      ebayPathToItemCategory(`${ROOT} › Men › Men's Accessories › Belts`),
    ).toBe("accessories");
  });

  describe("US-2799: a hat is headwear, not an accessory", () => {
    // item_category picks the rubric, the photo profile and the measurement
    // template. This function's job is to OVERWRITE item_category when a seller
    // corrects the eBay category, so getting a hat wrong here undoes all three
    // at the exact moment the seller was being most explicit about the item.
    it.each([
      `${ROOT} › Men › Men's Accessories › Hats`,
      `${ROOT} › Men › Men's Clothing › Hats`,
      `${ROOT} › Women › Women's Accessories › Hats`,
      `${ROOT} › Unisex Adult › Unisex Adult Accessories › Hats`,
    ])("%s", (path) => {
      expect(ebayPathToItemCategory(path)).toBe("headwear");
    });

    it("beats the generic 'Clothing' word sitting beside it in the path", () => {
      // The whole reason headwear has to be checked BEFORE clothing: eBay files
      // hats under a clothing parent on several paths, so both words are in the
      // tail and only order decides.
      expect(ebayPathToItemCategory(`${ROOT} › Men › Men's Clothing › Hats`)).toBe(
        "headwear",
      );
    });

    it("does not steal capris, which are pants", () => {
      // The file's own comment says the closing boundary is what keeps "caps"
      // from matching "capris". Nothing asserted it. Now something does — and
      // it is the one word-boundary claim this file makes that would be
      // expensive to get wrong.
      expect(
        ebayPathToItemCategory(`${ROOT} › Women › Women's Clothing › Capris & Cropped Pants`),
      ).toBe("clothing");
    });

    it("does not steal bootcut jeans, which are also pants", () => {
      // Same claim, the other example the comment names.
      expect(
        ebayPathToItemCategory(`${ROOT} › Women › Women's Clothing › Jeans › Bootcut`),
      ).toBe("clothing");
    });
  });

  it("returns null for a non-fashion / unknown vertical", () => {
    expect(
      ebayPathToItemCategory("Cell Phones & Accessories › Cell Phones & Smartphones"),
    ).toBeNull();
    expect(ebayPathToItemCategory(null)).toBeNull();
    expect(ebayPathToItemCategory("")).toBeNull();
  });
});

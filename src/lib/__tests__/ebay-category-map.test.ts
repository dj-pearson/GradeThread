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

  it("returns null only for genuinely unknown input now", () => {
    // US-3016 changed the electronics case deliberately. This asserted null
    // for every non-fashion vertical, which is what made the composer's own
    // helper text ("Picking an eBay category above keeps this in sync") false
    // for anything that is not a garment.
    expect(
      ebayPathToItemCategory("Cell Phones & Accessories › Cell Phones & Smartphones"),
    ).toBe("electronics");
    expect(ebayPathToItemCategory(null)).toBeNull();
    expect(ebayPathToItemCategory("")).toBeNull();
    expect(ebayPathToItemCategory("Everything Else › Weird Stuff")).toBeNull();
  });

  // ── US-3016: the non-apparel roots ───────────────────────────────────────
  //
  // FlipDesk lists anything eBay lists. These are the three the owner was
  // actually holding when this came up, plus the roots around them.
  describe("non-apparel verticals", () => {
    it("maps a doll, a plate and a carved egg to collectibles", () => {
      expect(
        ebayPathToItemCategory("Toys & Hobbies › Dolls & Bears › Dolls › Barbie"),
      ).toBe("collectibles");
      expect(
        ebayPathToItemCategory(
          "Antiques › Decorative Arts › Ceramics & Porcelain › Plates",
        ),
      ).toBe("collectibles");
      expect(
        ebayPathToItemCategory("Collectibles › Cultures & Ethnicities › Asian › Japanese"),
      ).toBe("collectibles");
      expect(ebayPathToItemCategory("Pottery & Glass › Pottery & China")).toBe(
        "collectibles",
      );
      expect(ebayPathToItemCategory("Coins & Paper Money › Coins: US")).toBe(
        "collectibles",
      );
    });

    it("reads the ROOT, not the descendants, outside apparel", () => {
      // This is the whole point of the inversion. Both of these paths end in a
      // word the apparel branches would match, and both would have been
      // classified as footwear or an accessory by reading the tail.
      expect(
        ebayPathToItemCategory("Collectibles › Advertising › Merchandise & Memorabilia › Shoes"),
      ).toBe("collectibles");
      expect(
        ebayPathToItemCategory("Toys & Hobbies › Action Figures › Accessories"),
      ).toBe("collectibles");
    });

    it("splits the two roots that straddle our values", () => {
      expect(
        ebayPathToItemCategory("Sports Mem, Cards & Fan Shop › Sports Trading Cards › Singles"),
      ).toBe("sports_cards");
      expect(
        ebayPathToItemCategory("Sports Mem, Cards & Fan Shop › Autographs-Original › Baseball"),
      ).toBe("collectibles");
      // eBay's newer standalone root covers Pokemon and Magic too; our enum
      // has one card bucket and it picks the rubric, so they share it.
      expect(
        ebayPathToItemCategory("Trading Cards › Collectible Card Games › CCG Individual Cards"),
      ).toBe("sports_cards");
    });

    it("still lets the apparel root fall through to the descendants", () => {
      // The apparel root names three verticals at once, so it must NOT be
      // root-classified. Regression guard on the inversion above.
      expect(
        ebayPathToItemCategory(`${ROOT} › Men › Men's Shoes › Athletic Shoes`),
      ).toBe("shoes");
      expect(
        ebayPathToItemCategory(`${ROOT} › Women › Women's Clothing › Dresses`),
      ).toBe("clothing");
    });

    it("declines a path whose first segment is not a marketplace root", () => {
      // category_name in the aspect cache is not always a full breadcrumb —
      // plenty of cached rows start at "Pants" or "Sweaters". Those must reach
      // the descendant logic, not be mistaken for an unknown root.
      expect(ebayPathToItemCategory("Pants")).toBe("clothing");
    });
  });
});

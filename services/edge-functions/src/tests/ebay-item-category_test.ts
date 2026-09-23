// US-3468: an eBay breadcrumb decides the vertical an adopted item lands in,
// and every eBay root has a home.
import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import {
  EBAY_ROOT_CATEGORIES,
  itemCategoryFromEbayPath,
  splitEbayCategoryPath,
} from "../lib/ebay-item-category.ts";
import { ITEM_CATEGORIES } from "../lib/ai-extract.ts";

Deno.test("US-3468: a baseball card is sports_cards, not clothing", () => {
  assertEquals(
    itemCategoryFromEbayPath(
      "Sports Mem, Cards & Fan Shop › Sports Trading Cards › Trading Card Singles",
    ),
    "sports_cards",
  );
  // Trading's colon form, straight off GetItem's PrimaryCategory.CategoryName.
  assertEquals(
    itemCategoryFromEbayPath(
      "Sports Mem, Cards & Fan Shop:Sports Trading Cards:Trading Card Singles",
    ),
    "sports_cards",
  );
  assertEquals(
    itemCategoryFromEbayPath(
      "Collectibles › Non-Sport Trading Cards › Trading Card Singles",
    ),
    "sports_cards",
  );
  assertEquals(
    itemCategoryFromEbayPath(
      "Toys & Hobbies › Collectible Card Games › CCG Individual Cards",
    ),
    "sports_cards",
  );
});

Deno.test("US-3468: the clothing root splits into its verticals by segment, never by the root's own words", () => {
  const cases: Array<[string, string]> = [
    [
      "Clothing, Shoes & Accessories › Men › Men's Clothing › Shirts › Casual Button-Down Shirts",
      "clothing",
    ],
    [
      "Clothing, Shoes & Accessories › Women › Women's Clothing › Dresses",
      "clothing",
    ],
    [
      "Clothing, Shoes & Accessories › Kids › Girls › Girls' Clothing (Sizes 4 & Up)",
      "clothing",
    ],
    [
      "Clothing, Shoes & Accessories › Men › Men's Shoes › Athletic Shoes",
      "shoes",
    ],
    ["Clothing, Shoes & Accessories › Women › Women's Shoes › Boots", "shoes"],
    [
      "Clothing, Shoes & Accessories › Men › Men's Accessories › Hats",
      "headwear",
    ],
    ["Clothing, Shoes & Accessories › Women › Women's Bags & Handbags", "bags"],
    [
      "Clothing, Shoes & Accessories › Men › Men's Accessories › Backpacks, Bags & Briefcases",
      "bags",
    ],
    [
      "Clothing, Shoes & Accessories › Men › Men's Accessories › Belts",
      "accessories",
    ],
    [
      "Clothing, Shoes & Accessories › Men › Men's Accessories › Wallets",
      "accessories",
    ],
    [
      "Clothing, Shoes & Accessories › Women › Women's Accessories › Sunglasses & Sunglasses Accessories",
      "accessories",
    ],
    [
      "Clothing, Shoes & Accessories › Men › Men's Accessories › Watches",
      "watches",
    ],
  ];
  for (const [path, want] of cases) {
    assertEquals(itemCategoryFromEbayPath(path), want, path);
  }
});

Deno.test("US-3468: every other root, including the ones GradeThread does not model", () => {
  const cases: Array<[string, string]> = [
    [
      "Jewelry & Watches › Watches, Parts & Accessories › Watches › Wristwatches",
      "watches",
    ],
    ["Jewelry & Watches › Fine Jewelry › Rings", "jewelry"],
    ["Books & Magazines › Books", "books"],
    [
      "Consumer Electronics › Portable Audio & Headphones › Headphones",
      "electronics",
    ],
    ["Cell Phones & Accessories › Cell Phones & Smartphones", "electronics"],
    ["Computers/Tablets & Networking › Laptops & Netbooks", "electronics"],
    ["Cameras & Photo › Digital Cameras", "electronics"],
    ["Video Games & Consoles › Video Games", "electronics"],
    ["Collectibles › Advertising › Soda", "collectibles"],
    ["Coins & Paper Money › Coins: US › Dollars", "collectibles"],
    ["Stamps › United States › Postage", "collectibles"],
    [
      "Toys & Hobbies › Action Figures & Accessories › Action Figures",
      "collectibles",
    ],
    ["Dolls & Bears › Dolls › Clothing & Accessories", "collectibles"],
    ["Antiques › Furniture › Chairs", "collectibles"],
    ["Art › Paintings", "collectibles"],
    ["Pottery & Glass › Pottery › Art Pottery", "collectibles"],
    ["Entertainment Memorabilia › Movie Memorabilia › Posters", "collectibles"],
    [
      "Sports Mem, Cards & Fan Shop › Fan Apparel & Souvenirs › Baseball-MLB",
      "collectibles",
    ],
    [
      "Sports Mem, Cards & Fan Shop › Fan Apparel & Souvenirs › Football-NFL › Jerseys",
      "clothing",
    ],
    [
      "Sports Mem, Cards & Fan Shop › Fan Apparel & Souvenirs › Football-NFL › Caps & Hats",
      "headwear",
    ],
    [
      "Sports Mem, Cards & Fan Shop › Autographs-Original › Baseball-MLB › Balls",
      "collectibles",
    ],
    [
      "Sporting Goods › Team Sports › Baseball & Softball › Clothing, Shoes & Accessories › Shoes & Cleats",
      "shoes",
    ],
    ["Sporting Goods › Cycling › Cycling Clothing › Jerseys", "clothing"],
    ["Sporting Goods › Golf › Golf Clothing, Shoes & Accs › Golf Bags", "bags"],
    ["Sporting Goods › Golf › Golf Clubs & Equipment › Golf Clubs", "other"],
    ["Baby › Baby Clothing, Shoes & Accessories › Baby Clothing", "clothing"],
    ["Baby › Baby Clothing, Shoes & Accessories › Baby Shoes", "shoes"],
    ["Baby › Strollers & Accessories › Strollers", "other"],
    ["Travel › Luggage › Suitcases", "bags"],
    ["Travel › Travel Accessories › Passport Holders", "other"],
    [
      "eBay Motors › Apparel & Merchandise › Motorcycle Apparel & Merchandise › Jackets & Leathers",
      "clothing",
    ],
    ["eBay Motors › Parts & Accessories › Car & Truck Parts", "other"],
    ["Home & Garden › Kitchen, Dining & Bar › Cookware", "other"],
    ["Health & Beauty › Fragrances › Men's Fragrances", "other"],
    ["Music › Vinyl Records", "other"],
    ["Movies & TV › DVDs & Blu-ray Discs", "other"],
    ["Musical Instruments & Gear › Guitars & Basses", "other"],
    ["Pet Supplies › Dog Supplies", "other"],
    ["Crafts › Sewing › Fabric", "other"],
    ["Business & Industrial › Restaurant & Food Service", "other"],
    ["Gift Cards & Coupons › Gift Cards", "other"],
    ["Tickets & Experiences › Concert Tickets", "other"],
    ["Real Estate › Land", "other"],
    ["Specialty Services › Printing & Personalization", "other"],
    ["Everything Else › Adult Only", "other"],
    ["A Root eBay Invents Next Year › Something", "other"],
  ];
  for (const [path, want] of cases) {
    assertEquals(itemCategoryFromEbayPath(path), want, path);
  }
});

Deno.test("US-3468: the root roster maps only onto real item categories, and every root resolves", () => {
  const allowed = new Set<string>([...ITEM_CATEGORIES, "by_segment"]);
  for (const entry of EBAY_ROOT_CATEGORIES) {
    assert(allowed.has(entry.category), `${entry.root}: ${entry.category}`);
  }
  // The roster is eBay US's L1 list; 35 entries as of 2026-09.
  assertEquals(EBAY_ROOT_CATEGORIES.length, 35);
});

Deno.test("US-3468: no path means no answer, so the caller keeps what it had", () => {
  assertEquals(itemCategoryFromEbayPath(null), null);
  assertEquals(itemCategoryFromEbayPath(""), null);
  assertEquals(itemCategoryFromEbayPath("   "), null);
  assertEquals(splitEbayCategoryPath("A › B:C > D"), ["A", "B", "C", "D"]);
});

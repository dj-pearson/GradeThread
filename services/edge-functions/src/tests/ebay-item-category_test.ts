// US-3468: an eBay breadcrumb decides the vertical an adopted item lands in.
import { assertEquals } from "@std/assert";
import {
  itemCategoryFromEbayPath,
  splitEbayCategoryPath,
} from "../lib/ebay-item-category.ts";

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

Deno.test("US-3468: the other roots", () => {
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
    ["Video Games & Consoles › Video Games", "electronics"],
    ["Collectibles › Advertising › Soda", "collectibles"],
    ["Coins & Paper Money › Coins: US › Dollars", "collectibles"],
    [
      "Toys & Hobbies › Action Figures & Accessories › Action Figures",
      "collectibles",
    ],
    [
      "Sports Mem, Cards & Fan Shop › Fan Apparel & Souvenirs › Baseball-MLB",
      "collectibles",
    ],
    [
      "Sporting Goods › Team Sports › Baseball & Softball › Clothing, Shoes & Accessories › Shoes & Cleats",
      "shoes",
    ],
    ["Sporting Goods › Cycling › Cycling Clothing › Jerseys", "clothing"],
    ["Sporting Goods › Golf › Golf Clubs & Equipment › Golf Clubs", "other"],
    ["Home & Garden › Kitchen, Dining & Bar › Cookware", "other"],
  ];
  for (const [path, want] of cases) {
    assertEquals(itemCategoryFromEbayPath(path), want, path);
  }
});

Deno.test("US-3468: no path means no answer, so the caller keeps what it had", () => {
  assertEquals(itemCategoryFromEbayPath(null), null);
  assertEquals(itemCategoryFromEbayPath(""), null);
  assertEquals(itemCategoryFromEbayPath("   "), null);
  assertEquals(splitEbayCategoryPath("A › B:C > D"), ["A", "B", "C", "D"]);
});

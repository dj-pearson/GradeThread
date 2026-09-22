// US-3468: which GradeThread item_category an eBay listing belongs to, read
// off the listing's category breadcrumb.
//
// Every item adopted from an eBay listing used to be created as "clothing",
// whatever eBay filed it under, so a graded baseball card sat in the clothing
// vertical with the clothing photo profile and the garment measurement
// template around it. The breadcrumb is already resolvable for any category
// id (getCategoryName, cached in ebay_category_aspects), and GetItem returns
// it outright as PrimaryCategory.CategoryName, so the vertical is knowable at
// the moment the item is made.
//
// EVERY eBay top-level category has a home here. GradeThread models twelve
// item types (ai-extract.ts ITEM_CATEGORIES, the item_category enum), so the
// 30-odd eBay roots are folded onto those twelve: the roots that ARE one of
// our verticals map to it, the roots that split across several (Clothing,
// Shoes & Accessories; Jewelry & Watches; Sporting Goods; Baby; Travel) are
// read by segment, and the roots GradeThread does not model (Home & Garden,
// Health & Beauty, Music, Pet Supplies, ...) map to "other", which is the
// enum's own catch-all and is a real answer: the listing was read and is not
// a garment. A root this table has never heard of also answers "other", for
// the same reason. Only NO path answers null, so the caller keeps what it had.
//
// Pure module: string in, enum value out. Matching is by SEGMENT, case-
// insensitive, most specific rule first. The root segment is never scanned
// for vertical words because "Clothing, Shoes & Accessories" contains three.

import type { ITEM_CATEGORIES } from "./ai-extract.ts";

export type ItemCategory = (typeof ITEM_CATEGORIES)[number];

/** eBay renders paths three ways: " › " (Taxonomy), ":" (Trading), " > ". */
export function splitEbayCategoryPath(
  path: string | null | undefined,
): string[] {
  if (!path) return [];
  return path
    .split(/\s*›\s*|\s*>\s*|:/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * eBay US top-level categories and the vertical each one is, when the root
 * alone decides it. Roots that split by segment are handled in code above
 * this table and are listed here only so the table is the complete roster.
 * Order does not matter; every regex is anchored at the start of the root.
 */
export const EBAY_ROOT_CATEGORIES: ReadonlyArray<
  { root: RegExp; category: ItemCategory | "by_segment" }
> = [
  { root: /^antiques/i, category: "collectibles" },
  { root: /^art$/i, category: "collectibles" },
  { root: /^baby/i, category: "by_segment" },
  { root: /^books/i, category: "books" },
  { root: /^business/i, category: "other" },
  { root: /^cameras/i, category: "electronics" },
  { root: /^cell phones/i, category: "electronics" },
  { root: /^clothing/i, category: "by_segment" },
  { root: /^coins/i, category: "collectibles" },
  { root: /^collectibles/i, category: "collectibles" },
  { root: /^computers/i, category: "electronics" },
  { root: /^consumer electronics/i, category: "electronics" },
  { root: /^crafts/i, category: "other" },
  { root: /^dolls/i, category: "collectibles" },
  { root: /^dvds|^movies/i, category: "other" },
  { root: /^ebay motors/i, category: "by_segment" },
  { root: /^entertainment memorabilia/i, category: "collectibles" },
  { root: /^everything else/i, category: "other" },
  { root: /^gift cards/i, category: "other" },
  { root: /^health/i, category: "other" },
  { root: /^home/i, category: "other" },
  { root: /^jewelry/i, category: "by_segment" },
  { root: /^music$/i, category: "other" },
  { root: /^musical instruments/i, category: "other" },
  { root: /^pet supplies/i, category: "other" },
  { root: /^pottery/i, category: "collectibles" },
  { root: /^real estate/i, category: "other" },
  { root: /^specialty services/i, category: "other" },
  { root: /^sporting goods/i, category: "by_segment" },
  { root: /^sports mem/i, category: "by_segment" },
  { root: /^stamps/i, category: "collectibles" },
  { root: /^tickets/i, category: "other" },
  { root: /^toys/i, category: "collectibles" },
  { root: /^travel/i, category: "by_segment" },
  { root: /^video games/i, category: "electronics" },
];

const SHOES = /\bshoes?\b|\bboots\b|sneakers|footwear|cleats|sandals|slippers/i;
const HEADWEAR = /\bhats?\b|\bcaps?\b|beanies|headwear|helmets/i;
const BAGS =
  /\bbags?\b|handbag|backpack|briefcase|luggage|\bpurses?\b|suitcase/i;
const WATCHES = /\bwatch(es)?\b/i;
const JEWELRY = /jewelry|jewellery/i;
const APPAREL =
  /apparel|clothing|jerseys?|\bshirts?\b|\bpants\b|jackets?|\bshorts\b|dresses|uniforms?|outerwear|sweaters?|hoodies|activewear|swimwear|socks|underwear|sleepwear/i;
const CARDS = /trading card|card singles|collectible card game|\bccg\b/i;

/**
 * The item_category an eBay category path implies, or null when there is no
 * path to read.
 */
export function itemCategoryFromEbayPath(
  path: string | null | undefined,
): ItemCategory | null {
  const segments = splitEbayCategoryPath(path);
  if (segments.length === 0) return null;
  const root = segments[0];
  const rest = segments.slice(1);
  const leaf = rest[rest.length - 1] ?? "";
  const restText = rest.join(" | ");
  // The LEAF decides first, then the segments above it. A scan across every
  // segment at once read "Golf Clothing, Shoes & Accs > Golf Bags" as shoes,
  // because an intermediate segment names three verticals on its way to one.
  const pick = (
    rules: ReadonlyArray<readonly [RegExp, ItemCategory]>,
  ): ItemCategory | null => {
    for (const [re, category] of rules) if (re.test(leaf)) return category;
    for (const [re, category] of rules) if (re.test(restText)) return category;
    return null;
  };

  // A trading card is a card wherever eBay files it: under Sports Mem, under
  // Collectibles (Non-Sport Trading Cards) or under Toys (Collectible Card
  // Games). ai-extract's classifier uses the same rule.
  if (CARDS.test(segments.join(" | "))) return "sports_cards";

  const entry = EBAY_ROOT_CATEGORIES.find((e) => e.root.test(root));
  if (!entry) return "other";
  if (entry.category !== "by_segment") return entry.category;

  if (/^clothing/i.test(root)) {
    return pick([
      [SHOES, "shoes"],
      [HEADWEAR, "headwear"],
      [BAGS, "bags"],
      [JEWELRY, "jewelry"],
      [WATCHES, "watches"],
      // "Accessories" means a standalone belt, scarf or pair of sunglasses
      // ONLY under this root; elsewhere it is phone cases and camera straps.
      [/accessor/i, "accessories"],
    ]) ?? "clothing";
  }
  if (/^jewelry/i.test(root)) return pick([[WATCHES, "watches"]]) ?? "jewelry";
  if (/^sports mem/i.test(root)) {
    // Fan Apparel & Souvenirs holds jerseys and caps beside mugs and pennants.
    return pick([
      [HEADWEAR, "headwear"],
      [/jerseys?|\bshirts?\b|jackets?|hoodies|sweatshirts?/i, "clothing"],
    ]) ?? "collectibles";
  }
  // Sporting Goods, Baby, Travel, eBay Motors: garments, shoes, hats and bags
  // live under all four; the rest of each root is gear, nursery, tickets or
  // parts, which GradeThread does not model.
  return pick([
    [SHOES, "shoes"],
    [HEADWEAR, "headwear"],
    [BAGS, "bags"],
    [WATCHES, "watches"],
    [JEWELRY, "jewelry"],
    [APPAREL, "clothing"],
  ]) ?? "other";
}

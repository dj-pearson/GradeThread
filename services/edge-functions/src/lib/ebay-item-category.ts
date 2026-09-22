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
// Pure module: string in, enum value out. The mapping is by SEGMENT, matched
// case-insensitively, most specific rule first. A path this cannot place
// under a known root answers "other" (the enum's own catch-all); no path at
// all answers null so the caller keeps whatever it had.

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

const ELECTRONICS_ROOTS = [
  /^consumer electronics/i,
  /^cell phones/i,
  /^computers/i,
  /^cameras/i,
  /^video games/i,
];

const COLLECTIBLE_ROOTS = [
  /^collectibles/i,
  /^coins/i,
  /^stamps/i,
  /^toys/i,
  /^dolls/i,
  /^entertainment memorabilia/i,
  /^antiques/i,
  /^art$/i,
  /^pottery/i,
  /^sports mem/i,
];

/**
 * The item_category an eBay category path implies, or null when there is no
 * path to read. "other" is a real answer: it means the path was read and
 * names a vertical GradeThread does not model.
 */
export function itemCategoryFromEbayPath(
  path: string | null | undefined,
): ItemCategory | null {
  const segments = splitEbayCategoryPath(path);
  if (segments.length === 0) return null;
  const root = segments[0];
  // Everything below the root. The root itself is excluded from the segment
  // scans because "Clothing, Shoes & Accessories" contains all three words.
  const rest = segments.slice(1);
  const restText = rest.join(" | ");
  const has = (re: RegExp) => re.test(restText);

  // A trading card is a card wherever eBay files it: under Sports Mem, under
  // Collectibles (Non-Sport Trading Cards) or under Toys (Collectible Card
  // Games). ai-extract's classifier uses the same rule.
  if (
    /trading card|card singles|collectible card game|\bccg\b/i.test(
      segments.join(" | "),
    )
  ) {
    return "sports_cards";
  }

  if (/^clothing/i.test(root)) {
    if (has(/\bshoes?\b|\bboots\b|sneakers|footwear/i)) return "shoes";
    if (has(/\bhats?\b|\bcaps?\b|beanies|headwear/i)) return "headwear";
    if (has(/\bbags?\b|handbag|backpack|briefcase|luggage|\bpurses?\b/i)) {
      return "bags";
    }
    if (has(/jewelry|jewellery/i)) return "jewelry";
    if (has(/\bwatch(es)?\b/i)) return "watches";
    if (has(/accessor/i)) return "accessories";
    return "clothing";
  }
  if (/^jewelry/i.test(root)) {
    return has(/\bwatch(es)?\b/i) ? "watches" : "jewelry";
  }
  if (/^books/i.test(root)) return "books";
  if (ELECTRONICS_ROOTS.some((re) => re.test(root))) return "electronics";
  if (COLLECTIBLE_ROOTS.some((re) => re.test(root))) return "collectibles";
  if (/^sporting goods/i.test(root)) {
    if (has(/\bshoes?\b|footwear|cleats|\bboots\b/i)) return "shoes";
    if (has(/\bhats?\b|\bcaps?\b/i)) return "headwear";
    if (has(/\bbags?\b|backpack/i)) return "bags";
    if (has(/apparel|clothing|jerseys?|shirts?|pants|jackets?|shorts/i)) {
      return "clothing";
    }
    return "other";
  }
  return "other";
}

import { ITEM_CATEGORIES } from "@/lib/constants";

type ItemCategory = (typeof ITEM_CATEGORIES)[number];

// Best-effort reverse map: an eBay category BREADCRUMB path → the coarse
// GradeThread `item_category` enum. Used to keep item_category (and the
// garment_type/category it seeds) in lockstep when the seller fixes the eBay
// category in the composer, so one correction cascades.
//
// The path is root-first, " › "-joined (see ebay-client.ts categoryTreePath),
// e.g. "Clothing, Shoes & Accessories › Men › Men's Shoes › Athletic Shoes".
// The MARKETPLACE ROOT segment mentions several verticals ("…Shoes &
// Accessories"), so we classify from the DESCENDANT segments only.
//
// Conservative by design: returns null when the path is ambiguous or a
// non-garment vertical (electronics, collectibles, …) — a WRONG coarse category
// is worse than leaving it, so callers apply only a non-null result.
export function ebayPathToItemCategory(
  path: string | null | undefined,
): ItemCategory | null {
  if (!path) return null;
  const segs = path
    .split("›")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (segs.length === 0) return null;
  // Drop the marketplace root (it names multiple verticals); classify from the
  // specific descendants. Fall back to the whole path if there's only one seg.
  const tail = (segs.length > 1 ? segs.slice(1) : segs).join(" | ");

  // Order matters: the more specific verticals win over "clothing", since a
  // fashion path's descendants can still contain generic words. Patterns allow a
  // trailing plural but keep a closing boundary so "boots" matches but "bootcut"
  // (jeans) does not, and "caps" matches but "capris" (pants) does not.
  if (
    /\b(?:shoes?|sneakers?|trainers?|boots?|footwear|heels?|sandals?|loafers?|clogs?|moccasins?|pumps?|slippers?)\b/.test(
      tail,
    )
  ) {
    return "shoes";
  }
  if (
    /\b(?:handbags?|purses?|backpacks?|wallets?|totes?|clutch(?:es)?|satchels?|messenger|duffels?|briefcases?|bags?)\b/.test(
      tail,
    )
  ) {
    return "bags";
  }
  if (/\bwatch(?:es)?\b/.test(tail)) return "watches";
  if (
    /\b(?:jewel\w*|rings?|necklaces?|earrings?|bracelets?|pendants?|brooch(?:es)?|anklets?|cufflinks?|charms?)\b/.test(
      tail,
    )
  ) {
    return "jewelry";
  }
  if (
    /\b(?:clothing|apparel|shirts?|dress(?:es)?|pants?|trousers?|jeans?|jackets?|coats?|sweaters?|hoodies?|sweatshirts?|skirts?|shorts?|blouses?|suits?|blazers?|leggings?|activewear|swimwear|swimsuits?|lingerie|sleepwear|robes?|vests?|rompers?|jumpsuits?|cardigans?|polos?|tees?|t-shirts?|capris?|overalls?)\b/.test(
      tail,
    )
  ) {
    return "clothing";
  }
  if (
    /\b(?:hats?|caps?|beanies?|belts?|scarves|scarf|gloves?|mittens?|sunglasses|eyewear|neckties?|ties?|bandanas?|suspenders?|accessor\w*)\b/.test(
      tail,
    )
  ) {
    return "accessories";
  }
  return null;
}

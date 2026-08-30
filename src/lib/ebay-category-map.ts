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
// Conservative by design: returns null when the path is ambiguous — a WRONG
// coarse category is worse than leaving it, so callers apply only a non-null
// result.
//
// US-3016: it used to return null for every non-garment vertical too, which
// made the composer's own helper text false. That text reads "Picking an eBay
// category above keeps this in sync unless you set it here yourself", and for
// a Ken doll or a set of antique plates it did not: the seller picked Toys &
// Hobbies, Category stayed empty, and the one line explaining the field said
// it should not have. Non-apparel is now classified from its ROOT segment —
// see rootVertical below for why the root, specifically.
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

  // NON-APPAREL IS CLASSIFIED FROM THE ROOT, and that inversion is the whole
  // trick. The apparel root is useless — "Clothing, Shoes & Accessories" names
  // three verticals at once, which is why everything below reads the
  // descendants instead. Every other root is the opposite: "Collectibles",
  // "Antiques", "Toys & Hobbies" and "Coins & Paper Money" each name exactly
  // one thing, and their descendants are actively misleading. "Collectibles ›
  // Advertising › Shoes" is a tin sign, not footwear; "Toys & Hobbies › Action
  // Figures › Accessories" is a plastic sword. Running the descendant regexes
  // on those paths would not have been conservative, it would have been wrong.
  const rooted = rootVertical(segs[0] ?? "", tail);
  if (rooted) return rooted;

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
  // US-2799: headwear sits with the other SPECIFIC verticals, above `clothing`,
  // for the same reason shoes and bags do — an eBay hat path reads
  // "Men › Men's Accessories › Hats" or "… › Men's Clothing › Hats", so the
  // generic word is present alongside the leaf that actually names the item.
  //
  // Until now a hat returned `accessories`, and this function is not advisory:
  // its whole job is to overwrite item_category when a seller CORRECTS the eBay
  // category in the composer. So a seller deliberately picking "Men's Hats" was
  // moved OFF headwear rather than onto it — the loudest possible statement of
  // what the item is, translated into the wrong answer. item_category picks the
  // rubric, the photo profile and the measurement template, so that correction
  // cost the seller all three.
  if (
    /\b(?:hats?|caps?|beanies?|snapbacks?|visors?|fedoras?|berets?|balaclavas?|headwear)\b/
      .test(tail)
  ) {
    return "headwear";
  }
  if (
    /\b(?:clothing|apparel|shirts?|dress(?:es)?|pants?|trousers?|jeans?|jackets?|coats?|sweaters?|hoodies?|sweatshirts?|skirts?|shorts?|blouses?|suits?|blazers?|leggings?|activewear|swimwear|swimsuits?|lingerie|sleepwear|robes?|vests?|rompers?|jumpsuits?|cardigans?|polos?|tees?|t-shirts?|capris?|overalls?)\b/.test(
      tail,
    )
  ) {
    return "clothing";
  }
  // The hat words are GONE from this branch, not left as a harmless duplicate.
  // Two branches both claiming hats reads as undecided, and the next person to
  // reorder these would silently restore the bug above.
  if (
    /\b(?:belts?|scarves|scarf|gloves?|mittens?|sunglasses|eyewear|neckties?|ties?|bandanas?|suspenders?|accessor\w*)\b/.test(
      tail,
    )
  ) {
    return "accessories";
  }
  return null;
}

// eBay's top-level roots that name a single vertical, mapped onto the coarse
// item_category enum. `tail` is passed only for the two roots that genuinely
// straddle two of our values.
//
// Unknown roots return null and fall through to the descendant logic above.
// That matters more than it looks: `category_name` in the aspect cache is not
// always a full root-first breadcrumb — plenty of rows hold a short path whose
// first segment is "Pants" or "Sweaters" — so this must decline politely
// rather than assume segs[0] is a marketplace root.
function rootVertical(root: string, tail: string): ItemCategory | null {
  const r = root.trim();
  if (!r) return null;

  // Straddles two of our values, so the descendants decide.
  if (/^jewell?ry & watches/.test(r)) {
    return /\bwatch(?:es)?\b/.test(tail) ? "watches" : "jewelry";
  }
  if (/^sports mem/.test(r)) {
    return /\b(?:cards?|trading)\b/.test(tail) ? "sports_cards" : "collectibles";
  }

  // Trading cards got their own eBay root, and it covers Pokemon and Magic as
  // well as sport. Our enum has one card bucket, and item_category picks the
  // rubric and photo profile, so a Charizard belongs in the same one as a
  // rookie card whatever the value is named.
  if (/^(?:trading cards|collectible card games)/.test(r)) return "sports_cards";

  // Everything a collector deals in that we grade the same way: an object,
  // judged on condition and provenance rather than fit.
  if (
    /^(?:collectibles|toys & hobbies|antiques|art\b|pottery & glass|coins & paper money|stamps|entertainment memorabilia|dolls & bears)/
      .test(r)
  ) {
    return "collectibles";
  }

  if (/^(?:books|magazines|books & magazines|textbooks)/.test(r)) return "books";

  if (
    /^(?:consumer electronics|computers\/tablets|cell phones & accessories|video games & consoles|cameras & photo|tv, video & home audio)/
      .test(r)
  ) {
    return "electronics";
  }

  return null;
}

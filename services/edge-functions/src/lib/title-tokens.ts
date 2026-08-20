// US-2691: the shared vocabulary of what in a listing title is NOT the product.
//
// Extracted from ebay-client.ts, where it grew for comp matching (US-546). The
// style-code consensus needs exactly the same judgement — strip the chatter, see
// what the market actually named — and a second copy of a colour list is a
// second thing to forget to update.
//
// Deliberately NOT a general stopword list. Gender words stay (men's and
// women's discriminate real products), model numbers stay (501 and 90 ARE the
// product), and fabric names stay (Warpstreme is half of what a Lululemon
// listing is telling you).
//
// ⚠ Two OLDER copies of this idea still exist and are not folded in here:
// TITLE_STOPWORDS in identification-verify.ts and TITLE_NOISE in
// style-code-observations.ts. Both are tuned to their own callers and merging
// them would change agreement scoring and the learned-hint text in one move,
// which is not this story's change to make. Named so the next reader sees three
// lists rather than discovering the third one the hard way.

/** Grammatical filler + listing-label noise. Adds zero matching signal. */
export const TITLE_FILLER_TOKENS: ReadonlySet<string> = new Set<string>([
  "a", "an", "the", "and", "or", "for", "with", "in", "of", "to", "by", "on",
  "at", "from", "your", "this", "that",
  "size", "sz", "new", "brand", "style", "item", "nwt", "nwot",
]);

/** Common colour words. A red and a blue of one product are one product. */
export const TITLE_COLOR_TOKENS: ReadonlySet<string> = new Set<string>([
  "black", "white", "red", "blue", "green", "yellow", "orange", "purple",
  "pink", "brown", "gray", "grey", "navy", "beige", "tan", "gold", "silver",
  "maroon", "teal", "olive", "cream", "ivory", "khaki", "burgundy", "charcoal",
  "mustard", "coral", "turquoise", "lavender", "multicolor", "multicolour",
  "multi",
]);

/** Standalone size words: letter sizes, spelled-out sizes, fit qualifiers. */
export const TITLE_SIZE_TOKENS: ReadonlySet<string> = new Set<string>([
  "xs", "s", "m", "l", "xl", "xxl", "xxxl", "xxxxl",
  "2xl", "3xl", "4xl", "5xl",
  "xsmall", "small", "medium", "large", "xlarge", "xxlarge",
  "petite", "plus", "tall", "reg", "regular",
]);

/**
 * Condition grades, gender words and marketplace chatter.
 *
 * SEPARATE from the filler set on purpose. Gender words are meaningful when
 * MATCHING comps (a men's and a women's jacket are not the same listing) and
 * meaningless when NAMING a product — "Commission Short" is the name whether the
 * seller wrote "Mens" in front of it or not. So comp matching keeps these and
 * the style-code consensus drops them.
 */
export const TITLE_LISTING_CHATTER: ReadonlySet<string> = new Set<string>([
  "nwt", "nwot", "euc", "vguc", "guc", "bnwt", "nib",
  "used", "worn", "excellent", "good", "great", "condition", "preowned",
  "pre", "owned", "gently", "barely", "like",
  "mens", "men", "womens", "women", "unisex", "ladies", "kids", "youth",
  "boys", "girls", "juniors",
  "free", "ship", "shipping", "fast", "rare", "vtg", "vintage",
  "authentic", "genuine", "euro", "lot", "bundle", "nwob",
]);

/**
 * Lowercase a token and strip leading/trailing punctuation, keeping inner
 * characters (the `x` in 32x34, the `.` in a model number). Returns "" when
 * nothing alphanumeric remains.
 */
export function normalizeTitleToken(raw: string): string {
  return raw.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
}

/**
 * Is this token a size rather than part of the product's name?
 *
 * Bare digit runs are deliberately NOT sizes here: they are often model
 * identifiers (Levi's 501, Air Max 90) and removing them hurts matching. The
 * shapes below are unambiguous — 32x34, W32, 32W.
 */
export function isSizeToken(tok: string): boolean {
  if (TITLE_SIZE_TOKENS.has(tok)) return true;
  if (/^\d{1,3}x\d{1,3}$/.test(tok)) return true;
  if (/^[wl]\d{1,3}$/.test(tok)) return true;
  if (/^\d{1,3}[wl]$/.test(tok)) return true;
  return false;
}

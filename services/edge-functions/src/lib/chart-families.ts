// US-3405: which family a size chart belongs to, and which family a garment
// category asks for.
//
// This lives in its own module because BOTH chart narrowers need it and they
// cannot import each other: brand-knowledge.ts imports sizing-charts.ts for the
// in-code seed, so sizing-charts.ts asking brand-knowledge.ts for a family
// would be a cycle. Nothing here imports anything.
//
// The distinction it exists to make: `category_match` is a hand-written word
// list on each chart, so a brand's tops chart that never says "blouse" matches
// nothing and the narrowing falls through. The FAMILY is stated by the
// garment scope itself, which is not hand-maintained per word, so it answers
// "is this the right kind of chart" without asserting what a brand publishes.

export type GarmentFamily =
  | "tops"
  | "bottoms"
  | "outerwear"
  | "dresses"
  | "footwear";

/** Tokens that place a chart's `garment` string in a family. A chart can be in
 *  more than one ("Tops & outerwear (body inches)"), which is why the lookup
 *  returns a set rather than a single label. */
const GARMENT_FAMILY_TOKENS: Readonly<
  Record<GarmentFamily, readonly string[]>
> = {
  tops: [
    "top",
    "shirt",
    "blouse",
    "sweater",
    "knit",
    "tee",
    "polo",
    "sweatshirt",
    "hoodie",
  ],
  bottoms: [
    "bottom",
    "jean",
    "pant",
    "short",
    "skirt",
    "trouser",
    "legging",
    "tight",
    "chino",
    "denim (",
    "waist",
  ],
  outerwear: ["outerwear", "jacket", "coat", "parka", "vest"],
  dresses: ["dress", "gown", "rtw", "apparel"],
  footwear: ["footwear", "shoe", "sneaker", "boot", "sandal"],
};

/** Which families a chart's garment string belongs to. */
export function garmentFamilies(garment: string): Set<GarmentFamily> {
  const s = (garment ?? "").toLowerCase();
  const out = new Set<GarmentFamily>();
  for (const [family, tokens] of Object.entries(GARMENT_FAMILY_TOKENS)) {
    if (tokens.some((t) => s.includes(t))) out.add(family as GarmentFamily);
  }
  return out;
}

/** Which family a GARMENT_CATEGORIES / GARMENT_TYPES value asks for, or null
 *  when the value maps to no chart family (hat, bag, belt, accessories, ...).
 *  A null means "do not reorder against a guess". */
export function categoryFamily(category: string | null): GarmentFamily | null {
  const c = (category ?? "").toLowerCase();
  if (!c) return null;
  const match = (...tokens: string[]) => tokens.some((t) => c.includes(t));
  if (match("t-shirt", "tshirt", "shirt", "blouse", "sweater", "hoodie", "top")) {
    // "shirt" before outerwear so "t-shirt" does not land on a jacket token.
    return "tops";
  }
  if (match("jacket", "coat", "parka", "vest", "outerwear")) return "outerwear";
  if (match("jean", "pant", "short", "skirt", "trouser", "bottom")) {
    return "bottoms";
  }
  if (match("dress", "gown")) return "dresses";
  if (match("sneaker", "boot", "sandal", "shoe", "footwear")) return "footwear";
  return null;
}

/** Keep the charts in the asked family, or every chart when the pool has none.
 *
 *  Both narrowers use this as their fallback. Returning the whole pool when the
 *  family is absent is deliberate and load-bearing: a brand that genuinely has
 *  no tops chart must still send something, because a loosely-matched chart
 *  beats an empty answer. Measured over the 441-row corpus, zero pools return
 *  nothing. */
export function narrowToFamily<T extends { garment: string }>(
  charts: T[],
  category: string | null,
): T[] {
  const want = categoryFamily(category);
  if (!want) return charts;
  const inFamily = charts.filter((c) => garmentFamilies(c.garment).has(want));
  return inFamily.length > 0 ? inFamily : charts;
}

// Category-specific measurement templates for FlipDesk items.
// Measurements are stored on inventory_items.measurements (jsonb) keyed by
// the field `key`. Lengths are flat measurements (garment laid flat).

export type MeasurementGroup =
  | "top"
  | "bottom"
  | "dress"
  | "outerwear"
  // US-2464. A suit, tuxedo or coverall is the one garment that is measured as
  // a TOP and a BOTTOM at the same time. Before this group it fell to `generic`
  // (length + width, both optional), so the seven numbers a suit is actually
  // bought on were not offered at all and the photo tags had nowhere to hang.
  | "suit"
  | "shoes"
  | "watch"
  // US-2225 AC4. A bag is the one category whose defining dimension is DEPTH —
  // a 30cm tote and a 30cm clutch are different objects, and neither the top
  // nor the generic template has a field for it. Without this group a bag fell
  // to `generic` (length + width, both optional), so the two numbers a buyer
  // asks for first were not even offered.
  | "bag"
  // US-2224. Ties, belts, scarves and gloves are sold on two numbers and a
  // belt on a third. They had no group at all, so they fell to `generic`
  // (length + width, both optional) — a belt listed without a wearable range is
  // a belt nobody can buy with confidence.
  | "accessory"
  // US-2223 AC2. Hats are sold on head circumference; crown height and brim
  // length are what separate two caps that both say 7 3/8.
  | "headwear"
  | "generic";

export type MeasurementUnit = "length" | "shoe" | "mm";

export interface MeasurementField {
  key: string;
  label: string;
  /** length = in/cm toggle applies; shoe = US size; mm = fixed millimetres */
  unit: MeasurementUnit;
  required: boolean;
}

export const MEASUREMENT_TEMPLATES: Record<
  MeasurementGroup,
  MeasurementField[]
> = {
  top: [
    { key: "chest", label: "Chest (pit to pit)", unit: "length", required: true },
    { key: "length", label: "Length (HPS to hem)", unit: "length", required: true },
    { key: "shoulder", label: "Shoulder", unit: "length", required: false },
    { key: "sleeve", label: "Sleeve", unit: "length", required: false },
  ],
  bottom: [
    { key: "waist", label: "Waist (flat)", unit: "length", required: true },
    { key: "inseam", label: "Inseam", unit: "length", required: true },
    { key: "rise", label: "Front rise", unit: "length", required: false },
    { key: "hip", label: "Hip", unit: "length", required: false },
    { key: "leg_opening", label: "Leg opening", unit: "length", required: false },
  ],
  dress: [
    { key: "bust", label: "Bust", unit: "length", required: true },
    { key: "waist", label: "Waist", unit: "length", required: true },
    { key: "hip", label: "Hip", unit: "length", required: false },
    { key: "length", label: "Length", unit: "length", required: true },
  ],
  outerwear: [
    { key: "chest", label: "Chest (pit to pit)", unit: "length", required: true },
    { key: "length", label: "Length", unit: "length", required: true },
    { key: "shoulder", label: "Shoulder", unit: "length", required: false },
    { key: "sleeve", label: "Sleeve", unit: "length", required: false },
  ],
  // US-2464. The jacket half reuses the `outerwear` keys and the pant half
  // reuses the `bottom` keys, deliberately: a suit's jacket chest IS a chest,
  // and every downstream consumer (listing templates, eBay item specifics, the
  // fit widget) already knows those keys. Inventing `jacket_chest` would have
  // made a suit invisible to all of them.
  //
  // Only the LABELS disambiguate, because on a two-piece the seller is holding
  // two garments and "Waist" alone is genuinely ambiguous between the jacket's
  // waist and the trouser's. `length` is labelled "Jacket length" for the same
  // reason.
  //
  // Chest, jacket length, waist and inseam are required; a suit listed without
  // all four cannot be sized by a buyer. Shoulder, sleeve and rise are optional
  // because a seller who measures them is tailoring-literate and the ones who
  // are not should still be able to advance the item.
  suit: [
    { key: "chest", label: "Jacket chest (pit to pit)", unit: "length", required: true },
    { key: "length", label: "Jacket length", unit: "length", required: true },
    { key: "shoulder", label: "Jacket shoulder", unit: "length", required: false },
    { key: "sleeve", label: "Jacket sleeve", unit: "length", required: false },
    { key: "waist", label: "Pant waist (flat)", unit: "length", required: true },
    { key: "inseam", label: "Pant inseam", unit: "length", required: true },
    { key: "rise", label: "Pant front rise", unit: "length", required: false },
  ],
  shoes: [
    { key: "size_us", label: "US size", unit: "shoe", required: true },
    { key: "insole", label: "Insole length", unit: "length", required: false },
  ],
  watch: [
    { key: "case_diameter", label: "Case diameter", unit: "mm", required: true },
    { key: "lug_width", label: "Lug width", unit: "mm", required: false },
    { key: "band_length", label: "Band length", unit: "mm", required: false },
  ],
  // US-2225 AC4. Width/height/depth are REQUIRED because a bag listed without
  // all three is a bag a buyer cannot size, and every resale platform's bag
  // form asks for exactly these.
  //
  // BOTH drops are offered, and that is the decision worth recording: a top-
  // handle bag has no strap and a crossbody has no handles, so a single "strap
  // drop" field would sit blank on half of all bags — and a blank measurement
  // reads as "the seller did not measure it", not as "this bag does not have
  // one". Two optional fields let the right one be filled and the wrong one be
  // honestly empty.
  bag: [
    { key: "width", label: "Width (base)", unit: "length", required: true },
    { key: "height", label: "Height", unit: "length", required: true },
    { key: "depth", label: "Depth", unit: "length", required: true },
    { key: "strap_drop", label: "Strap drop", unit: "length", required: false },
    { key: "handle_drop", label: "Handle drop", unit: "length", required: false },
  ],
  // Length and width are REQUIRED because every one of these four is sold on
  // them: a tie's length and blade width, a belt's length and width, a scarf's
  // two dimensions, a glove's length and palm width.
  //
  // `hole_span` is optional and belt-only, and it is first-to-last hole rather
  // than a hole COUNT: the count tells a buyer nothing without the spacing, and
  // the span is the number that answers "will this fit me".
  // Circumference is the one that must be measured, and it is a LENGTH rather
  // than a size: a fitted cap's "7 3/8" belongs in the item's size field, not
  // here, because it is a size label and not something anyone put a tape to.
  // Half of resale headwear is snapback or strapback and has no numeric size at
  // all, so a size-only template would leave those unmeasurable.
  headwear: [
    { key: "circumference", label: "Head circumference (inside)", unit: "length", required: true },
    { key: "crown_height", label: "Crown height", unit: "length", required: false },
    { key: "brim_length", label: "Brim length", unit: "length", required: false },
  ],
  accessory: [
    { key: "length", label: "Length", unit: "length", required: true },
    { key: "width", label: "Width", unit: "length", required: true },
    { key: "hole_span", label: "First to last hole (belts)", unit: "length", required: false },
  ],
  generic: [
    { key: "length", label: "Length", unit: "length", required: false },
    { key: "width", label: "Width", unit: "length", required: false },
  ],
};

// US-2673: how a free-form garment string is matched.
//
// This used to be an ordered list of substring tests, and both halves of that
// were wrong in ways that only showed up once the TITLE became a real witness
// (see garmentDescriptorFor).
//
// SUBSTRINGS. `/bag/` matched "Baggies", `/cap/` matched "Capri", `/boot/`
// matched "Bootcut" and `/top/` matches half the brand names in resale. So
// "Patagonia Baggies Shorts" was measured as a handbag and "Zara Capri Pants"
// as a hat. Matching whole words (with a plural tolerance, because everything
// in resale is listed plural) removes the entire class.
//
// ORDER. Testing bags before shoes was a deliberate fix for "boot bag" — but
// the rule it was reaching for is not "bags win", it is that ENGLISH PUTS THE
// HEAD NOUN LAST. A boot bag is a bag, a cargo jacket is a jacket, a dress
// shirt is a shirt and fleece joggers are joggers. Taking the LAST garment word
// gets all of those right from one rule, and it retires three hand-written
// exception patterns (DRESS_MODIFIER, NOT_A_SUIT_SET, SUIT_SINGLE_BOTTOM) that
// existed only to undo the ordering. It also fixes cases nobody had listed: a
// "mini skirt" is a skirt, not a dress.
//
// Compounds that are one word ("shirtdress", "pantsuit", "tracksuit") no longer
// fall out of a substring match, so they are spelled out below. That is the
// cost of whole-word matching and it is worth paying: an unlisted compound
// degrades to `generic`, which is honest, where a substring match degrades to
// confidently wrong.

type NamedGroup = Exclude<MeasurementGroup, "generic">;

/**
 * Single words. Matched against whole tokens, tolerating a plural `s`/`es` —
 * so `jean` matches "jeans" but `bag` does not match "baggies".
 */
const GROUP_WORDS: Record<NamedGroup, readonly string[]> = {
  bag: [
    "bag", "purse", "tote", "clutch", "satchel", "crossbody", "backpack",
    "rucksack", "duffel", "duffle", "handbag", "hobo", "pouch", "wallet",
    "briefcase",
  ],
  // `sock` is deliberately ABSENT from accessory and everywhere else — socks
  // are sold by size, not by measurement, and a template would ask a seller to
  // measure something nobody publishes.
  headwear: [
    "hat", "cap", "beanie", "snapback", "fitted", "trucker", "visor", "fedora",
    "beret", "headwear", "balaclava",
  ],
  // US-2798: `neckwear` is here because it is a GARMENT_CATEGORY VALUE, not
  // a word a person says. US-2224 created this group for ties and belts, and
  // US-2571 got `neckwear` into the classifier's vocabulary - but nothing
  // taught this table the word, so the one category that most needed the
  // group resolved to `generic` and got length and width as OPTIONAL fields.
  // A tie measured by nobody is what the group exists to prevent.
  //
  // `headwear` was already in its own group's word list for exactly this
  // reason. The rule is: every value a classifier can emit belongs in the
  // word list of the group it should reach, even when no human would type it.
  accessory: [
    "tie", "necktie", "neckwear", "belt", "scarf", "scarves", "glove",
    "mitten", "shawl", "cravat", "ascot", "suspender", "accessory",
    "accessories",
  ],
  shoes: [
    "shoe", "sneaker", "boot", "sandal", "footwear", "loafer", "mule", "clog",
    "slipper",
  ],
  watch: ["watch"],
  // US-2464: swimwear is measured on bust/waist/hip, the same three numbers a
  // dress is, and fell to `generic` before.
  dress: [
    "dress", "dresses", "sundress", "shirtdress", "romper", "jumpsuit", "maxi",
    "midi", "mini", "swimsuit", "bikini", "tankini", "monokini",
  ],
  // US-2464: robes and kimonos are open-front layers measured exactly like a
  // coat, and had no entry at all.
  outerwear: [
    "jacket", "coat", "outerwear", "blazer", "parka", "windbreaker",
    "overcoat", "anorak", "bomber", "vest", "gilet", "fleece", "cardigan",
    "robe", "bathrobe", "kimono", "poncho", "cape",
  ],
  // US-2464: a suit set is measured as a top AND a bottom. "swimsuit",
  // "jumpsuit" and "bodysuit" are single garments and are not listed here;
  // whole-word matching is what keeps `suit` from reaching inside them, which
  // is why the old NOT_A_SUIT_SET exclusion is gone.
  suit: [
    "suit", "tuxedo", "tux", "pantsuit", "tracksuit", "sweatsuit", "coverall",
    "overall", "scrub", "pajama", "pyjama",
  ],
  // US-2464: `trunk` for swim trunks. US-2468: `bottom` for the coarse
  // GARMENT_TYPES value iOS stores in garment_type.
  bottom: [
    "pant", "jean", "short", "skirt", "trouser", "chino", "jogger", "legging",
    "sweatpant", "cargo", "trunk", "slack", "capri", "bottom",
  ],
  top: [
    "shirt", "tshirt", "tee", "top", "blouse", "sweater", "hoodie",
    "sweatshirt", "tank", "polo", "jersey", "henley", "pullover", "crewneck",
    "longsleeve", "rugby", "oxford", "flannel", "thermal",
  ],
};

/**
 * Multi-word names. Needed where the phrase means something its last word does
 * not: "one piece" is a swimsuit, "three piece" is a suit, "pocket square" is
 * an accessory. Position is taken from the phrase's LAST word, so a phrase and
 * a plain word compete on the same footing.
 */
const GROUP_PHRASES: Record<NamedGroup, readonly string[]> = {
  bag: [],
  headwear: ["bucket hat"],
  accessory: ["bow tie", "pocket square"],
  shoes: [],
  watch: [],
  dress: ["one piece"],
  outerwear: [],
  suit: ["two piece", "three piece"],
  bottom: [],
  top: ["t shirt", "long sleeve", "button down", "button up"],
};

const NAMED_GROUPS = Object.keys(GROUP_WORDS) as NamedGroup[];

/** Lowercase, and turn every run of punctuation into a space, so "t-shirt"
 *  becomes "t shirt" and "button-down" becomes "button down". */
function tokenize(value: string): string[] {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ")
    .filter(Boolean);
}

function matchesWord(token: string, word: string): boolean {
  return token === word || token === `${word}s` || token === `${word}es`;
}

// Map a free-form category/garment string to a measurement group.
export function measurementGroupFor(
  category: string | null | undefined,
): MeasurementGroup {
  const tokens = tokenize(category ?? "");
  if (tokens.length === 0) return "generic";

  const hits: Array<{ end: number; len: number; group: NamedGroup }> = [];
  for (const group of NAMED_GROUPS) {
    for (const phrase of GROUP_PHRASES[group]) {
      const words = phrase.split(" ");
      for (let i = 0; i + words.length <= tokens.length; i++) {
        if (words.every((w, k) => matchesWord(tokens[i + k]!, w))) {
          hits.push({ end: i + words.length - 1, len: words.length, group });
        }
      }
    }
    for (const word of GROUP_WORDS[group]) {
      for (let i = 0; i < tokens.length; i++) {
        if (matchesWord(tokens[i]!, word)) hits.push({ end: i, len: 1, group });
      }
    }
  }
  if (hits.length === 0) return "generic";

  // The winner is the match that ENDS LAST. On a tie the longer match wins, so
  // "one piece" beats a single word sitting at the same index.
  let best = hits[0]!;
  for (const hit of hits) {
    if (hit.end > best.end || (hit.end === best.end && hit.len > best.len)) {
      best = hit;
    }
  }
  return best.group;
}

// US-2595: the group has to come from the GARMENT word, and callers rarely
// hold just one string.
//
// `item_category` is an enum whose clothing value is literally "clothing", and
// measurementGroupFor("clothing") is `generic` — length and width, both
// optional. `items_full.category` is COALESCE(item_category, garment_category),
// so the moment an item's vertical is set (which the AI extract pass does
// routinely) every web surface reading that column lost the real template: a
// blazer was never offered a chest or a sleeve, and shorts were never offered a
// waist or an inseam. The garment word was on the row the whole time, one
// column over.
//
// Resolution order is most-specific-first, and a candidate only wins if it
// actually resolves to a real group — so "clothing" is skipped rather than
// swallowing the answer, and the title is a genuine last resort ("Vintage Levi's
// 550 Denim Shorts" is a better descriptor than nothing).
export interface GarmentDescriptorSource {
  /**
   * US-2673: the LEAF of the chosen eBay category, e.g. "Sweaters" out of
   * "Clothing, Shoes & Accessories > Men > Men's Clothing > Sweaters".
   *
   * Ranked first, because it is the most deliberate garment statement on the
   * item: somebody picked it, eBay validated it, and the specifics editor
   * already trusts it enough to ask for a waist and an inseam off the back of
   * it. Switching the category therefore switches the measurements, which is
   * what a seller correcting "women's pants" to "men's sweater" expects and did
   * not get — the two categories are both `clothing`, so the coarse cascade saw
   * no change and nothing on the garment axis moved.
   *
   * The LEAF and not the path: the path begins "Clothing, Shoes & Accessories",
   * and a leaf that names no garment ("Athletic Apparel") would otherwise walk
   * back up and match `shoes` in the root.
   */
  ebay_leaf?: string | null;
  garment_category?: string | null;
  garment_type?: string | null;
  item_category?: string | null;
  /** items_full's COALESCE(item_category, garment_category) column. */
  category?: string | null;
  title?: string | null;
}

/** The last "a > b > c" segment of an eBay category breadcrumb. */
export function ebayCategoryLeaf(path: string | null | undefined): string | null {
  if (!path) return null;
  const segs = path.split(/[>›]/).map((x) => x.trim()).filter(Boolean);
  return segs.length ? segs[segs.length - 1]! : null;
}

// US-2673: the six coarse GARMENT_TYPES values, which are a VERTICAL and not a
// garment. `garment_type` is filled by deriveGarmentType() from item_category
// whenever intake never captured one — "clothing" becomes "tops" — so on any
// item the AI did not classify, this column reads "tops" whether the garment is
// a t-shirt or a pair of jeans. It was consulted second, ahead of the title, so
// a listing called "Polo Ralph Lauren Women's Skinny Jeans" was offered a chest
// and a sleeve and never a waist or an inseam.
//
// They still resolve — iOS genuinely stores the coarse value here, and "bottoms"
// with nothing else on the row is better than `generic`. They just go last, so a
// real garment noun anywhere else on the item beats a value that may be a guess.
const COARSE_VERTICALS = new Set([
  "tops",
  "bottoms",
  "outerwear",
  "dresses",
  "footwear",
  "accessories",
]);

// ⚠ THE DEMOTION IS SCOPED TO THE FIELD, NOT TO THE WORD.
//
// It shipped testing the VALUE, which quietly broke the field it was written to
// promote: eBay's own tree has leaves called literally "Tops", "Dresses" and
// "Accessories", so an item categorised "… > Women's Clothing > Tops" had its
// leaf skipped in the first pass and a stale `garment_category: "pants"` won.
// The seller saw Waist, Inseam and Front Rise on a blouse.
//
// A leaf is not a guess — a person picked it and eBay validated it — which is
// the entire reason it is ranked first. `garment_type` is the column that may
// hold a derived vertical, and it is the only one this was ever about.
interface Candidate {
  value: string | null | undefined;
  /** May this candidate be demoted for naming a vertical? */
  coarseEligible: boolean;
}

const isCoarse = (s: string) => COARSE_VERTICALS.has(s.trim().toLowerCase());

export function garmentDescriptorFor(item: GarmentDescriptorSource): string {
  const candidates: Candidate[] = [
    // eBay's own leaf. Never demoted — see the note on COARSE_VERTICALS.
    { value: item.ebay_leaf, coarseEligible: false },
    { value: item.garment_category, coarseEligible: true },
    { value: item.garment_type, coarseEligible: true },
    { value: item.category, coarseEligible: true },
    { value: item.item_category, coarseEligible: true },
    // A title is free text a human wrote, not a derived vertical, and it is the
    // last resort anyway.
    { value: item.title, coarseEligible: false },
  ];
  // Two passes over the same list, so the order above still expresses
  // preference within each tier: everything specific first, verticals after.
  for (const c of candidates) {
    const s = (c.value ?? "").trim();
    if (!s) continue;
    if (c.coarseEligible && isCoarse(s)) continue;
    if (measurementGroupFor(s) !== "generic") return s;
  }
  for (const c of candidates) {
    const s = (c.value ?? "").trim();
    if (s && measurementGroupFor(s) !== "generic") return s;
  }
  // Nothing resolved: hand back the most specific string we were given so the
  // caller's own fallbacks (labels, prompts) still have something to show.
  for (const c of candidates) {
    const s = (c.value ?? "").trim();
    if (s) return s;
  }
  return "";
}

/** measurementGroupFor, but fed from a whole item row instead of one column. */
export function measurementGroupForItem(
  item: GarmentDescriptorSource,
): MeasurementGroup {
  return measurementGroupFor(garmentDescriptorFor(item));
}

/**
 * Where to send a seller who wants the brand's size guide.
 *
 * US-2918: prefer the REAL guide. `sourceUrl` is the `source_url` recorded on
 * the brand's chart row — the brand's own published guide, checked by a human
 * before `verified` was allowed to flip true — and it arrives with the band
 * table from GET /api/flipdesk/size-bands. A Google search was the only option
 * while there was no per-brand URL to hold; it is the fallback now, not the
 * answer, because "lululemon size guide" on Google is three ads and a reseller
 * blog before the brand's own page.
 *
 * Only http(s) is accepted. A chart row is admin-editable, and a `javascript:`
 * or `data:` value reaching an href would be a stored XSS on every composer
 * that renders it.
 */
export function sizeGuideUrl(brand: string, sourceUrl?: string | null): string {
  const candidate = (sourceUrl ?? "").trim();
  if (candidate) {
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol === "https:" || parsed.protocol === "http:") {
        return parsed.toString();
      }
    } catch {
      // Not a URL at all — fall through to the search.
    }
  }
  return `https://www.google.com/search?q=${encodeURIComponent(
    brand + " size guide",
  )}`;
}

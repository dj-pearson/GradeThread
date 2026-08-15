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

// US-2464. "dress" is a noun AND a modifier, and the modifier sense is more
// common in resale than the garment sense. Because the dress branch is tested
// before both `bottom` and `top`, every one of these compounds was being
// measured as a dress: "dress pants" was asked for a bust and never for an
// inseam, and "dress shirt" was asked for a hip.
//
// Matching the compound and REFUSING the dress branch (rather than reordering
// the branches) is what keeps "sundress" and "shirtdress" correct — those are
// genuine dresses whose names contain another garment's noun, and any reorder
// that fixed "dress shirt" would have broken "shirtdress".
const DRESS_MODIFIER =
  /dress\s*-?\s*(shirt|blouse|pant|trouser|slack|short|skirt|sock|shoe|boot|belt|tie|watch|coat|jacket|blazer|vest|suit|uniform)/;

// US-2464. A suit set is measured as a top AND a bottom. The exclusions are the
// words that merely CONTAIN "suit" without being a two-piece: a swimsuit and a
// bodysuit are single garments, and a jumpsuit is measured like a dress.
// Tracksuits and sweatsuits are deliberately NOT excluded — they are two
// pieces and a buyer needs both sets of numbers.
const NOT_A_SUIT_SET = /(swim|jump|body|cat|snow|wet|rain|play)suit/;
const SUIT_SET =
  /(pant.?suit|suit|tuxedo|\btux\b|two.?piece|three.?piece|coverall|overall|scrub|pajama|pyjama)/;
// "Suit pants" sold on their own are a bottom, not a set. `pantsuit` is safe
// here: it is "pant" then "suit", so it never matches "suit" then "pant".
const SUIT_SINGLE_BOTTOM = /(suit|tuxedo|tux)\s*-?\s*(pant|trouser|slack|short|skirt)/;

// Map a free-form category/garment string to a measurement group.
export function measurementGroupFor(
  category: string | null | undefined,
): MeasurementGroup {
  const c = (category ?? "").toLowerCase();
  if (!c) return "generic";
  // US-2225: bags are tested FIRST, deliberately. "boot bag", "shoe bag" and
  // "cargo bag" all contain a keyword that a later branch claims, and every one
  // of them is a bag — the noun that matters is the last one. Testing bags last
  // would have routed a boot bag to the shoe template and asked the seller for
  // an insole length.
  if (/(bag|purse|tote|clutch|satchel|crossbody|backpack|rucksack|duffel|duffle|handbag|hobo|pouch|wallet|briefcase)/.test(c))
    return "bag";
  // US-2224: after bags (a "tie bag" is a bag) and before shoes, so "glove"
  // and "belt" cannot be claimed by a later branch. `sock` is deliberately
  // ABSENT — socks are sold by size, not by measurement, and adding them here
  // would ask a seller to measure something nobody publishes.
  // US-2223: before accessories, because "cap" and "hat" are the nouns here and
  // a "bucket hat" must not be claimed by anything else. `visor` is included —
  // it has a brim and a band and nothing else, which this template covers.
  if (/(hat|cap|beanie|snapback|fitted|trucker|visor|fedora|beret|bucket.?hat|headwear|balaclava)/.test(c))
    return "headwear";
  // US-2468: `accessor` catches the coarse GARMENT_TYPES value "accessories",
  // which iOS stores in garment_type and which resolved to `generic` before.
  if (/(tie|necktie|bow.?tie|belt|scarf|scarves|glove|mitten|shawl|pocket.?square|cravat|ascot|suspender|accessor)/.test(c))
    return "accessory";
  if (/(shoe|sneaker|boot|sandal|footwear|loafer|mule|clog|slipper)/.test(c)) return "shoes";
  if (/watch/.test(c)) return "watch";
  // US-2464: swimwear joins the dress template — a one-piece, bikini or tankini
  // is sold on bust/waist/hip, the same three numbers, and fell to `generic`
  // (length + width) before.
  if (
    !DRESS_MODIFIER.test(c) &&
    /(dress|romper|jumpsuit|maxi|mini|midi|swimsuit|bikini|tankini|monokini|one.?piece)/.test(c)
  )
    return "dress";
  // US-2464: robes and kimonos are open-front layers measured exactly like a
  // coat, and had no branch at all.
  if (/(jacket|coat|outerwear|blazer|parka|windbreaker|overcoat|anorak|bomber|vest|gilet|fleece|cardigan|robe|kimono|poncho|cape)/.test(c))
    return "outerwear";
  // US-2464: AFTER outerwear so a standalone "suit jacket" stays outerwear, and
  // BEFORE bottom so "pantsuit" is not claimed by the `pant` keyword.
  if (SUIT_SET.test(c) && !NOT_A_SUIT_SET.test(c) && !SUIT_SINGLE_BOTTOM.test(c))
    return "suit";
  // US-2464: `trunk` added for swim trunks — board shorts already matched.
  // US-2468: `bottom` catches the coarse GARMENT_TYPES value "bottoms".
  if (/(pant|jean|short|skirt|trouser|chino|jogger|legging|sweatpant|cargo|trunk|slack|bottom)/.test(c))
    return "bottom";
  if (/(shirt|tee|t-shirt|top|blouse|sweater|hoodie|sweatshirt|tank|polo|jersey|henley|pullover|crewneck|longsleeve|long.sleeve|rugby|button.down|button.up|oxford|flannel|thermal)/.test(c))
    return "top";
  return "generic";
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
  garment_category?: string | null;
  garment_type?: string | null;
  item_category?: string | null;
  /** items_full's COALESCE(item_category, garment_category) column. */
  category?: string | null;
  title?: string | null;
}

export function garmentDescriptorFor(item: GarmentDescriptorSource): string {
  const candidates = [
    item.garment_category,
    item.garment_type,
    item.category,
    item.item_category,
    item.title,
  ];
  for (const c of candidates) {
    const s = (c ?? "").trim();
    if (s && measurementGroupFor(s) !== "generic") return s;
  }
  // Nothing resolved: hand back the most specific string we were given so the
  // caller's own fallbacks (labels, prompts) still have something to show.
  for (const c of candidates) {
    const s = (c ?? "").trim();
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

// A Google search for "<brand> size guide" — always a valid URL, works for
// any brand without maintaining a per-brand lookup table.
export function sizeGuideUrl(brand: string): string {
  return `https://www.google.com/search?q=${encodeURIComponent(
    brand + " size guide",
  )}`;
}

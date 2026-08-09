// Category-specific measurement templates for FlipDesk items.
// Measurements are stored on inventory_items.measurements (jsonb) keyed by
// the field `key`. Lengths are flat measurements (garment laid flat).

export type MeasurementGroup =
  | "top"
  | "bottom"
  | "dress"
  | "outerwear"
  | "shoes"
  | "watch"
  // US-2225 AC4. A bag is the one category whose defining dimension is DEPTH —
  // a 30cm tote and a 30cm clutch are different objects, and neither the top
  // nor the generic template has a field for it. Without this group a bag fell
  // to `generic` (length + width, both optional), so the two numbers a buyer
  // asks for first were not even offered.
  | "bag"
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
  generic: [
    { key: "length", label: "Length", unit: "length", required: false },
    { key: "width", label: "Width", unit: "length", required: false },
  ],
};

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
  if (/(shoe|sneaker|boot|sandal|footwear|loafer|mule|clog|slipper)/.test(c)) return "shoes";
  if (/watch/.test(c)) return "watch";
  if (/(dress|romper|jumpsuit|maxi|mini|midi)/.test(c)) return "dress";
  if (/(jacket|coat|outerwear|blazer|parka|windbreaker|overcoat|anorak|bomber|vest|gilet|fleece|cardigan)/.test(c))
    return "outerwear";
  if (/(pant|jean|short|skirt|trouser|chino|jogger|legging|sweatpant|cargo)/.test(c))
    return "bottom";
  if (/(shirt|tee|t-shirt|top|blouse|sweater|hoodie|sweatshirt|tank|polo|jersey|henley|pullover|crewneck|longsleeve|long.sleeve|rugby|button.down|button.up|oxford|flannel|thermal)/.test(c))
    return "top";
  return "generic";
}

// A Google search for "<brand> size guide" — always a valid URL, works for
// any brand without maintaining a per-brand lookup table.
export function sizeGuideUrl(brand: string): string {
  return `https://www.google.com/search?q=${encodeURIComponent(
    brand + " size guide",
  )}`;
}

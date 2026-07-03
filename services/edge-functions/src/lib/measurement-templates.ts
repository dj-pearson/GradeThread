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

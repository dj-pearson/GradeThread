import { GARMENT_TYPES, GARMENT_CATEGORIES } from "@/lib/constants";

export type GarmentType = (typeof GARMENT_TYPES)[number];
export type GarmentCategory = (typeof GARMENT_CATEGORIES)[number];

// Coarse item_category → default garment_type. Mirrors the edge
// ITEM_CATEGORY_FALLBACK (services/edge-functions/src/lib/marketplace-category.ts)
// so the two layers agree on the default. Only categories that grade as garments
// map here; electronics / books / sports_cards / collectibles / other
// intentionally return null — they have their own rubric or aren't
// garment-graded, so we must not fabricate a garment_type for them.
const ITEM_CATEGORY_TO_GARMENT_TYPE: Partial<Record<string, GarmentType>> = {
  clothing: "tops",
  shoes: "footwear",
  bags: "accessories",
  accessories: "accessories",
  jewelry: "accessories",
  watches: "accessories",
};

// A sensible default garment_category per garment_type. garment_category is a
// metadata label — the clothing rubric is keyed by item_category + garment_type,
// not by garment_category — so "other" is a safe, non-overstating default the
// user can refine. Only the cases where the type strongly implies the category
// (dresses → dress) deviate.
const GARMENT_TYPE_TO_DEFAULT_CATEGORY: Record<GarmentType, GarmentCategory> = {
  tops: "other",
  bottoms: "other",
  outerwear: "other",
  dresses: "dress",
  footwear: "other",
  accessories: "other",
};

function asGarmentType(v: string | null | undefined): GarmentType | null {
  const t = (v ?? "").trim().toLowerCase();
  return (GARMENT_TYPES as readonly string[]).includes(t)
    ? (t as GarmentType)
    : null;
}

function asGarmentCategory(v: string | null | undefined): GarmentCategory | null {
  const t = (v ?? "").trim().toLowerCase();
  return (GARMENT_CATEGORIES as readonly string[]).includes(t)
    ? (t as GarmentCategory)
    : null;
}

// The default garment_type for an item_category, or null when the category
// isn't garment-graded.
export function deriveGarmentType(
  itemCategory: string | null | undefined,
): GarmentType | null {
  const i = (itemCategory ?? "").trim().toLowerCase();
  return ITEM_CATEGORY_TO_GARMENT_TYPE[i] ?? null;
}

// Best-effort garment_type/garment_category for an item so grading isn't blocked
// by fields intake never captured (US-1423). Prefers explicit values (AI
// classification or a prior user pick) when they're valid enum members, then
// falls back to a deterministic default derived from item_category. Returns
// nulls when the category isn't garment-graded — callers persist only non-nulls.
export function deriveGarmentDefaults(
  itemCategory: string | null | undefined,
  explicit?: { garment_type?: string | null; garment_category?: string | null },
): { garment_type: GarmentType | null; garment_category: GarmentCategory | null } {
  const explicitType = asGarmentType(explicit?.garment_type);
  const explicitCategory = asGarmentCategory(explicit?.garment_category);
  const garment_type = explicitType ?? deriveGarmentType(itemCategory);
  const garment_category =
    explicitCategory ??
    (garment_type ? GARMENT_TYPE_TO_DEFAULT_CATEGORY[garment_type] : null);
  return { garment_type, garment_category };
}

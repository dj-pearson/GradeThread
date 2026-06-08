// US-722: seeded per-platform category mapping (deterministic, no AI cost).
//
// Maps a GradeThread garment/item category to a best-effort starting category
// for each no-API marketplace. The platforms' real taxonomies also need a
// DEPARTMENT/gender (Men/Women/Kids) that GradeThread doesn't always capture —
// so these are LEAF suggestions the seller confirms in the Listing Kit's
// editable category field (US-723). Unmapped → returns null and the caller
// falls back to the natural-language category query.
//
// This is the seeded layer chosen for US-722. An admin-extensible DB override +
// AI-suggested categories are a deliberate follow-up (see the PRD note); this
// pure map covers the common garment types with zero per-item cost.

import type { MarketplacePlatform } from "./marketplace-specs.ts";

// Canonical GradeThread garment types (src/lib/constants.ts GARMENT_TYPES):
// tops | bottoms | outerwear | dresses | footwear | accessories
type GarmentKey =
  | "tops"
  | "bottoms"
  | "outerwear"
  | "dresses"
  | "footwear"
  | "accessories";

// Per-platform leaf category for each garment type. Gender/department is left
// for the seller to confirm. eBay (Taxonomy API) and Shopify (free-form) are
// intentionally omitted.
const SEED: Partial<Record<MarketplacePlatform, Record<GarmentKey, string>>> = {
  poshmark: {
    tops: "Tops",
    bottoms: "Pants & Jumpsuits",
    outerwear: "Jackets & Coats",
    dresses: "Dresses",
    footwear: "Shoes",
    accessories: "Accessories",
  },
  mercari: {
    tops: "Tops & blouses",
    bottoms: "Pants",
    outerwear: "Coats & jackets",
    dresses: "Dresses",
    footwear: "Shoes",
    accessories: "Accessories",
  },
  depop: {
    tops: "Tops",
    bottoms: "Bottoms",
    outerwear: "Outerwear & Jackets",
    dresses: "Dresses",
    footwear: "Shoes",
    accessories: "Accessories",
  },
  grailed: {
    tops: "Tops",
    bottoms: "Bottoms",
    outerwear: "Outerwear",
    dresses: "Dresses",
    footwear: "Footwear",
    accessories: "Accessories",
  },
};

// Coarse item_category → garment-type fallback when garment_category is absent.
const ITEM_CATEGORY_FALLBACK: Record<string, GarmentKey> = {
  clothing: "tops",
  tops: "tops",
  bottoms: "bottoms",
  outerwear: "outerwear",
  dresses: "dresses",
  shoes: "footwear",
  footwear: "footwear",
  accessories: "accessories",
};

function toGarmentKey(
  garmentCategory: string | null,
  itemCategory: string | null,
): GarmentKey | null {
  const g = (garmentCategory ?? "").trim().toLowerCase();
  if (g in (SEED.grailed as Record<string, string>)) return g as GarmentKey;
  const i = (itemCategory ?? "").trim().toLowerCase();
  return ITEM_CATEGORY_FALLBACK[i] ?? null;
}

export interface SeededCategory {
  /** The suggested platform category (a leaf — confirm the department). */
  path: string;
  /** Always "seed" here; reserved for future "ai" / "user" sources. */
  source: "seed";
}

/**
 * Resolves a starting category for a platform from the seeded map. Returns null
 * when the garment type isn't mapped (caller falls back to the AI category
 * query, and the seller picks the real category).
 */
export function resolveSeededCategory(
  platform: MarketplacePlatform,
  garmentCategory: string | null,
  itemCategory: string | null,
): SeededCategory | null {
  const table = SEED[platform];
  if (!table) return null;
  const key = toGarmentKey(garmentCategory, itemCategory);
  if (!key) return null;
  return { path: table[key], source: "seed" };
}

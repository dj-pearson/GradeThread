// US-722: per-platform category mapping — PURE layer (deterministic, no I/O).
//
// Maps a GradeThread garment/item category to a best-effort starting category
// for each no-API marketplace. The platforms' real taxonomies also need a
// DEPARTMENT/gender (Men/Women/Kids) that GradeThread doesn't always capture —
// so these are LEAF suggestions the seller confirms in the Listing Kit's
// editable category field (US-723). Unmapped → returns null and the caller
// falls back to the natural-language category query.
//
// This file is the pure, unit-testable layer: the seeded map, the garment-key
// normalizer, and the per-platform candidate-category hints used to constrain
// the AI. The DB-backed cache/override + AI suggestion live in
// marketplace-category-resolve.ts (which has Supabase/Anthropic I/O), mirroring
// the platform-variants.ts (pure) / ai-listing.ts (I/O) split.

import type { MarketplacePlatform } from "./marketplace-specs.ts";

// Canonical GradeThread garment types (src/lib/constants.ts GARMENT_TYPES):
// tops | bottoms | outerwear | dresses | footwear | accessories
export type GarmentKey =
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

export function toGarmentKey(
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

// Platforms that use the curated no-API map. eBay resolves via the Taxonomy API
// and Shopify is free-form — neither lives in the seeded/cached table.
export const MAPPED_PLATFORMS: ReadonlySet<MarketplacePlatform> = new Set<
  MarketplacePlatform
>(["poshmark", "mercari", "depop", "grailed"]);

// Candidate top-level categories per platform — the closed set the AI must
// choose from when a garment type isn't seeded, so a suggestion can never be a
// hallucinated category the platform doesn't have. Superset of the SEED values.
export const PLATFORM_CATEGORY_HINTS: Partial<
  Record<MarketplacePlatform, readonly string[]>
> = {
  poshmark: [
    "Tops",
    "Pants & Jumpsuits",
    "Jackets & Coats",
    "Dresses",
    "Sweaters",
    "Skirts",
    "Shorts",
    "Jeans",
    "Shoes",
    "Bags",
    "Accessories",
    "Intimates & Sleepwear",
    "Swim",
    "Activewear",
  ],
  mercari: [
    "Tops & blouses",
    "Pants",
    "Coats & jackets",
    "Dresses",
    "Sweaters",
    "Skirts",
    "Shorts",
    "Jeans",
    "Shoes",
    "Bags & purses",
    "Accessories",
    "Sleepwear & intimates",
    "Swimwear",
    "Activewear",
  ],
  depop: [
    "Tops",
    "Bottoms",
    "Outerwear & Jackets",
    "Dresses",
    "Knitwear",
    "Skirts",
    "Shorts",
    "Jeans",
    "Shoes",
    "Bags",
    "Accessories",
    "Swimwear",
    "Activewear",
  ],
  grailed: [
    "Tops",
    "Bottoms",
    "Outerwear",
    "Dresses",
    "Tailoring",
    "Footwear",
    "Accessories",
  ],
};

// A resolved (or unresolved) platform category. `source` is "none" only when
// unmapped; "seed"/"ai"/"admin" reflect where the mapping came from.
export interface CategoryResolution {
  status: "mapped" | "unmapped";
  /** The platform-native category (leaf/path); null when unmapped. */
  path: string | null;
  /** Optional department/gender when known; null otherwise. */
  department: string | null;
  source: "seed" | "ai" | "admin" | "none";
  /** True until a human confirms an AI suggestion (drives the kit's prompt). */
  needsConfirmation: boolean;
}

/** The unmapped sentinel — caller falls back to the NL query + prompts a pick. */
export const UNMAPPED_CATEGORY: CategoryResolution = {
  status: "unmapped",
  path: null,
  department: null,
  source: "none",
  needsConfirmation: false,
};

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

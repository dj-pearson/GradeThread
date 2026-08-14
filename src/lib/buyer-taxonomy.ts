import { GARMENT_CATEGORIES } from "@/lib/constants";

// US-2552: one category vocabulary for everything a buyer tells us they want.
//
// WHAT MATCHING ACTUALLY DOES, because the fix depends on it and the finding
// guessed: `matchesSearch` (services/edge-functions/src/lib/condition-alerts.ts)
// compares a want's categories to `submissions.garment_category` with
// case-insensitive EXACT EQUALITY. That column is constrained to
// GARMENT_CATEGORIES. So a category is either in that list — in which case it
// can match — or it is a string that can never match anything, ever, silently.
//
// The onboarding chips were a hardcoded 13. Every one of them happened to be a
// real GARMENT_CATEGORIES value, so the finding's worst case ("a buyer who picks
// sneakers may never match") was not true. The real defect is quieter: it is an
// arbitrary SUBSET. A buyer who only wants scarves, shorts, sandals, hats,
// belts, blouses, neckwear or gloves had no way to say so, and when US-2224
// added neckwear and gloves to the taxonomy nothing told that list to grow.

/**
 * The categories a buyer can choose. Everything in the garment taxonomy except
 * `other`, which is the grader's fallback bucket for "we could not classify
 * this" — as a stated shopping interest it would match miscellany rather than
 * anything the buyer meant.
 */
export const BUYER_CATEGORY_OPTIONS: readonly string[] = GARMENT_CATEGORIES.filter(
  (c) => c !== "other",
);

/** Is this a category that can actually match a graded item? */
export function isMatchableCategory(value: string): boolean {
  return BUYER_CATEGORY_OPTIONS.includes(value.trim().toLowerCase());
}

/**
 * Keep only categories that can match, lower-cased and de-duplicated.
 *
 * Used on the way IN from any free-text surface, so a typo is dropped at the
 * boundary rather than stored as a criterion that quietly matches nothing.
 */
export function normalizeCategories(values: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const raw of values) {
    const v = raw.trim().toLowerCase();
    if (v && isMatchableCategory(v)) seen.add(v);
  }
  return [...seen];
}

// ── Sizes ───────────────────────────────────────────────────────────────────
//
// Sizes were stored as a single `{ all: [...] }` bucket, which says a buyer
// wears one size across shoes, jeans and coats. Nobody does. The buckets below
// are the groups a person actually HAS one size in — "M for tops, 32 for jeans,
// 10 for shoes" — rather than one bucket per garment type, because nobody is a
// different size in a hoodie than in a sweater.

export interface SizeGroup {
  key: string;
  label: string;
  placeholder: string;
  /** Which garment categories this group covers. */
  categories: readonly string[];
}

export const SIZE_GROUPS: readonly SizeGroup[] = [
  {
    key: "tops",
    label: "Tops and outerwear",
    placeholder: "M, L…",
    categories: [
      "t-shirt",
      "shirt",
      "blouse",
      "sweater",
      "hoodie",
      "jacket",
      "coat",
    ],
  },
  {
    key: "bottoms",
    label: "Bottoms",
    placeholder: "32, 34…",
    categories: ["jeans", "pants", "shorts", "skirt"],
  },
  { key: "dresses", label: "Dresses", placeholder: "8, M…", categories: ["dress"] },
  {
    key: "shoes",
    label: "Shoes",
    placeholder: "10, 44…",
    categories: ["sneakers", "boots", "sandals"],
  },
  {
    key: "accessories",
    label: "Accessories",
    placeholder: "One size, L…",
    categories: ["hat", "bag", "belt", "scarf", "neckwear", "gloves"],
  },
];

/**
 * The legacy single bucket. Rows written before US-2552 have their sizes here.
 *
 * It is READ and preserved rather than dropped or spread across the new groups:
 * spreading would invent a claim the buyer never made (that their shoe size is
 * also their jeans size), and dropping would delete an answer they gave us.
 */
export const LEGACY_SIZE_KEY = "all";

export type SizeBuckets = Record<string, string[]>;

/** Per-group sizes from a stored `sizes` jsonb, ignoring unknown keys. */
export function readSizeBuckets(sizes: unknown): SizeBuckets {
  const out: SizeBuckets = {};
  if (!sizes || typeof sizes !== "object") return out;
  const src = sizes as Record<string, unknown>;
  for (const group of SIZE_GROUPS) {
    const v = src[group.key];
    if (Array.isArray(v)) {
      const cleaned = v.map(String).map((s) => s.trim()).filter(Boolean);
      if (cleaned.length > 0) out[group.key] = cleaned;
    }
  }
  return out;
}

/** Sizes saved under the pre-US-2552 single bucket, if any. */
export function readLegacySizes(sizes: unknown): string[] {
  if (!sizes || typeof sizes !== "object") return [];
  const v = (sizes as Record<string, unknown>)[LEGACY_SIZE_KEY];
  return Array.isArray(v) ? v.map(String).map((s) => s.trim()).filter(Boolean) : [];
}

/**
 * The `sizes` value to store: the per-group buckets, plus the legacy bucket
 * carried through untouched so an old answer is never silently discarded.
 */
export function writeSizeBuckets(
  buckets: SizeBuckets,
  legacy: readonly string[] = [],
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const group of SIZE_GROUPS) {
    const v = buckets[group.key];
    if (v && v.length > 0) out[group.key] = v;
  }
  if (legacy.length > 0) out[LEGACY_SIZE_KEY] = [...legacy];
  return out;
}

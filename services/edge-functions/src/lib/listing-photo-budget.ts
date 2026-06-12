// US-545: per-item AI cost discipline for AutoLister.
//
// Two Sonnet vision calls run per item (the listing-generation pass and the
// item-specifics aspect-refine pass), and both send the item's FULL photo set.
// Image tokens dominate per-item cost, so the cost levers here are pure +
// testable and apply BEFORE any model call:
//
//  1. selectListingPhotos — drop exact-duplicate and near-identical (extra
//     same-role) shots and cap the count. A listing's attributes are fully
//     determined by a handful of role-diverse shots (front, tag, back, a couple
//     of details, a defect); a 5th close-up of the same seam is near-identical
//     and only adds image-token cost. Both vision passes send this trimmed set.
//     NOTE: Anthropic server-side-resizes every image to <= ~1.15MP before
//     billing, so source-resolution downscale does NOT change token cost — the
//     real lever is the photo *count*, which is what this caps.
//
//  2. isEasyAspectCategory — flag common, well-structured apparel categories
//     whose item-specifics the cheap model (Haiku) refines reliably, so the
//     aspect-refine pass can downshift models on the bulk of a clothing batch.
//
//  3. estimateListingItemCost / the image-token model — the measurement surface
//     for the "~30-50% per-item reduction" target. At runtime the real spend is
//     tracked in ai_enrichment_log.cost_usd (see generateListing); this lets the
//     reduction be asserted deterministically at representative batch parameters.

import { estimateCost } from "./ai-extract.ts";

export interface BudgetPhoto {
  url: string;
  // flipdesk_photo_type hint, e.g. front | back | tag | tag_2 | detail |
  // detail_2..4 | interior | defect | flatlay | on_model | measurement_*
  type?: string;
}

// Cap on photos forwarded to a vision pass. eBay shows up to 24 in the gallery,
// but a listing's *attributes* are determined by far fewer role-diverse shots.
export const DEFAULT_MAX_LISTING_PHOTOS = 6;

// Per base-role budget. `priority` decides which roles survive the total cap
// (lower = kept first); `keep` is the per-role cap that dedupes near-identical
// same-role shots (e.g. a 3rd detail close-up). Measurement shots carry no
// listing-attribute signal (measurements arrive as structured data), so they're
// dropped unless they're the only photos.
const ROLE_BUDGET: Record<string, { priority: number; keep: number }> = {
  front: { priority: 0, keep: 1 },
  tag: { priority: 1, keep: 2 },
  back: { priority: 2, keep: 1 },
  detail: { priority: 3, keep: 2 },
  defect: { priority: 4, keep: 2 },
  flatlay: { priority: 5, keep: 1 },
  on_model: { priority: 6, keep: 1 },
  interior: { priority: 7, keep: 1 },
  measurement: { priority: 9, keep: 0 },
};
const OTHER_ROLE = { priority: 8, keep: 1 };

/**
 * Collapse a flipdesk_photo_type to its base role: `detail_2` → `detail`,
 * `tag_2` → `tag`, `measurement_chest` → `measurement`. Pure.
 */
export function basePhotoRole(type?: string): string {
  if (!type) return "other";
  const t = type.toLowerCase().trim();
  if (!t) return "other";
  if (t.startsWith("measurement")) return "measurement";
  return t.replace(/_\d+$/, "");
}

/**
 * Trim an item's photo set to the cost-disciplined subset sent to the vision
 * passes: exact-duplicate URLs removed, near-identical same-role shots capped,
 * and the total capped to `maxPhotos`, keeping the most listing-relevant roles.
 * Original capture order is preserved in the result. Never returns empty when
 * given a non-empty input. Pure — no network — so it's unit-tested directly.
 */
export function selectListingPhotos(
  photos: BudgetPhoto[],
  maxPhotos: number = DEFAULT_MAX_LISTING_PHOTOS,
): BudgetPhoto[] {
  // 1. Drop exact-duplicate URLs (same shot linked twice) and blank urls.
  const seen = new Set<string>();
  const deduped: Array<{ photo: BudgetPhoto; index: number }> = [];
  photos.forEach((photo, index) => {
    const key = (photo.url ?? "").trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    deduped.push({ photo, index });
  });
  if (deduped.length === 0) return [];

  // 2. Annotate with role budget and process in priority order so the per-role
  //    cap and the total cap both keep the most useful shots.
  const annotated = deduped.map((d) => {
    const role = basePhotoRole(d.photo.type);
    const budget = ROLE_BUDGET[role] ?? OTHER_ROLE;
    return { ...d, role, priority: budget.priority, keep: budget.keep };
  });
  annotated.sort((a, b) => a.priority - b.priority || a.index - b.index);

  const keptByRole = new Map<string, number>();
  const budgeted: Array<{ photo: BudgetPhoto; index: number }> = [];
  for (const a of annotated) {
    const used = keptByRole.get(a.role) ?? 0;
    if (used >= a.keep) continue; // near-identical same-role shot — drop.
    keptByRole.set(a.role, used + 1);
    budgeted.push({ photo: a.photo, index: a.index });
  }

  // 3. Total cap (budgeted is in priority order).
  let chosen = budgeted.slice(0, Math.max(1, maxPhotos));

  // 4. Never return empty when input was non-empty (e.g. all measurement
  //    shots, keep:0) — fall back to the first deduped photo.
  if (chosen.length === 0) {
    const first = deduped[0]!;
    chosen = [{ photo: first.photo, index: first.index }];
  }

  // 5. Restore original capture order for a natural gallery sequence.
  chosen.sort((a, b) => a.index - b.index);
  return chosen.map((c) => c.photo);
}

// Category text that warrants the full vision model on the aspect-refine pass:
// high-variance or attribute-dense categories where a cheap model is more
// likely to mis-fill item-specifics. Matched as substrings (lowercased).
const HARD_CATEGORY_SIGNALS = [
  "trading card",
  "sports mem",
  "coin",
  "stamp",
  "watch",
  "jewelr",
  "electronic",
  "cell phone",
  "computer",
  "camera",
  "antique",
  "collectible",
  "musical instrument",
  "vintage", // vintage/era attribution needs the stronger model
  "designer", // luxury/designer aspects are high-stakes
];

// Common, well-structured apparel categories whose item-specifics Haiku refines
// reliably (Brand/Size/Color/Material/Department/Type are usually unambiguous).
const EASY_CATEGORY_SIGNALS = [
  "t-shirt",
  "tee",
  "shirt",
  "polo",
  "jean",
  "pant",
  "trouser",
  "short",
  "sweater",
  "hoodie",
  "sweatshirt",
  "jacket",
  "coat",
  "dress",
  "skirt",
  "shoe",
  "sneaker",
  "boot",
  "activewear",
  "legging",
  "blouse",
  "top",
];

/**
 * True when the resolved category (or the model's natural-language category
 * query) is a common apparel category whose item-specifics the cheap model
 * refines reliably — so the aspect-refine pass can use Haiku. A hard signal
 * (designer/vintage/non-apparel) always wins and returns false. Pure.
 */
export function isEasyAspectCategory(
  categoryText: string | null | undefined,
): boolean {
  if (!categoryText) return false;
  const p = categoryText.toLowerCase();
  if (HARD_CATEGORY_SIGNALS.some((s) => p.includes(s))) return false;
  return EASY_CATEGORY_SIGNALS.some((s) => p.includes(s));
}

// ── Cost model (measurement surface for AC #3) ─────────────────────────────
//
// Anthropic resizes any image to <= ~1.15MP before billing, so a single photo
// costs a bounded ~APPROX_IMAGE_TOKENS input tokens regardless of source
// resolution. This is the basis for proving the per-item reduction; production
// uses the exact token counts returned by the API (estimateCost in ai-extract).
export const APPROX_IMAGE_TOKENS = 1500;

export interface PassCostInput {
  model: string;
  imageCount: number;
  /** Non-image input tokens (system + user text + tool schema). */
  textTokensIn: number;
  tokensOut: number;
}

/** Estimated USD cost of a single model pass given its photo count. Pure. */
export function estimatePassCost(p: PassCostInput): number {
  const tokensIn = p.imageCount * APPROX_IMAGE_TOKENS + p.textTokensIn;
  return estimateCost(p.model, tokensIn, p.tokensOut);
}

/** Estimated USD cost of all passes that make up one generated listing. Pure. */
export function estimateListingItemCost(passes: PassCostInput[]): number {
  return passes.reduce((sum, p) => sum + estimatePassCost(p), 0);
}

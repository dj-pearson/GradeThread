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
  /**
   * US-2681: true when photo QA found a §11 cover-photo problem with THIS shot
   * (garment too small, more than one garment, busy ground, a prop in frame).
   *
   * Undefined means nobody looked, which is not the same as clean and is
   * treated as neither — see the slot-1 preference below.
   */
  coverIssue?: boolean;
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
  // Defect outranks detail: for pre-owned garments the flaw shots determine
  // condition_notes/SNAD accuracy, while a 2nd close-up is merely nice-to-have.
  defect: { priority: 3, keep: 2 },
  detail: { priority: 4, keep: 2 },
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

  // 6. US-2681 (AC4): slot 1 is the retrieval key for eBay image search, so it
  //    goes to a photo with no known cover problem when one is available.
  //
  //    ONLY a photo already ELIGIBLE for slot 1 is considered. Promoting a tag
  //    close-up because it happens to carry no cover_ flag would be worse than
  //    the problem: the flags are only ever set against slot 1, so a tag shot's
  //    silence means nothing was ever checked, not that it is a good cover.
  //
  //    Falls through to the existing role ordering when every candidate is
  //    flagged, or when none was ever assessed. Reordering on the strength of a
  //    check that did not run is the failure this whole story is about.
  const ordered = chosen.map((c) => c.photo);
  const firstCleanCover = ordered.findIndex(
    (p, i) => i > 0 && p.coverIssue === false && isCoverEligible(p.type),
  );
  if (firstCleanCover > 0 && ordered[0]!.coverIssue === true) {
    const [promoted] = ordered.splice(firstCleanCover, 1);
    ordered.unshift(promoted!);
  }
  return ordered;
}

// Cap on photos forwarded to the aspect-refine pass. Item specifics are read
// off the whole garment and its label; a defect close-up never decides one.
export const DEFAULT_MAX_ASPECT_PHOTOS = 5;

/**
 * The subset of the vision set that the aspect-refine pass gets.
 *
 * The refine pass used to receive the same photos as the listing pass. That set
 * is built for CONDITION accuracy, so it keeps up to two defect close-ups, and
 * every one of them costs the refine model ~1,500 image tokens to look at a
 * seam or a stain that no item specific is read from. Theme, Fabric Type,
 * Neckline, Pattern, Country of Origin and the rest come off the front, back,
 * tag and one detail shot.
 *
 * Defect-role shots are dropped, the remainder is kept by role priority (front,
 * tag, back, detail, ...) up to `maxPhotos`, and capture order is restored so
 * "Photo 1" stays the cover. Never returns empty for a non-empty input: a set
 * that is ONLY defect shots is sent as-is rather than sending nothing. Pure.
 */
export function selectAspectPhotos<T extends BudgetPhoto>(
  visionPhotos: T[],
  maxPhotos: number = DEFAULT_MAX_ASPECT_PHOTOS,
): T[] {
  if (visionPhotos.length === 0) return [];
  const withoutDefects = visionPhotos.filter(
    (p) => basePhotoRole(p.type) !== "defect",
  );
  const pool = withoutDefects.length > 0 ? withoutDefects : visionPhotos;
  const ranked = pool
    .map((photo, index) => ({
      photo,
      index,
      priority: (ROLE_BUDGET[basePhotoRole(photo.type)] ?? OTHER_ROLE).priority,
    }))
    .sort((a, b) => a.priority - b.priority || a.index - b.index)
    .slice(0, Math.max(1, maxPhotos))
    .sort((a, b) => a.index - b.index);
  return ranked.map((r) => r.photo);
}

/**
 * Roles that can legitimately BE a cover photo: a whole-garment view.
 *
 * A tag, detail, defect, interior or measurement shot is a fragment by design.
 * The reorder nudge already tells a seller when one of those ended up first;
 * this list stops the cover-issue preference from creating that situation.
 */
function isCoverEligible(type?: string): boolean {
  const role = basePhotoRole(type);
  return role === "front" || role === "flatlay" || role === "on_model" || role === "back";
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

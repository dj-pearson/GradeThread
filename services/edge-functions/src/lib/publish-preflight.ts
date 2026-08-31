// US-473 + US-566: publish pre-flight hardening for eBay.
//
// Two classes of failure used to surface as raw eBay errors (or worse, a 502
// from our own proxy) only AFTER we'd already sent the inventory PUT / publish:
//
//   • too many / duplicate / unreachable images   (eBay error 25601, 25710…)
//   • a condition the leaf category doesn't accept (eBay error 25002/25019…)
//
// These are all knowable BEFORE we call eBay, so we turn them into fixable
// "blockers" the seller can act on. This module is pure (the reachability check
// takes an injected fetcher) so it's fully unit-testable without live calls.

import type { EbayCondition } from "./ai-listing.ts";
// US-2681: the section-11 cover-photo verdict, from the PURE spec module rather
// than from ai-photo-qa.ts. Importing the assessor here would pull the Anthropic
// SDK and the Supabase client into a module whose whole contract is that it has
// neither, and the test-env-isolation guard caught exactly that. One source of
// truth for what counts as a cover issue, no dependency.
import {
  type CoverIssueLike,
  coverPhotoAssessment,
  type CoverPhotoAssessment,
  coverPhotoWarnings,
} from "./cover-photo-spec.ts";

// eBay raised the Inventory-API picture cap to 24 (the old 12-image gallery cap
// was Trading-API-era). We honour the real, current limit. Sending more returns
// error 25601 ("The size for ImageLinks cannot exceed…").
export const EBAY_MAX_IMAGES = 24;

export interface ImageCapResult {
  /** De-duplicated, order-preserved URLs, capped to the limit. */
  urls: string[];
  /** Count of duplicate URLs removed before capping. */
  duplicatesRemoved: number;
  /** Count of URLs dropped because the list exceeded the cap (after de-dup). */
  dropped: number;
}

/**
 * De-dup (re-uploads can share a URL), drop empties, preserve order (photos
 * arrive sorted by sort_order so the cover + best shots survive the cap), and
 * cap to eBay's image limit. Reports how many were de-duped vs dropped so the
 * caller can decide whether to warn or block.
 */
export function dedupeAndCapImages(
  urls: Array<string | null | undefined>,
  max: number = EBAY_MAX_IMAGES,
): ImageCapResult {
  const cleaned = urls.filter((u): u is string => !!u && u.trim() !== "");
  const deduped = [...new Set(cleaned)];
  const duplicatesRemoved = cleaned.length - deduped.length;
  const capped = deduped.slice(0, max);
  return {
    urls: capped,
    duplicatesRemoved,
    dropped: deduped.length - capped.length,
  };
}

/**
 * Turn an over-the-cap photo set into a fixable blocker. Returns null when the
 * set fits (≤ max unique images) — duplicates alone are silently de-duped, not
 * blocked. Over-cap is blocked (rather than silently dropping) so a seller
 * never loses a defect shot they intended to publish without knowing.
 */
export function imageCapBlocker(
  result: ImageCapResult,
  max: number = EBAY_MAX_IMAGES,
): string | null {
  if (result.dropped <= 0) return null;
  const total = result.urls.length + result.dropped;
  return (
    `You have ${total} photos but eBay allows ${max}. ` +
    `Remove ${result.dropped} photo${result.dropped === 1 ? "" : "s"} ` +
    `(lowest-priority shots) to publish.`
  );
}

// ── US-1896: photo standards preflight ─────────────────────────────────
//
// eBay's picture standards drive both listing eligibility and search ranking
// (vault/30-platform/ebay-ranking-playbook.md §6): a photo under 500px on its longest side is
// below eBay's hard minimum (a fixable BLOCKER), and a hero photo under 1600px
// disables buyer zoom / hurts ranking (a WARNING). Separately, the FIRST photo
// is the search-result thumbnail — leading with a tag/detail/defect shot instead
// of a full front/flat view costs click-through, so we NUDGE a reorder.
//
// Pure + fail-open on unknown dimensions (older rows have no width/height yet,
// backfilled lazily) — mirrors validateImageUpload's US-529 min-dimension check,
// which also only enforces when the dimensions are parseable.

/** eBay's hard minimum for a listable photo's longest side. */
export const PHOTO_MIN_LONGEST_PX = 500;
/** Below this longest side, eBay disables buyer zoom on the hero image. */
export const PHOTO_ZOOM_LONGEST_PX = 1600;

// Photo types that make a good search-result thumbnail (a full view of the
// item). Anything else as the FIRST photo triggers the reorder nudge. Mirrors
// the flipdesk_photo_type storage vocabulary (photo-profiles.ts).
const GOOD_HERO_PHOTO_TYPES: ReadonlySet<string> = new Set([
  "front",
  "back",
  "flatlay",
  "on_model",
]);

export interface PhotoStandardsPhoto {
  photo_type: string | null;
  width: number | null;
  height: number | null;
  sort_order: number;
}

export interface PhotoStandardsResult {
  /** Fixable blockers (a photo below eBay's 500px hard minimum). */
  blockers: string[];
  /** Non-blocking warnings (hero under 1600px = zoom disabled). */
  warnings: string[];
  /** First-photo reorder nudge (thumbnail is a tag/detail/defect shot), or null. */
  nudge: string | null;
  /**
   * US-2681: the §11 image-search verdict on the cover photo.
   *
   * "unknown" when the photos were never QA-assessed, which is most of them and
   * is NOT the same as clean — see coverPhotoAssessment. Never a blocker: this
   * is a retrieval-quality opinion, and refusing to publish over one would stop
   * a seller listing a garment that is perfectly sellable by text search.
   */
  coverPhoto: CoverPhotoAssessment;
}

/** Longest side of a photo, or null when either dimension is unknown. */
function longestSide(p: { width: number | null; height: number | null }): number | null {
  if (p.width == null || p.height == null) return null;
  if (!Number.isFinite(p.width) || !Number.isFinite(p.height)) return null;
  const longest = Math.max(p.width, p.height);
  return longest > 0 ? longest : null;
}

/**
 * Evaluate a set of LISTABLE photos (already filtered by filterListablePhotos
 * and sorted by sort_order) against eBay's picture standards. Pure; fail-open on
 * unknown dimensions. The hero photo is the lowest sort_order (the cover / first
 * thumbnail). Does NOT mutate or reorder the input.
 */
export function photoStandardsPreflight(
  photos: readonly PhotoStandardsPhoto[],
  /**
   * US-2681: the stored photo-QA result for this item, when there is one. Null
   * or omitted yields a cover verdict of "unknown", which is the honest answer
   * for an item nothing has looked at.
   */
  qa?: { issues: CoverIssueLike[] } | null,
): PhotoStandardsResult {
  const blockers: string[] = [];
  const warnings: string[] = [];
  let nudge: string | null = null;
  const coverPhoto = coverPhotoAssessment(qa);
  if (photos.length === 0) return { blockers, warnings, nudge, coverPhoto };

  // Count photos whose KNOWN longest side is below the 500px hard minimum.
  let tooSmall = 0;
  for (const p of photos) {
    const longest = longestSide(p);
    if (longest != null && longest < PHOTO_MIN_LONGEST_PX) tooSmall++;
  }
  if (tooSmall > 0) {
    blockers.push(
      `${tooSmall === 1 ? "A photo is" : `${tooSmall} photos are`} smaller than ` +
        `eBay's ${PHOTO_MIN_LONGEST_PX}px minimum on the longest side. Re-shoot or ` +
        `re-upload ${tooSmall === 1 ? "it" : "them"} at a higher resolution to publish.`,
    );
  }

  // Hero = lowest sort_order. Copy before sort so the caller's array is untouched.
  const hero = [...photos].sort((a, b) => a.sort_order - b.sort_order)[0];

  // Warning: hero under 1600px → eBay zoom disabled (fail-open when unknown).
  const heroLongest = longestSide(hero);
  if (heroLongest != null && heroLongest < PHOTO_ZOOM_LONGEST_PX) {
    warnings.push(
      `Your main photo is ${heroLongest}px on its longest side — under ` +
        `${PHOTO_ZOOM_LONGEST_PX}px, so eBay disables buyer zoom and it may rank ` +
        `lower. Use a larger version for the best listing.`,
    );
  }

  // Nudge: hero is a tag/detail/defect-type shot rather than a full view. Only
  // when the type is known and NOT a good-thumbnail type.
  const heroType = (hero.photo_type ?? "").trim();
  if (heroType && !GOOD_HERO_PHOTO_TYPES.has(heroType)) {
    nudge =
      `Your search thumbnail is a ${heroTypeLabel(heroType)} shot — drag a full ` +
      `front or flat-lay view first so buyers see the whole item in search results.`;
  }

  // US-2681 (AC3): warnings, never blockers. eBay image search is a second
  // index, so a cover photo that segments badly costs a seller the buyers who
  // search by picture — real, and not a reason to refuse a listing that will
  // still be found by text.
  if (coverPhoto.status === "issues") {
    warnings.push(...coverPhotoWarnings(coverPhoto));
    // The reorder nudge wins if it is already set: "your thumbnail is a tag
    // shot" is the bigger problem and has a one-drag fix, and stacking a second
    // nudge under it would split the seller's attention between two.
    if (!nudge) {
      nudge =
        "Buyers who search by picture may not find this. Your main photo should " +
        "be one garment filling the frame on a plain background, with nothing " +
        "else in shot.";
    }
  }

  return { blockers, warnings, nudge, coverPhoto };
}

/** Friendly noun for a photo_type in the reorder nudge. */
function heroTypeLabel(photoType: string): string {
  if (photoType.startsWith("tag")) return "tag";
  if (photoType.startsWith("detail")) return "detail";
  if (photoType === "defect") return "flaw";
  if (photoType === "interior") return "interior";
  if (photoType.startsWith("measurement")) return "measurement";
  return photoType.replace(/_/g, " ");
}

// ── Condition validation against the leaf category ─────────────────────
//
// The Inventory API takes a symbolic condition enum (NEW, USED_EXCELLENT…) but
// eBay's Taxonomy "get_item_condition_policies" returns the numeric conditionId
// allow-list per category. This is the canonical enum→id mapping eBay publishes
// for the Inventory API. Some leaves (vintage, collectibles, designer) restrict
// the set, so we validate against the category's allow-list before publishing.
export const CONDITION_ENUM_TO_ID: Record<EbayCondition, string> = {
  NEW: "1000",
  NEW_OTHER: "1500",
  NEW_WITH_DEFECTS: "1750",
  LIKE_NEW: "2750",
  // Granular pre-owned apparel conditions (2990/3010). 3000 (USED_EXCELLENT) is
  // the middle "Pre-owned - Good" tier that these bracket.
  PRE_OWNED_EXCELLENT: "2990",
  USED_EXCELLENT: "3000",
  PRE_OWNED_FAIR: "3010",
  USED_VERY_GOOD: "4000",
  USED_GOOD: "5000",
  USED_ACCEPTABLE: "6000",
  FOR_PARTS_OR_NOT_WORKING: "7000",
};

// Human labels for eBay conditionIds, used to phrase the blocker's "allowed
// conditions" hint. Covers the ids a clothing/general-merchandise seller will
// actually see returned by the policies API.
const CONDITION_ID_LABEL: Record<string, string> = {
  "1000": "New",
  "1500": "New other",
  "1750": "New with defects",
  "2000": "Certified refurbished",
  "2010": "Excellent refurbished",
  "2020": "Very good refurbished",
  "2030": "Good refurbished",
  "2500": "Seller refurbished",
  "2750": "Like new",
  "2990": "Pre-owned - Excellent",
  "3000": "Used / pre-owned",
  "3010": "Pre-owned - Fair",
  "4000": "Very good",
  "5000": "Good",
  "6000": "Acceptable",
  "7000": "For parts or not working",
};

function labelForConditionId(id: string): string {
  return CONDITION_ID_LABEL[id] ?? `Condition ${id}`;
}

/**
 * Validate a chosen condition enum against the category's allowed conditionIds.
 * Returns a fixable blocker string, or null when valid / unknowable.
 *
 *  • Empty/unknown allow-list → null (don't block on missing policy data; many
 *    categories return no restriction and accept the default set).
 *  • Mapped id present in the allow-list → null (valid).
 *  • Otherwise → a blocker naming the conditions the category DOES accept.
 */
export function validateConditionForCategory(
  conditionEnum: string,
  allowedConditionIds: string[],
): string | null {
  if (!allowedConditionIds || allowedConditionIds.length === 0) return null;
  const id = CONDITION_ENUM_TO_ID[conditionEnum as EbayCondition];
  // Unknown enum (shouldn't happen — it's typed) → don't block.
  if (!id) return null;
  if (allowedConditionIds.includes(id)) return null;

  const allowedLabels = allowedConditionIds
    .map(labelForConditionId)
    // de-dup labels (refurb tiers can collapse) and cap the hint length
    .filter((v, i, a) => a.indexOf(v) === i)
    .slice(0, 6);
  return (
    `"${labelForConditionId(id)}" isn't accepted in this eBay category. ` +
    `Allowed: ${allowedLabels.join(", ")}. Change the condition in the composer.`
  );
}

// Conditions we can EMIT to the Inventory API, ordered best→worst by quality
// (eBay conditionId). Drives the auto-pick fallback below: when a category
// rejects the chosen condition we only ever fall to an equal-or-WORSE one, so a
// remap never overstates the item.
const CONDITION_QUALITY_ORDER: readonly string[] = [
  "1000", // New with tags
  "1500", // New without tags
  "1750", // New with defects
  "2750", // Like new
  "2990", // Pre-owned - Excellent (apparel)
  "3000", // Used / pre-owned  (apparel: "Pre-owned - Good")
  "3010", // Pre-owned - Fair   (apparel)
  "4000", // Very good
  "5000", // Good
  "6000", // Acceptable
  "7000", // For parts / not working
];

// Reverse of CONDITION_ENUM_TO_ID: conditionId → the enum we'd emit for it.
const CONDITION_ID_TO_ENUM: Record<string, EbayCondition> = Object.fromEntries(
  (Object.entries(CONDITION_ENUM_TO_ID) as [EbayCondition, string][]).map(
    ([enumName, id]) => [id, enumName],
  ),
) as Record<string, EbayCondition>;

/**
 * US-1296+: auto-correct a chosen condition to one the leaf category accepts,
 * never overstating quality. eBay rejects a publish (error 25021) when the
 * condition id isn't in the category's allow-list — e.g. apparel categories
 * reject LIKE_NEW (2750). Rather than fail, we pick the nearest ALLOWED
 * condition of equal-or-worse quality.
 *
 * Returns:
 *   • the same enum when it's already accepted, or the allow-list is empty/
 *     unknown (don't touch what we can't verify);
 *   • the nearest allowed enum of EQUAL-OR-WORSE quality when the chosen one is
 *     rejected (e.g. NEW_OTHER → USED_EXCELLENT for a category without 1500);
 *   • null when the category accepts ONLY conditions better than the chosen one,
 *     or only ones we can't represent (e.g. refurbished tiers) — the caller
 *     should surface a fixable blocker instead of silently overstating.
 */
export function remapConditionForCategory(
  conditionEnum: string,
  allowedConditionIds: string[],
): EbayCondition | null {
  if (!allowedConditionIds || allowedConditionIds.length === 0) {
    return conditionEnum as EbayCondition;
  }
  const desiredId = CONDITION_ENUM_TO_ID[conditionEnum as EbayCondition];
  // Unknown enum → leave it; the API will validate.
  if (!desiredId) return conditionEnum as EbayCondition;
  if (allowedConditionIds.includes(desiredId)) {
    return conditionEnum as EbayCondition;
  }
  const desiredRank = CONDITION_QUALITY_ORDER.indexOf(desiredId);
  if (desiredRank < 0) return conditionEnum as EbayCondition;

  // Among allowed ids we can emit, pick the closest of equal-or-worse quality
  // (rank ≥ desiredRank). Never choose a better-quality condition.
  let best: { rank: number; cond: EbayCondition } | null = null;
  for (const id of allowedConditionIds) {
    const rank = CONDITION_QUALITY_ORDER.indexOf(id);
    const cond = CONDITION_ID_TO_ENUM[id];
    if (rank < desiredRank || !cond) continue; // better than ours / unrepresentable
    if (best === null || rank < best.rank) best = { rank, cond };
  }
  return best ? best.cond : null;
}

// ── US-3031: legacy used ladder → 2025 pre-loved apparel ladder ──────────────
//
// remapConditionForCategory compares conditionIds by NUMBER, which is only
// meaningful inside one family. eBay's legacy used ladder has four tiers
// (3000/4000/5000/6000) and the apparel pre-loved ladder has three
// (2990/3000/3010), and every apparel id sorts "better" than every legacy one.
// Rank alone therefore collapses a legacy "Very good" onto "Pre-owned - Fair",
// two tiers down, which sandbags a good garment and prices it accordingly.
//
// So translate across families by MEANING instead. The equivalences are read
// straight off the two grade maps below, which already agree on what each tier
// means in grade points: USED_EXCELLENT and PRE_OWNED_EXCELLENT both start at
// 7.5, and the apparel band covering the legacy Very good / Good range
// (4.5-7.5) is "Pre-owned - Good" (3000). Only the bottom legacy tier lands on
// "Pre-owned - Fair".
const LEGACY_TO_APPAREL_CONDITION: Partial<Record<EbayCondition, EbayCondition>> = {
  // 2750 → 2990. "Like new" has no apparel id; Excellent is the closest tier
  // that exists, and it is the conservative direction.
  LIKE_NEW: "PRE_OWNED_EXCELLENT",
  // 4000 → 3000 ("Pre-owned - Good"): grade band 6.0-7.5 maps there.
  USED_VERY_GOOD: "USED_EXCELLENT",
  // 5000 → 3000. Same words, same band midpoint (5.25 sits above the 5.0 Good
  // floor). Not an upgrade — the apparel ladder simply has no fourth tier.
  USED_GOOD: "USED_EXCELLENT",
  // 6000 → 3010 ("Pre-owned - Fair"): the bottom of both ladders.
  USED_ACCEPTABLE: "PRE_OWNED_FAIR",
  // 7000 has no apparel equivalent; a for-parts garment is Fair at best, and
  // sellers should be reading the composer warning rather than auto-listing it.
};

/**
 * The WORST condition a category allows, but only when that floor is itself a
 * genuinely PRE-OWNED tier (2990 or worse). Categories whose floor is still in
 * the new/like-new family return null: calling a worn garment "Like new" to
 * satisfy an allow-list is exactly the overstatement this module exists to
 * prevent, and it earns an INAD return rather than a sale.
 */
function worstPreOwnedAllowed(
  allowedConditionIds: string[],
): EbayCondition | null {
  const preOwnedFloorRank = CONDITION_QUALITY_ORDER.indexOf("2990");
  let worst: { rank: number; cond: EbayCondition } | null = null;
  for (const id of allowedConditionIds) {
    const rank = CONDITION_QUALITY_ORDER.indexOf(id);
    const cond = CONDITION_ID_TO_ENUM[id];
    if (rank < preOwnedFloorRank || !cond) continue;
    if (worst === null || rank > worst.rank) worst = { rank, cond };
  }
  return worst ? worst.cond : null;
}

export interface DraftConditionResolution {
  /** The condition to store on the draft. */
  condition: EbayCondition;
  /** True when it differs from what the model picked. */
  changed: boolean;
  /**
   * True when NO allowed condition can honestly stand in for the pick — the
   * category accepts only better or unrepresentable tiers. The draft keeps the
   * model's value and goes to review; the composer's own warning and the
   * publish blocker then do their job.
   */
  unresolved: boolean;
}

/**
 * US-3031: settle a GENERATED draft's eBay condition against the resolved
 * category's allow-list, at generation time.
 *
 * The listing model chooses from the full condition enum with no idea which
 * leaf it will land in. Clothing leaves accept only {1000, 1500, 1750, 2990,
 * 3000, 3010} and reject the legacy USED_VERY_GOOD / USED_GOOD /
 * USED_ACCEPTABLE and LIKE_NEW tiers — which are precisely the ones a model
 * reaches for on a worn garment. Left alone the draft carries a value eBay
 * bounces at publish, and the seller meets it as a red warning in the composer
 * instead of a listing.
 *
 * The ladder, in order:
 *   1. The pick is allowed, or the allow-list is unknown → keep it.
 *   2. On an apparel pre-loved leaf, the cross-family translation above.
 *   3. Nearest ALLOWED condition of equal-or-worse quality (rank remap) — the
 *      non-apparel path, unchanged.
 *   4. The category's pre-owned floor, when it has one.
 *   5. Otherwise keep the pick and mark it unresolved.
 */
export function resolveDraftCondition(
  aiCondition: string,
  allowedConditionIds: string[],
): DraftConditionResolution {
  const original = aiCondition as EbayCondition;
  const settled = (cond: EbayCondition): DraftConditionResolution => ({
    condition: cond,
    changed: cond !== original,
    unresolved: false,
  });
  if (!allowedConditionIds || allowedConditionIds.length === 0) {
    return settled(original);
  }
  const desiredId = CONDITION_ENUM_TO_ID[original];
  if (!desiredId || allowedConditionIds.includes(desiredId)) {
    return settled(original);
  }
  if (isApparelPrelovedCategory(allowedConditionIds)) {
    const translated = LEGACY_TO_APPAREL_CONDITION[original];
    const translatedId = translated ? CONDITION_ENUM_TO_ID[translated] : undefined;
    if (translated && translatedId && allowedConditionIds.includes(translatedId)) {
      return settled(translated);
    }
  }
  const remapped = remapConditionForCategory(original, allowedConditionIds);
  if (remapped) return settled(remapped);
  const floor = worstPreOwnedAllowed(allowedConditionIds);
  if (floor) return settled(floor);
  return { condition: original, changed: false, unresolved: true };
}

// ── US-1894: grade → eBay 2025 pre-loved apparel condition mapping ───────────
//
// eBay split apparel "Used" into a 3-tier PRE-OWNED scale in Jan-2025:
//   • Pre-owned - Excellent (2990)  — worn a handful of times, no visible flaws
//   • Pre-owned - Good      (3000)  — light, expected wear (eBay's "used" id)
//   • Pre-owned - Fair      (3010)  — noticeable wear/flaws, still wearable
// plus the "new" family: New (1000), New without tags (1500 / NEW_OTHER), and
// New with imperfections (1750 / NEW_WITH_DEFECTS).
//
// The base map (mapGradeToBaseCondition) targets the LEGACY used ladder
// (USED_EXCELLENT/VERY_GOOD/GOOD/ACCEPTABLE = 3000/4000/5000/6000). That ladder
// never produces 2990 or 3010, and remapConditionForCategory only ever moves
// EQUAL-OR-WORSE — so on an apparel leaf that accepts ONLY {1000,1500,1750,2990,
// 3000,3010} a low-grade item mapped to 6000 has nothing worse allowed and fails
// to publish (the flip side of the 25021 overstatement bug). The apparel band
// map below targets the pre-loved scale directly so every grade lands in-range.

// GradeThread scale → apparel pre-loved condition. Bands are calibrated to the
// tier boundaries in CLAUDE.md (NWT 10 / NWOT 9 / Excellent 8 / Very Good 7 /
// Good 6 / Fair 5 / Poor 3-4). Named so a reviewer can see the mapping at a
// glance; keep in lockstep with mapGradeToApparelCondition.
export const APPAREL_CONDITION_BANDS = {
  /** ≥ this → New (1000): the NWT tier. */
  NEW_MIN: 9.75,
  /** ≥ this → New without tags (1500): the NWOT tier. */
  NEW_OTHER_MIN: 9.0,
  /** ≥ this → Pre-owned - Excellent (2990). */
  PRE_OWNED_EXCELLENT_MIN: 7.5,
  /** ≥ this → Pre-owned - Good (3000, USED_EXCELLENT enum). Below → Fair (3010). */
  PRE_OWNED_GOOD_MIN: 5.0,
} as const;

/**
 * Legacy grade → condition ladder (the historical mapEbayCondition body, made
 * shared so flipdesk-ebay and this module stay single-source). Used for
 * NON-apparel categories and as the pre-remap default. Explicit editor values
 * still win upstream.
 */
export function mapGradeToBaseCondition(
  grade: number | null,
  label: string | null,
): EbayCondition {
  const upper = (label ?? "").toUpperCase();
  const isNwot = upper.includes("NWOT") || upper.includes("WITHOUT TAGS");
  const isNwt = !isNwot && (upper.includes("NWT") || upper.includes("WITH TAGS"));
  if (isNwt) return "NEW";
  if (isNwot) return "NEW_OTHER";
  if (grade != null) {
    if (grade >= 9.75) return "NEW";
    if (grade >= 9.0) return "NEW_OTHER";
    if (grade >= 7.5) return "USED_EXCELLENT";
    if (grade >= 6.0) return "USED_VERY_GOOD";
    if (grade >= 4.5) return "USED_GOOD";
    return "USED_ACCEPTABLE";
  }
  return "USED_EXCELLENT";
}

/**
 * Grade → eBay 2025 pre-loved APPAREL condition (the {NEW, NEW_OTHER,
 * NEW_WITH_DEFECTS, PRE_OWNED_EXCELLENT, USED_EXCELLENT=Good, PRE_OWNED_FAIR}
 * set). A label carrying a "new with defects / imperfections" hint maps to
 * NEW_WITH_DEFECTS even at a high grade (a flaw on an otherwise-new item).
 */
export function mapGradeToApparelCondition(
  grade: number | null,
  label: string | null,
): EbayCondition {
  const upper = (label ?? "").toUpperCase();
  const isNwot = upper.includes("NWOT") || upper.includes("WITHOUT TAGS");
  const isNwt = !isNwot && (upper.includes("NWT") || upper.includes("WITH TAGS"));
  const hasDefectHint = upper.includes("DEFECT") || upper.includes("IMPERFECT") ||
    upper.includes("NWD");
  // A flaw on an otherwise-NEW item → New with defects (1750). Only in the NEW
  // grade range: a defect on a worn item is just normal pre-owned wear.
  const inNewRange = isNwt || isNwot ||
    (grade != null && grade >= APPAREL_CONDITION_BANDS.NEW_OTHER_MIN);
  if (hasDefectHint && inNewRange) return "NEW_WITH_DEFECTS";
  if (isNwt) return "NEW";
  if (isNwot) return "NEW_OTHER";
  if (grade == null) return "USED_EXCELLENT"; // = Pre-owned - Good (3000)
  if (grade >= APPAREL_CONDITION_BANDS.NEW_MIN) return "NEW";
  if (grade >= APPAREL_CONDITION_BANDS.NEW_OTHER_MIN) return "NEW_OTHER";
  if (grade >= APPAREL_CONDITION_BANDS.PRE_OWNED_EXCELLENT_MIN) {
    return "PRE_OWNED_EXCELLENT";
  }
  if (grade >= APPAREL_CONDITION_BANDS.PRE_OWNED_GOOD_MIN) return "USED_EXCELLENT";
  return "PRE_OWNED_FAIR";
}

/**
 * True when the category's allow-list is the apparel pre-loved taxonomy — i.e.
 * it accepts the granular apparel ids 2990 (Excellent) or 3010 (Fair). These
 * ids only appear on clothing/shoe/accessory leaves, so their presence is the
 * signal to map via the pre-loved bands rather than the legacy used ladder.
 */
export function isApparelPrelovedCategory(
  allowedConditionIds: string[],
): boolean {
  if (!allowedConditionIds || allowedConditionIds.length === 0) return false;
  return allowedConditionIds.includes("2990") ||
    allowedConditionIds.includes("3010");
}

/**
 * Unified condition resolver for the publish/revise path (US-1894).
 *   1. An explicit editor value always wins (only allow-list-remapped for safety).
 *   2. Else, on an apparel pre-loved category, map the grade via the 2025 bands.
 *   3. Else, use the legacy base ladder (non-apparel unchanged).
 * The result is always passed through remapConditionForCategory so it can never
 * overstate quality nor emit an id the leaf rejects. Returns null only when even
 * the remap can't find a representable equal-or-worse condition (caller blocks).
 */
export function resolveEbayCondition(params: {
  explicit?: string | null;
  grade: number | null;
  label: string | null;
  allowedConditionIds: string[];
}): EbayCondition | null {
  const { explicit, grade, label, allowedConditionIds } = params;
  const desired = explicit && explicit.trim()
    ? (explicit.trim() as EbayCondition)
    : isApparelPrelovedCategory(allowedConditionIds)
    ? mapGradeToApparelCondition(grade, label)
    : mapGradeToBaseCondition(grade, label);
  return remapConditionForCategory(desired, allowedConditionIds);
}

// Superlatives that contradict a lower pre-owned tier — a "flawless" claim on a
// Good/Fair listing invites INAD ("item not as described") returns and, per
// eBay's own guidance, suppresses visibility. Lower-cased, whole-word matched.
const CONTRADICTORY_SUPERLATIVES = [
  "flawless",
  "pristine",
  "mint",
  "like new",
  "as new",
  "perfect condition",
  "no flaws",
  "no signs of wear",
  "immaculate",
  "unworn",
];

// The tiers a superlative would contradict (Good / Fair / worse). "Excellent"
// and the NEW family may legitimately use strong language.
const LOWER_PREOWNED_TIERS = new Set<EbayCondition>([
  "USED_EXCELLENT", // = Pre-owned - Good
  "PRE_OWNED_FAIR",
  "USED_VERY_GOOD",
  "USED_GOOD",
  "USED_ACCEPTABLE",
  "FOR_PARTS_OR_NOT_WORKING",
]);

export interface ConditionDescriptionCheck {
  ok: boolean;
  /** Human-readable contradictions found (empty when ok). */
  warnings: string[];
}

/**
 * US-1894 AC2: flag condition-description text that contradicts the chosen tier
 * (e.g. "flawless" on a Pre-owned - Fair listing). Pure + caller decides whether
 * to warn, block, or strip. Empty/absent text and higher tiers pass.
 */
export function conditionDescriptionConsistency(
  condition: EbayCondition,
  text: string | null | undefined,
): ConditionDescriptionCheck {
  const body = (text ?? "").toLowerCase();
  if (!body.trim() || !LOWER_PREOWNED_TIERS.has(condition)) {
    return { ok: true, warnings: [] };
  }
  const warnings: string[] = [];
  for (const phrase of CONTRADICTORY_SUPERLATIVES) {
    // Word-boundary match so "mint" doesn't fire inside "mintable" etc.
    const re = new RegExp(`\\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    if (re.test(body)) {
      warnings.push(
        `"${phrase}" contradicts the "${labelForConditionId(CONDITION_ENUM_TO_ID[condition])}" condition`,
      );
    }
  }
  return { ok: warnings.length === 0, warnings };
}

export interface CategoryConditionOption {
  /** The emittable eBay condition enum (what the Inventory API takes). */
  value: EbayCondition;
  /** The eBay numeric conditionId this enum maps to. */
  id: string;
  /** Human label for the id (category-neutral). */
  label: string;
}

/**
 * Turn a category's allowed conditionIds (from getItemConditionPolicies) into the
 * SELECTABLE condition options for the composer's dropdown: only ids we can emit
 * (have an enum), ordered best→worst by quality, de-duped. `allowedLabels` lists
 * every allowed condition's label (including any we can't emit yet, e.g. refurb
 * tiers) so the UI can explain what the category accepts. An empty allow-list
 * (unrestricted category) yields empty arrays — the caller falls back to the full
 * static option list.
 */
export function conditionOptionsForCategory(
  allowedConditionIds: string[],
): { options: CategoryConditionOption[]; allowedLabels: string[] } {
  if (!allowedConditionIds || allowedConditionIds.length === 0) {
    return { options: [], allowedLabels: [] };
  }
  // eBay's granular pre-owned APPAREL family (2990 Excellent / 3010 Fair) only
  // ever appears in clothing leaves. When it does, the shared id 3000 is labeled
  // "Pre-owned - Good" (not the generic "Used / pre-owned"), and calling both
  // 2990 and 3000 "Excellent" would be a confusing duplicate — so relabel 3000
  // for this category. Detected purely from the allow-list shape (no eBay name
  // fetch / no migration needed).
  const apparelFamily = allowedConditionIds.includes("2990") ||
    allowedConditionIds.includes("3010");
  const labelFor = (id: string): string =>
    apparelFamily && id === "3000" ? "Pre-owned - Good" : labelForConditionId(id);

  // Order allowed ids by quality (best→worst); ids outside the known order
  // (shouldn't happen) trail in their original order.
  const ordered = [
    ...CONDITION_QUALITY_ORDER.filter((id) => allowedConditionIds.includes(id)),
    ...allowedConditionIds.filter((id) => !CONDITION_QUALITY_ORDER.includes(id)),
  ];
  const seen = new Set<string>();
  const options: CategoryConditionOption[] = [];
  for (const id of ordered) {
    if (seen.has(id)) continue;
    seen.add(id);
    const value = CONDITION_ID_TO_ENUM[id];
    if (!value) continue; // e.g. refurbished tiers we don't emit — not selectable
    options.push({ value, id, label: labelFor(id) });
  }
  const allowedLabels = allowedConditionIds
    .map(labelFor)
    .filter((v, i, a) => a.indexOf(v) === i);
  return { options, allowedLabels };
}

// ── Image reachability ─────────────────────────────────────────────────
//
// eBay fetches imageUrls server-side at publish; an unreachable URL fails the
// whole publish with an opaque error. We HEAD-probe each unique URL first and
// flag only DEFINITIVE client errors (404/410/403) as blockers. Transient
// problems (timeouts, 5xx, network errors) are treated as reachable so a flaky
// CDN moment doesn't block a legitimate publish — eBay will retry its own fetch.

export type UrlFetcher = (url: string) => Promise<{ ok: boolean; status: number }>;

export interface ReachabilityResult {
  /** URLs that returned a definitive client error (404/410/403). */
  unreachable: string[];
}

const DEFINITIVE_UNREACHABLE = new Set([403, 404, 410]);

/**
 * Probe each unique URL with the injected fetcher and collect the ones that
 * definitively don't exist. Bounded by `maxChecked` so a huge batch doesn't
 * stall publish; the cover + first images (highest priority) are checked first.
 */
export async function checkImageReachability(
  urls: string[],
  fetcher: UrlFetcher,
  opts: { maxChecked?: number } = {},
): Promise<ReachabilityResult> {
  const maxChecked = opts.maxChecked ?? EBAY_MAX_IMAGES;
  const unique = [...new Set(urls.filter((u) => !!u && u.trim() !== ""))].slice(
    0,
    maxChecked,
  );
  const unreachable: string[] = [];
  await Promise.all(
    unique.map(async (url) => {
      try {
        const { status } = await fetcher(url);
        if (DEFINITIVE_UNREACHABLE.has(status)) unreachable.push(url);
      } catch {
        // Network error / timeout → treat as reachable (best-effort, no block).
      }
    }),
  );
  return { unreachable };
}

/** Phrase an unreachable-image set as a single fixable blocker. */
export function reachabilityBlocker(result: ReachabilityResult): string | null {
  if (result.unreachable.length === 0) return null;
  const n = result.unreachable.length;
  return (
    `${n} photo${n === 1 ? " is" : "s are"} unreachable and would fail on eBay. ` +
    `Re-upload the affected photo${n === 1 ? "" : "s"} in the composer and try again.`
  );
}

// ── US-1893: leaf-category guard ───────────────────────────────────────
//
// eBay only lets items list under a LEAF category. A category id that arrives
// from manual entry, CSV import, or an older row can be a PARENT node, which
// eBay rejects at publish with an opaque error. The publish preflight verifies
// leaf-ness up front and surfaces a fixable blocker naming the best leaf
// suggestion instead. Leaf resolution is cache-first (a category we've already
// fetched aspects for is a proven leaf), so an already-validated id costs no
// live Taxonomy call — see resolveCategoryLeafStatus + the route wiring.

export type CategoryLeafStatus = "leaf" | "non_leaf" | "not_found" | "unverified";

/** The top get_category_suggestions leaf, offered as the one-click fix. */
export interface LeafCategorySuggestion {
  categoryId: string;
  categoryName: string;
  categoryTreePath?: string | null;
}

export interface LeafGuardDeps {
  /**
   * True when the id has cached leaf-only metadata (aspects) — a proven leaf, so
   * we can pass WITHOUT a live Taxonomy call. `get_item_aspects_for_category`
   * only returns aspects for leaf categories, so a populated cache row is proof.
   */
  hasCachedLeaf: (categoryId: string) => Promise<boolean>;
  /** Live Taxonomy leaf probe — only invoked on a cache miss. */
  probeLeafStatus: (categoryId: string) => Promise<CategoryLeafStatus>;
}

/**
 * Resolve a category id's leaf status, cache-first. An already-validated
 * (aspect-cached) id short-circuits to "leaf" and never touches the live probe.
 */
export async function resolveCategoryLeafStatus(
  categoryId: string,
  deps: LeafGuardDeps,
): Promise<CategoryLeafStatus> {
  if (await deps.hasCachedLeaf(categoryId)) return "leaf";
  return await deps.probeLeafStatus(categoryId);
}

/**
 * Turn a resolved leaf status into a publish blocker string, or null to pass.
 *
 * - "leaf": listable → null.
 * - "unverified": we couldn't reach Taxonomy (transient) → fail OPEN (null); a
 *   hiccup on our side must never block a seller's publish.
 * - "non_leaf" / "not_found": a real, fixable problem → a blocker that names the
 *   top suggested leaf as a one-click fix when we have one.
 */
export function leafCategoryBlocker(
  categoryId: string | null,
  status: CategoryLeafStatus,
  suggestion: LeafCategorySuggestion | null,
): string | null {
  if (!categoryId) return null; // "Pick an eBay category." is a separate blocker.
  if (status === "leaf" || status === "unverified") return null;
  const problem =
    status === "not_found"
      ? `eBay category ${categoryId} could not be found in the current category tree`
      : `eBay category ${categoryId} is a parent category, not a specific (leaf) category items can list under`;
  if (suggestion) {
    const where = suggestion.categoryTreePath
      ? ` (${suggestion.categoryTreePath})`
      : "";
    return `${problem}. Use "${suggestion.categoryName}"${where} — category ${suggestion.categoryId} — instead.`;
  }
  return `${problem}. Pick a specific (leaf) category for this item.`;
}

// US-1896: client mirror of the edge picture-standards preflight
// (services/edge-functions/src/lib/publish-preflight.ts → photoStandardsPreflight).
// The two MUST stay in lockstep: same 500px hard floor, same 1600px zoom
// threshold, same GOOD_HERO_PHOTO_TYPES / heroTypeLabel copy. The composer uses
// this for a LIVE nudge (no publish round-trip) from the photo_type + sort_order
// data it already holds; the edge remains the source of truth at publish time.
//
// Pure + fail-open on unknown dimensions (photo-manager rows may not carry
// width/height), exactly like the edge.

/** eBay's hard minimum for a listable photo's longest side. */
export const PHOTO_MIN_LONGEST_PX = 500;
/** Below this longest side, eBay disables buyer zoom on the hero image. */
export const PHOTO_ZOOM_LONGEST_PX = 1600;

// Photo types that make a good search-result thumbnail (a full view of the
// item). Anything else as the FIRST photo triggers the reorder nudge. Mirrors
// GOOD_HERO_PHOTO_TYPES in publish-preflight.ts.
export const GOOD_HERO_PHOTO_TYPES: ReadonlySet<string> = new Set([
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
}

/** Longest side of a photo, or null when either dimension is unknown. */
function longestSide(p: { width: number | null; height: number | null }): number | null {
  if (p.width == null || p.height == null) return null;
  if (!Number.isFinite(p.width) || !Number.isFinite(p.height)) return null;
  const longest = Math.max(p.width, p.height);
  return longest > 0 ? longest : null;
}

/** Friendly noun for a photo_type in the reorder nudge. Mirrors the edge. */
export function heroTypeLabel(photoType: string): string {
  if (photoType.startsWith("tag")) return "tag";
  if (photoType.startsWith("detail")) return "detail";
  if (photoType === "defect") return "flaw";
  if (photoType === "interior") return "interior";
  if (photoType.startsWith("measurement")) return "measurement";
  return photoType.replace(/_/g, " ");
}

/**
 * Faithful client port of the edge photoStandardsPreflight. Evaluate a set of
 * LISTABLE photos against eBay's picture standards. Pure; fail-open on unknown
 * dimensions. The hero photo is the lowest sort_order. Does NOT mutate the input.
 */
export function photoStandardsPreflight(
  photos: readonly PhotoStandardsPhoto[],
): PhotoStandardsResult {
  const blockers: string[] = [];
  const warnings: string[] = [];
  let nudge: string | null = null;
  if (photos.length === 0) return { blockers, warnings, nudge };

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

  // Non-null: the length guard above proves the array is non-empty.
  const hero = [...photos].sort((a, b) => a.sort_order - b.sort_order)[0]!;

  const heroLongest = longestSide(hero);
  if (heroLongest != null && heroLongest < PHOTO_ZOOM_LONGEST_PX) {
    warnings.push(
      `Your main photo is ${heroLongest}px on its longest side — under ` +
        `${PHOTO_ZOOM_LONGEST_PX}px, so eBay disables buyer zoom and it may rank ` +
        `lower. Use a larger version for the best listing.`,
    );
  }

  const heroType = (hero.photo_type ?? "").trim();
  if (heroType && !GOOD_HERO_PHOTO_TYPES.has(heroType)) {
    nudge =
      `Your search thumbnail is a ${heroTypeLabel(heroType)} shot — drag a full ` +
      `front or flat-lay view first so buyers see the whole item in search results.`;
  }

  return { blockers, warnings, nudge };
}

export interface HeroNudgePhoto {
  id: string;
  photo_type: string | null;
  sort_order: number;
}

export interface HeroNudge {
  /** The nudge copy (mirrors photoStandardsPreflight's nudge). */
  message: string;
  /**
   * A better hero candidate to move to the front for a one-click reorder — the
   * lowest-sort_order photo of a GOOD_HERO type — or null when the item has no
   * full-view photo yet (nothing to reorder; the seller must add one).
   */
  suggestedHeroId: string | null;
}

/**
 * Composer live nudge: when the FIRST photo (lowest sort_order) is a
 * tag/detail/defect-type shot rather than a full view, return the nudge copy and
 * the best hero candidate to reorder to the front. Returns null when the hero is
 * already a full-view type (or unknown). Purely a function of photo_type +
 * sort_order, exactly the data the composer already holds.
 */
export function firstPhotoNudge(
  photos: readonly HeroNudgePhoto[],
): HeroNudge | null {
  if (photos.length === 0) return null;
  const ordered = [...photos].sort((a, b) => a.sort_order - b.sort_order);
  // Non-null: the length guard above proves the array is non-empty.
  const hero = ordered[0]!;
  const heroType = (hero.photo_type ?? "").trim();
  // Fail-open: unknown or already-good hero type → no nudge.
  if (!heroType || GOOD_HERO_PHOTO_TYPES.has(heroType)) return null;

  const candidate = ordered.find(
    (p) => GOOD_HERO_PHOTO_TYPES.has((p.photo_type ?? "").trim()),
  );
  return {
    message:
      `Your search thumbnail is a ${heroTypeLabel(heroType)} shot — ` +
      `lead with a full front or flat-lay view so buyers see the whole item in ` +
      `search results.`,
    suggestedHeroId: candidate ? candidate.id : null,
  };
}

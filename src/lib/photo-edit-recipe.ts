// US-2208: the record of how an edited listing photo was derived from its
// original, stored in `item_photos.edit_recipe` (jsonb).
//
// Holding the recipe — rather than only the edited pixels — is what makes a
// re-edit lossless. Reopening the editor loads the pristine original and
// replays these values into the controls, so a seller who nudges brightness
// three times gets three renders OF THE ORIGINAL, not a JPEG re-encoded three
// times with tone compounded on tone.
//
// It arrives from PostgREST as untyped jsonb, so everything here is written to
// survive a malformed, truncated, or future-version payload: parseEditRecipe()
// never throws and never returns a partially-populated recipe.

import {
  NEUTRAL_ADJUSTMENTS,
  clampAdjustments,
  type Adjustments,
} from "@/lib/image-adjustments";

/** Normalized crop rect, all values 0-1 relative to the rendered frame. */
export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PhotoEditRecipe {
  /** Schema version. Bump when the shape changes incompatibly. */
  v: 1;
  /** Coarse rotation in degrees: 0 | 90 | 180 | 270. */
  rotation: number;
  /** Fine straighten angle, -15..15. */
  fine: number;
  /** Crop applied after rotation, or null when the full frame was kept. */
  crop: CropRect | null;
  /** Locked crop aspect (w/h in image pixels), or null for a free crop. */
  aspect: number | null;
  adjustments: Adjustments;
  /**
   * Whether a background cut-out was applied. Recorded but NOT auto-replayed on
   * reopen: replaying it means re-running the segmentation model, which is
   * seconds of work the seller didn't ask for. The editor surfaces a note
   * instead, and re-running it is one click.
   */
  bgRemoved: boolean;
  /** ISO timestamp of the save that produced the current image. */
  editedAt: string;
}

export const RECIPE_VERSION = 1 as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Finite-number coercion with a fallback — rejects NaN, Infinity and strings. */
function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function parseCrop(v: unknown): CropRect | null {
  if (!isRecord(v)) return null;
  const x = num(v.x, NaN);
  const y = num(v.y, NaN);
  const w = num(v.w, NaN);
  const h = num(v.h, NaN);
  if (![x, y, w, h].every(Number.isFinite)) return null;
  // A crop outside the frame, or one with no area, would render as an empty
  // canvas — treat it as "no crop" rather than propagating a broken rect.
  if (w <= 0 || h <= 0) return null;
  if (x < 0 || y < 0 || x + w > 1.0001 || y + h > 1.0001) return null;
  return { x, y, w, h };
}

function parseAdjustments(v: unknown): Adjustments {
  if (!isRecord(v)) return { ...NEUTRAL_ADJUSTMENTS };
  return clampAdjustments({
    brightness: num(v.brightness, 0),
    contrast: num(v.contrast, 0),
    saturation: num(v.saturation, 0),
    warmth: num(v.warmth, 0),
    sharpness: num(v.sharpness, 0),
  });
}

/**
 * Read a recipe off a row. Returns null for anything unusable — an absent
 * column, a null, a foreign shape, or a version this build doesn't understand.
 *
 * An unknown version deliberately yields null rather than a best-effort parse:
 * the caller falls back to editing the current image, which is always correct,
 * whereas guessing at an unfamiliar shape could silently mis-seed a crop.
 */
export function parseEditRecipe(raw: unknown): PhotoEditRecipe | null {
  if (!isRecord(raw)) return null;
  if (raw.v !== RECIPE_VERSION) return null;

  const rotation = ((Math.round(num(raw.rotation, 0) / 90) * 90) % 360 + 360) % 360;
  const fine = Math.max(-15, Math.min(15, num(raw.fine, 0)));
  const aspectRaw = num(raw.aspect, NaN);
  return {
    v: RECIPE_VERSION,
    rotation,
    fine,
    crop: parseCrop(raw.crop),
    aspect: Number.isFinite(aspectRaw) && aspectRaw > 0 ? aspectRaw : null,
    adjustments: parseAdjustments(raw.adjustments),
    bgRemoved: raw.bgRemoved === true,
    editedAt: typeof raw.editedAt === "string" ? raw.editedAt : "",
  };
}

/** Build a recipe for a save. `editedAt` is injected so callers stay testable. */
export function buildEditRecipe(input: {
  rotation: number;
  fine: number;
  crop: CropRect | null;
  aspect: number | null;
  adjustments: Adjustments;
  bgRemoved: boolean;
  editedAt: string;
}): PhotoEditRecipe {
  return {
    v: RECIPE_VERSION,
    rotation: input.rotation,
    fine: input.fine,
    crop: input.crop,
    aspect: input.aspect,
    adjustments: clampAdjustments(input.adjustments),
    bgRemoved: input.bgRemoved,
    editedAt: input.editedAt,
  };
}

/**
 * Whether a recipe actually changed anything. A recipe that only records "the
 * seller opened the editor and saved" should not light up the revert control.
 */
export function recipeIsNoOp(r: PhotoEditRecipe | null): boolean {
  if (!r) return true;
  const a = r.adjustments;
  return (
    r.rotation === 0 &&
    r.fine === 0 &&
    r.crop === null &&
    !r.bgRemoved &&
    a.brightness === 0 &&
    a.contrast === 0 &&
    a.saturation === 0 &&
    a.warmth === 0 &&
    a.sharpness === 0
  );
}

/**
 * Storage path for a photo's preserved original: the same `{userId}/{itemId}/`
 * prefix with an `originals/` folder before the filename.
 *
 * Keeping segment 1 as the user id is REQUIRED — the storage RLS policy on both
 * buckets is `(storage.foldername(name))[1] = auth.uid()::text`, so writing the
 * original anywhere else would be rejected.
 */
export function originalPathFor(storagePath: string): string {
  const cut = storagePath.lastIndexOf("/");
  if (cut < 0) return `originals/${storagePath}`;
  return `${storagePath.slice(0, cut)}/originals/${storagePath.slice(cut + 1)}`;
}

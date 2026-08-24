// US-2843: is this comp listing showing a garment, or a catalog render?
//
// THE PROBLEM THIS EXISTS FOR. The condition-priced comps work (US-2841) fits a
// price-vs-grade slope over comp listings we have read for condition. A large
// share of marketplace apparel listings carry manufacturer or feed-tool catalog
// images rather than photographs of the actual item. Those read near perfect,
// every time, at whatever price the seller happened to pick. Leave them in and
// the slope bends toward a condition nobody is selling, which makes the ceiling
// we hand a reseller standing in a thrift store too high. The failure is not a
// wrong pixel; it is somebody overpaying for a jacket.
//
// WHAT IT DECIDES ON. Metadata only: photo hashes, their dimensions, and how
// many DISTINCT cells each hash has already been seen under. No pixels, no
// network, no env. The caller has the bytes; this module does not want them.
//
// THE ASYMMETRY, STATED ON PURPOSE. A false positive costs one dropped comp out
// of a sample. A false negative bends the curve for every listing after it. So
// the tells are tuned to catch catalog sets even where that occasionally throws
// away a real seller whose listing tool padded their photos to square. The
// fixture keeps one case of each failure (S15 missed, E15 wrongly flagged) so
// the next reader sees the edge rather than trusting a clean-looking score.

/** How many distinct cells a hash must appear under before it reads as catalog stock. */
export const CROSS_CELL_STOCK_MIN = 3;

/**
 * The lower bar for a one-photo listing.
 *
 * With a single image there is no dimension spread and no second opinion, so
 * repetition is the only signal available and it has to count for more. Two
 * unrelated cells sharing the only photo a listing has is already a catalog
 * hero being passed around.
 */
export const SINGLE_PHOTO_CROSS_CELL_MIN = 2;

/** Below this many photos, "they are all the same size" says nothing. */
export const UNIFORM_MIN_PHOTOS = 3;

/**
 * Square only counts as a tell at catalog resolution.
 *
 * Feed tools and product photography output large squares (1600, 2000). A
 * seller cropping square for social lands at 1080 or below, and E14 in the
 * fixture is exactly that person. Without this floor they lose their comps.
 */
export const SQUARE_MIN_SIDE = 1200;

export interface CompPhoto {
  /** Stable hash of the image bytes. Computed by the caller. */
  hash: string;
  width: number | null;
  height: number | null;
}

export interface CompPhotoSet {
  cellKey: string;
  photos: CompPhoto[];
}

/** How many DISTINCT cells this hash has been seen under. Absent means one. */
export type HashCellCount = (hash: string) => number;

export type StockStrength = "strong" | "weak" | "none";

export interface StockVerdict {
  /** True when this set must not contribute to a curve. */
  stock: boolean;
  strength: StockStrength;
  /** Machine-readable tells, always populated when stock is true (AC4). */
  reasons: string[];
}

function hasDimensions(p: CompPhoto): boolean {
  return typeof p.width === "number" && typeof p.height === "number" &&
    p.width > 0 && p.height > 0;
}

/**
 * Decide whether a comp listing's photos are catalog stock.
 *
 * One STRONG tell rejects on its own. Weak tells need company: either of them
 * alone fires on ordinary sellers, and rejecting on one would quietly delete
 * everybody who shoots a consistent set.
 */
export function isStockPhotoSet(
  set: CompPhotoSet,
  cellsForHash: HashCellCount,
): StockVerdict {
  const photos = set.photos ?? [];
  if (photos.length === 0) {
    // Not stock. Unusable, which is a different thing, and the caller needs to
    // tell the two apart when it writes the rejection reason down.
    return { stock: false, strength: "none", reasons: ["no_photos"] };
  }

  const reasons: string[] = [];

  // strong tells
  if (photos.length === 1) {
    if (cellsForHash(photos[0].hash) >= SINGLE_PHOTO_CROSS_CELL_MIN) {
      return {
        stock: true,
        strength: "strong",
        reasons: ["single_photo_cross_cell"],
      };
    }
  } else if (photos.some((p) => cellsForHash(p.hash) >= CROSS_CELL_STOCK_MIN)) {
    // One shared photo condemns the set: sellers who paste the catalog hero on
    // top of their own detail shots are the common case, not the rare one.
    return { stock: true, strength: "strong", reasons: ["cross_cell_hash"] };
  }

  // weak tells
  let weak = 0;
  const measurable = photos.filter(hasDimensions);
  if (
    photos.length >= UNIFORM_MIN_PHOTOS &&
    measurable.length === photos.length
  ) {
    const first = measurable[0];
    const uniform = measurable.every(
      (p) => p.width === first.width && p.height === first.height,
    );
    if (uniform) {
      reasons.push("uniform_dimensions");
      weak++;
      if (first.width === first.height && (first.width ?? 0) >= SQUARE_MIN_SIDE) {
        reasons.push("square_aspect");
        weak++;
      }
    }
  }

  return {
    stock: weak >= 2,
    strength: weak > 0 ? "weak" : "none",
    reasons,
  };
}

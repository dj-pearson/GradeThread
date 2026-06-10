import { FLIPDESK_PHOTO_TYPES } from "@/lib/constants";
import type { FlipdeskPhotoType } from "@/types/database";

// Canonical default photo order for a listing: Front → Back → Tag → Detail …
// `FLIPDESK_PHOTO_TYPES` is already authored in that order, so its index IS the
// type's rank. Index 0 (lowest sort_order) is the cover / eBay main image.
//
// Within a type we leave a gap (×100) so multiple photos of the same type stack
// after each other without colliding with the next type. A manual drag-reorder
// later densifies sort_order to 0..n (see photo-manager / composer), and a new
// upload after that lands at its canonical position without clobbering the
// manual order.

const UNRANKED = FLIPDESK_PHOTO_TYPES.length;
const TYPE_STRIDE = 100;

/** Position of `type` in the canonical order; unknown types sort last. */
export function photoTypeRank(type: FlipdeskPhotoType | string): number {
  const i = (FLIPDESK_PHOTO_TYPES as readonly string[]).indexOf(type);
  return i === -1 ? UNRANKED : i;
}

/**
 * sort_order to assign a freshly uploaded photo of `newType` so the default
 * order is Front, Back, Tag, Detail … regardless of which slot the user filled
 * first. `existing` is the item's current photos (any shape with a photo_type).
 */
export function nextUploadSortOrder(
  existing: ReadonlyArray<{ photo_type: FlipdeskPhotoType | string }>,
  newType: FlipdeskPhotoType | string,
): number {
  const sameType = existing.filter((p) => p.photo_type === newType).length;
  return photoTypeRank(newType) * TYPE_STRIDE + sameType;
}

/**
 * Stable canonical sort: orders by type rank, then by the row's existing
 * sort_order so prior manual ordering within a type is preserved.
 */
export function canonicalPhotoSort<
  T extends { photo_type: FlipdeskPhotoType | string; sort_order: number },
>(photos: ReadonlyArray<T>): T[] {
  return [...photos].sort((a, b) => {
    const ra = photoTypeRank(a.photo_type);
    const rb = photoTypeRank(b.photo_type);
    if (ra !== rb) return ra - rb;
    return a.sort_order - b.sort_order;
  });
}

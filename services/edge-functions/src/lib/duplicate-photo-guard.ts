// US-3538: the same photo in several slots.
//
// Photo reuse detection skipped a submission's OWN images, and slot coverage
// was checked by slot name only, so one front shot uploaded as front, back and
// label passed coverage and was graded as three angles. This refuses, before
// any charge, a core photo (front, back, label) that is a near-duplicate of
// another photo in the same submission. Detail shots may legitimately repeat
// an area, so two details are not compared with each other.

import { hammingHex } from "./photo-reuse.ts";

export const CORE_SLOTS = new Set(["front", "back", "label"]);
/** Same threshold family as reuse detection: <= 6 of 64 bits is the same photo. */
export const DUPLICATE_MAX_DISTANCE = 6;

/** The pair that duplicates a core slot, or null. Pure. */
export function duplicateCorePhoto(
  photos: ReadonlyArray<{ imageType: string; phash: string | null }>,
): { a: string; b: string } | null {
  for (let i = 0; i < photos.length; i++) {
    for (let j = i + 1; j < photos.length; j++) {
      const p = photos[i]!;
      const q = photos[j]!;
      if (!p.phash || !q.phash) continue;
      if (!CORE_SLOTS.has(p.imageType) && !CORE_SLOTS.has(q.imageType)) {
        continue;
      }
      if (hammingHex(p.phash, q.phash) <= DUPLICATE_MAX_DISTANCE) {
        return { a: p.imageType, b: q.imageType };
      }
    }
  }
  return null;
}

export function duplicatePhotoMessage(d: { a: string; b: string }): string {
  return `The ${d.a} and ${d.b} photos look like the same picture. Take a separate photo for each.`;
}

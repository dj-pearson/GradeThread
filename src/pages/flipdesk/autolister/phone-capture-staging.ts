// US-3185: turning a bin shot on a phone into staged photos and groups.
//
// Extracted from autolister.tsx rather than written there, because the page is
// at its US-2520 line ceiling and because this is the part worth testing: the
// mapping from "the phone said these four shots were item 3" to "the grid has
// an Item 3 with four photos in it" is where a bin quietly becomes one heap.
//
// Pure. It takes the groups as they are and returns what they should become,
// so the caller's setState stays a one-liner and this can be driven with plain
// objects.

import type { CapturePhoto } from "@/lib/phone-capture-client";
import { groupPhotosByItem } from "@/lib/phone-capture-client";
import type { StagedPhoto } from "@/stores/autolister-upload-store";

/** The part of the page's Group this needs. Structural, like WarnableGroup. */
export interface StageableGroup {
  id: string;
  name: string;
  photoIds: string[];
  coverId: string;
}

export interface StageCaptureResult<G extends StageableGroup> {
  /** New staged photos, in the order the phone sent them. */
  staged: StagedPhoto[];
  /** The whole group list as it should now be: existing ones extended, new ones appended. */
  groups: G[];
}

/**
 * Stage one poll's worth of arrivals.
 *
 * `groupIds` maps a capture group index to the page Group it was staged into,
 * and is MUTATED rather than returned, because it has to survive between polls:
 * the second poll for the same item must extend that item's group, not start a
 * second one. The caller holds it in a ref for exactly that reason.
 *
 * `newId` is injected so a test can name the ids it asserts on.
 */
export function stageCapturedPhotos<G extends StageableGroup>(
  photos: readonly CapturePhoto[],
  groups: readonly G[],
  groupIds: Map<number, string>,
  newId: () => string = () => crypto.randomUUID(),
): StageCaptureResult<G> {
  const staged: StagedPhoto[] = [];
  // group id -> the photo ids this poll adds to it.
  const additions = new Map<string, string[]>();
  const order: { id: string; cover: string }[] = [];

  for (const bucket of groupPhotosByItem(photos)) {
    let groupId = groupIds.get(bucket.groupIndex);
    if (!groupId) {
      groupId = newId();
      groupIds.set(bucket.groupIndex, groupId);
    }
    const ids: string[] = [];
    for (const photo of bucket.photos) {
      const id = newId();
      ids.push(id);
      staged.push({
        id,
        url: photo.url,
        storagePath: photo.storagePath,
        thumbnailUrl: null,
        thumbnailStoragePath: null,
        width: photo.width,
        height: photo.height,
        bytes: photo.bytes,
        // The phone's shots carry no EXIF by the time they reach here — the
        // upload route strips it (US-276) — so auto-grouping has nothing to
        // read. It does not need to: the seller already said where the
        // boundaries are, which is the whole point of the Next item control.
        capturedAtMs: null,
        phash: "",
      });
    }
    const existing = additions.get(groupId);
    if (existing) existing.push(...ids);
    else {
      additions.set(groupId, ids);
      order.push({ id: groupId, cover: ids[0] ?? "" });
    }
  }

  const next = groups.map((g) => {
    const add = additions.get(g.id);
    if (!add) return g;
    additions.delete(g.id);
    return { ...g, photoIds: [...g.photoIds, ...add] };
  });

  // Whatever is left in `additions` is an item the phone started and the page
  // has no group for yet. Numbered from the list's length so the names follow
  // on from whatever the seller already had, the way auto-grouping does.
  let n = next.length;
  for (const { id, cover } of order) {
    const add = additions.get(id);
    if (!add || add.length === 0) continue;
    n += 1;
    next.push({ id, name: `Item ${n}`, photoIds: add, coverId: cover } as unknown as G);
  }
  return { staged, groups: next };
}

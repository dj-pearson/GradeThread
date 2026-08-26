// US-1567 AC5: the PhotoManager retag/delete network round-trips, extracted
// behind a minimal client shape so tests drive them through a mocked seam —
// and kept OUT of the component module on purpose: importing photo-manager.tsx
// from a test drags its whole UI import graph (use-ebay + the editor dialog,
// ~650 lines of untestable-in-jsdom UI) into the v8 coverage denominator and
// sinks the global thresholds. This module imports nothing but types.
import type { ItemPhotoRow, FlipdeskPhotoType } from "@/types/database";
import {
  originalPathFor,
  parseEditRecipe,
  type PhotoEditRecipe,
} from "@/lib/photo-edit-recipe";
import {
  calibrationAfterPhotoEdit,
  rotatedDims,
  type CalibrationEditOutcome,
  type RotatableCalibration,
} from "@/lib/measure-photo-geometry";
import {
  bucketForItemPhotoRow,
  bumpItemPhotoUrl,
  needsSignedDisplayUrl,
} from "@/lib/item-photo-url";

export interface PhotoMutationClient {
  // PromiseLike, not Promise: supabase-js query builders are thenables.
  from(table: string): {
    update(patch: unknown): {
      eq(col: string, v: string): PromiseLike<{ error: unknown }>;
    };
    delete(): { eq(col: string, v: string): PromiseLike<{ error: unknown }> };
  };
  storage: {
    from(bucket: string): { remove(paths: string[]): PromiseLike<unknown> };
  };
}

/** The extra storage surface the edit round-trip needs beyond retag/delete. */
export interface PhotoEditClient extends PhotoMutationClient {
  storage: {
    from(bucket: string): {
      remove(paths: string[]): PromiseLike<unknown>;
      copy(from: string, to: string): PromiseLike<{ error: unknown }>;
      upload(
        path: string,
        body: Blob,
        opts: { upsert: boolean; contentType: string },
      ): PromiseLike<{ error: unknown }>;
      download(path: string): PromiseLike<{ data: Blob | null; error: unknown }>;
      getPublicUrl(path: string): { data: { publicUrl: string } };
    };
  };
}

/**
 * Photo fields the edit round-trip reads.
 *
 * `photo_url` is in here because it decides the BUCKET (US-2407): an empty one
 * means the bytes are in the private `submission-images` bucket, and an edit has
 * to be written back to the bucket it came from.
 */
export type EditablePhoto =
  & Pick<
    ItemPhotoRow,
    | "id"
    | "storage_path"
    | "thumbnail_storage_path"
    | "original_storage_path"
    | "photo_url"
  >
  // US-2888: the MeasureCard calibration is written in the pixel coordinates of
  // the image being replaced, so an edit has to move it or admit it is stale.
  // All optional: PhotoManager selects `*` and has every one of these, while
  // the uploader's in-flight rows have none of them and want the no-op path.
  & Partial<Pick<ItemPhotoRow, "width" | "height" | "edit_recipe">>
  & { measure_calibration?: RotatableCalibration | null };

/** Options for {@link persistPhotoEdit}. */
export interface PersistPhotoEditOptions {
  /**
   * Pixel dimensions of the blob being written. Supplied by the editor, which
   * already knows its output canvas size — the alternative is decoding the
   * blob again purely to read two numbers.
   */
  dims?: [number, number] | null;
  /** Injected clock, for the cache-busting query string. */
  now?: number;
}

/**
 * Write edited pixels over a photo, preserving its pristine original first.
 *
 * The original is copied aside exactly ONCE — on the first edit — and
 * `original_storage_path` is what records that it happened. A second edit finds
 * that column already set and leaves the stored original alone, so the "revert"
 * target is always the true pre-edit upload rather than the previous edit.
 *
 * A re-encode busts photo_url but the pre-generated thumbnail still holds the
 * OLD pixels — and itemPhotoThumb() prefers thumbnail_url, so galleries and
 * covers would keep showing the stale image while zoom and eBay (which read
 * photo_url) showed the new one. The thumbnail is dropped so those surfaces
 * fall back to the cache-busted photo_url.
 *
 * US-2407: the edit is written back to the bucket the bytes CAME from. A photo
 * captured on the phone (Garment Tag, second tag, certificate) lives in the
 * private bucket, and this used to hardcode `item-photos` — so the preserve-the-
 * original copy() failed and every such photo was uneditable on desktop. Writing
 * it back privately keeps the seller's crop and republishes nothing: photo_url
 * stays "", which is what every public destination reads. Same round trip iOS
 * has always made for a private rotate (`PhotoRotateService`).
 */
export async function persistPhotoEdit(
  client: PhotoEditClient,
  photo: EditablePhoto,
  blob: Blob,
  recipe: PhotoEditRecipe | null,
  options: PersistPhotoEditOptions = {},
): Promise<CalibrationEditOutcome> {
  const now = options.now ?? Date.now();
  const path = photo.storage_path;
  if (!path) throw new Error("This photo has no storage path.");

  const isPrivate = needsSignedDisplayUrl(photo);
  const store = client.storage.from(bucketForItemPhotoRow(photo));

  let originalPath = photo.original_storage_path;
  if (!originalPath) {
    const candidate = originalPathFor(path);
    const { error: copyErr } = await store.copy(path, candidate);
    // Abort rather than proceed. Uploading over `path` without a preserved copy
    // is exactly the destructive behaviour this function exists to prevent, and
    // a silent fallback would leave the seller believing they can revert.
    if (copyErr) {
      throw new Error(
        `Couldn't preserve the original photo, so the edit was not saved: ${
          copyErr instanceof Error ? copyErr.message : String(copyErr)
        }`,
      );
    }
    originalPath = candidate;
  }

  const { error: upErr } = await store.upload(path, blob, {
    upsert: true,
    contentType: "image/jpeg",
  });
  if (upErr) throw upErr;

  if (photo.thumbnail_storage_path) {
    void store.remove([photo.thumbnail_storage_path]);
  }

  // US-2888. A rotate replaces the pixels the MeasureCard calibration was
  // measured on, and nothing used to rewrite it — so the homography went on
  // measuring along the old axis and every stored line endpoint stayed at its
  // old coordinate. On a portrait-to-landscape turn that puts endpoints past
  // the new right edge: still saved, still counted, and impossible to drag back
  // because dragging an endpoint was the only way to move one.
  //
  // A quarter turn is rigid, so the calibration carries across EXACTLY and no
  // card has to be re-detected. Anything that resamples the frame gets the
  // honest answer instead: cleared, and detected again on the next open.
  const outcome = calibrationAfterPhotoEdit({
    calibration: photo.measure_calibration,
    prevRecipe: parseEditRecipe(photo.edit_recipe),
    nextRecipe: recipe,
    width: photo.width,
    height: photo.height,
  });

  // Dimensions were never written back on an edit either, so a rotated photo
  // reported its pre-rotation width forever — and the rotate above reads them.
  // Prefer what the editor measured; fall back to turning the stored pair.
  const dims = options.dims ??
    (outcome.action === "rotate" && photo.width && photo.height
      ? rotatedDims(photo.width, photo.height, outcome.turns)
      : null);

  // A private photo has no public URL to bust and must not acquire one — an
  // empty photo_url is exactly what keeps it out of every eBay/export payload.
  // Its display URL is invalidated client-side instead.
  const { error: dbErr } = await client
    .from("item_photos")
    .update({
      ...(isPrivate
        ? {}
        : { photo_url: `${store.getPublicUrl(path).data.publicUrl}?v=${now}` }),
      thumbnail_url: null,
      thumbnail_storage_path: null,
      original_storage_path: originalPath,
      edit_recipe: recipe,
      ...(dims ? { width: dims[0], height: dims[1] } : {}),
      ...(outcome.action === "rotate"
        ? { measure_calibration: outcome.calibration }
        : {}),
      ...(outcome.action === "clear" ? { measure_calibration: null } : {}),
    } as never)
    .eq("id", photo.id);
  if (dbErr) throw dbErr;
  if (isPrivate) bumpItemPhotoUrl(path);
  return outcome;
}

/**
 * Restore a photo's preserved original over its working path and clear the
 * recipe. `original_storage_path` is deliberately KEPT: the original is still
 * the original, and a later edit should not copy a second one.
 *
 * Download-then-upload rather than a storage copy(), because copy() does not
 * overwrite an existing destination and `storage_path` always exists here.
 */
export async function revertPhotoEdit(
  client: PhotoEditClient,
  photo: EditablePhoto,
  now: number = Date.now(),
): Promise<void> {
  const path = photo.storage_path;
  const originalPath = photo.original_storage_path;
  if (!path) throw new Error("This photo has no storage path.");
  if (!originalPath) throw new Error("This photo has no preserved original.");

  const isPrivate = needsSignedDisplayUrl(photo);
  const store = client.storage.from(bucketForItemPhotoRow(photo));
  const { data: original, error: dlErr } = await store.download(originalPath);
  if (dlErr || !original) {
    throw new Error("Couldn't read the original photo, so nothing was changed.");
  }

  const { error: upErr } = await store.upload(path, original, {
    upsert: true,
    contentType: "image/jpeg",
  });
  if (upErr) throw upErr;

  if (photo.thumbnail_storage_path) {
    void store.remove([photo.thumbnail_storage_path]);
  }

  // Same private-bucket split as the save path: no public URL is minted for a
  // photo whose bytes are private.
  const { error: dbErr } = await client
    .from("item_photos")
    .update({
      ...(isPrivate
        ? {}
        : { photo_url: `${store.getPublicUrl(path).data.publicUrl}?v=${now}` }),
      thumbnail_url: null,
      thumbnail_storage_path: null,
      edit_recipe: null,
    } as never)
    .eq("id", photo.id);
  if (dbErr) throw dbErr;
  if (isPrivate) bumpItemPhotoUrl(path);
}

export async function persistRetag(
  client: PhotoMutationClient,
  photo: Pick<ItemPhotoRow, "id">,
  photoType: FlipdeskPhotoType,
  // US-2462: written on EVERY retag, including when it is null. Leaving it out
  // when the new type takes no qualifier would keep the previous role on the
  // row — a "Fabric close-up" retagged to "Front" would stay role='fabric', and
  // the grading fabric check would still count it.
  photoRole: string | null = null,
): Promise<void> {
  const { error } = await client
    .from("item_photos")
    .update({ photo_type: photoType, photo_role: photoRole } as never)
    .eq("id", photo.id);
  if (error) throw error;
}

export async function persistDelete(
  client: PhotoMutationClient,
  // photo_url is REQUIRED, not optional: it decides the bucket, and an omitted
  // one reads as "" — i.e. private — which would send a public photo's delete to
  // the wrong bucket. Let the type force every caller to hand it over.
  photo: Pick<ItemPhotoRow, "id" | "storage_path" | "photo_url"> &
    Partial<Pick<ItemPhotoRow, "original_storage_path">>,
): Promise<void> {
  // US-2208: the preserved original is invisible to every listing surface, so
  // nothing else would ever reclaim it — delete it alongside the working file
  // or edited photos leak a full-size object each.
  const paths = [photo.storage_path, photo.original_storage_path].filter(
    (p): p is string => typeof p === "string" && p.length > 0,
  );
  if (paths.length > 0) {
    // US-2407: from the bucket the bytes are actually in. Hardcoding the public
    // one deleted the ROW and left every phone-captured tag's object orphaned in
    // the private bucket — invisible, unreclaimable, and still holding the PII
    // the delete was meant to remove.
    await client.storage.from(bucketForItemPhotoRow(photo)).remove(paths);
  }
  const { error } = await client.from("item_photos").delete().eq("id", photo.id);
  if (error) throw error;
}

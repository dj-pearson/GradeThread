// US-1567 AC5: the PhotoManager retag/delete network round-trips, extracted
// behind a minimal client shape so tests drive them through a mocked seam —
// and kept OUT of the component module on purpose: importing photo-manager.tsx
// from a test drags its whole UI import graph (use-ebay + the editor dialog,
// ~650 lines of untestable-in-jsdom UI) into the v8 coverage denominator and
// sinks the global thresholds. This module imports nothing but types.
import type { ItemPhotoRow, FlipdeskPhotoType } from "@/types/database";
import {
  originalPathFor,
  type PhotoEditRecipe,
} from "@/lib/photo-edit-recipe";

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

const BUCKET = "item-photos";

/** Photo fields the edit round-trip reads. */
export type EditablePhoto = Pick<
  ItemPhotoRow,
  "id" | "storage_path" | "thumbnail_storage_path" | "original_storage_path"
>;

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
 */
export async function persistPhotoEdit(
  client: PhotoEditClient,
  photo: EditablePhoto,
  blob: Blob,
  recipe: PhotoEditRecipe | null,
  now: number = Date.now(),
): Promise<void> {
  const path = photo.storage_path;
  if (!path) throw new Error("This photo has no storage path.");

  const store = client.storage.from(BUCKET);

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

  const publicUrl = store.getPublicUrl(path).data.publicUrl;
  const { error: dbErr } = await client
    .from("item_photos")
    .update({
      photo_url: `${publicUrl}?v=${now}`,
      thumbnail_url: null,
      thumbnail_storage_path: null,
      original_storage_path: originalPath,
      edit_recipe: recipe,
    } as never)
    .eq("id", photo.id);
  if (dbErr) throw dbErr;
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

  const store = client.storage.from(BUCKET);
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

  const publicUrl = store.getPublicUrl(path).data.publicUrl;
  const { error: dbErr } = await client
    .from("item_photos")
    .update({
      photo_url: `${publicUrl}?v=${now}`,
      thumbnail_url: null,
      thumbnail_storage_path: null,
      edit_recipe: null,
    } as never)
    .eq("id", photo.id);
  if (dbErr) throw dbErr;
}

export async function persistRetag(
  client: PhotoMutationClient,
  photo: Pick<ItemPhotoRow, "id">,
  photoType: FlipdeskPhotoType,
): Promise<void> {
  const { error } = await client
    .from("item_photos")
    .update({ photo_type: photoType } as never)
    .eq("id", photo.id);
  if (error) throw error;
}

export async function persistDelete(
  client: PhotoMutationClient,
  photo: Pick<ItemPhotoRow, "id" | "storage_path"> &
    Partial<Pick<ItemPhotoRow, "original_storage_path">>,
): Promise<void> {
  // US-2208: the preserved original is invisible to every listing surface, so
  // nothing else would ever reclaim it — delete it alongside the working file
  // or edited photos leak a full-size object each.
  const paths = [photo.storage_path, photo.original_storage_path].filter(
    (p): p is string => typeof p === "string" && p.length > 0,
  );
  if (paths.length > 0) {
    await client.storage.from("item-photos").remove(paths);
  }
  const { error } = await client.from("item_photos").delete().eq("id", photo.id);
  if (error) throw error;
}

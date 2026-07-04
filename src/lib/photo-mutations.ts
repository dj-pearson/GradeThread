// US-1567 AC5: the PhotoManager retag/delete network round-trips, extracted
// behind a minimal client shape so tests drive them through a mocked seam —
// and kept OUT of the component module on purpose: importing photo-manager.tsx
// from a test drags its whole UI import graph (use-ebay + the editor dialog,
// ~650 lines of untestable-in-jsdom UI) into the v8 coverage denominator and
// sinks the global thresholds. This module imports nothing but types.
import type { ItemPhotoRow, FlipdeskPhotoType } from "@/types/database";

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
  photo: Pick<ItemPhotoRow, "id" | "storage_path">,
): Promise<void> {
  if (photo.storage_path) {
    await client.storage.from("item-photos").remove([photo.storage_path]);
  }
  const { error } = await client.from("item_photos").delete().eq("id", photo.id);
  if (error) throw error;
}

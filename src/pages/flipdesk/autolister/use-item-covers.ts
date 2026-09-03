// Cover photo per item for the queue row thumbnail (2026-09-03), so a seller
// can tell the drafts apart before clicking "Review" the same way the Inventory
// table lets them. Same rule as that table and iOS SyncEngine.primaryPhotos:
// the cover is the LOWEST sort_order photo per item.

import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { PhotoLike } from "@/lib/item-photo-url";

export const ITEM_COVERS_KEY = "autolister_item_covers";

/**
 * `itemIdsKey` is the id CONTENTS, not the count (see use-item-meta.ts).
 * Chunked BY ITEM ID with each chunk ordered ascending, so an item's photos
 * never span chunks and the first row seen per item is its cover.
 */
export function useAutolisterItemCovers(
  batchId: string | null,
  itemIds: string[],
  itemIdsKey: string,
) {
  return useQuery<Record<string, PhotoLike>>({
    queryKey: [ITEM_COVERS_KEY, batchId, itemIdsKey],
    enabled: itemIds.length > 0,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const CHUNK = 200;
      const map: Record<string, PhotoLike> = {};
      for (let i = 0; i < itemIds.length; i += CHUNK) {
        const { data: rows } = await supabase
          .from("item_photos")
          .select(
            "inventory_item_id, photo_type, thumbnail_url, photo_url, storage_path, sort_order",
          )
          .in("inventory_item_id", itemIds.slice(i, i + CHUNK))
          .order("sort_order", { ascending: true });
        for (
          const r of (rows ?? []) as Array<{
            inventory_item_id: string | null;
            photo_type: string | null;
            thumbnail_url: string | null;
            photo_url: string | null;
            storage_path: string | null;
          }>
        ) {
          if (r.inventory_item_id && !map[r.inventory_item_id]) {
            map[r.inventory_item_id] = {
              photo_type: r.photo_type,
              thumbnail_url: r.thumbnail_url,
              photo_url: r.photo_url,
              storage_path: r.storage_path,
            };
          }
        }
      }
      return map;
    },
  });
}

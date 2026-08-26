// US-2520 shrink-only ratchet: the queue's per-batch item metadata read, lifted
// out of autolister-queue.tsx when US-2919 needed three more columns on it.
//
// It is one query with one cache key, so it belongs in one place — the queue
// renders it as badges, and the size check reads brand, size, garment_category
// and measurements off the same rows rather than issuing a second read.

import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { ItemCategory, ItemStatus, PhotoQaIssue } from "@/types/database";

// Item titles + persisted photo-QA (US-537) for friendlier, actionable rows.
export interface ItemMeta {
  title: string;
  qaScore: number | null;
  qaIssues: PhotoQaIssue[];
  /** US-1578: informational — the item carries flat measurements. */
  hasMeasurements: boolean;
  /** Feed the in-cockpit "Add photos" uploader the right slot profile + status. */
  category: ItemCategory | null;
  status: ItemStatus | null;
  /** US-2919: what the size check needs to judge this draft. */
  brand: string | null;
  size: string | null;
  garment: string | null;
  measurements: Record<string, unknown> | null;
}
/**
 * Item titles, persisted photo-QA (US-537) and the columns the US-2919 size
 * check reads, for one batch.
 *
 * `itemIdsKey` is the id CONTENTS, not the count: a length-only cache key
 * returns the stale meta map when the batch's id set changes without changing
 * size.
 */
export function useAutolisterItemMeta(
batchId: string | null,
itemIds: string[],
itemIdsKey: string,
) {
return useQuery<Record<string, ItemMeta>>({
  queryKey: ["autolister_item_meta", batchId, itemIdsKey],
  enabled: itemIds.length > 0,
  queryFn: async () => {
    // US-554: chunk so large batches don't overflow the `in` list.
    const CHUNK = 200;
    const map: Record<string, ItemMeta> = {};
    for (let i = 0; i < itemIds.length; i += CHUNK) {
      const { data: rows } = await supabase
        .from("inventory_items")
        .select(
          "id, title, photo_qa_score, photo_qa_issues, measurements, item_category, status, brand, size, garment_category",
        )
        .in("id", itemIds.slice(i, i + CHUNK));
      for (
        const r of (rows ?? []) as Array<{
          id: string;
          title: string;
          photo_qa_score: number | null;
          photo_qa_issues: PhotoQaIssue[] | null;
          measurements: Record<string, unknown> | null;
          item_category: ItemCategory | null; // US-2804: was `category`
          status: ItemStatus | null;
          brand: string | null;
          size: string | null;
          garment_category: string | null;
        }>
      ) {
        map[r.id] = {
          title: r.title,
          qaScore: r.photo_qa_score,
          qaIssues: r.photo_qa_issues ?? [],
          hasMeasurements: !!r.measurements &&
            Object.keys(r.measurements).length > 0,
          category: r.item_category ?? null,
          status: r.status ?? null,
          brand: r.brand,
          size: r.size,
          // garment_category is the specific garment word ("blazer");
          // item_category reads "clothing" on anything with a vertical set,
          // which resolves to no chart at all.
          garment: r.garment_category ?? r.item_category ?? null,
          measurements: r.measurements,
        };
      }
    }
    return map;
  },
});
}

// US-2520 shrink-only ratchet: the queue's per-batch listing read, lifted out
// of autolister-queue.tsx when the row label started reading the generated
// title off the same rows (2026-09-03).
//
// One query, one cache key. The queue renders it three ways: the needs-review
// badge and its low-confidence tooltip (US-541), the price for the sort and
// the "est." badge (US-956), and now the row title itself.

import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";

export interface ListingReview {
  needsReview: boolean;
  /** Item aspects the AI scored under 0.7, for the badge tooltip. */
  fields: string[];
  price: number | null;
  /** The AI-written title. Null until generation names the draft. */
  title: string | null;
}

/**
 * Review flags, low-confidence fields, price and title for one batch's
 * generated listings, keyed by listing_id. RLS scopes the read to the owner
 * via the parent item.
 *
 * `listingIdsKey` is the id CONTENTS, not the count: a length-only cache key
 * returns the stale map when the batch's id set changes without changing size.
 */
export function useAutolisterListingReview(
  batchId: string | null,
  listingIds: string[],
  listingIdsKey: string,
) {
  return useQuery<Record<string, ListingReview>>({
    queryKey: ["autolister_listing_review", batchId, listingIdsKey],
    enabled: listingIds.length > 0,
    queryFn: async () => {
      // US-554: chunk the id list so a very large batch can't blow the URL/`in`
      // length limit (was a single unbounded .in()).
      const CHUNK = 200;
      const map: Record<string, ListingReview> = {};
      for (let i = 0; i < listingIds.length; i += CHUNK) {
        const { data: rows } = await supabase
          .from("listings")
          .select("id, needs_review, ai_field_confidence, listing_price, listing_title")
          .in("id", listingIds.slice(i, i + CHUNK));
        for (
          const r of (rows ?? []) as Array<{
            id: string;
            needs_review: boolean | null;
            ai_field_confidence: Record<string, number> | null;
            listing_price: number | null;
            listing_title: string | null;
          }>
        ) {
          const low = r.ai_field_confidence
            ? Object.entries(r.ai_field_confidence)
              // US-956: listing_price confidence rides in ai_field_confidence to
              // gate the "est." badge — it's not an item-specific aspect, so keep
              // it out of the "AI is unsure about: …" aspect tooltip.
              .filter(([name, c]) => name !== "listing_price" && c < 0.7)
              .map(([name]) => name)
            : [];
          map[r.id] = {
            needsReview: !!r.needs_review,
            fields: low,
            price: r.listing_price,
            title: r.listing_title,
          };
        }
      }
      return map;
    },
  });
}

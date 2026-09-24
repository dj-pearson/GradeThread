import { edgeFetch } from "@/lib/edge-fetch";

// INV-7 follow-up: the promote dialog's request, chunked. Kept out of the
// dialog file so that file exports only its component.

/** Ids per request; keeps the route's `.in()` read inside a URL's length. */
const PROMOTE_CHUNK = 100;

export interface BulkResult {
  listingId: string;
  ok: boolean;
  error: string | null;
}

/**
 * The route resolves the ids with one `.in()` read, which rides in the URL. A
 * select-all across pages reaches 2,000 ids, far past what a URL carries, so
 * they go PROMOTE_CHUNK at a time and the per-listing results are merged.
 */
export async function sendPromoteInChunks(
  listingIds: readonly string[],
  pct: number,
  mode: "create" | "update",
  fetcher: typeof edgeFetch = edgeFetch,
): Promise<{ succeeded: number; failed: number; results: BulkResult[] }> {
  const merged = { succeeded: 0, failed: 0, results: [] as BulkResult[] };
  let sent = 0;
  for (let i = 0; i < listingIds.length; i += PROMOTE_CHUNK) {
    const part = listingIds.slice(i, i + PROMOTE_CHUNK);
    const res = await fetcher("/api/flipdesk/ebay/marketing/ads/bulk", {
      method: "POST",
      body: JSON.stringify({ listing_ids: part, bid_percentage: pct, mode }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = json.detail || json.error || "eBay rejected the change.";
      // Earlier chunks already changed ad rates; say so rather than reading
      // as "nothing changed".
      throw new Error(
        sent > 0 ? `${msg} (${sent} of ${listingIds.length} were already sent.)` : msg,
      );
    }
    merged.succeeded += Number(json.succeeded ?? 0);
    merged.failed += Number(json.failed ?? 0);
    merged.results.push(...((json.results ?? []) as BulkResult[]));
    sent += part.length;
  }
  return merged;
}

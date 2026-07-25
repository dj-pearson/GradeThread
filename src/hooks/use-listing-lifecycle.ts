import { useMutation, useQueryClient } from "@tanstack/react-query";
import { edgeFetch } from "@/lib/edge-fetch";

// US-2166: the PLATFORM-AGNOSTIC listing lifecycle (price / end / bulk reprice).
//
// These replace the useEbay* mutations for these three actions. The eBay hooks
// still exist and are still correct for eBay-only surfaces — what was wrong was
// the LISTINGS TABLE calling them for every row regardless of platform, then
// catching the resulting 409 and writing the local `listings` row instead
// (US-2162 / US-2163). A seller was told "Listing ended locally." while the
// Shopify/Etsy/Depop listing stayed live and purchasable.
//
// The server contract these hooks rely on:
//   • the local row is only advanced when the marketplace confirmed the change
//   • a failed push is an ERROR, never a quiet local write
//   • `pushed: false` means nothing was live to push to (an unpublished draft) —
//     it does NOT mean "we gave up and saved it locally"
// So callers here must NOT add a local-write fallback. That fallback was the bug.

export interface ListingPriceResponse {
  ok: true;
  listing_id: string;
  price: number;
  /** false only when the listing was never published to a marketplace. */
  pushed: boolean;
}

export interface ListingEndResponse {
  ok: true;
  listing_id: string;
  /** false when nothing was live upstream (unpublished draft, or already gone). */
  ended_upstream?: boolean;
  already_ended?: boolean;
  note?: string;
}

export interface BulkPriceRowResult {
  listing_id: string;
  ok: boolean;
  price?: number;
  previous_price?: number | null;
  pushed?: boolean;
  error?: string;
}

export interface BulkPriceResponse {
  ok: true;
  total: number;
  succeeded: number;
  failed: number;
  results: BulkPriceRowResult[];
}

export interface BulkEndRowResult {
  listing_id: string;
  ok: boolean;
  ended_upstream?: boolean;
  already_ended?: boolean;
  error?: string;
}

export interface BulkEndResponse {
  ok: true;
  total: number;
  succeeded: number;
  failed: number;
  results: BulkEndRowResult[];
}

/** Throws an Error carrying the HTTP status, so callers can branch on 409/501. */
async function readOrThrow<T>(res: Response, fallback: string): Promise<T> {
  const json = (await res.json().catch(() => ({}))) as {
    error?: string;
    code?: string;
  };
  if (!res.ok) {
    const err: Error & { status?: number; code?: string } = new Error(
      json.error || fallback,
    );
    err.status = res.status;
    err.code = json.code;
    throw err;
  }
  return json as T;
}

/** Invalidations shared by every lifecycle mutation. */
function useLifecycleInvalidation() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["items_full"] });
    void qc.invalidateQueries({ queryKey: ["item_listing_platforms"] });
    void qc.invalidateQueries({ queryKey: ["item_listing_metrics"] });
  };
}

/** Reprice ONE listing on its own marketplace, whatever that marketplace is. */
export function useUpdateListingPrice() {
  const invalidate = useLifecycleInvalidation();
  return useMutation<
    ListingPriceResponse,
    Error & { status?: number; code?: string },
    { listingId: string; price: number }
  >({
    mutationFn: async ({ listingId, price }) => {
      const res = await edgeFetch(
        `/api/flipdesk/listings/${encodeURIComponent(listingId)}/price`,
        { method: "POST", json: { price } },
      );
      return readOrThrow<ListingPriceResponse>(res, "Price update failed.");
    },
    onSuccess: invalidate,
  });
}

/** End ONE listing on its own marketplace. */
export function useEndListing() {
  const invalidate = useLifecycleInvalidation();
  return useMutation<
    ListingEndResponse,
    Error & { status?: number; code?: string },
    { listingId: string }
  >({
    mutationFn: async ({ listingId }) => {
      const res = await edgeFetch(
        `/api/flipdesk/listings/${encodeURIComponent(listingId)}/end`,
        { method: "POST" },
      );
      return readOrThrow<ListingEndResponse>(res, "End listing failed.");
    },
    onSuccess: invalidate,
  });
}

/**
 * Reprice a SELECTION in one request — either an explicit `price` for every id,
 * or a `dropPct` the server applies to each row's own current price.
 *
 * One HTTP call, not one per listing: the old browser loop would also have
 * tripped the 30-req/60s rate limit on /api/flipdesk/listings/* at around the
 * 30th selected row.
 */
export function useBulkListingPrice() {
  const invalidate = useLifecycleInvalidation();
  return useMutation<
    BulkPriceResponse,
    Error & { status?: number },
    {
      listingIds?: string[];
      price?: number;
      dropPct?: number;
      /**
       * US-2172: per-row prices — the shape undo uses. Each row goes back to
       * its OWN former price, which no single shared price or percentage can
       * express. When present, the ids come from these entries.
       */
      items?: Array<{ listingId: string; price: number }>;
    }
  >({
    mutationFn: async ({ listingIds, price, dropPct, items }) => {
      const res = await edgeFetch("/api/flipdesk/listings/bulk-price", {
        method: "POST",
        json: {
          ...(items
            ? {
              items: items.map((i) => ({ listing_id: i.listingId, price: i.price })),
            }
            : { listing_ids: listingIds ?? [] }),
          ...(price !== undefined ? { price } : {}),
          ...(dropPct !== undefined ? { drop_pct: dropPct } : {}),
        },
      });
      return readOrThrow<BulkPriceResponse>(res, "Bulk reprice failed.");
    },
    onSuccess: invalidate,
  });
}

/**
 * US-2172: the rows a bulk reprice can be rolled back to.
 *
 * Only rows that actually SUCCEEDED and have a known previous price are
 * reversible. A row whose marketplace refused never changed, so "undoing" it
 * would push a price nobody asked for; a row with no previous_price can't be
 * restored to anything meaningful. Both are filtered out rather than guessed at.
 */
export function undoableFrom(
  res: BulkPriceResponse,
): Array<{ listingId: string; price: number }> {
  return res.results
    .filter(
      (r): r is BulkPriceRowResult & { previous_price: number } =>
        r.ok &&
        typeof r.previous_price === "number" &&
        r.previous_price > 0 &&
        // No-op rows are not worth a round trip.
        r.previous_price !== r.price,
    )
    .map((r) => ({ listingId: r.listing_id, price: r.previous_price }));
}

/**
 * End a SELECTION, each listing on its own marketplace, in one request.
 *
 * A row that could not be ended upstream comes back `ok:false` with its local
 * status untouched — an item that is still for sale keeps looking like it is
 * still for sale.
 */
export function useBulkEndListings() {
  const invalidate = useLifecycleInvalidation();
  return useMutation<
    BulkEndResponse,
    Error & { status?: number },
    { listingIds: string[] }
  >({
    mutationFn: async ({ listingIds }) => {
      const res = await edgeFetch("/api/flipdesk/listings/bulk-end", {
        method: "POST",
        json: { listing_ids: listingIds },
      });
      return readOrThrow<BulkEndResponse>(res, "Bulk end failed.");
    },
    onSuccess: invalidate,
  });
}

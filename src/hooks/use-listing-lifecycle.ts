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
  /**
   * US-9202: the listing is live on an extension channel, so the price was
   * saved here and the desktop extension applies it there. Until it confirms,
   * the marketplace still shows the old price and the row says "Stale".
   */
  queued?: boolean;
}

export interface ListingEndResponse {
  ok: true;
  listing_id: string;
  /** false when nothing was live upstream (unpublished draft, or already gone). */
  ended_upstream?: boolean;
  already_ended?: boolean;
  /**
   * US-2162: the marketplace has no end-listing API, so the row is stamped for
   * the Lister extension to end in the seller's own browser. The listing is
   * STILL LIVE until then — `ended_upstream` is false and the copy must say so.
   */
  queued?: boolean;
  note?: string;
}

export interface BulkPriceRowResult {
  listing_id: string;
  ok: boolean;
  price?: number;
  previous_price?: number | null;
  pushed?: boolean;
  /** US-9202: live on an extension channel; the desktop extension applies it. */
  queued?: boolean;
  error?: string;
}

export interface BulkPriceResponse {
  ok: true;
  total: number;
  succeeded: number;
  failed: number;
  /** US-9202: successes waiting on the desktop extension. */
  queued?: number;
  results: BulkPriceRowResult[];
}

export interface BulkEndRowResult {
  listing_id: string;
  ok: boolean;
  ended_upstream?: boolean;
  already_ended?: boolean;
  /** US-2162: queued for the Lister extension; still live until it runs. */
  queued?: boolean;
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
/**
 * US-2163 (AC2): how many listings ride in one bulk-price request.
 *
 * Matches the 25-per-call chunking /listings/bulk-price-quantity already uses.
 * The point is not the server's comfort — it processes rows sequentially either
 * way — it is that a chunk boundary is the only place a long batch can report
 * progress or be cancelled. One request for 100 listings is a black box; four
 * requests of 25 is four progress ticks and three chances to stop.
 *
 * It is still nothing like the old per-listing loop: 100 listings cost 4
 * requests, comfortably inside the 30-per-60s limit on /api/flipdesk/listings/*
 * that the loop used to trip around row 30.
 */
export const BULK_PRICE_CHUNK_SIZE = 25;

/** Split ids into BULK_PRICE_CHUNK_SIZE-sized chunks. Pure, so it is testable. */
export function chunkForBulkPrice<T>(
  items: readonly T[],
  size = BULK_PRICE_CHUNK_SIZE,
): T[][] {
  if (size < 1) return items.length > 0 ? [[...items]] : [];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/** Merge per-chunk responses into the single result the UI reports. */
export function mergeBulkPriceResponses(
  parts: readonly BulkPriceResponse[],
): BulkPriceResponse {
  const results = parts.flatMap((p) => p.results);
  return {
    ok: true,
    // Counts are recomputed from the merged rows rather than summed from the
    // parts, so a cancelled batch reports what actually happened instead of a
    // total that includes chunks never sent.
    total: results.length,
    succeeded: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    queued: results.filter((r) => r.ok && r.queued).length,
    results,
  };
}

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

// ── Bulk resubmit (US-2404) ─────────────────────────────────────────

export interface BulkReviseRowResult {
  listing_id: string;
  ok: boolean;
  status: number;
  error?: string;
  /** e.g. "not_an_ebay_listing" — set when the server named a reason code. */
  code?: string;
}

export interface BulkReviseResponse {
  ok: true;
  requested: number;
  pushed: number;
  failed: number;
  results: BulkReviseRowResult[];
}

/**
 * Per-request cap. Mirrors MAX_BULK_REVISE_ITEMS on the server, which is lower
 * than the bulk-price cap because a revise is several eBay API calls per
 * listing. A larger selection is split into this many ids per request, which is
 * also what gives the seller a progress tick and a chance to stop.
 */
export const BULK_REVISE_CHUNK_SIZE = 25;

/** Split ids into BULK_REVISE_CHUNK_SIZE-sized chunks. Pure, so it is testable. */
export function chunkForBulkRevise<T>(
  items: readonly T[],
  size = BULK_REVISE_CHUNK_SIZE,
): T[][] {
  if (size < 1) return items.length > 0 ? [[...items]] : [];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/** Merge chunked responses into one, preserving every per-row result. */
export function mergeBulkReviseResponses(
  parts: readonly BulkReviseResponse[],
): BulkReviseResponse {
  const results = parts.flatMap((p) => p.results ?? []);
  const pushed = results.filter((r) => r.ok).length;
  return {
    ok: true,
    requested: results.length,
    pushed,
    failed: results.length - pushed,
    results,
  };
}

/**
 * One line of plain English for the toast. Deliberately does NOT say "pushed"
 * unless a row actually was: reporting a refusal as a success is the defect
 * US-2163 removed from bulk price, and the same shape would be worse here —
 * a seller would believe eBay is showing edits it never received.
 */
export function describeBulkRevise(res: BulkReviseResponse): string {
  const { pushed, failed } = res;
  if (failed === 0) {
    return pushed === 1
      ? "1 listing resubmitted to eBay."
      : `${pushed} listings resubmitted to eBay.`;
  }
  if (pushed === 0) {
    return failed === 1
      ? "eBay refused the update. Nothing was changed."
      : `eBay refused all ${failed} updates. Nothing was changed.`;
  }
  return `${pushed} resubmitted, ${failed} refused by eBay — open those to see why.`;
}

/**
 * Resubmit a SELECTION of live eBay listings: re-assert what is already saved
 * in GradeThread (item specifics, category, condition, photos) against each live
 * listing. The bulk-bar equivalent of the composer's "Save & resubmit to eBay".
 *
 * Chunked, and the chunks run in SEQUENCE — a revise is several eBay API calls
 * per listing, so overlapping them is how you meet a rate limit.
 */
export function useBulkReviseListings() {
  const invalidate = useLifecycleInvalidation();
  return useMutation<
    BulkReviseResponse,
    Error & { status?: number },
    { listingIds: string[]; onProgress?: (done: number, total: number) => void }
  >({
    mutationFn: async ({ listingIds, onProgress }) => {
      const chunks = chunkForBulkRevise(listingIds);
      const parts: BulkReviseResponse[] = [];
      let done = 0;
      for (const chunk of chunks) {
        const res = await edgeFetch("/api/flipdesk/ebay/listings/bulk-revise", {
          method: "POST",
          json: { listing_ids: chunk },
        });
        parts.push(await readOrThrow<BulkReviseResponse>(res, "Bulk resubmit failed."));
        done += chunk.length;
        onProgress?.(done, listingIds.length);
      }
      return mergeBulkReviseResponses(parts);
    },
    onSuccess: invalidate,
  });
}

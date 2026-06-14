// Bulk-publish orchestration (US-1046) — PURE, dependency-injected so it's fully
// unit-testable without touching the network.
//
// eBay bulk endpoints take ≤25 items/call and return a per-item responses[].
// This module chunks a large set into ≤25 batches, calls the injected bulk fn,
// normalizes each item's outcome, and — when a whole batch CALL throws (network
// / 5xx / rate-limit after retries) — falls back to the injected single-item fn
// so one bad batch never sinks the rest. Per-item success/failure is always
// reported (AC2).

import { EBAY_BULK_MAX } from "./ebay-client.ts";
import type { BulkResponseEntry } from "./ebay-client.ts";

export function chunk<T>(arr: T[], size: number): T[][] {
  if (size < 1) return [arr];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export interface BulkItemResult {
  key: string; // offerId or sku — whatever identifies the item
  ok: boolean;
  listingId?: string;
  error?: string;
}

// ── Bulk price/quantity (US-1046 clean surface) ─────────────────────

export interface PriceQtyUpdate {
  sku: string;
  offerId: string;
  priceValue?: number; // dollars; omitted = leave price unchanged
  quantity?: number; // omitted = leave quantity unchanged
  currency?: string;
}

/// Build one `bulk_update_price_quantity` request entry. Pure + unit-tested.
/// Price rides the offer; quantity updates both the offer's availableQuantity
/// and the SKU's ship-to-location availability so the live listing reflects it.
export function buildPriceQtyRequest(u: PriceQtyUpdate): Record<string, unknown> {
  const offer: Record<string, unknown> = { offerId: u.offerId };
  if (u.quantity != null) offer.availableQuantity = u.quantity;
  if (u.priceValue != null) {
    offer.price = { value: u.priceValue.toFixed(2), currency: u.currency ?? "USD" };
  }
  const req: Record<string, unknown> = { sku: u.sku, offers: [offer] };
  if (u.quantity != null) {
    req.shipToLocationAvailability = { quantity: u.quantity };
  }
  return req;
}

// eBay marks success with 200/201; anything else (or an errors[] entry) fails.
function entryOk(e: BulkResponseEntry): boolean {
  const code = e.statusCode ?? 0;
  return code >= 200 && code < 300 && !(e.errors && e.errors.length > 0);
}

// Normalize one raw eBay bulk response entry → BulkItemResult. `key` falls back
// across the id fields eBay uses per endpoint (offerId for publish, sku for
// inventory). Pure.
export function normalizeBulkEntry(
  e: BulkResponseEntry,
  fallbackKey = "",
): BulkItemResult {
  const key = e.offerId ?? e.sku ?? fallbackKey;
  if (entryOk(e)) {
    return { key, ok: true, listingId: e.listingId };
  }
  const error = e.errors?.map((x) => x.message).filter(Boolean).join("; ") ||
    `eBay status ${e.statusCode ?? "unknown"}`;
  return { key, ok: false, error };
}

export interface BulkPublishDeps {
  // Publish a batch of ≤BULK_MAX offer ids; returns eBay's raw responses[].
  publishBatch: (offerIds: string[]) => Promise<BulkResponseEntry[]>;
  // Fallback: publish one offer; resolves to its listingId or throws.
  publishOne: (offerId: string) => Promise<string>;
  batchSize?: number;
}

// Publish many offers using bulk calls, chunked + with single-item fallback when
// a batch call throws. Always returns one BulkItemResult per input offer id.
export async function bulkPublishWithFallback(
  offerIds: string[],
  deps: BulkPublishDeps,
): Promise<BulkItemResult[]> {
  const size = Math.min(deps.batchSize ?? EBAY_BULK_MAX, EBAY_BULK_MAX);
  const results: BulkItemResult[] = [];

  for (const batch of chunk(offerIds, size)) {
    let entries: BulkResponseEntry[] | null = null;
    try {
      entries = await deps.publishBatch(batch);
    } catch {
      entries = null; // whole-batch failure → fall back per item below
    }

    if (entries) {
      // Map eBay's responses back to the requested ids by position when the
      // entry omits an offerId.
      batch.forEach((offerId, i) => {
        const e = entries![i] ?? {};
        results.push(normalizeBulkEntry({ offerId, ...e }, offerId));
      });
      continue;
    }

    // Batch-level failure: try each offer individually so a single bad/oversized
    // item or a transient batch error doesn't drop the whole chunk.
    for (const offerId of batch) {
      try {
        const listingId = await deps.publishOne(offerId);
        results.push({ key: offerId, ok: true, listingId });
      } catch (err) {
        results.push({
          key: offerId,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  return results;
}

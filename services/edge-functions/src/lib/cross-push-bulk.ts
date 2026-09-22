// US-3456: bulk cross-list, the pure half.
//
// "Select forty garments, choose the marketplaces, press one button." The
// fan-out itself is crossPushPlatform (lib/cross-push.ts), one call per item
// per platform, with its own already-live and already-queued skips; this
// module decides WHAT that loop runs over and how the result reads back.
//
// eBay is refused here on purpose. eBay is the source row every other
// channel copies (channel-copy.ts), it has its own durable publish batch
// (listing_publish_batches, US-1113) with progress a page already renders,
// and running it through a per-item fan-out would put forty eBay publishes on
// one request with no reclaim behind them. The web sends eBay to the batch
// it already has and the rest here.

import { isCrossListingPlatform, type CrossListingPlatform } from "./marketplace-adapters/types.ts";

/** Items per request. Forty garments is a bulk day; a hundred is a cap, not a target. */
export const MAX_BULK_CROSS_PUSH_ITEMS = 100;

/** A batch label the seller reads back in the queue; bounded so it is a label. */
export const MAX_BATCH_LABEL_LENGTH = 60;

export interface BulkPlan {
  itemIds: string[];
  platforms: CrossListingPlatform[];
  /** The one-line reason the request cannot run at all, or null. */
  refused: string | null;
  /** Ids dropped as duplicates or past the cap, counted so the response can say so. */
  droppedItems: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Dedupe both lists, drop malformed ids, refuse eBay and unknown platforms,
 * and cap the item count. Pure.
 */
export function planBulkCrossPush(rawItemIds: unknown, rawPlatforms: unknown): BulkPlan {
  const items = Array.isArray(rawItemIds)
    ? rawItemIds.filter((v): v is string => typeof v === "string" && UUID.test(v))
    : [];
  const uniqueItems = [...new Set(items)];
  const itemIds = uniqueItems.slice(0, MAX_BULK_CROSS_PUSH_ITEMS);

  const platforms: CrossListingPlatform[] = [];
  let refused: string | null = null;
  if (!Array.isArray(rawPlatforms) || rawPlatforms.length === 0) {
    refused = "platforms must be a non-empty array.";
  } else {
    for (const p of rawPlatforms) {
      if (typeof p !== "string" || !isCrossListingPlatform(p)) {
        refused = `Unsupported platform: ${String(p)}.`;
        break;
      }
      if (p === "ebay") {
        refused = "eBay publishes through its own batch (POST /api/flipdesk/autolister/publish-batch), not here.";
        break;
      }
      if (!platforms.includes(p)) platforms.push(p);
    }
  }
  if (!refused && itemIds.length === 0) refused = "item_ids must name at least one item.";

  return {
    itemIds,
    platforms,
    refused,
    droppedItems: Math.max(0, (Array.isArray(rawItemIds) ? rawItemIds.length : 0) - itemIds.length),
  };
}

/** The label as stored on every queue row of the batch, or null for none. */
export function batchLabelFor(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.replace(/\s+/g, " ").trim();
  if (!trimmed) return null;
  return trimmed.slice(0, MAX_BATCH_LABEL_LENGTH);
}

export type BulkRowOutcome =
  | "published"
  | "queued"
  | "already_live"
  | "already_queued"
  | "no_source"
  | "not_found"
  | "blocked";

export interface BulkRow {
  item_id: string;
  platform: CrossListingPlatform;
  outcome: BulkRowOutcome;
  listing_row_id: string | null;
  listing_url: string | null;
  error: string | null;
}

export interface BulkSummary {
  rows: number;
  published: number;
  queued: number;
  skipped: number;
  noSource: number;
  notFound: number;
  blocked: number;
}

/** Counts by outcome, the shape both clients toast from. Pure. */
export function summarizeBulkRows(rows: readonly BulkRow[]): BulkSummary {
  const out: BulkSummary = { rows: rows.length, published: 0, queued: 0, skipped: 0, noSource: 0, notFound: 0, blocked: 0 };
  for (const r of rows) {
    switch (r.outcome) {
      case "published": out.published += 1; break;
      case "queued": out.queued += 1; break;
      case "already_live":
      case "already_queued": out.skipped += 1; break;
      case "no_source": out.noSource += 1; break;
      case "not_found": out.notFound += 1; break;
      case "blocked": out.blocked += 1; break;
    }
  }
  return out;
}

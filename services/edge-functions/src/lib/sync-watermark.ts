// US-2320: deciding where an incremental sync's cursor may safely move to.
//
// The eBay orders pass wrapped everything in a catch that logged and carried
// on, then fell through to an UNCONDITIONAL `last_synced_at = now()`. So a
// seller with 500 modified orders, where eBay 500s at order 200, kept orders
// 1-199 and lost 200-500 — and the cursor now said "now", so the next
// incremental pull asked eBay only for orders modified since then. The 301
// missing orders were never re-fetched by anything: their sales rows, payouts,
// net_profit and the inventory_items.status='sold' flip are simply gone. The
// HTTP response was already 202 {ok:true} and the UI said "Synced just now".
// The backstop cron cannot recover it either, because it selects stale owners
// by that same last_synced_at.
//
// Shopify gets this right (flipdesk-shopify.ts gates the watermark on
// ingest.ok), and the AC asks for that shape. This module is the decision
// itself, pulled out so it is unit-testable and cannot quietly regress:
//
//   • The FETCH was incomplete (a throw mid-paging, or the page ceiling) →
//     do not advance AT ALL. We do not know what we did not see, so there is
//     no safe value; only re-asking the same window can find out.
//   • The fetch completed but some orders failed to persist → rewind to the
//     EARLIEST failure. Everything from that instant onward is re-pulled, and
//     the orders before it are already written. eBay's date filter is
//     inclusive, so handing back the failed order's own timestamp re-fetches
//     it.
//   • Everything landed → advance to now(), which is what it always did.
//
// Rewinding rather than freezing matters: freezing on any per-order failure
// means one permanently-malformed order stalls the cursor forever and the
// seller re-pulls the whole 90-day window on every sync until someone notices.

export interface FailedOrder {
  orderId: string;
  /** eBay's lastModifiedDate for this order. Null when it never reported one. */
  lastModifiedDate: string | null;
}

export type WatermarkPlan =
  | { advance: false; reason: "fetch_incomplete" | "undatable_failure" }
  | { advance: true; to: string; reason: "clean" | "rewound" };

export interface WatermarkInput {
  /** False when the order fetch threw, or stopped at the page ceiling. */
  fetchComplete: boolean;
  /** Orders we fetched but did not fully persist. */
  failedOrders: FailedOrder[];
  /** The timestamp a clean pass advances to. */
  now: string;
}

export function planOrdersWatermark(input: WatermarkInput): WatermarkPlan {
  if (!input.fetchComplete) {
    return { advance: false, reason: "fetch_incomplete" };
  }
  if (input.failedOrders.length === 0) {
    return { advance: true, to: input.now, reason: "clean" };
  }

  // A failure we cannot place in time is a failure we cannot rewind to. Freeze
  // instead — a stalled cursor is visible in the sync run and re-pulls a window
  // we already have; a wrongly-advanced one loses orders silently and forever.
  let earliest = Number.POSITIVE_INFINITY;
  for (const f of input.failedOrders) {
    const t = Date.parse(f.lastModifiedDate ?? "");
    if (!Number.isFinite(t)) return { advance: false, reason: "undatable_failure" };
    if (t < earliest) earliest = t;
  }

  const nowMs = Date.parse(input.now);
  // Defensive: a clock skew or a bogus future lastModifiedDate must never push
  // the cursor PAST now, which would skip everything modified in between.
  if (Number.isFinite(nowMs) && earliest > nowMs) {
    return { advance: true, to: input.now, reason: "rewound" };
  }
  return { advance: true, to: new Date(earliest).toISOString(), reason: "rewound" };
}

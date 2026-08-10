// Cross-channel quantity sync — delist on sale across marketplaces (US-1290).
//
// When a garment in a cross-listing group (rows sharing listings.draft_id) sells
// on one marketplace, its still-live siblings on the OTHER marketplaces must be
// pulled so the same physical item can't be sold twice (the #1 reseller pain:
// overselling). This module owns the PURE decision over a group's sibling rows:
//   • toDelist — still-live siblings to end via their platform adapter.
//   • oversold — siblings ALREADY sold on another channel: a SIMULTANEOUS-SALE
//     conflict that must be SURFACED to the seller, never silently resolved
//     (US-1290 AC3). We never auto-end or auto-pick a "winner" between two real
//     sales of one physical item — only the seller can decide which order to
//     cancel.
//
// The impure execution (calling each platform's delist API + persisting +
// surfacing the conflict) lives in cross-listings.ts, which consumes this
// planner. Keeping the decision pure makes the delist/oversell semantics
// unit-testable with no DB (mirrors the shopify-orders / drip-graph split).

// How a platform's live listing is ended when a sibling sells. Mirrors the
// per-platform branches executed in cross-listings.ts.
export type DelistMethod =
  | "ebay_api" // withdrawOffer (Sell Inventory API)
  | "shopify_api" // productDelete (Admin GraphQL)
  | "depop_api" // deleteDepopProduct (SKU-addressed)
  | "etsy_api" // setEtsyListingState → 'inactive' (US-2164; 404 = already gone)
  | "extension" // Poshmark/Mercari/Grailed/Vinted/Facebook — no server write
  // API; queued for the GradeThread Lister browser extension
  // (delist_requested_at)
  //
  // US-2165: 'unsupported' NO LONGER means "quietly end the local row". A
  // platform with no delist channel leaves the listing live on its
  // marketplace, so cross-listings.ts now stamps a durable
  // platform_fields.delist_unresolved marker and notifies the seller. Adding a
  // platform to CROSS_LISTING_PLATFORMS without a delist path therefore fails
  // LOUDLY instead of silently overselling.
  | "unsupported";

const API_DELIST: Record<string, DelistMethod> = {
  ebay: "ebay_api",
  shopify: "shopify_api",
  depop: "depop_api",
  // US-2164: Etsy has a real delist API and the adapter already used it for a
  // manual end — auto-end was the one path that skipped it, so an Etsy sibling
  // stayed live and purchasable after the garment sold elsewhere.
  etsy: "etsy_api",
  // whatnot is deliberately ABSENT: its listing path is still 501 pending
  // US-1662, so there is nothing to call. It resolves to 'unsupported' and now
  // gets the US-2165 marker rather than a silent local end.
};

// Marketplaces ended through the GradeThread Lister extension (US-716) rather
// than a server-side API. Keep in sync with LISTER_EXTENSION_PLATFORMS (src/lib).
export const EXTENSION_DELIST_PLATFORMS = new Set([
  "poshmark",
  "mercari",
  "grailed",
  // US-2479 / US-2480. Both were advertised (Vinted as tier `extension`,
  // Facebook about to be) with no entry here, so delistMethodFor resolved them
  // to 'unsupported' — which since US-2165 means the sibling is left LIVE on its
  // marketplace with a delist_unresolved marker. For the two highest-volume
  // channels a seller cross-lists to, that is the oversell this whole module
  // exists to prevent, arriving through the one door nobody had closed.
  "vinted",
  "facebook",
]);

// Pure: how the given platform is delisted on a sibling sale.
export function delistMethodFor(platform: string): DelistMethod {
  const api = API_DELIST[platform];
  if (api) return api;
  if (EXTENSION_DELIST_PLATFORMS.has(platform)) return "extension";
  return "unsupported";
}

// Statuses that mean a sibling is still live and should be pulled on a sale.
const LIVE_STATUSES = new Set(["draft", "active"]);

export interface CrossListingSibling {
  id: string;
  platform: string;
  listing_status: string;
}

export interface CrossListingSalePlan<T extends CrossListingSibling> {
  /** Still-live siblings to end so the garment can't sell twice. */
  toDelist: T[];
  /**
   * Siblings ALREADY sold on another channel — a simultaneous-sale oversell
   * that must be surfaced, never auto-resolved.
   */
  oversold: T[];
}

// Pure: partition a cross-listing group's siblings (the just-sold listing is
// excluded by id) into the ones to delist and the ones that reveal an oversell.
// Does not mutate inputs. Siblings already 'ended' (or any other non-live,
// non-sold status) need no action — they're neither live nor a double sale.
export function planCrossListingSale<T extends CrossListingSibling>(
  soldListingId: string,
  siblings: readonly T[],
): CrossListingSalePlan<T> {
  const toDelist: T[] = [];
  const oversold: T[] = [];
  for (const sib of siblings) {
    if (sib.id === soldListingId) continue;
    if (sib.listing_status === "sold") {
      oversold.push(sib);
    } else if (LIVE_STATUSES.has(sib.listing_status)) {
      toDelist.push(sib);
    }
  }
  return { toDelist, oversold };
}

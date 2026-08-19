// US-9117: the seam between a lib and the repricing paths.
//
// The bulk preview, the bulk apply and the two per-suggestion verbs live in
// routes/flipdesk-pricing.ts, wrapped around helpers that the repricing CRON
// also uses (computeListingSuggestion, loadOwnedRepriceListings, the comp
// engine). Pulling those out would mean deciding what the cron keeps, which is
// a bigger change than the connector needs.
//
// So the route registers, the same way lib/ebay-publish-port.ts and
// lib/autolister-enqueue.ts do. Each registered function is the SAME body the
// HTTP handler runs -- the handlers were rewritten to call them -- so a tool
// and the dashboard cannot drift into pricing a listing differently.
//
// ⚠ THE MONEY RULE THIS PRESERVES: apply pushes to eBay FIRST and writes the
// local price only if that succeeded (US-467). A local write after a failed
// remote update leaves the seller's price disagreeing with the live listing,
// which nothing surfaces. Any future implementation of these functions must
// keep that order.

/** One row of a bulk reprice preview, before anything is written. */
export interface RepriceRow {
  listing_id: string;
  inventory_item_id: string;
  title: string;
  current_price_cents: number;
  suggested_price_cents: number;
  delta_cents: number;
  comp_count: number;
  comp_median_cents: number | null;
  reason_code: string;
  margin_floor_cents: number | null;
  /** null when appliable; otherwise why it is excluded. */
  skip: string | null;
}

export interface RepricePreviewResult {
  items: RepriceRow[];
  /** True when the selection was trimmed to the per-call cap. */
  capped: boolean;
}

export interface RepriceApplyResult {
  applied: number;
  ebay_synced: number;
  skipped: Array<{ listing_id: string; reason: string }>;
  errors: Array<{ listing_id: string; message: string }>;
}

/** The shape a status/body handler returns, for the two per-suggestion verbs. */
export interface PricingOutcome {
  status: number;
  body: Record<string, unknown>;
}

interface Repricer {
  preview: (ownerId: string, listingIds: string[]) => Promise<RepricePreviewResult>;
  apply: (
    ownerId: string,
    items: Array<{ listing_id: string; price_cents: number }>,
  ) => Promise<RepriceApplyResult>;
  applySuggestion: (ownerId: string, suggestionId: string) => Promise<PricingOutcome>;
  dismissSuggestion: (ownerId: string, suggestionId: string) => Promise<PricingOutcome>;
}

let repricer: Repricer | null = null;

/** Called by routes/flipdesk-pricing.ts at module load. */
export function registerRepricer(impl: Repricer): void {
  repricer = impl;
}

/**
 * The registered repricer, or null.
 *
 * Null means the route module was never imported. A caller must refuse rather
 * than report success -- repricing nothing and saying it worked is the worst
 * available outcome for a seller watching their store.
 */
export function repricerImpl(): Repricer | null {
  return repricer;
}

export function hasRepricer(): boolean {
  return repricer !== null;
}

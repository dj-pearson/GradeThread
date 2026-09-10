import type { Run } from "@/lib/latest-run";
import type { EbayShippingQuote, EbayShippingRate } from "@/hooks/use-ebay";

// US-3223. What "Buy label" sends is the quote id and rate id that a rate-shop
// left in state, so a stale rate-shop is money: eBay charges for the parcel the
// quote describes, not the one on screen.
//
// The interleaving: "Get rates" is disabled while the rate call is pending, but
// fetchRates does a sales lookup FIRST, and the button is live for that whole
// round trip. Type 1 lb, click, change to 5 lb, click again — two quotes in
// flight. The 1 lb quote resolves last, so the dialog lists 1 lb rates and holds
// a 1 lb quote id while the weight box says 5 lb, and Buy purchases postage for
// a parcel that weighs five times what was paid for.

export interface RateQuotePatch {
  quoteId: string;
  rateOptions: EbayShippingRate[];
  selectedRateId: string | null;
}

/**
 * The cheapest rate that actually carries a price. eBay returns rates with a
 * null total (a service it can quote but not price here); preselecting one of
 * those would put an unbuyable row under the Buy button.
 */
export function cheapestPricedRate(
  rates: EbayShippingRate[],
): EbayShippingRate | null {
  return rates
    .filter((r) => r.totalCostCents != null)
    .reduce<EbayShippingRate | null>(
      (best, r) =>
        best == null || r.totalCostCents! < best.totalCostCents! ? r : best,
      null,
    );
}

/**
 * The patch a rate quote should apply, or null when a newer rate-shop has taken
 * ownership and this quote must be dropped.
 */
export function acceptRateQuote(
  run: Run,
  quote: EbayShippingQuote,
): RateQuotePatch | null {
  if (run.superseded) return null;
  return {
    quoteId: quote.shippingQuoteId,
    rateOptions: quote.rates,
    // Preselect the cheapest KNOWN price so the common case is one click — but
    // never auto-buy; the seller still confirms.
    selectedRateId: cheapestPricedRate(quote.rates)?.rateId ?? null,
  };
}

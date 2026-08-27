// US-2941: the three numbers a seller needs to answer an offer in ten seconds.
//
// The offers list showed a price and nothing else, so deciding meant opening
// the item in another tab to find out what it cost and what it was listed at.
// At any volume that is the whole bottleneck, and offers expire.
//
// ── SHARED WITH THE RULES ENGINE ON PURPOSE ─────────────────────────────────
//
// `grossMarginCents` is the same arithmetic the edge's decideOffer margin floor
// applies. The number the seller reads and the number the automation acts on
// must not be able to differ — a rule that skips an offer the screen shows as
// profitable is a rule the seller will switch off and never trust again.
//
// ── UNKNOWN IS NOT ZERO ─────────────────────────────────────────────────────
//
// Every function here returns null rather than a number when an input is
// missing. An item with no recorded cost has an UNKNOWN margin, and rendering
// that as $0.00 or as 100% is a confident lie next to an Accept button.

export interface OfferEconomicsInput {
  /** The buyer's offer, in dollars. */
  offerPrice: number | null | undefined;
  /** What the listing was asking when the offer landed, in dollars. */
  listPrice: number | null | undefined;
  /** Acquisition cost in dollars, or null when the item has none recorded. */
  itemCost: number | null | undefined;
}

function usable(n: number | null | undefined): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

/** The offer as a percent of the asking price, to 0.1. Null when unknowable. */
export function pctOfList(input: OfferEconomicsInput): number | null {
  if (!usable(input.offerPrice) || !usable(input.listPrice)) return null;
  return Math.round((input.offerPrice / input.listPrice) * 1000) / 10;
}

/** Gross margin over acquisition cost, in cents. Null when the cost is unknown. */
export function grossMarginCents(input: OfferEconomicsInput): number | null {
  if (!usable(input.offerPrice) || !usable(input.itemCost)) return null;
  return Math.round((input.offerPrice - input.itemCost) * 100);
}

/** That margin as a percent of the offer, to 0.1. Null when the cost is unknown. */
export function marginPct(input: OfferEconomicsInput): number | null {
  const cents = grossMarginCents(input);
  if (cents == null || !usable(input.offerPrice)) return null;
  return Math.round((cents / (input.offerPrice * 100)) * 1000) / 10;
}

export type ExpiryUrgency = "expired" | "last_hours" | "today" | "later";

export interface ExpiryReading {
  urgency: ExpiryUrgency;
  /** Whole hours left. Negative once it has passed. */
  hoursLeft: number;
  label: string;
}

/**
 * How long is left on an offer.
 *
 * HOURS, not days, and that is the point: eBay offers commonly run 48 hours, so
 * a day-granularity countdown spends half its life saying "1d left" on
 * something that expires before lunch. `last_hours` is under two hours, which
 * is the band where a seller should stop what they are doing.
 *
 * Returns null for a missing or unreadable date rather than inventing urgency —
 * the same rule the post-sale deadline badge follows.
 */
export function readExpiry(
  expiresAt: string | null | undefined,
  now: number = Date.now(),
): ExpiryReading | null {
  if (!expiresAt) return null;
  const at = Date.parse(expiresAt);
  if (!Number.isFinite(at)) return null;
  const hoursLeft = Math.floor((at - now) / 3_600_000);
  if (hoursLeft < 0) return { urgency: "expired", hoursLeft, label: "Expired" };
  if (hoursLeft < 2) {
    return {
      urgency: "last_hours",
      hoursLeft,
      label: hoursLeft <= 0 ? "Under an hour left" : "Under 2 hours left",
    };
  }
  if (hoursLeft < 24) {
    return { urgency: "today", hoursLeft, label: `${hoursLeft}h left` };
  }
  const days = Math.floor(hoursLeft / 24);
  return { urgency: "later", hoursLeft, label: `${days}d left` };
}

/** Money, for display. */
export function formatMoney(cents: number, currency = "USD"): string {
  const symbol = currency === "USD" ? "$" : `${currency} `;
  const sign = cents < 0 ? "-" : "";
  return `${sign}${symbol}${Math.abs(cents / 100).toFixed(2)}`;
}

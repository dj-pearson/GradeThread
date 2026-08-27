// US-2932: what a "keep the item" partial refund is worth offering.
//
// On low-value apparel a return frequently costs the seller more than the sale
// made. The buyer posts it back at the seller's expense, the garment comes home
// used, and it has to be relisted. A partial refund that leaves the item with
// the buyer can be strictly cheaper for both sides — but only up to a point,
// and nothing in FlipDesk computed that point, so the choice was made by feel.
//
// ── THE ARITHMETIC, WHICH THE UI ALSO SHOWS ─────────────────────────────────
//
// Take the return:  refund the sale price, pay return shipping, get the item
//                   back. Relative to keeping the money that is
//                   `acquiredPrice - salePrice - returnShipping`.
// Offer a partial:  refund P, the buyer keeps the item. That is `-P`.
//
// The partial is the better deal while `P < salePrice - acquiredPrice +
// returnShipping`. That expression is the CEILING, not the suggestion — offering
// the ceiling makes the seller exactly indifferent, which is a bad opening bid
// and leaves no room to move.
//
// ── WHAT IT WILL NOT DO ─────────────────────────────────────────────────────
//
// It returns null rather than a number whenever it is guessing: no sale price,
// no acquisition cost, or a ceiling at or below zero (the item is worth more
// back than the discount would save). A suggestion built on an unknown cost is
// a confident number with nothing behind it, and this one is attached to a
// button that moves money.

/**
 * Estimated cost of getting a garment posted back, in cents.
 *
 * A single flat figure, and named rather than inlined so the UI can say what it
 * assumed. It is not a quote: FlipDesk does not buy the return label and eBay
 * does not tell us what it cost until after the fact. US-2380 (the
 * sell.logistics scope) is what would turn this into a real rate.
 */
export const ESTIMATED_RETURN_SHIPPING_CENTS = 800;

/** How much of the ceiling to actually suggest. Leaves room to negotiate up. */
const SUGGESTION_FRACTION = 0.6;

export interface KeepItInputs {
  /** What the buyer paid, in cents. */
  salePriceCents: number | null;
  /** What the seller paid for the garment, in cents. */
  acquiredPriceCents: number | null;
  returnShippingCents?: number;
}

export interface KeepItSuggestion {
  /** What to offer, in cents. */
  suggestedCents: number;
  /** The most that is still cheaper than taking the return, in cents. */
  ceilingCents: number;
  returnShippingCents: number;
}

/**
 * Suggest a keep-it partial refund, or null when the inputs cannot support one.
 *
 * Pure. Rounds the suggestion DOWN to a whole currency unit — a seller reads
 * "$14" as a decision and "$13.87" as a calculation they now have to check.
 */
export function suggestKeepItRefund(inputs: KeepItInputs): KeepItSuggestion | null {
  const { salePriceCents, acquiredPriceCents } = inputs;
  const returnShippingCents = inputs.returnShippingCents ?? ESTIMATED_RETURN_SHIPPING_CENTS;
  if (salePriceCents == null || acquiredPriceCents == null) return null;
  if (!Number.isFinite(salePriceCents) || !Number.isFinite(acquiredPriceCents)) return null;
  if (salePriceCents <= 0) return null;

  const ceilingCents = salePriceCents - acquiredPriceCents + returnShippingCents;
  // Ceiling at or below zero: the garment is worth more back than any discount
  // saves, so there is no partial worth offering. Say nothing rather than
  // suggest a token amount that makes the seller worse off.
  if (ceilingCents <= 0) return null;

  const raw = Math.floor((ceilingCents * SUGGESTION_FRACTION) / 100) * 100;
  // Never suggest the whole sale: a full refund through this path leaves the
  // return sitting open, which is a different and worse outcome than closing it.
  const suggestedCents = Math.min(Math.max(raw, 100), salePriceCents - 100);
  if (suggestedCents <= 0) return null;

  return { suggestedCents, ceilingCents, returnShippingCents };
}

/** Whole dollars, for the sentence that explains the number. */
export function centsToDisplay(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

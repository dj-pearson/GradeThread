// US-2739: the unit boundary between FlipDesk's money and a marketplace's own
// price input.
//
// MIRRORED, character for character below the header, at
// services/edge-functions/src/lib/marketplace-price.ts. The edge and the SPA
// share no module graph, so the same rule has to exist twice; the two copies
// are pinned token-for-token by src/test/marketplace-price-mirror.test.ts, the
// same arrangement aspect-normalize and orderedListPhotos already use.
//
// WHERE THE BOUNDARY IS. FlipDesk holds money as DOLLARS: `listings.listing_price`
// and `platform_fields[platform].price` are both numeric dollar amounts. A
// marketplace's price field has its own units, and they are not always ours.
// Poshmark's listing-price input is inputmode="numeric" pattern="[0-9]*" —
// digits only, no decimal point — because Poshmark prices in whole dollars.
// "32.49" is not a value that field can hold. Vinted is the same (US-2742).
//
// The boundary is the moment a FlipDesk number becomes the keystrokes the
// extension types. That is `marketplacePriceString` for the two builders of the
// `list` payload, and `stepPrice` for the revise payload and the Listing Kit
// row (both of which carry a number rather than a string). Every one of them
// goes through this file, so there is exactly one place that knows a
// marketplace's units, and `MarketplaceSpec.priceStep` is the one place that
// knows which marketplace has which.
//
// WHY THE MATHS IS IN CENTS. `Math.round(dollars / step) * step` is float
// arithmetic on money: with a fractional step it produces 32.450000000000003,
// which is a string no numeric input will take. Integer cents cannot do that,
// and cents are what repricing-rules.ts already works in
// (computeMarkdownCents / effectiveFloorCents). Dollars become cents in exactly
// one function, `dollarsToCents`, and every intermediate carries its unit in
// its name.

/** The only place the two units meet. */
export const CENTS_PER_DOLLAR = 100;

/**
 * Dollars -> integer cents. THE single conversion site.
 *
 * Rounds, because a dollar figure that arrived from Postgres numeric or from a
 * JSON blob can carry a sub-cent tail, and a price is money: truncating it
 * loses the seller a cent on every listing that has one.
 */
export function dollarsToCents(dollars: number): number {
  return Math.round(dollars * CENTS_PER_DOLLAR);
}

/** Integer cents -> dollars. */
export function centsToDollars(cents: number): number {
  return cents / CENTS_PER_DOLLAR;
}

/**
 * Round `priceCents` to the nearest whole `stepCents`, never below one step.
 *
 * NEAREST, not floored. Flooring quietly costs the seller money on every
 * cross-post, and the adjusted number is shown in the Listing Kit row before
 * they send it, so it is a visible change rather than a silent one.
 *
 * Non-finite guards, found by writing the test rather than by reading the code:
 * an Infinity step makes Math.round(price / step) zero, and 0 * Infinity is NaN
 * — so a nonsense step turned a real price into NaN and put that on the row.
 * Leaving the price untouched is the only safe answer for a step we cannot use.
 *
 * @param stepCents 0 (or absent) means the marketplace keeps its cents.
 */
export function stepPriceCents(priceCents: number, stepCents: number): number {
  if (!Number.isFinite(stepCents) || !Number.isFinite(priceCents)) return priceCents;
  if (!(stepCents > 0) || !(priceCents > 0)) return priceCents;
  // Never below one step: a 40c item becomes $1, never $0.
  return Math.max(stepCents, Math.round(priceCents / stepCents) * stepCents);
}

/**
 * A price in the units the marketplace actually accepts, as a NUMBER.
 *
 * Dollars in, dollars out, because that is what the Listing Kit row, the
 * "Ready to list" validation and the revise payload all carry. The maths
 * happens in cents in the middle.
 *
 * @param step `MarketplaceSpec.priceStep` in dollars. 0 or absent keeps cents.
 */
export function stepPrice(resolved: number, step: number): number {
  if (!Number.isFinite(step) || !Number.isFinite(resolved)) return resolved;
  if (!(step > 0) || !(resolved > 0)) return resolved;
  return centsToDollars(
    stepPriceCents(dollarsToCents(resolved), dollarsToCents(step)),
  );
}

/**
 * THE BOUNDARY: the exact string this marketplace's price input can hold.
 *
 * Both builders of the extension `list` payload call this — `buildListerPayload`
 * in the browser and `buildListPayload` on the server — so a queued cross-post
 * and a desk one send the same digits. Before US-2739 only the browser stepped,
 * and only in the Listing Kit, so every phone-queued Poshmark job typed cents
 * into a field that refuses a decimal point.
 *
 * Formats from cents, never with String(number): String(0.1 + 0.2) is
 * "0.30000000000000004", and a price field handed that is a price field the
 * seller has to fix by hand.
 *
 * @param step `MarketplaceSpec.priceStep` in dollars. Absent keeps cents.
 * @returns "" when there is no price to send. Never a guess, never a zero.
 */
export function marketplacePriceString(
  price: number | null | undefined,
  step?: number | null,
): string {
  if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) return "";
  const stepDollars = typeof step === "number" && Number.isFinite(step) && step > 0 ? step : 0;
  const cents = stepPriceCents(dollarsToCents(price), dollarsToCents(stepDollars));
  if (!Number.isFinite(cents) || cents <= 0) return "";
  // A whole-dollar marketplace gets digits and nothing else: its input is
  // pattern="[0-9]*" and a decimal point is a keystroke it refuses.
  if (cents % CENTS_PER_DOLLAR === 0) return String(cents / CENTS_PER_DOLLAR);
  return (cents / CENTS_PER_DOLLAR).toFixed(2);
}

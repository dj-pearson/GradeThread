// US-562: Best-offer auto-accept / auto-decline thresholds.
//
// eBay's Sell Inventory API accepts a per-offer `bestOfferTerms` with optional
// `autoAcceptPrice` / `autoDeclinePrice`. An incoming offer at or above
// autoAcceptPrice is auto-accepted; an offer at or below autoDeclinePrice is
// auto-declined; anything in between waits for the seller.
//
// eBay enforces these constraints (Inventory API offer.listingPolicies):
//   - autoAcceptPrice  must be LESS THAN the listing (Buy It Now) price
//   - autoDeclinePrice must be LESS THAN autoAcceptPrice (when both are set)
//   - both must be greater than 0
//
// US-2405 — THE THRESHOLDS ARE THE SELLER'S OWN NUMBERS. NOTHING IS DERIVED.
// This used to fall back to the comp band (price_range_low_cents = p25 →
// decline, price_range_high_cents = p75 → accept) whenever the seller left a
// box blank. That default was persisted into the best_offer_* columns by the
// composer save, so it became a FIXED number that no longer tracked anything —
// and it survived a later price edit. A shirt repriced from $24 to $298 kept a
// $27.50 auto-accept, meaning a $28 offer on a $298 item would have been
// accepted automatically. Blank now means blank: no threshold is sent, the
// offer waits for the seller, which is the safe direction. The only work left
// here is validating what the seller typed against eBay's rules; a value that
// cannot be made valid is dropped rather than silently rewritten.

export interface BestOfferThresholdInput {
  /** The listing (Buy It Now) price, in whole cents. */
  priceCents: number;
  /** The seller's auto-accept threshold in cents, or null when they left it blank. */
  acceptCents: number | null;
  /** The seller's auto-decline threshold in cents, or null when they left it blank. */
  declineCents: number | null;
}

export interface BestOfferThresholds {
  /** Resolved auto-accept price in cents, or null when none applies. */
  autoAcceptCents: number | null;
  /** Resolved auto-decline price in cents, or null when none applies. */
  autoDeclineCents: number | null;
}

function positive(v: number | null): number | null {
  if (v != null && Number.isFinite(v) && v > 0) return Math.round(v);
  return null;
}

/**
 * Validates the auto-accept / auto-decline thresholds to send on a best-offer
 * enabled offer. Input is the seller's own numbers only; the result is always
 * clamped to eBay's constraints (see file header).
 */
export function resolveBestOfferThresholds(
  input: BestOfferThresholdInput,
): BestOfferThresholds {
  const price =
    Number.isFinite(input.priceCents) && input.priceCents > 0
      ? Math.round(input.priceCents)
      : 0;

  let accept = positive(input.acceptCents);
  let decline = positive(input.declineCents);

  // Constraint 1: autoAcceptPrice must be strictly below the listing price.
  // When the seller's number sits at/above list, nudge it to one cent under.
  // If list is ≤ 1 cent there's no room for a valid accept threshold, so drop it.
  if (accept != null && price > 0 && accept >= price) {
    accept = price > 1 ? price - 1 : null;
  }

  // Constraint 2: autoDeclinePrice must be strictly below autoAcceptPrice when
  // both are present. We drop the decline rather than silently rewriting the
  // seller's number.
  if (accept != null && decline != null && decline >= accept) {
    decline = null;
  }

  // When there's no accept threshold, decline still must sit below the list
  // price to be meaningful.
  if (accept == null && decline != null && price > 0 && decline >= price) {
    decline = null;
  }

  return {
    autoAcceptCents: accept != null && accept > 0 ? accept : null,
    autoDeclineCents: decline != null && decline > 0 ? decline : null,
  };
}

/** Formats whole cents as an eBay money string ("24.99"). */
export function centsToMoneyString(cents: number): string {
  return (Math.round(cents) / 100).toFixed(2);
}

// ── US-2944: reconciling the LISTING's thresholds with the RULES engine ─────
//
// Two systems decide the same offer and nothing checked they agreed.
//
//   • eBay's own auto-accept, set per offer via `bestOfferTerms`, fires the
//     instant a qualifying bid lands.
//   • The FlipDesk offer rule (lib/offer-rules.ts), which runs hourly and
//     applies a MARGIN FLOOR eBay knows nothing about.
//
// eBay always wins the race, so a listing whose stored autoAcceptPrice sits
// BELOW the rule's number is a hole: an offer in the gap is taken by eBay at a
// price the rule would have refused, and the seller's margin floor never gets a
// vote. Nothing in the product noticed.
//
// The fix is one direction only. This function can RAISE the pushed
// auto-accept to match the rule, or drop it entirely; it never lowers one, and
// it never invents one. US-2405 still governs: a seller who left the box blank
// gets nothing pushed, because a derived threshold that stops tracking anything
// is how a $28 offer came to be auto-accepted on a $298 item.

export interface RuleReconcileInput {
  /** The listing price, in cents. */
  priceCents: number;
  /** The seller's own auto-accept, in cents. Null when they left it blank. */
  sellerAcceptCents: number | null;
  /** The active rule's accept threshold, as a percent of list. Null when none. */
  ruleAcceptAtPct: number | null;
  /** The rule's margin floor, in percent over cost. */
  ruleMarginFloorPct: number;
  /** Acquisition cost in cents, or null when the item has none recorded. */
  itemCostCents: number | null;
}

export interface RuleReconcileResult {
  /** What to push to eBay, in cents. Null means push nothing. */
  autoAcceptCents: number | null;
  /**
   * Why, for the conflict banner. `matched` means the seller's own number
   * already satisfied the rule and nothing changed.
   */
  reason:
    | "no_rule"
    | "no_seller_threshold"
    | "matched"
    | "raised_to_rule"
    | "raised_to_margin_floor"
    | "dropped_no_valid_price";
}

/**
 * Decide the auto-accept price to push, given both systems' opinions. Pure.
 *
 * The order is the contract:
 *   1. No rule, or no seller threshold → leave it exactly as it was. Blank
 *      means blank, and a rule is not permission to invent a number.
 *   2. Compute the rule's price from its percent of list.
 *   3. The MARGIN FLOOR raises that price when it is higher. A floor that could
 *      only ever lower the accept price would be a floor that loses sales,
 *      which is the asymmetry offer-rules.ts is built around.
 *   4. Take the HIGHER of the seller's number and the rule's. Never the lower —
 *      that is the hole this exists to close.
 */
export function reconcileAutoAcceptWithRule(
  input: RuleReconcileInput,
): RuleReconcileResult {
  const price = Number.isFinite(input.priceCents) && input.priceCents > 0
    ? Math.round(input.priceCents)
    : 0;
  const seller = positive(input.sellerAcceptCents);

  if (input.ruleAcceptAtPct == null) {
    return { autoAcceptCents: seller, reason: "no_rule" };
  }
  // US-2405. A rule is not permission to derive a threshold the seller never
  // set: with the box blank, an offer waits for them, which is the safe
  // direction and the whole point of that story.
  if (seller == null) {
    return { autoAcceptCents: null, reason: "no_seller_threshold" };
  }
  if (price <= 0) {
    return { autoAcceptCents: seller, reason: "no_rule" };
  }

  let ruleCents = Math.round(price * (input.ruleAcceptAtPct / 100));
  let reason: RuleReconcileResult["reason"] = "raised_to_rule";

  const cost = positive(input.itemCostCents);
  if (cost != null) {
    const floorCents = Math.round(cost * (1 + input.ruleMarginFloorPct / 100));
    if (floorCents > ruleCents) {
      ruleCents = floorCents;
      reason = "raised_to_margin_floor";
    }
  }

  // No valid price satisfies eBay's "strictly below list" constraint, so push
  // nothing rather than a number the rule would refuse.
  if (ruleCents >= price) {
    return { autoAcceptCents: null, reason: "dropped_no_valid_price" };
  }
  if (seller >= ruleCents) {
    return { autoAcceptCents: seller, reason: "matched" };
  }
  return { autoAcceptCents: ruleCents, reason };
}

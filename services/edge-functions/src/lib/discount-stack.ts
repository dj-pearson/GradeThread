// US-2951: what an item actually sells for once every discount stacks.
//
// A markdown sale, a coded coupon and an accepted best offer can all apply to
// the same garment, and nothing in FlipDesk added them up. A seller who set a
// 20% sale in March, a 10% coupon in June and a 70%-of-list auto-accept has an
// item that can leave at 50% of ask, and the first they hear about it is the
// payout.
//
// ── WORST CASE, NOT EXPECTED CASE ───────────────────────────────────────────
//
// This computes the LOWEST price the item can legally leave at, because that is
// the only number that answers "can this go below my floor". An expected value
// weighted by how often coupons get used would be smaller, more accurate on
// average, and useless for the one question being asked.
//
// ── AND IT REPORTS, IT DOES NOT REMOVE ──────────────────────────────────────
//
// An item already inside a breaching stack is listed as a warning. Silently
// pulling it out of a promotion the seller built is a bigger surprise than the
// discount was.
//
// Pure — no network, no database, so the arithmetic is testable directly.

export interface DiscountInput {
  /** What the listing asks, in cents. */
  priceCents: number | null;
  /** What the item cost, in cents. Null when unknown. */
  costCents: number | null;
  /** Shipping the seller absorbs on a sale, in cents. */
  shippingCostCents?: number | null;
  /** Percent off from a markdown sale. Null when the item is in none. */
  markdownPct?: number | null;
  /** Percent off from a coded coupon. Null when the item is in none. */
  couponPct?: number | null;
  /** An auto-accept threshold in cents, which caps the realised price. */
  autoAcceptCents?: number | null;
  /** Minimum margin over cost, in percent. */
  marginFloorPct: number;
}

export interface StackVerdict {
  /** The lowest the item can realistically leave at, in cents. */
  worstCaseCents: number;
  /** The floor it must clear, in cents. Null when the cost is unknown. */
  floorCents: number | null;
  /** True when the worst case is below the floor. Always false when unchecked. */
  breaches: boolean;
  /**
   * Never checked, because the cost is unknown. Distinct from `breaches: false`,
   * which means checked and safe — labelling an unchecked item as safe is the
   * failure this whole guard exists to avoid.
   */
  unchecked: boolean;
  /** Each discount that contributed, with the cents it took off. */
  contributions: Array<{ kind: string; cents: number }>;
}

function usable(n: number | null | undefined): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

/**
 * The worst-case realised price and whether it clears the floor. Pure.
 *
 * ORDER OF APPLICATION IS THE CONTRACT, and it matches how eBay stacks them: a
 * markdown changes the listed price, a coupon comes off the marked-down price,
 * and an auto-accept CAPS whatever is left rather than discounting it again.
 * Applying the coupon to the original price would understate the damage, which
 * is the wrong direction for a safety check.
 */
export function evaluateStack(input: DiscountInput): StackVerdict {
  const contributions: Array<{ kind: string; cents: number }> = [];
  const price = usable(input.priceCents) ? input.priceCents : 0;
  let running = price;

  if (usable(input.markdownPct)) {
    const off = Math.round(running * (input.markdownPct / 100));
    contributions.push({ kind: "markdown sale", cents: off });
    running -= off;
  }
  if (usable(input.couponPct)) {
    // Off the MARKED-DOWN price, which is how eBay applies it.
    const off = Math.round(running * (input.couponPct / 100));
    contributions.push({ kind: "coupon", cents: off });
    running -= off;
  }
  if (usable(input.autoAcceptCents) && input.autoAcceptCents < running) {
    const off = running - input.autoAcceptCents;
    contributions.push({ kind: "auto-accepted offer", cents: off });
    running = input.autoAcceptCents;
  }

  const shipping = usable(input.shippingCostCents) ? input.shippingCostCents : 0;
  const worstCaseCents = running - shipping;
  if (shipping > 0) contributions.push({ kind: "shipping you absorb", cents: shipping });

  if (!usable(input.costCents)) {
    return {
      worstCaseCents,
      floorCents: null,
      breaches: false,
      unchecked: true,
      contributions,
    };
  }
  const floorCents = Math.round(input.costCents * (1 + input.marginFloorPct / 100));
  return {
    worstCaseCents,
    floorCents,
    breaches: worstCaseCents < floorCents,
    unchecked: false,
    contributions,
  };
}

/** One line a seller can act on, naming every discount and its amount. */
export function describeStack(verdict: StackVerdict): string {
  if (verdict.unchecked) {
    return "No purchase price on record, so this one was not checked.";
  }
  const parts = verdict.contributions
    .map((c) => `${c.kind} $${(c.cents / 100).toFixed(2)}`)
    .join(", ");
  const worst = `$${(verdict.worstCaseCents / 100).toFixed(2)}`;
  const floor = `$${((verdict.floorCents ?? 0) / 100).toFixed(2)}`;
  if (!verdict.breaches) {
    return parts
      ? `Worst case ${worst}, above your ${floor} floor (${parts}).`
      : `Worst case ${worst}, above your ${floor} floor.`;
  }
  return `Worst case ${worst}, BELOW your ${floor} floor (${parts}).`;
}

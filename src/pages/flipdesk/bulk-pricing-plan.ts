// What a Bulk pricing change will do to each selected row, worked out before
// anything is sent. Pure, so the page, its confirm dialog and the tests all read
// the same answer.

export type PriceMode = "none" | "set" | "reduce" | "increase";

export interface PricingRow {
  id: string;
  title: string;
  /** Current price in dollars. */
  price: number;
  /** The seller's hard floor on this garment, in dollars. Null when none. */
  floorPrice: number | null;
}

export interface PriceChange {
  mode: PriceMode;
  /** Dollars for "set", a percent for "reduce" and "increase". */
  value: number | null;
  roundTo99: boolean;
}

const cents = (d: number) => Math.round(d * 100);
const dollars = (c: number) => c / 100;

/** Nearest price ending in .99, never under $0.99. */
function nearest99(c: number): number {
  return Math.max(99, Math.round(c / 100) * 100 - 1);
}

/**
 * The new price for one row, or null when the change would not move it the way
 * the seller asked.
 *
 * Rounding follows the mode. A reduce rounds down to the cent and an increase
 * rounds up, so a percentage can never land on the wrong side of the current
 * price by rounding alone. With ".99" on, the price goes to the nearest .99 and
 * is then held to the same rule: a reduce must end strictly below the current
 * price and an increase strictly above, or the row is "no change". Rounding
 * $10.99 down 2% lands back on $10.99, and $9.60 down 1% rounds UP to $9.99;
 * both are reported as no change rather than sent.
 */
export function targetPrice(current: number, change: PriceChange): number | null {
  const { mode, value, roundTo99 } = change;
  if (mode === "none" || value == null || !Number.isFinite(value) || value <= 0) return null;
  const now = cents(current);
  let raw: number;
  if (mode === "set") raw = cents(value);
  else if (mode === "reduce") raw = Math.floor(now * (1 - value / 100) + 1e-6);
  else raw = Math.ceil(now * (1 + value / 100) - 1e-6);
  const next = roundTo99 ? nearest99(raw) : raw;
  if (next <= 0) return null;
  if (mode === "reduce" && next >= now) return null;
  if (mode === "increase" && next <= now) return null;
  if (mode === "set" && next === now) return null;
  return dollars(next);
}

export type RowOutcome =
  | { kind: "change"; from: number; to: number }
  | { kind: "floor"; from: number; to: number; floor: number }
  | { kind: "no_change"; from: number };

export function planRow(row: PricingRow, change: PriceChange): RowOutcome {
  const to = targetPrice(row.price, change);
  if (to == null) return { kind: "no_change", from: row.price };
  if (row.floorPrice != null && cents(to) < cents(row.floorPrice)) {
    return { kind: "floor", from: row.price, to, floor: row.floorPrice };
  }
  return { kind: "change", from: row.price, to };
}

export interface BulkUpdate {
  listing_id: string;
  price?: number;
  quantity?: number;
  expected_price?: number;
}

export interface BulkPlan {
  updates: BulkUpdate[];
  outcomes: Map<string, RowOutcome>;
  changed: number;
  floored: PricingRow[];
  noChange: number;
  /** Selected rows the current filters hide. They are still sent. */
  hidden: number;
  /** Drops of more than half, or rises past 3x: the confirm asks twice. */
  bigMoves: number;
}

export function planBulk(
  rows: PricingRow[],
  selected: ReadonlySet<string>,
  visible: ReadonlySet<string>,
  change: PriceChange,
  quantity: number | undefined,
): BulkPlan {
  const plan: BulkPlan = {
    updates: [],
    outcomes: new Map(),
    changed: 0,
    floored: [],
    noChange: 0,
    hidden: 0,
    bigMoves: 0,
  };
  const pricing = change.mode !== "none" && change.value != null;
  for (const row of rows) {
    if (!selected.has(row.id)) continue;
    if (!visible.has(row.id)) plan.hidden++;
    const outcome = pricing ? planRow(row, change) : null;
    if (outcome) plan.outcomes.set(row.id, outcome);
    // A garment the seller drew a line under is skipped and named, never
    // clamped: they asked for a number, and quietly sending a different one is
    // what makes a bulk tool untrustworthy (US-3192).
    if (outcome?.kind === "floor") {
      plan.floored.push(row);
      continue;
    }
    const price = outcome?.kind === "change" ? outcome.to : undefined;
    if (outcome?.kind === "no_change") plan.noChange++;
    if (price == null && quantity == null) continue;
    if (price != null) {
      plan.changed++;
      if (price < row.price / 2 || price > row.price * 3) plan.bigMoves++;
    }
    plan.updates.push({
      listing_id: row.id,
      ...(price != null ? { price, expected_price: row.price } : {}),
      ...(quantity != null ? { quantity } : {}),
    });
  }
  return plan;
}

/** "38 will change, 4 skipped (floor), 2 no change". */
export function planSummary(plan: Pick<BulkPlan, "changed" | "floored" | "noChange">): string {
  const parts = [`${plan.changed} will change`];
  if (plan.floored.length) parts.push(`${plan.floored.length} skipped (floor)`);
  if (plan.noChange) parts.push(`${plan.noChange} no change`);
  return parts.join(", ");
}

/**
 * What stays selected after a send: only the rows that failed. Keeping every
 * row selected meant a second Apply cut the ones that had already succeeded a
 * second time.
 */
export function remainingSelection(
  results: Array<{ listing_id: string; ok: boolean }>,
): Set<string> {
  return new Set(results.filter((r) => !r.ok).map((r) => r.listing_id));
}

export interface ConfirmCopy {
  title: string;
  lines: string[];
  confirmLabel: string;
  /** When set, Apply stays off until the seller ticks this. */
  ack: string | null;
}

/**
 * What the confirm dialog says before a bulk change goes live. Quantity 0 is
 * worded as what it does on eBay (out of stock), a quantity above 1 warns that
 * a one-off garment can then sell twice, and a drop of more than half or a
 * rise past 3x has to be acknowledged, not just clicked through.
 */
export function confirmCopy(
  plan: Pick<BulkPlan, "updates" | "floored" | "noChange" | "hidden" | "bigMoves">,
  op: { priceOp: string | null; roundTo99: boolean; quantity: number | undefined },
): ConfirmCopy {
  const n = plan.updates.length;
  const listings = `${n} live eBay listing${n === 1 ? "" : "s"}`;
  const outOfStock = op.quantity === 0 && op.priceOp == null;
  const title = outOfStock
    ? `Mark ${n} listing${n === 1 ? "" : "s"} out of stock on eBay?`
    : `Apply changes to ${n} listing${n === 1 ? "" : "s"}?`;
  const parts = [
    op.priceOp,
    op.priceOp && op.roundTo99 ? "round to .99" : null,
    op.quantity === 0 ? "mark them out of stock" : op.quantity != null ? `set quantity to ${op.quantity}` : null,
  ].filter(Boolean);
  const lines = [`This will ${parts.join(", ")} on ${listings} immediately.`];
  if (op.quantity != null && op.quantity > 1) {
    lines.push(
      `A quantity above 1 lets eBay sell the same garment ${op.quantity} times. Only do this for items you really have ${op.quantity} of.`,
    );
  }
  if (plan.hidden > 0) {
    lines.push(`${plan.hidden} of these ${plan.hidden === 1 ? "is" : "are"} hidden by your filters.`);
  }
  if (plan.floored.length > 0) {
    const names = plan.floored.slice(0, 3).map((r) => r.title).join(", ");
    const more = plan.floored.length > 3 ? ` and ${plan.floored.length - 3} more` : "";
    lines.push(
      `${plan.floored.length} will be skipped because the new price is below their floor: ${names}${more}.`,
    );
  }
  if (plan.noChange > 0) lines.push(`${plan.noChange} would not change and will not be sent.`);
  const ack = plan.bigMoves > 0
    ? `I checked: ${plan.bigMoves} price${plan.bigMoves === 1 ? "" : "s"} will drop by more than half or rise above 3x.`
    : null;
  return {
    title,
    lines,
    confirmLabel: outOfStock ? "Mark out of stock" : "Apply changes",
    ack,
  };
}

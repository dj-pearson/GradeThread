// US-3012 — splitting a thrift receipt across the items it paid for.
//
// THE OWNER'S OBSERVATION IS THE WHOLE DESIGN. A thrift receipt describes
// nothing useful -- "MENS SHIRT", "RED ITEM", "CLOTHING 2.99" -- so matching a
// line to an item on its DESCRIPTION is hopeless and always will be. The PRICES
// are the useful part. Six lines totalling $47.83, photographed on the day six
// items were added, carry six real cost bases; all that is missing is which
// price goes with which item, and that is a question a person answers in fifteen
// seconds and a computer answers badly.
//
// So nothing here guesses. It arranges what the seller says into an allocation
// that is arithmetically honest, and it REFUSES in the two cases where an
// allocation would be worse than none.
//
// Pure: no network, no database, no clock.

/**
 * How far the printed lines may miss the total and still be trusted.
 *
 * Zero would be the honest number, but a receipt read by a vision model can
 * legitimately be a cent out on a rounding line, and refusing over one cent
 * would send sellers back to typing. Two cents is small enough that no real
 * misread hides under it: a missed LINE is dollars, not cents.
 */
export const RECONCILE_TOLERANCE_CENTS = 2;

export interface ReceiptLine {
  description: string | null;
  amount_cents: number;
}

export interface AllocationTarget {
  id: string;
  title: string;
  /** What it already cost, if anything. Non-null means this would OVERWRITE. */
  acquired_price_cents: number | null;
  acquired_date: string | null;
}

/** One item, and what this receipt says it cost. */
export interface Allocation {
  item_id: string;
  cents: number;
  /** Which printed line, when the split came from lines rather than a total. */
  line_index: number | null;
}

export interface AllocationPlan {
  allocations: Allocation[];
  /**
   * What is left over. AC4: this becomes ONE operating expense, never smeared
   * across the items.
   */
  remainder_cents: number;
  /** Items that already had a cost basis and would be overwritten. */
  overwrites: string[];
}

export type SplitRefusal =
  | { kind: "lines_do_not_reconcile"; gap_cents: number; message: string }
  | { kind: "no_items"; message: string }
  | { kind: "nothing_to_split"; message: string };

/**
 * AC3 — may the printed lines be used at all?
 *
 * `gapCents` is `linesReconcile()`: total less tax less the sum of the lines. A
 * non-zero gap means the receipt was read PARTIALLY, and a split built on it
 * puts a WRONG cost basis on items that previously had an honest gap. An honest
 * gap is recoverable; a confident wrong number is not, because nobody goes back
 * to check a field that is already filled in.
 */
export function canSplitByLine(gapCents: number | null): boolean {
  if (gapCents === null) return false;
  return Math.abs(gapCents) <= RECONCILE_TOLERANCE_CENTS;
}

export function refusalForGap(gapCents: number | null): SplitRefusal | null {
  if (gapCents === null || canSplitByLine(gapCents)) return null;
  const off = Math.abs(gapCents) / 100;
  return {
    kind: "lines_do_not_reconcile",
    gap_cents: gapCents,
    message:
      `The lines on this receipt are $${off.toFixed(2)} away from the total, so ` +
      "some of them were not read. Splitting by line would put a wrong price on " +
      "every item. Use the whole receipt total instead.",
  };
}

/**
 * AC2 — the one-tap case.
 *
 * Thrift receipts print in the order things came off the counter, which is often
 * the order they were photographed. When the counts match, pairing them in order
 * is right often enough to be worth one tap -- and wrong often enough that the
 * seller has to CONFIRM it rather than have it applied for them.
 */
export function pairInOrder(
  lines: readonly ReceiptLine[],
  items: readonly AllocationTarget[],
): Allocation[] | null {
  if (lines.length === 0 || lines.length !== items.length) return null;
  return lines.map((line, i) => ({
    item_id: items[i]!.id,
    cents: line.amount_cents,
    line_index: i,
  }));
}

/**
 * Build the plan from whatever the seller assigned.
 *
 * `assignments` maps a line index to an item id. A line with no assignment is
 * not an error: a bag fee or a line for something never inventoried belongs in
 * the remainder, which is AC4's whole point.
 */
export function planFromLines(
  lines: readonly ReceiptLine[],
  items: readonly AllocationTarget[],
  assignments: Readonly<Record<number, string | null>>,
): AllocationPlan {
  const byId = new Map(items.map((i) => [i.id, i]));
  const perItem = new Map<string, { cents: number; line: number }>();
  let remainder = 0;

  lines.forEach((line, index) => {
    const itemId = assignments[index] ?? null;
    if (!itemId || !byId.has(itemId)) {
      remainder += line.amount_cents;
      return;
    }
    // Two lines onto one item is legitimate -- a pair of shoes rung up twice --
    // so they ADD rather than the second replacing the first.
    const existing = perItem.get(itemId);
    perItem.set(itemId, {
      cents: (existing?.cents ?? 0) + line.amount_cents,
      line: existing?.line ?? index,
    });
  });

  return {
    allocations: [...perItem.entries()].map(([item_id, v]) => ({
      item_id,
      cents: v.cents,
      line_index: v.line,
    })),
    remainder_cents: remainder,
    overwrites: [...perItem.keys()].filter(
      (id) => byId.get(id)?.acquired_price_cents != null,
    ),
  };
}

/**
 * AC7 — the receipt that reads only as a total.
 *
 * A handwritten estate-sale receipt is the common case, not the edge case. The
 * seller picks the items and the total is divided.
 *
 * THE LEFTOVER CENTS ARE DISTRIBUTED, NOT DROPPED. $1.00 across three items is
 * 34/33/33, never 33/33/33 -- the second loses a cent from the seller's cost
 * basis, and it loses it silently, which is how a total that reconciled on the
 * receipt stops reconciling in the books. The extra cents go to the earliest
 * items so the result is deterministic and re-running gives the same answer.
 */
export function splitEvenly(
  totalCents: number,
  itemIds: readonly string[],
): AllocationPlan {
  if (itemIds.length === 0) {
    return { allocations: [], remainder_cents: totalCents, overwrites: [] };
  }
  const base = Math.floor(totalCents / itemIds.length);
  let leftover = totalCents - base * itemIds.length;

  const allocations = itemIds.map((item_id) => {
    const extra = leftover > 0 ? 1 : 0;
    leftover -= extra;
    return { item_id, cents: base + extra, line_index: null };
  });

  return { allocations, remainder_cents: 0, overwrites: [] };
}

/**
 * The seller typing an amount per item, for a receipt with no usable lines.
 *
 * Whatever is left of the total after their amounts is the remainder, and it can
 * be NEGATIVE: typing more than the receipt says is a mistake worth showing
 * rather than clamping, because a clamp would silently accept a total the
 * receipt never had.
 */
export function planFromAmounts(
  totalCents: number,
  items: readonly AllocationTarget[],
  amounts: Readonly<Record<string, number>>,
): AllocationPlan {
  const byId = new Map(items.map((i) => [i.id, i]));
  const allocations: Allocation[] = [];
  let assigned = 0;

  for (const [item_id, cents] of Object.entries(amounts)) {
    if (!byId.has(item_id) || !Number.isFinite(cents) || cents <= 0) continue;
    const whole = Math.round(cents);
    allocations.push({ item_id, cents: whole, line_index: null });
    assigned += whole;
  }

  return {
    allocations,
    remainder_cents: totalCents - assigned,
    overwrites: allocations
      .map((a) => a.item_id)
      .filter((id) => byId.get(id)?.acquired_price_cents != null),
  };
}

/** What the plan is worth in total. The check the screen shows before saving. */
export function planTotalCents(plan: AllocationPlan): number {
  return (
    plan.allocations.reduce((s, a) => s + a.cents, 0) + plan.remainder_cents
  );
}

export interface PlanProblem {
  kind: "over_allocated" | "no_allocations" | "zero_allocation";
  message: string;
}

/**
 * What would make this plan wrong to save.
 *
 * Deliberately NOT a check that the plan equals the receipt total. A seller
 * splitting only three of a receipt's six lines is doing something reasonable --
 * the other three were not inventory -- and the rest becomes the remainder.
 * Over-allocating is different: it invents money the receipt never had.
 */
export function planProblems(
  plan: AllocationPlan,
  totalCents: number,
): PlanProblem[] {
  const out: PlanProblem[] = [];
  if (plan.allocations.length === 0) {
    out.push({
      kind: "no_allocations",
      message: "Put at least one line onto an item before saving.",
    });
  }
  if (plan.allocations.some((a) => a.cents <= 0)) {
    out.push({
      kind: "zero_allocation",
      message: "An item cannot have cost nothing. Remove it or give it an amount.",
    });
  }
  if (plan.remainder_cents < 0) {
    out.push({
      kind: "over_allocated",
      message:
        `That is $${(Math.abs(plan.remainder_cents) / 100).toFixed(2)} more than ` +
        `the receipt's $${(totalCents / 100).toFixed(2)}. Check the amounts.`,
    });
  }
  return out;
}

/**
 * AC4 — the leftover, as one expense.
 *
 * A bag fee smeared across six items makes every cost basis slightly wrong and
 * untraceable, and the seller can never work out afterwards which part of an
 * item's price was really the bag. One expense row is both correct and findable.
 *
 * Returns null when there is nothing left over, so the screen does not offer to
 * create a zero-dollar expense.
 */
export function remainderExpense(
  plan: AllocationPlan,
  vendor: string | null,
  spentOn: string | null,
): { amount_cents: number; description: string; spent_on: string | null } | null {
  if (plan.remainder_cents <= 0) return null;
  return {
    amount_cents: plan.remainder_cents,
    description: vendor
      ? `${vendor} — not itemised`
      : "Receipt remainder — not itemised",
    spent_on: spentOn,
  };
}

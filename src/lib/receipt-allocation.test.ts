import { describe, it, expect } from "vitest";
import {
  RECONCILE_TOLERANCE_CENTS,
  canSplitByLine,
  pairInOrder,
  planFromAmounts,
  planFromLines,
  planProblems,
  planTotalCents,
  refusalForGap,
  remainderExpense,
  splitEvenly,
  type AllocationTarget,
  type ReceiptLine,
} from "./receipt-allocation";

// US-3012.

const ITEMS: AllocationTarget[] = [
  { id: "a", title: "Blue shirt", acquired_price_cents: null, acquired_date: "2025-04-01" },
  { id: "b", title: "Red jacket", acquired_price_cents: null, acquired_date: "2025-04-01" },
  { id: "c", title: "Boots", acquired_price_cents: 500, acquired_date: "2025-04-01" },
];

/** What a Goodwill receipt actually looks like. */
const LINES: ReceiptLine[] = [
  { description: "MENS SHIRT", amount_cents: 299 },
  { description: "RED ITEM", amount_cents: 799 },
  { description: "CLOTHING", amount_cents: 1200 },
];

describe("canSplitByLine (AC3)", () => {
  it("allows a receipt whose lines add up", () => {
    expect(canSplitByLine(0)).toBe(true);
    expect(canSplitByLine(RECONCILE_TOLERANCE_CENTS)).toBe(true);
    expect(canSplitByLine(-RECONCILE_TOLERANCE_CENTS)).toBe(true);
  });

  it("refuses a receipt that was read partially", () => {
    // The whole point. A gap means a line was missed, and a split built on it
    // puts a WRONG cost on every item -- worse than the honest gap it replaced,
    // because nobody re-checks a field that is already filled in.
    expect(canSplitByLine(1200)).toBe(false);
    expect(canSplitByLine(-1200)).toBe(false);
  });

  it("refuses when there is nothing to reconcile against", () => {
    // null means no total or no lines. Neither can be checked, so neither is
    // trusted for a per-line split.
    expect(canSplitByLine(null)).toBe(false);
  });

  it("says how far off it is, and what to do instead", () => {
    const r = refusalForGap(1250);
    expect(r?.kind).toBe("lines_do_not_reconcile");
    expect(r?.message).toContain("$12.50");
    expect(r?.message).toMatch(/whole receipt total/i);
    expect(refusalForGap(0)).toBeNull();
    expect(refusalForGap(null)).toBeNull();
  });
});

describe("pairInOrder (AC2)", () => {
  it("pairs lines to items in printed order when the counts match", () => {
    const paired = pairInOrder(LINES, ITEMS);
    expect(paired).toEqual([
      { item_id: "a", cents: 299, line_index: 0 },
      { item_id: "b", cents: 799, line_index: 1 },
      { item_id: "c", cents: 1200, line_index: 2 },
    ]);
  });

  it("refuses when the counts do not match", () => {
    // A guess at which of five lines belongs to three items is exactly the
    // clever-and-wrong the story rules out.
    expect(pairInOrder(LINES, ITEMS.slice(0, 2))).toBeNull();
    expect(pairInOrder(LINES.slice(0, 2), ITEMS)).toBeNull();
    expect(pairInOrder([], [])).toBeNull();
  });
});

describe("planFromLines", () => {
  it("puts each assigned line on its item", () => {
    const plan = planFromLines(LINES, ITEMS, { 0: "a", 1: "b", 2: "c" });
    expect(plan.allocations).toHaveLength(3);
    expect(plan.remainder_cents).toBe(0);
    expect(planTotalCents(plan)).toBe(2298);
  });

  it("sends an unassigned line to the remainder, not onto the items (AC4)", () => {
    // A bag fee smeared across six items makes every cost basis slightly wrong
    // AND untraceable: the seller can never work out afterwards which part of a
    // price was really the bag.
    const plan = planFromLines(LINES, ITEMS, { 0: "a", 1: "b" });
    expect(plan.allocations).toHaveLength(2);
    expect(plan.remainder_cents).toBe(1200);
    expect(planTotalCents(plan)).toBe(2298);
  });

  it("adds two lines onto one item rather than replacing", () => {
    // A pair of shoes rung up as two lines is a real receipt, and the second
    // silently replacing the first would halve the cost basis.
    const plan = planFromLines(LINES, ITEMS, { 0: "a", 1: "a", 2: "b" });
    expect(plan.allocations.find((x) => x.item_id === "a")?.cents).toBe(1098);
    expect(plan.remainder_cents).toBe(0);
  });

  it("ignores an assignment to an item that is not on offer", () => {
    const plan = planFromLines(LINES, ITEMS, { 0: "ghost", 1: "b", 2: "c" });
    expect(plan.allocations.map((a) => a.item_id).sort()).toEqual(["b", "c"]);
    expect(plan.remainder_cents).toBe(299);
  });

  it("names the items whose existing cost basis would be overwritten", () => {
    // Boots already cost $5. Replacing that silently is how a seller loses a
    // number they entered by hand.
    const plan = planFromLines(LINES, ITEMS, { 2: "c" });
    expect(plan.overwrites).toEqual(["c"]);
    expect(planFromLines(LINES, ITEMS, { 0: "a" }).overwrites).toEqual([]);
  });
});

describe("splitEvenly (AC7)", () => {
  it("divides a total with no lines at all", () => {
    const plan = splitEvenly(3000, ["a", "b", "c"]);
    expect(plan.allocations.map((a) => a.cents)).toEqual([1000, 1000, 1000]);
    expect(plan.remainder_cents).toBe(0);
  });

  it("DISTRIBUTES the leftover cents rather than dropping them", () => {
    // $1.00 across three is 34/33/33. Dropping the cent loses it from a cost
    // basis silently, and a total that reconciled on the receipt stops
    // reconciling in the books.
    const plan = splitEvenly(100, ["a", "b", "c"]);
    expect(plan.allocations.map((a) => a.cents)).toEqual([34, 33, 33]);
    expect(planTotalCents(plan)).toBe(100);
  });

  it("is deterministic, so re-running gives the same answer", () => {
    const a = splitEvenly(1001, ["x", "y", "z"]);
    const b = splitEvenly(1001, ["x", "y", "z"]);
    expect(a).toEqual(b);
    expect(planTotalCents(a)).toBe(1001);
  });

  it("never loses a cent, for any total and any count", () => {
    for (const total of [1, 7, 99, 100, 4783, 100_000]) {
      for (const n of [1, 2, 3, 5, 7, 11]) {
        const ids = Array.from({ length: n }, (_, i) => `i${i}`);
        expect(planTotalCents(splitEvenly(total, ids)), `${total}/${n}`).toBe(total);
      }
    }
  });

  it("keeps the whole total as the remainder when no items are chosen", () => {
    const plan = splitEvenly(4783, []);
    expect(plan.allocations).toEqual([]);
    expect(plan.remainder_cents).toBe(4783);
  });
});

describe("planFromAmounts (AC7, typed by hand)", () => {
  it("takes what the seller typed and leaves the rest over", () => {
    const plan = planFromAmounts(4783, ITEMS, { a: 1000, b: 2000 });
    expect(plan.allocations).toHaveLength(2);
    expect(plan.remainder_cents).toBe(1783);
  });

  it("goes NEGATIVE when the seller typed more than the receipt", () => {
    // Clamping would silently accept a total the receipt never had. A negative
    // remainder is a visible mistake, which is what it is.
    const plan = planFromAmounts(1000, ITEMS, { a: 800, b: 800 });
    expect(plan.remainder_cents).toBe(-600);
    expect(planProblems(plan, 1000).map((p) => p.kind)).toContain("over_allocated");
  });

  it("skips a zero or nonsense amount rather than storing it", () => {
    const plan = planFromAmounts(1000, ITEMS, {
      a: 500,
      b: 0,
      c: Number.NaN,
      ghost: 300,
    });
    expect(plan.allocations.map((x) => x.item_id)).toEqual(["a"]);
    expect(plan.remainder_cents).toBe(500);
  });
});

describe("planProblems", () => {
  it("does NOT require the plan to spend the whole receipt", () => {
    // Splitting three of six lines is reasonable: the other three were not
    // inventory. That is the remainder's job, not an error.
    const plan = planFromLines(LINES, ITEMS, { 0: "a" });
    expect(planProblems(plan, 2298)).toEqual([]);
  });

  it("refuses an empty plan and a zero-priced item", () => {
    expect(planProblems(splitEvenly(0, []), 0).map((p) => p.kind))
      .toContain("no_allocations");
    expect(planProblems(splitEvenly(0, ["a"]), 0).map((p) => p.kind))
      .toContain("zero_allocation");
  });
});

describe("remainderExpense (AC4)", () => {
  it("becomes one expense, named so it can be found later", () => {
    const plan = planFromLines(LINES, ITEMS, { 0: "a", 1: "b" });
    const e = remainderExpense(plan, "Goodwill", "2025-04-01");
    expect(e?.amount_cents).toBe(1200);
    expect(e?.description).toContain("Goodwill");
    expect(e?.spent_on).toBe("2025-04-01");
  });

  it("offers nothing when there is nothing left over", () => {
    // A zero-dollar expense is a row the seller has to look at and delete.
    const plan = planFromLines(LINES, ITEMS, { 0: "a", 1: "b", 2: "c" });
    expect(remainderExpense(plan, "Goodwill", "2025-04-01")).toBeNull();
  });

  it("offers nothing on a NEGATIVE remainder", () => {
    // Over-allocated is a mistake to fix, not an expense to create.
    const plan = planFromAmounts(1000, ITEMS, { a: 800, b: 800 });
    expect(remainderExpense(plan, "Goodwill", null)).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import {
  netAfterOverhead,
  sumExpensesInPeriod,
  type OverheadExpenseRow,
} from "./finances-overhead";

// US-2226: operating expenses must fold into the Finances net profit so the
// platform shows one true-net number, not two conflicting ones.

const rows: OverheadExpenseRow[] = [
  { amount: 40, spent_on: "2026-06-15" }, // before this-month window
  { amount: 25, spent_on: "2026-07-03" },
  { amount: 12.5, spent_on: "2026-07-20" },
];

describe("sumExpensesInPeriod", () => {
  it("sums every row when the period is all-time (null start)", () => {
    expect(sumExpensesInPeriod(rows, null)).toBeCloseTo(77.5);
  });

  it("excludes rows dated before the period start", () => {
    // July window drops the June 15 expense.
    expect(sumExpensesInPeriod(rows, "2026-07-01T05:00:00.000Z")).toBeCloseTo(37.5);
  });

  it("ignores non-finite amounts", () => {
    expect(
      sumExpensesInPeriod(
        [{ amount: Number.NaN, spent_on: "2026-07-05" }, { amount: 10, spent_on: "2026-07-06" }],
        null,
      ),
    ).toBe(10);
  });
});

describe("netAfterOverhead", () => {
  it("subtracts overhead from net profit", () => {
    expect(netAfterOverhead(500, 77.5)).toBeCloseTo(422.5);
  });

  it("adding an expense inside the period lowers true net by exactly that amount (AC4)", () => {
    const start = "2026-07-01T05:00:00.000Z";
    const netProfit = 500;

    const before = netAfterOverhead(netProfit, sumExpensesInPeriod(rows, start));
    const withNew = netAfterOverhead(
      netProfit,
      sumExpensesInPeriod([...rows, { amount: 18, spent_on: "2026-07-25" }], start),
    );

    expect(before - withNew).toBeCloseTo(18);
  });
});

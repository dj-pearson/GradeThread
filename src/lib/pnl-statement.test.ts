import { describe, it, expect } from "vitest";
import {
  buildStatement,
  statementTotals,
  statementDelta,
  type StatementEntry,
} from "./pnl-statement";
import { SYSTEM_ACCOUNTS } from "./chart-of-accounts";
import { saleEntries, ledgerNetCents, type SaleMoney } from "./ledger-math";
import {
  periodRange,
  priorRange,
  ymd,
  parseYmd,
} from "./tax-profile";

// US-2985.

const SALE: SaleMoney = {
  sale_price: "180.00",
  shipping_collected: "12.99",
  platform_fees: "23.40",
  payment_processing_fees: "5.22",
  shipping_cost: "9.85",
  grading_cost: "3.00",
  other_costs: "1.15",
  tax: "14.87",
};

/** The ledger entries one sale produces, in the statement's input shape. */
function fromSale(
  sale: SaleMoney = SALE,
  basis: string | null = "42.00",
): StatementEntry[] {
  return saleEntries(sale, basis, null, true).map((e) => ({
    account: e.account,
    amount_cents: e.amount_cents,
  }));
}

describe("the statement agrees with the ledger", () => {
  it("net profit equals the ledger net for the same entries", () => {
    // AC6, and the reason this file exists at all: the statement must not be a
    // second derivation. If these two ever disagree, one of them is inventing
    // a number.
    const entries = fromSale();
    expect(buildStatement(entries).netProfitCents).toBe(
      ledgerNetCents(saleEntries(SALE, "42.00", null, true)),
    );
  });

  it("keeps sales tax out of every total, while still showing it", () => {
    const s = buildStatement(fromSale());
    expect(s.excludedCents).toBe(1487);
    // Excluded money is in none of the running totals.
    expect(s.netProfitCents).toBe(
      buildStatement(
        fromSale({ ...SALE, tax: "0.00" }, "42.00"),
      ).netProfitCents,
    );
    // ...but it is on the statement, under its own heading.
    const excluded = s.sections.find((x) => x.key === "excluded");
    expect(excluded?.lines.map((l) => l.code)).toContain("sales_tax_collected");
  });

  it("subtotals compose: each one is the sum of the ones above it", () => {
    const s = buildStatement(fromSale());
    expect(s.netRevenueCents).toBe(s.grossReceiptsCents + s.returnsCents);
    expect(s.grossProfitCents).toBe(s.netRevenueCents + s.cogsCents);
    expect(s.netProfitCents).toBe(
      s.grossProfitCents + s.operatingExpensesCents,
    );
  });
});

describe("row order", () => {
  it("is Schedule C order, never alphabetical", () => {
    // A preparer reads down the form. An alphabetised statement makes them hunt.
    const entries: StatementEntry[] = SYSTEM_ACCOUNTS.map((a) => ({
      account: a.code,
      amount_cents: a.flow === "income" ? 1000 : -1000,
    }));
    const s = buildStatement(entries);
    const order = SYSTEM_ACCOUNTS.map((a) => a.code);
    for (const section of s.sections) {
      const idx = section.lines
        .filter((l) => l.code !== "__unplaced")
        .map((l) => order.indexOf(l.code));
      expect([...idx].sort((a, b) => a - b)).toEqual(idx);
    }
  });

  it("puts the sections in reading order", () => {
    const entries: StatementEntry[] = SYSTEM_ACCOUNTS.map((a) => ({
      account: a.code,
      amount_cents: 100,
    }));
    expect(buildStatement(entries).sections.map((s) => s.key)).toEqual([
      "income",
      "returns",
      "cogs",
      "expenses",
      "excluded",
    ]);
  });
});

describe("rows that print at zero", () => {
  it("shows the spine even on an empty period", () => {
    // A statement with no COGS row does not say "no cost of goods", it says
    // nothing, and the seller cannot tell a zero from a gap.
    const s = buildStatement([]);
    const codes = s.sections.flatMap((x) => x.lines.map((l) => l.code));
    expect(codes).toContain("sales_revenue");
    expect(codes).toContain("returns_allowances");
    expect(codes).toContain("purchases");
    expect(s.netProfitCents).toBe(0);
  });

  it("hides accounts that genuinely had no activity", () => {
    const s = buildStatement(fromSale());
    const codes = s.sections.flatMap((x) => x.lines.map((l) => l.code));
    expect(codes).not.toContain("meals");
    expect(codes).not.toContain("insurance");
  });
});

describe("an entry the chart cannot place", () => {
  it("is shown rather than dropped, so the total stays honest", () => {
    const s = buildStatement([
      ...fromSale(),
      { account: "some_account_that_does_not_exist", amount_cents: -5000 },
    ]);
    const unplaced = s.sections
      .flatMap((x) => x.lines)
      .find((l) => l.code === "__unplaced");
    expect(unplaced?.cents).toBe(-5000);
    // And it moves the bottom line, because the money is real.
    expect(s.netProfitCents).toBe(
      buildStatement(fromSale()).netProfitCents - 5000,
    );
  });

  it("says why it reaches no line", () => {
    const s = buildStatement([{ account: "nope", amount_cents: -1 }]);
    const unplaced = s.sections
      .flatMap((x) => x.lines)
      .find((l) => l.code === "__unplaced");
    expect(unplaced?.noLineReason).toBeTruthy();
    expect(unplaced?.scheduleCLine).toBeNull();
  });
});

describe("statementTotals", () => {
  it("names the Schedule C line on every subtotal", () => {
    for (const row of statementTotals(buildStatement(fromSale()))) {
      expect(row.hint, `${row.key} has no form hint`).toBeTruthy();
    }
  });

  it("emphasises gross profit and net profit, and nothing else", () => {
    const rows = statementTotals(buildStatement(fromSale()));
    expect(rows.filter((r) => r.emphasis).map((r) => r.key)).toEqual([
      "gross_profit",
      "net_profit",
    ]);
  });
});

describe("statementDelta", () => {
  it("is a plain difference", () => {
    expect(statementDelta(15000, 10000)).toEqual({ cents: 5000, percent: 50 });
    expect(statementDelta(8000, 10000)).toEqual({ cents: -2000, percent: -20 });
  });

  it("refuses a percentage against zero", () => {
    // Going from $0 to $500 is not a 100% rise, and printing one is a lie the
    // seller will repeat to somebody.
    expect(statementDelta(50000, 0)).toEqual({ cents: 50000, percent: null });
    expect(statementDelta(0, 0)).toEqual({ cents: 0, percent: null });
  });

  it("uses the magnitude of the prior period, so a loss improving reads positive", () => {
    // Last quarter -$1000, this quarter -$400. That is a $600 improvement, and
    // it must not print as -60%.
    expect(statementDelta(-40000, -100000).percent).toBe(60);
  });
});

describe("period ranges", () => {
  it("are half-open, so two adjacent periods share a boundary and overlap nowhere", () => {
    const jan = periodRange("month", 1, new Date(2026, 0, 15));
    const feb = periodRange("month", 1, new Date(2026, 1, 15));
    expect(jan.to).toBe(feb.from);
    expect(jan.from).toBe("2026-01-01");
    expect(jan.to).toBe("2026-02-01");
  });

  it("build the yyyy-mm-dd locally, never through toISOString", () => {
    // toISOString() on a local midnight lands on the previous day west of
    // Greenwich, which is the whole class of bug US-2339 is.
    expect(ymd(new Date(2026, 0, 1))).toBe("2026-01-01");
    expect(ymd(new Date(2026, 11, 31))).toBe("2026-12-31");
    expect(ymd(parseYmd("2026-07-04"))).toBe("2026-07-04");
  });

  it("run the quarter from the fiscal year start", () => {
    const q = periodRange("quarter", 7, new Date(2026, 7, 5));
    expect(q.from).toBe("2026-07-01");
    expect(q.to).toBe("2026-10-01");
    expect(q.label).toBe("Q1 2026-27");
  });

  it("name a non-calendar year across both years", () => {
    expect(periodRange("year", 7, new Date(2026, 7, 1)).label).toBe(
      "Tax year 2026-27",
    );
    expect(periodRange("year", 1, new Date(2026, 7, 1)).label).toBe("2026");
  });

  it("cover the whole year with no gap and no overlap", () => {
    // Four quarters, laid end to end, must be exactly the year.
    for (const startMonth of [1, 4, 7, 10]) {
      const year = periodRange("year", startMonth, new Date(2026, 7, 15));
      let cursor = year.from;
      for (let i = 0; i < 4; i++) {
        const q = periodRange("quarter", startMonth, parseYmd(cursor));
        expect(q.from, `fy${startMonth} quarter ${i + 1}`).toBe(cursor);
        cursor = q.to;
      }
      expect(cursor).toBe(year.to);
    }
  });
});

describe("priorRange", () => {
  it("steps back one whole period, so the comparison is like for like", () => {
    const feb = periodRange("month", 1, new Date(2026, 1, 10));
    const jan = priorRange("month", 1, feb);
    expect(jan.from).toBe("2026-01-01");
    expect(jan.to).toBe("2026-02-01");
  });

  it("steps a quarter back across a year boundary", () => {
    const q1 = periodRange("quarter", 1, new Date(2026, 0, 15));
    const prior = priorRange("quarter", 1, q1);
    expect(prior.from).toBe("2025-10-01");
    expect(prior.to).toBe("2026-01-01");
  });

  it("steps a year back", () => {
    const y = periodRange("year", 1, new Date(2026, 5, 1));
    expect(priorRange("year", 1, y)).toMatchObject({
      from: "2025-01-01",
      to: "2026-01-01",
    });
  });

  it("compares a custom range against the same number of days before it", () => {
    // The only defensible reading, and the screen says so -- "the previous
    // period" for an arbitrary range is otherwise a guess the seller has to
    // reverse-engineer.
    const custom = { from: "2026-03-10", to: "2026-03-27", label: "custom" };
    const prior = priorRange("custom", 1, custom);
    expect(prior.to).toBe("2026-03-10");
    expect(prior.from).toBe("2026-02-21");
    expect(prior.label).toBe("Previous 17 days");
  });

  it("never overlaps the range it is the prior of", () => {
    for (const g of ["month", "quarter", "year"] as const) {
      const r = periodRange(g, 1, new Date(2026, 4, 20));
      expect(priorRange(g, 1, r).to).toBe(r.from);
    }
  });
});

describe("the statement matches what the database produced", () => {
  // These fifteen entries are the EXACT rows scripts/fixtures/ledger-invariant.sql
  // produced on a real Postgres, copied from the run. The database's own
  // ledger_reconciliation() reported true_net_cents = 9165 for them.
  //
  // Pinning that here ties the pure builder to a measured result rather than to
  // another copy of my own arithmetic. If the SQL derivation and this builder
  // ever drift, one of these two numbers moves.
  const FIXTURE: StatementEntry[] = [
    { account: "sales_revenue", amount_cents: 2999 },
    { account: "sales_revenue", amount_cents: 18000 },
    { account: "shipping_income", amount_cents: 1299 },
    { account: "sales_tax_collected", amount_cents: 247 },
    { account: "sales_tax_collected", amount_cents: 1487 },
    { account: "purchases", amount_cents: -4200 },
    { account: "cogs_other", amount_cents: -300 },
    { account: "cogs_other", amount_cents: -115 },
    { account: "platform_fees", amount_cents: -477 },
    { account: "platform_fees", amount_cents: -2862 },
    { account: "supplies", amount_cents: -2499 },
    { account: "shipping_postage", amount_cents: -985 },
    { account: "shipping_postage", amount_cents: -595 },
    { account: "cash_payout", amount_cents: 15234 },
    { account: "uncategorised", amount_cents: -1100 },
  ];

  it("nets to the 9165 cents ledger_reconciliation reported", () => {
    expect(buildStatement(FIXTURE).netProfitCents).toBe(9165);
  });

  it("breaks down the way the fixture does", () => {
    const s = buildStatement(FIXTURE);
    expect(s.grossReceiptsCents).toBe(22298);
    expect(s.cogsCents).toBe(-4615);
    expect(s.operatingExpensesCents).toBe(-8518);
    expect(s.grossProfitCents).toBe(17683);
  });

  it("holds the payout and the sales tax outside the bottom line", () => {
    // 15234 of cash and 1734 of tax moved through the books and neither is
    // profit. Counting either would nearly triple this seller's income.
    const s = buildStatement(FIXTURE);
    expect(s.excludedCents).toBe(15234 + 1734);
    expect(s.netProfitCents).toBe(9165);
  });
});

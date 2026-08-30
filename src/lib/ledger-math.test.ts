import { describe, it, expect } from "vitest";
import {
  toCents,
  formatCents,
  saleNetCents,
  saleEntries,
  ledgerNetCents,
  NON_PROFIT_ACCOUNTS,
  type SaleMoney,
} from "./ledger-math";

// US-2984.
//
// The full invariant needs Postgres and lives in
// scripts/check-ledger-invariant.mjs. This is the half CI can run every push:
// the money conversion, the sign convention, and the assertion that the entry
// derivation reproduces finances_dashboard's formula exactly.

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

describe("toCents", () => {
  it("is exact where a float is not", () => {
    // 19.99 * 100 is 1998.9999999999998 in IEEE 754. Doing this on the digits
    // instead is the whole reason this function exists.
    expect(toCents("19.99")).toBe(1999);
    expect(toCents(19.99)).toBe(1999);
    expect(toCents("0.07")).toBe(7);
    expect(toCents("1.005")).toBe(101);
    expect(toCents("8.07")).toBe(807);
  });

  it("never returns a non-integer", () => {
    for (const v of ["0.01", "1.10", "1234.56", "99999.99", 0.29, 4.7, 1e3]) {
      const c = toCents(v);
      expect(Number.isInteger(c), `${v} produced ${c}`).toBe(true);
    }
  });

  it("treats missing money as zero, not NaN", () => {
    expect(toCents(null)).toBe(0);
    expect(toCents(undefined)).toBe(0);
    expect(toCents("")).toBe(0);
  });

  it("handles negatives", () => {
    expect(toCents("-42.50")).toBe(-4250);
    expect(toCents(-0.01)).toBe(-1);
  });

  it("round-trips every cent from 0 to 999 through a decimal string", () => {
    // The loop that would catch a rounding bug that only shows on some values.
    for (let cents = 0; cents < 1000; cents++) {
      const asDecimal = (cents / 100).toFixed(2);
      expect(toCents(asDecimal), `${asDecimal}`).toBe(cents);
    }
  });
});

describe("formatCents", () => {
  it("pads the cents", () => {
    expect(formatCents(1999)).toBe("$19.99");
    expect(formatCents(5)).toBe("$0.05");
    expect(formatCents(100)).toBe("$1.00");
    expect(formatCents(0)).toBe("$0.00");
  });

  it("puts the sign before the currency symbol", () => {
    expect(formatCents(-4250)).toBe("-$42.50");
  });
});

describe("the entries reproduce the dashboard formula", () => {
  it("agrees to the cent on an ordinary sale", () => {
    // The claim the whole epic rests on, in its CI-runnable form.
    const entries = saleEntries(SALE, "42.00", null, true);
    expect(ledgerNetCents(entries)).toBe(saleNetCents(SALE, "42.00", null));
  });

  it("agrees when the item has no cost basis at all", () => {
    const entries = saleEntries(SALE, null, null, true);
    expect(ledgerNetCents(entries)).toBe(saleNetCents(SALE, null, null));
  });

  it("agrees across a spread of random sales", () => {
    // A single fixture proves one path. This proves the shape.
    let seed = 20260829;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const money = () => (Math.round(rnd() * 30000) / 100).toFixed(2);
    for (let i = 0; i < 500; i++) {
      const sale: SaleMoney = {
        sale_price: money(),
        shipping_collected: money(),
        platform_fees: money(),
        payment_processing_fees: money(),
        shipping_cost: i % 3 === 0 ? "0.00" : money(),
        grading_cost: money(),
        other_costs: money(),
        tax: money(),
      };
      const basis = i % 5 === 0 ? null : money();
      const legacy = i % 2 === 0 ? money() : null;
      expect(ledgerNetCents(saleEntries(sale, basis, legacy, true))).toBe(
        saleNetCents(sale, basis, legacy),
      );
    }
  });
});

describe("what the entries deliberately leave out of profit", () => {
  it("records sales tax and keeps it out of net", () => {
    const withTax = saleEntries(SALE, "42.00", null, true);
    const noTax = saleEntries({ ...SALE, tax: "0.00" }, "42.00", null, true);
    // Recorded...
    expect(withTax.some((e) => e.account === "sales_tax_collected")).toBe(true);
    expect(noTax.some((e) => e.account === "sales_tax_collected")).toBe(false);
    // ...and worth nothing to profit.
    expect(ledgerNetCents(withTax)).toBe(ledgerNetCents(noTax));
  });

  it("keeps a payout out of net, because the sale was already counted", () => {
    const base = saleEntries(SALE, "42.00", null, true);
    const withPayout = [
      ...base,
      {
        account: "cash_payout" as const,
        amount_cents: 15234,
        source_kind: "payout" as const,
        source_detail: "payout",
      },
    ];
    expect(ledgerNetCents(withPayout)).toBe(ledgerNetCents(base));
  });

  it("names both non-profit accounts, so a new one cannot be added silently", () => {
    expect([...NON_PROFIT_ACCOUNTS].sort()).toEqual([
      "cash_payout",
      "sales_tax_collected",
    ]);
  });
});

describe("the legacy shipments double-count guard", () => {
  // This is the defect the SQL sabotage run reproduced: without the guard the
  // shipping label is deducted twice, once from sales.shipping_cost and once
  // from the shipments row.
  it("ignores a shipments row when the sale carries its own shipping", () => {
    const withLegacy = saleEntries(SALE, "42.00", "9.85", true);
    const without = saleEntries(SALE, "42.00", null, true);
    expect(ledgerNetCents(withLegacy)).toBe(ledgerNetCents(without));
    expect(withLegacy.some((e) => e.source_detail === "legacy_shipment")).toBe(
      false,
    );
  });

  it("uses the shipments row when the sale carries no shipping", () => {
    const sale = { ...SALE, shipping_cost: "0.00" };
    const entries = saleEntries(sale, "42.00", "5.95", true);
    const legacy = entries.find((e) => e.source_detail === "legacy_shipment");
    expect(legacy?.amount_cents).toBe(-595);
    expect(ledgerNetCents(entries)).toBe(saleNetCents(sale, "42.00", "5.95"));
  });
});

describe("entry shape", () => {
  it("writes no zero-valued rows", () => {
    // A books screen full of $0.00 lines is noise a seller reads past to find
    // the row that matters.
    const bare: SaleMoney = {
      sale_price: "10.00",
      shipping_collected: "0",
      platform_fees: "0",
      payment_processing_fees: "0",
      shipping_cost: "0",
      grading_cost: "0",
      other_costs: "0",
      tax: "0",
    };
    const entries = saleEntries(bare, null, null, true);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.account).toBe("sales_revenue");
    expect(entries.every((e) => e.amount_cents !== 0)).toBe(true);
  });

  it("gives every entry a distinct natural key within one sale", () => {
    // The unique index is (user_id, source_kind, source_id, source_detail), so
    // two entries from one sale sharing a (kind, detail) pair would silently
    // drop one on insert.
    const entries = saleEntries(SALE, "42.00", null, true);
    const keys = entries.map((e) => `${e.source_kind}:${e.source_detail}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("makes every cost negative and every income positive", () => {
    const entries = saleEntries(SALE, "42.00", null, true);
    for (const e of entries) {
      const isIncome =
        e.account === "sales_revenue" ||
        e.account === "shipping_income" ||
        e.account === "sales_tax_collected";
      expect(
        isIncome ? e.amount_cents > 0 : e.amount_cents < 0,
        `${e.account} had the wrong sign`,
      ).toBe(true);
    }
  });
});

describe("the two sales-tax branches (US-2987)", () => {
  it("excludes facilitator tax from gross receipts", () => {
    const e = saleEntries(SALE, "42.00", null, true);
    const revenue = e
      .filter((x) => x.account === "sales_revenue")
      .reduce((s, x) => s + x.amount_cents, 0);
    expect(revenue).toBe(18000);
    expect(e.some((x) => x.account === "sales_tax_collected")).toBe(true);
    expect(e.some((x) => x.account === "sales_tax_remitted")).toBe(false);
  });

  it("puts seller-collected tax INTO gross receipts and deducts the remittance", () => {
    const e = saleEntries(SALE, "42.00", null, false);
    const revenue = e
      .filter((x) => x.account === "sales_revenue")
      .reduce((s, x) => s + x.amount_cents, 0);
    // 180.00 + 14.87 of tax the seller is the retailer for.
    expect(revenue).toBe(19487);
    expect(
      e.find((x) => x.account === "sales_tax_remitted")?.amount_cents,
    ).toBe(-1487);
    expect(e.some((x) => x.account === "sales_tax_collected")).toBe(false);
  });

  it("nets to the SAME profit either way, which is why this needs a test", () => {
    // The bottom line cannot tell you the branch was chosen correctly. Gross
    // receipts can, and that is the figure a 1099-K is compared against.
    const facilitator = ledgerNetCents(saleEntries(SALE, "42.00", null, true));
    const seller = ledgerNetCents(saleEntries(SALE, "42.00", null, false));
    expect(facilitator).toBe(seller);
    expect(facilitator).toBe(saleNetCents(SALE, "42.00", null));
  });

  it("keeps the natural keys distinct on the seller-collected branch too", () => {
    // Both tax entries come from the same sale, so they must differ on
    // source_detail or the unique index silently drops one.
    const e = saleEntries(SALE, "42.00", null, false);
    const keys = e.map((x) => `${x.source_kind}:${x.source_detail}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("emits no tax entry at all on either branch when the tax is zero", () => {
    const zero = { ...SALE, tax: "0.00" };
    for (const facilitator of [true, false]) {
      const e = saleEntries(zero, "42.00", null, facilitator);
      expect(e.some((x) => x.source_detail.startsWith("tax"))).toBe(false);
    }
  });
});

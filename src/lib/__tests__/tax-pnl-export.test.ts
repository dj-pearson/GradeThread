import { describe, it, expect } from "vitest";
import type { SaleRow } from "@/types/database";
import { computePnl } from "@/lib/pnl";
import {
  buildTaxPnlRow,
  buildTaxPnlRows,
  sumTaxPnl,
  distinctValues,
  taxPnlCsvText,
  type TaxPnlItemMeta,
  type TaxPnlRow,
} from "@/lib/tax-pnl-export";

// Minimal SaleRow factory — only the fields the P&L reads matter; everything
// else gets a harmless default so the row type-checks.
function sale(over: Partial<SaleRow>): SaleRow {
  return {
    id: "sale-1",
    inventory_item_id: "item-1",
    user_id: "user-1",
    listing_id: null,
    sale_price: 100,
    platform_fees: 0,
    sale_date: "2026-03-15",
    buyer_username: null,
    buyer_notes: null,
    shipping_collected: 0,
    payment_processing_fees: 0,
    shipping_cost: 0,
    grading_cost: 0,
    other_costs: 0,
    net_profit: null,
    buyer_id: null,
    sold_at: null,
    shipped_at: null,
    tracking_number: null,
    carrier: null,
    delivered_at: null,
    payout_reference: null,
    tax: 0,
    payout_amount: null,
    status: "completed",
    cancelled_at: null,
    platform_order_ref: null,
    created_at: "2026-03-15T00:00:00Z",
    ...over,
  };
}

const meta = (over: Partial<TaxPnlItemMeta> = {}): TaxPnlItemMeta => ({
  title: "Item",
  category: "Tops",
  brand: "Nike",
  costBasis: 20,
  ...over,
});

describe("buildTaxPnlRow", () => {
  it("net is taken verbatim from computePnl (no new source of truth)", () => {
    const s = sale({
      sale_price: 100,
      shipping_collected: 10,
      platform_fees: 13,
      payment_processing_fees: 3,
      shipping_cost: 7,
      grading_cost: 2,
      other_costs: 1,
    });
    const m = meta({ costBasis: 20 });
    const row = buildTaxPnlRow(s, m);
    const pnl = computePnl(s, m.costBasis);

    expect(row.net).toBe(pnl.net);
    expect(row.revenue).toBe(pnl.revenue);
    expect(row.fees).toBe(pnl.fees);
    expect(row.cogs).toBe(pnl.costBasis);
  });

  it("broken-out cost columns sum back to net", () => {
    const row = buildTaxPnlRow(
      sale({
        sale_price: 100,
        shipping_collected: 10,
        platform_fees: 13,
        payment_processing_fees: 3,
        shipping_cost: 7,
        grading_cost: 2,
        other_costs: 1,
      }),
      meta({ costBasis: 20 }),
    );
    const recomputed =
      row.revenue -
      row.fees -
      row.shippingCost -
      row.gradingCost -
      row.otherCosts -
      row.cogs;
    expect(recomputed).toBeCloseTo(row.net, 10);
  });

  it("falls back to placeholders for missing meta", () => {
    const row = buildTaxPnlRow(sale({ inventory_item_id: "abc" }), undefined);
    expect(row.title).toBe("abc");
    expect(row.category).toBe("Uncategorized");
    expect(row.brand).toBe("No brand");
    expect(row.cogs).toBe(0);
  });
});

describe("buildTaxPnlRows", () => {
  const metaById = new Map<string, TaxPnlItemMeta>([
    ["a", meta({ category: "Tops", brand: "Nike", costBasis: 10 })],
    ["b", meta({ category: "Bottoms", brand: "Levi", costBasis: 25 })],
    ["c", meta({ category: "Tops", brand: "Adidas", costBasis: 5 })],
  ]);
  const sales: SaleRow[] = [
    sale({ id: "s-a", inventory_item_id: "a", sale_price: 60, sale_date: "2026-01-10" }),
    sale({ id: "s-b", inventory_item_id: "b", sale_price: 90, sale_date: "2026-06-01" }),
    sale({ id: "s-c", inventory_item_id: "c", sale_price: 40, sale_date: "2026-12-20" }),
    // cancelled / refunded must be excluded from P&L
    sale({ id: "s-x", inventory_item_id: "a", sale_price: 999, status: "cancelled", sale_date: "2026-02-02" }),
    sale({ id: "s-y", inventory_item_id: "b", sale_price: 999, status: "refunded", sale_date: "2026-02-02" }),
  ];

  it("includes only completed sales", () => {
    const rows = buildTaxPnlRows(sales, metaById);
    expect(rows.map((r) => r.saleId)).toEqual(["s-a", "s-b", "s-c"]);
  });

  it("filters by category", () => {
    const rows = buildTaxPnlRows(sales, metaById, { category: "Tops" });
    expect(rows.map((r) => r.saleId).sort()).toEqual(["s-a", "s-c"]);
  });

  it("filters by brand", () => {
    const rows = buildTaxPnlRows(sales, metaById, { brand: "Levi" });
    expect(rows.map((r) => r.saleId)).toEqual(["s-b"]);
  });

  it("filters by inclusive date range", () => {
    const rows = buildTaxPnlRows(sales, metaById, {
      startDate: "2026-01-10",
      endDate: "2026-06-01",
    });
    expect(rows.map((r) => r.saleId)).toEqual(["s-a", "s-b"]);
  });

  it("sorts by sale date ascending", () => {
    const rows = buildTaxPnlRows(sales, metaById);
    expect(rows.map((r) => r.saleDate)).toEqual([
      "2026-01-10",
      "2026-06-01",
      "2026-12-20",
    ]);
  });
});

describe("sumTaxPnl reconciles to the underlying rows", () => {
  it("totals equal the sum of per-item computePnl values", () => {
    const metaById = new Map<string, TaxPnlItemMeta>([
      ["a", meta({ costBasis: 10 })],
      ["b", meta({ costBasis: 25 })],
    ]);
    const sales: SaleRow[] = [
      sale({
        id: "s-a",
        inventory_item_id: "a",
        sale_price: 60,
        shipping_collected: 8,
        platform_fees: 9,
        payment_processing_fees: 2,
        shipping_cost: 5,
      }),
      sale({
        id: "s-b",
        inventory_item_id: "b",
        sale_price: 120,
        shipping_collected: 0,
        platform_fees: 18,
        payment_processing_fees: 4,
        shipping_cost: 10,
        grading_cost: 3,
      }),
    ];

    const rows = buildTaxPnlRows(sales, metaById);
    const totals = sumTaxPnl(rows);

    const expectedNet =
      computePnl(sales[0]!, 10).net + computePnl(sales[1]!, 25).net;
    expect(totals.net).toBeCloseTo(expectedNet, 10);
    expect(totals.count).toBe(2);

    // Summary identity: net = revenue − COGS − fees − shipping − grading − other
    const identity =
      totals.revenue -
      totals.cogs -
      totals.fees -
      totals.shippingCost -
      totals.gradingCost -
      totals.otherCosts;
    expect(identity).toBeCloseTo(totals.net, 10);
  });

  // US-1636: the summary must reconcile to the SUM OF THE PRINTED rows (each
  // detail cell is .toFixed(2)). Raw-float summation could disagree by a cent.
  it("summary equals the sum of the cent-rounded detail rows", () => {
    const mkRow = (over: Partial<TaxPnlRow>): TaxPnlRow => ({
      saleId: "s",
      itemId: "i",
      saleDate: "2026-01-01",
      title: "t",
      category: "c",
      brand: "b",
      salePrice: 0,
      shippingCollected: 0,
      revenue: 0,
      cogs: 0,
      fees: 0,
      shippingCost: 0,
      gradingCost: 0,
      otherCosts: 0,
      net: 0,
      ...over,
    });
    // Three rows whose fee value is 0.014 → each prints as "0.01", so the
    // printed column sums to 0.03; raw-float summation gives 0.042 → "0.04".
    const rows = [
      mkRow({ fees: 0.014, revenue: 0.014 }),
      mkRow({ fees: 0.014, revenue: 0.014 }),
      mkRow({ fees: 0.014, revenue: 0.014 }),
    ];
    const totals = sumTaxPnl(rows);
    const printedFeeSum = rows.reduce((a, r) => a + Number(r.fees.toFixed(2)), 0);
    expect(totals.fees).toBeCloseTo(printedFeeSum, 10); // 0.03, not 0.04
    expect(totals.fees.toFixed(2)).toBe("0.03");
  });

  it("empty input yields zeroed totals", () => {
    const totals = sumTaxPnl([]);
    expect(totals).toEqual({
      count: 0,
      revenue: 0,
      cogs: 0,
      fees: 0,
      shippingCost: 0,
      gradingCost: 0,
      otherCosts: 0,
      net: 0,
    });
  });
});

describe("distinctValues", () => {
  it("returns sorted distinct categories and brands", () => {
    const metaById = new Map<string, TaxPnlItemMeta>([
      ["a", meta({ category: "Tops", brand: "Nike" })],
      ["b", meta({ category: "Bottoms", brand: "Nike" })],
      ["c", meta({ category: "Tops", brand: "Adidas" })],
    ]);
    const rows = buildTaxPnlRows(
      [
        sale({ id: "1", inventory_item_id: "a" }),
        sale({ id: "2", inventory_item_id: "b" }),
        sale({ id: "3", inventory_item_id: "c" }),
      ],
      metaById,
    );
    expect(distinctValues(rows, "category")).toEqual(["Bottoms", "Tops"]);
    expect(distinctValues(rows, "brand")).toEqual(["Adidas", "Nike"]);
  });
});

describe("taxPnlCsvText", () => {
  it("emits a summary block then per-item detail, with totals matching", () => {
    const metaById = new Map<string, TaxPnlItemMeta>([
      ["a", meta({ title: "Red Tee", costBasis: 10 })],
    ]);
    const rows = buildTaxPnlRows(
      [sale({ id: "s-a", inventory_item_id: "a", sale_price: 50, platform_fees: 5 })],
      metaById,
    );
    const totals = sumTaxPnl(rows);
    const csv = taxPnlCsvText(rows, totals);

    expect(csv).toContain("TAX-READY P&L SUMMARY");
    expect(csv).toContain(`Net Profit,${totals.net.toFixed(2)}`);
    expect(csv).toContain("PER-ITEM DETAIL");
    expect(csv).toContain("COGS (Source Cost)");
    expect(csv).toContain("Red Tee");
  });
});

import { describe, expect, it } from "vitest";
import {
  sellThroughByGroup,
  gradingRoiBuckets,
  itemSaleOutcome,
  accountGradingRollup,
  GRADE_FEE_USD,
  MIN_BUCKET_SIZE,
  type DateRange,
} from "../flipdesk-analytics";
import type { ItemFullRow } from "@/types/database";

// Minimal row builder — only the fields these analytics read matter; the rest
// are inert and cast to ItemFullRow.
function makeItem(overrides: Partial<ItemFullRow> = {}): ItemFullRow {
  return {
    category: null,
    brand: null,
    source_name: null,
    list_date: null,
    sale_date: null,
    net_profit: null,
    days_to_sell: null,
    sale_price: null,
    sale_status: null,
    grade_value: null,
    grade_label: null,
    ...overrides,
  } as unknown as ItemFullRow;
}

const OPEN: DateRange = { from: null, to: null };

describe("sellThroughByGroup", () => {
  it("ignores items with neither a list nor sale date in range", () => {
    const items = [makeItem({ category: "Shoes" })]; // no dates at all
    expect(sellThroughByGroup(items, "category", OPEN)).toEqual([]);
  });

  it("counts listed and sold, computes sell-through, avg profit, median days", () => {
    const items = [
      makeItem({ category: "Shoes", list_date: "2026-01-01", sale_date: "2026-01-10", net_profit: 10, days_to_sell: 9 }),
      makeItem({ category: "Shoes", list_date: "2026-01-02", sale_date: "2026-01-20", net_profit: 30, days_to_sell: 18 }),
      makeItem({ category: "Shoes", list_date: "2026-01-03" }), // listed only
    ];
    const row = sellThroughByGroup(items, "category", OPEN)[0]!;
    expect(row.group).toBe("Shoes");
    expect(row.listed).toBe(3);
    expect(row.sold).toBe(2);
    expect(row.sellThrough).toBeCloseTo(2 / 3);
    expect(row.avgNetProfit).toBe(20); // (10 + 30) / 2
    expect(row.medianDaysToSell).toBe(13.5); // median of [9, 18]
  });

  it("returns sellThrough=null for a group that only sold (nothing listed in range)", () => {
    const items = [makeItem({ category: "Bags", sale_date: "2026-02-01" })];
    const row = sellThroughByGroup(items, "category", OPEN)[0]!;
    expect(row.listed).toBe(0);
    expect(row.sold).toBe(1);
    expect(row.sellThrough).toBeNull();
    expect(row.avgNetProfit).toBeNull(); // no finite net_profit pushed
    expect(row.medianDaysToSell).toBeNull();
  });

  it("excludes non-finite net_profit / days_to_sell from the stats", () => {
    const items = [
      makeItem({ category: "X", sale_date: "2026-01-05", net_profit: Number.NaN, days_to_sell: Infinity }),
      makeItem({ category: "X", sale_date: "2026-01-06", net_profit: 5, days_to_sell: 4 }),
    ];
    const row = sellThroughByGroup(items, "category", OPEN)[0]!;
    expect(row.avgNetProfit).toBe(5); // NaN filtered out
    expect(row.medianDaysToSell).toBe(4); // Infinity filtered out
  });

  it("honors the from/to date bounds", () => {
    const range: DateRange = { from: "2026-03-01", to: "2026-03-31" };
    const items = [
      makeItem({ category: "Y", list_date: "2026-02-15" }), // before from → excluded
      makeItem({ category: "Y", list_date: "2026-04-15" }), // after to → excluded
      makeItem({ category: "Y", list_date: "2026-03-15" }), // in range
    ];
    const row = sellThroughByGroup(items, "category", range)[0]!;
    expect(row.listed).toBe(1);
  });

  it("groups by brand and source with the right empty-value fallbacks", () => {
    const items = [
      makeItem({ brand: "  ", source_name: "Goodwill", list_date: "2026-01-01" }),
      makeItem({ brand: "Nike", source_name: null, list_date: "2026-01-01" }),
    ];
    expect(sellThroughByGroup(items, "brand", OPEN).map((r) => r.group).sort()).toEqual(["Nike", "No brand"]);
    expect(sellThroughByGroup(items, "source", OPEN).map((r) => r.group).sort()).toEqual(["Goodwill", "No source"]);
  });

  it("uses the Uncategorized fallback for a blank category", () => {
    const items = [makeItem({ category: "   ", list_date: "2026-01-01" })];
    expect(sellThroughByGroup(items, "category", OPEN)[0]!.group).toBe("Uncategorized");
  });

  it("sorts groups by sold desc, then listed desc", () => {
    const items = [
      makeItem({ category: "Low", list_date: "2026-01-01" }), // 1 listed, 0 sold
      makeItem({ category: "High", list_date: "2026-01-01", sale_date: "2026-01-02" }), // 1 sold
    ];
    expect(sellThroughByGroup(items, "category", OPEN).map((r) => r.group)).toEqual(["High", "Low"]);
  });
});

describe("gradingRoiBuckets", () => {
  function sold(category: string, price: number, grade: number | null, profit: number): ItemFullRow {
    return makeItem({ category, sale_price: price, grade_value: grade, net_profit: profit });
  }

  it("excludes items without a finite sale price", () => {
    expect(gradingRoiBuckets([makeItem({ category: "Shoes", grade_value: 8 })])).toEqual([]);
  });

  it("buckets by category and price band and computes the net-profit lift", () => {
    const items = [
      ...Array.from({ length: MIN_BUCKET_SIZE }, () => sold("Shoes", 100, 8, 40)),
      ...Array.from({ length: MIN_BUCKET_SIZE }, () => sold("Shoes", 100, null, 25)),
    ];
    const bucket = gradingRoiBuckets(items)[0]!;
    expect(bucket.category).toBe("Shoes");
    expect(bucket.band).toBe("$50–150");
    expect(bucket.netProfitLift).toBe(15); // 40 - 25
    expect(bucket.meaningful).toBe(true);
  });

  it("flags lift=null and meaningful=false when a side is empty / too small", () => {
    const items = [sold("Bags", 200, 9, 60)]; // only graded, 1 item, $150+ band
    const bucket = gradingRoiBuckets(items)[0]!;
    expect(bucket.band).toBe("$150+");
    expect(bucket.netProfitLift).toBeNull(); // ungraded side empty
    expect(bucket.meaningful).toBe(false);
  });

  it("places a price below $50 in the Under $50 band and uses Uncategorized fallback", () => {
    const bucket = gradingRoiBuckets([sold("  ", 30, 7, 5)])[0]!;
    expect(bucket.category).toBe("Uncategorized");
    expect(bucket.band).toBe("Under $50");
  });

  it("sorts by category then price band order", () => {
    const items = [sold("Zeta", 200, 8, 1), sold("Alpha", 30, 8, 1), sold("Alpha", 200, 8, 1)];
    const out = gradingRoiBuckets(items).map((b) => `${b.category}/${b.band}`);
    expect(out).toEqual(["Alpha/Under $50", "Alpha/$150+", "Zeta/$150+"]);
  });
});

describe("itemSaleOutcome", () => {
  it("returns null for an ungraded item", () => {
    expect(itemSaleOutcome(makeItem({ grade_value: null, sale_price: 50 }))).toBeNull();
  });

  it("returns null when the sale isn't realized (refunded / no price)", () => {
    expect(itemSaleOutcome(makeItem({ grade_value: 8, sale_price: 50, sale_status: "refunded" }))).toBeNull();
    expect(itemSaleOutcome(makeItem({ grade_value: 8, sale_price: null }))).toBeNull();
  });

  it("surfaces the outcome for a graded, realized sale (legacy null status counts)", () => {
    const out = itemSaleOutcome(
      makeItem({
        grade_value: 7.5,
        grade_label: "Very Good",
        sale_price: 42,
        net_profit: 18,
        days_to_sell: 12,
        sale_date: "2026-01-09",
        sale_status: null,
      }),
    );
    expect(out).toEqual({
      grade: 7.5,
      gradeLabel: "Very Good",
      salePrice: 42,
      netProfit: 18,
      daysToSell: 12,
      soldAt: "2026-01-09",
    });
  });

  it("nulls non-finite net profit / days to sell", () => {
    const out = itemSaleOutcome(
      makeItem({ grade_value: 6, sale_price: 20, net_profit: Number.NaN, days_to_sell: Infinity, sale_status: "completed" }),
    );
    expect(out?.netProfit).toBeNull();
    expect(out?.daysToSell).toBeNull();
  });
});

describe("accountGradingRollup", () => {
  function realized(grade: number | null, profit: number, days: number): ItemFullRow {
    return makeItem({ grade_value: grade, sale_price: 100, net_profit: profit, days_to_sell: days, sale_status: "completed" });
  }

  it("computes daysFaster, netHigher and pays-for-itself across realized sales", () => {
    const items = [
      ...Array.from({ length: MIN_BUCKET_SIZE }, () => realized(8, 40, 7)),
      ...Array.from({ length: MIN_BUCKET_SIZE }, () => realized(null, 25, 21)),
    ];
    const r = accountGradingRollup(items);
    expect(r.daysFaster).toBe(14); // 21 - 7
    expect(r.netHigher).toBe(15); // 40 - 25
    expect(r.paysForItselfInSales).toBe(Math.ceil(GRADE_FEE_USD / 15));
    expect(r.meaningful).toBe(true);
  });

  it("nulls the lifts when a side has no sales, and pays-for-itself when there's no positive lift", () => {
    const r = accountGradingRollup([realized(8, 10, 5)]); // graded only
    expect(r.daysFaster).toBeNull();
    expect(r.netHigher).toBeNull();
    expect(r.paysForItselfInSales).toBeNull();
    expect(r.meaningful).toBe(false);
  });

  it("returns paysForItselfInSales=null when graded nets the same or less", () => {
    const items = [
      ...Array.from({ length: MIN_BUCKET_SIZE }, () => realized(8, 10, 9)),
      ...Array.from({ length: MIN_BUCKET_SIZE }, () => realized(null, 20, 9)), // ungraded nets MORE
    ];
    const r = accountGradingRollup(items);
    expect(r.netHigher).toBe(-10);
    expect(r.paysForItselfInSales).toBeNull();
  });
});

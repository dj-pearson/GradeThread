// US-2825. Four ways this arithmetic lies, and the ranking that depends on all
// four being handled: a free item dividing by zero capital, a same-day sale
// dividing by zero days, a group that never sells scoring 0 and reading as
// merely average, and unranked groups sorting as though 0 were their score.

import { describe, expect, it } from "vitest";
import {
  capitalVelocity,
  deadestCapital,
  MIN_HOLD_DAYS,
  MIN_VELOCITY_SALES,
  rankedGroups,
  type VelocityFields,
} from "@/lib/capital-velocity";

const AS_OF = "2026-08-23";

function item(over: Partial<VelocityFields> = {}): VelocityFields {
  return {
    purchase_price: 20,
    purchase_date: "2026-01-01",
    sale_date: "2026-01-31",
    sale_status: "completed",
    net_profit: 30,
    category: "Outerwear",
    brand: "Carhartt",
    source_name: "Bishop Ave",
    ...over,
  };
}

/** N identical sold items, so a group clears MIN_VELOCITY_SALES. */
function sold(n: number, over: Partial<VelocityFields> = {}): VelocityFields[] {
  return Array.from({ length: n }, () => item(over));
}

describe("capitalVelocity", () => {
  it("computes percent returned per dollar per day", () => {
    // $30 profit on $20 of capital over 30 days = 5% per day.
    const r = capitalVelocity(sold(3), "category", AS_OF);
    const row = r.rows[0]!;
    expect(row.group).toBe("Outerwear");
    expect(row.soldItems).toBe(3);
    expect(row.deployedCapital).toBe(60);
    expect(row.realizedProfit).toBe(90);
    expect(row.medianDaysHeld).toBe(30);
    expect(row.velocityPctPerDay).toBeCloseTo(5, 6);
  });

  it("excludes a zero or null purchase price and counts it separately", () => {
    // The trap: a free item has infinite return on capital and would take the
    // top of the ranking forever.
    const r = capitalVelocity(
      [...sold(3), item({ purchase_price: 0 }), item({ purchase_price: null })],
      "category",
      AS_OF,
    );
    const row = r.rows[0]!;
    expect(row.unpricedItems).toBe(2);
    expect(r.unpricedItems).toBe(2);
    // Capital and profit come only from the three priced items.
    expect(row.deployedCapital).toBe(60);
    expect(row.velocityPctPerDay).toBeCloseTo(5, 6);
    expect(Number.isFinite(row.velocityPctPerDay!)).toBe(true);
  });

  it("clamps a same-day sale rather than dividing by zero days", () => {
    const r = capitalVelocity(
      sold(3, { purchase_date: "2026-02-10", sale_date: "2026-02-10" }),
      "category",
      AS_OF,
    );
    const row = r.rows[0]!;
    expect(row.medianDaysHeld).toBe(0);
    // 30 / 20 / 1 day = 150% per day. Large, real, and finite.
    expect(row.velocityPctPerDay).toBeCloseTo((30 / 20 / MIN_HOLD_DAYS) * 100, 6);
    expect(Number.isFinite(row.velocityPctPerDay!)).toBe(true);
  });

  it("reports a group with no sales as parked capital, not as a zero score", () => {
    const r = capitalVelocity(
      [
        item({ category: "Denim", sale_date: null, sale_status: null, purchase_price: 40 }),
        item({ category: "Denim", sale_date: null, sale_status: null, purchase_price: 60 }),
      ],
      "category",
      AS_OF,
    );
    const denim = r.rows.find((x) => x.group === "Denim")!;
    expect(denim.velocityPctPerDay).toBeNull();
    expect(denim.parkedCapital).toBe(100);
    expect(denim.parkedItems).toBe(2);
    expect(denim.deployedCapital).toBe(0);
    // Excluding it entirely would make a group that never sells look like a
    // group that does not exist.
    expect(denim.medianDaysParked).toBeGreaterThan(0);
  });

  it("withholds velocity under the sales floor", () => {
    const r = capitalVelocity(sold(MIN_VELOCITY_SALES - 1), "category", AS_OF);
    expect(r.rows[0]!.velocityPctPerDay).toBeNull();
    expect(r.rows[0]!.soldItems).toBe(MIN_VELOCITY_SALES - 1);
  });

  it("counts only completed sales as realized", () => {
    const r = capitalVelocity(
      [...sold(3), item({ sale_status: "refunded" }), item({ sale_status: "cancelled" })],
      "category",
      AS_OF,
    );
    const row = r.rows[0]!;
    expect(row.soldItems).toBe(3);
    // The refunded and cancelled items still hold capital, so they are parked.
    expect(row.parkedItems).toBe(2);
  });

  it("groups by brand and by source, not only by category", () => {
    const items = [
      ...sold(3, { brand: "Carhartt", source_name: "Bishop Ave" }),
      ...sold(3, { brand: "Levi's", source_name: "The bins", net_profit: 6 }),
    ];
    expect(
      capitalVelocity(items, "brand", AS_OF).rows.map((r) => r.group),
    ).toEqual(["Carhartt", "Levi's"]);
    expect(
      capitalVelocity(items, "source", AS_OF).rows.map((r) => r.group).sort(),
    ).toEqual(["Bishop Ave", "The bins"]);
  });

  it("labels missing group values instead of dropping the rows", () => {
    const r = capitalVelocity(
      sold(3, { category: null, brand: "  ", source_name: null }),
      "category",
      AS_OF,
    );
    expect(r.rows[0]!.group).toBe("Uncategorized");
    expect(capitalVelocity(sold(3, { brand: "  " }), "brand", AS_OF).rows[0]!.group)
      .toBe("No brand");
  });

  it("ignores a sale dated before its purchase rather than going negative", () => {
    const r = capitalVelocity(
      sold(3, { purchase_date: "2026-03-01", sale_date: "2026-02-01" }),
      "category",
      AS_OF,
    );
    // No usable hold length, so no velocity — not a negative day count.
    expect(r.rows[0]!.medianDaysHeld).toBeNull();
    expect(r.rows[0]!.velocityPctPerDay).toBeNull();
  });
});

describe("ranking", () => {
  it("sorts best velocity first", () => {
    const items = [
      ...sold(3, { category: "Fast", net_profit: 30, purchase_price: 20 }),
      ...sold(3, {
        category: "Slow",
        net_profit: 30,
        purchase_price: 20,
        purchase_date: "2026-01-01",
        sale_date: "2026-07-01",
      }),
    ];
    expect(
      capitalVelocity(items, "category", AS_OF).rows.map((r) => r.group),
    ).toEqual(["Fast", "Slow"]);
  });

  it("sorts unranked groups LAST, not as though zero were their score", () => {
    // A group with no velocity is unknown, not worst. Sorting it as 0 would
    // bury a group that simply has not sold three items yet beneath a group
    // that is genuinely losing money.
    const items = [
      ...sold(3, { category: "Losing", net_profit: -10 }),
      item({ category: "New", sale_date: null, sale_status: null }),
    ];
    const rows = capitalVelocity(items, "category", AS_OF).rows;
    expect(rows.map((r) => r.group)).toEqual(["Losing", "New"]);
    expect(rows[0]!.velocityPctPerDay).toBeLessThan(0);
    expect(rows[1]!.velocityPctPerDay).toBeNull();
  });

  it("rankedGroups keeps only the ones with a real number", () => {
    const items = [
      ...sold(3, { category: "Fast" }),
      item({ category: "New", sale_date: null, sale_status: null }),
    ];
    const report = capitalVelocity(items, "category", AS_OF);
    expect(rankedGroups(report).map((r) => r.group)).toEqual(["Fast"]);
  });
});

describe("deadestCapital", () => {
  it("names the group holding the most money that has returned nothing", () => {
    const items = [
      item({ category: "Denim", sale_date: null, sale_status: null, purchase_price: 400 }),
      item({ category: "Shoes", sale_date: null, sale_status: null, purchase_price: 40 }),
      ...sold(3, { category: "Outerwear" }),
    ];
    const report = capitalVelocity(items, "category", AS_OF);
    expect(deadestCapital(report)?.group).toBe("Denim");
  });

  it("is null when every group has sold something", () => {
    const report = capitalVelocity(sold(3), "category", AS_OF);
    expect(deadestCapital(report)).toBeNull();
  });
});

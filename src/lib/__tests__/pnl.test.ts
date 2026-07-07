import { describe, expect, it } from "vitest";
import { computePnl, detectDiscrepancies } from "../pnl";
import type { SaleRow } from "@/types/database";

function sale(opts: Partial<{
  sale_price: number | null;
  shipping_collected: number | null;
  platform_fees: number | null;
  payment_processing_fees: number | null;
  shipping_cost: number | null;
  grading_cost: number | null;
  other_costs: number | null;
}>): SaleRow {
  return {
    sale_price: opts.sale_price ?? null,
    shipping_collected: opts.shipping_collected ?? null,
    platform_fees: opts.platform_fees ?? null,
    payment_processing_fees: opts.payment_processing_fees ?? null,
    shipping_cost: opts.shipping_cost ?? null,
    grading_cost: opts.grading_cost ?? null,
    other_costs: opts.other_costs ?? null,
  } as unknown as SaleRow;
}

describe("computePnl", () => {
  it("computes revenue, fees, costs, net and margin from a full sale", () => {
    const p = computePnl(
      sale({
        sale_price: 100,
        shipping_collected: 10,
        platform_fees: 13,
        payment_processing_fees: 3,
        shipping_cost: 8,
        grading_cost: 5,
        other_costs: 1,
      }),
      20,
    );
    expect(p.revenue).toBe(110); // 100 + 10
    expect(p.fees).toBe(16); // 13 + 3
    expect(p.costs).toBe(14); // 8 + 5 + 1
    expect(p.costBasis).toBe(20);
    expect(p.net).toBe(60); // 110 - 16 - 14 - 20
    expect(p.marginPct).toBeCloseTo(60, 5); // net / sale_price * 100
  });

  it("treats every missing field as 0 and null cost basis as 0", () => {
    const p = computePnl(sale({}), null);
    expect(p.revenue).toBe(0);
    expect(p.fees).toBe(0);
    expect(p.costs).toBe(0);
    expect(p.costBasis).toBe(0);
    expect(p.net).toBe(0);
    expect(p.marginPct).toBeNull(); // sale_price is 0/null
  });

  it("returns null margin when sale_price is zero", () => {
    const p = computePnl(sale({ sale_price: 0, shipping_collected: 5 }), 0);
    expect(p.revenue).toBe(5);
    expect(p.marginPct).toBeNull();
  });
});

describe("detectDiscrepancies", () => {
  it("flags marketplace fees over 15% of the sale price", () => {
    const out = detectDiscrepancies(sale({ sale_price: 100, platform_fees: 20 }));
    expect(out.some((m) => m.includes("Marketplace fees"))).toBe(true);
  });

  it("flags shipping cost more than $2 over what the buyer paid", () => {
    const out = detectDiscrepancies(
      sale({ sale_price: 50, shipping_collected: 5, shipping_cost: 9 }),
    );
    expect(out.some((m) => m.includes("Shipping cost"))).toBe(true);
  });

  it("returns no discrepancies for a clean sale", () => {
    const out = detectDiscrepancies(
      sale({ sale_price: 100, platform_fees: 10, shipping_collected: 8, shipping_cost: 8 }),
    );
    expect(out).toEqual([]);
  });

  it("does not flag fees when there is no sale price", () => {
    const out = detectDiscrepancies(sale({ sale_price: 0, platform_fees: 99 }));
    expect(out.some((m) => m.includes("Marketplace fees"))).toBe(false);
  });
});

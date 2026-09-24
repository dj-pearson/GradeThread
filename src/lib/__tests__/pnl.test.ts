import { describe, expect, it } from "vitest";
import {
  computePnl,
  detectDiscrepancies,
  detectFeeDiscrepancy,
  salePlatform,
} from "../pnl";
import { quoteMarketplace } from "@/lib/marketplace-fee-schedules";
import type { SaleRow } from "@/types/database";

function sale(opts: Partial<{
  sale_price: number | null;
  shipping_collected: number | null;
  platform_fees: number | null;
  payment_processing_fees: number | null;
  shipping_cost: number | null;
  grading_cost: number | null;
  other_costs: number | null;
  tax: number | null;
  status: SaleRow["status"];
  platform_order_ref: Record<string, unknown> | null;
}>): SaleRow {
  return {
    status: opts.status ?? "completed",
    tax: opts.tax ?? 0,
    platform_order_ref: opts.platform_order_ref ?? null,
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

describe("detectFeeDiscrepancy (Money M9)", () => {
  it("does not flag a normal Poshmark sale ($40, $8 = 20%)", () => {
    expect(
      detectFeeDiscrepancy(sale({ sale_price: 40, platform_fees: 8 }), "poshmark"),
    ).toBeNull();
  });

  it("does not flag a small eBay sale charged on schedule", () => {
    const expected = quoteMarketplace("ebay", {
      itemPrice: 20,
      shippingCharged: 0,
      salesTax: 0,
    }).totalFees;
    // The flat 15% rule flagged this: the $0.40 order fee is 2% of $20.
    expect(expected / 20).toBeGreaterThan(0.15);
    expect(
      detectFeeDiscrepancy(sale({ sale_price: 20, platform_fees: expected }), "ebay"),
    ).toBeNull();
  });

  it("flags an eBay sale charged $5 over schedule, with the expected amount", () => {
    const expected = quoteMarketplace("ebay", {
      itemPrice: 60,
      shippingCharged: 8,
      salesTax: 4,
    }).totalFees;
    const out = detectFeeDiscrepancy(
      sale({ sale_price: 60, shipping_collected: 8, tax: 4, platform_fees: expected + 5 }),
      "ebay",
    );
    expect(out).not.toBeNull();
    expect(out!.expected).toBeCloseTo(expected, 2);
    expect(out!.overBy).toBeCloseTo(5, 2);
  });

  it("never flags a refunded or cancelled sale", () => {
    for (const status of ["refunded", "cancelled"] as const) {
      expect(
        detectFeeDiscrepancy(
          sale({ sale_price: 40, platform_fees: 30, status }),
          "poshmark",
        ),
      ).toBeNull();
      expect(
        detectDiscrepancies(
          sale({ sale_price: 40, platform_fees: 30, shipping_cost: 20, status }),
          "poshmark",
        ),
      ).toEqual([]);
    }
  });

  it("skips the fee rule when the platform is unknown", () => {
    expect(detectFeeDiscrepancy(sale({ sale_price: 100, platform_fees: 60 }), null)).toBeNull();
  });

  it("allows up to max($1, 10%) over schedule", () => {
    // Poshmark $100 = $20 expected; $22 is 10% over, $22.01 is past it.
    expect(
      detectFeeDiscrepancy(sale({ sale_price: 100, platform_fees: 22 }), "poshmark"),
    ).toBeNull();
    expect(
      detectFeeDiscrepancy(sale({ sale_price: 100, platform_fees: 22.5 }), "poshmark"),
    ).not.toBeNull();
  });
});

describe("salePlatform", () => {
  it("prefers the marketplace's own order reference", () => {
    expect(salePlatform(sale({ platform_order_ref: { platform: "depop" } }), "ebay")).toBe(
      "depop",
    );
  });
  it("falls back to the item's listing platform", () => {
    expect(salePlatform(sale({}), "mercari")).toBe("mercari");
  });
  it("is null for a platform with no schedule", () => {
    expect(salePlatform(sale({}), "grailed")).toBeNull();
    expect(salePlatform(sale({}), null)).toBeNull();
  });
});

describe("detectDiscrepancies", () => {
  it("flags fees over the platform's schedule", () => {
    const out = detectDiscrepancies(sale({ sale_price: 100, platform_fees: 30 }), "poshmark");
    expect(out.some((m) => m.includes("expected about $20.00"))).toBe(true);
  });

  it("flags shipping cost more than $2 over what the buyer paid", () => {
    const out = detectDiscrepancies(
      sale({ sale_price: 50, shipping_collected: 5, shipping_cost: 9 }),
    );
    expect(out.some((m) => m.includes("Shipping cost"))).toBe(true);
  });

  it("returns no discrepancies for a clean sale", () => {
    const out = detectDiscrepancies(
      sale({ sale_price: 100, platform_fees: 20, shipping_collected: 8, shipping_cost: 8 }),
      "poshmark",
    );
    expect(out).toEqual([]);
  });

  it("does not flag fees when there is no sale price", () => {
    const out = detectDiscrepancies(sale({ sale_price: 0, platform_fees: 99 }), "poshmark");
    expect(out.some((m) => m.includes("fees"))).toBe(false);
  });
});

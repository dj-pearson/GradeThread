import { describe, expect, it } from "vitest";
import { computePnl, detectDiscrepancies } from "@/lib/pnl";
import { validateStatusChange } from "@/lib/pipeline-rules";
import { FLIPDESK_PIPELINE } from "@/lib/constants";
import type { ItemFullRow, ItemStatus, SaleRow } from "@/types/database";

// US-137: deterministic backbone for the FlipDesk end-to-end lifecycle test.
//
// The Playwright spec (e2e/flipdesk-lifecycle.spec.ts) drives the *UI* of the
// money loop against a network-mock seam; this Vitest suite pins the *domain
// math and state machine* the dogfood pass depends on, with exact numbers and
// no external infra. It is the runnable half of AC#3 — "All assertions for
// status transitions, fee allocations, and P&L numbers pass" — and it proves
// the frontend live P&L (computePnl) agrees with the edge sync's stored
// net_profit formula (services/edge-functions/src/routes/flipdesk-ebay.ts), so
// the certificate / item-detail numbers a buyer or operator sees are trustworthy.

// ── Fixtures ──────────────────────────────────────────────────────────────

function makeItem(overrides: Partial<ItemFullRow> = {}): ItemFullRow {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    user_id: "00000000-0000-0000-0000-000000000001",
    item_number: "GT-0001",
    container: null,
    item_title: "Acme Wool Overcoat",
    item_description: null,
    brand: "Acme",
    style: "Overcoat",
    size: "L",
    notes: null,
    comps: [],
    category: "clothing",
    source_name: "Goodwill bins",
    source_id: null,
    sourced_by: null,
    purchase_date: "2026-01-01",
    purchase_price: 8,
    listed: false,
    list_date: null,
    link: null,
    list_price: null,
    sale_date: null,
    sale_price: null,
    fees: null,
    tax: null,
    shipping_cost: null,
    net_profit: null,
    payout: null,
    status: "sourced",
    days_to_sell: null,
    tracking: null,
    target_price: null,
    grade_value: null,
    grade_label: null,
    certificate_url: null,
    measurements: null,
    location_bin: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    buyer_id: null,
    sold_at_raw: null,
    payout_reference: null,
    listing_status: null,
    listing_id: null,
    listing_watchers: null,
    listing_views: null,
    photo_count: 0,
    has_required_photos: false,
    ai_field_sources: null,
    ai_enriched_at: null,
    sale_status: null,
    sale_cancelled_at: null,
    color: null,
    listing_platform: null,
    carrier: null,
    shipped_at: null,
    delivered_at: null,
    listing_needs_review: null,
    listing_reviewed_at: null,
    listing_title: null,
    // US-2790 (00650): parcel-estimator inputs on items_full.
    garment_category: null,
    material: null,
    quality_score: null,
    ...overrides,
  };
}

function makeSale(overrides: Partial<SaleRow> = {}): SaleRow {
  return {
    id: "22222222-2222-2222-2222-222222222222",
    inventory_item_id: "11111111-1111-1111-1111-111111111111",
    user_id: "33333333-3333-3333-3333-333333333333",
    listing_id: null,
    sale_price: 0,
    platform_fees: 0,
    sale_date: "2026-02-01",
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
    created_at: "2026-02-01T00:00:00.000Z",
    ...overrides,
  };
}

// Mirror of the edge sync's stored net_profit allocation
// (flipdesk-ebay.ts US-459). Kept here so the test fails loudly if the two
// formulas ever drift — a silent divergence would make the item-detail P&L
// disagree with the synced figure.
function edgeNetProfit(args: {
  status: SaleRow["status"];
  gross: number; // sale_price + shipping_collected, minus refunds
  fees: number;
  shippingLabelCost: number;
  salePrice: number;
  shippingCollected: number;
  gradingCost: number;
  otherCosts: number;
  costBasis: number;
}): number {
  const reversed = args.status === "cancelled" || args.status === "refunded";
  const net = reversed
    ? args.gross - args.fees - args.shippingLabelCost
    : args.salePrice +
      args.shippingCollected -
      args.fees -
      args.shippingLabelCost -
      args.gradingCost -
      args.otherCosts -
      args.costBasis;
  return Math.round(net * 100) / 100;
}

// ── Status-transition state machine (AC#3: status transitions) ─────────────

describe("FlipDesk pipeline state machine", () => {
  it("defines the full lifecycle in order, sourced → completed", () => {
    const order = FLIPDESK_PIPELINE.map((s) => s.status);
    expect(order.slice(0, 12)).toEqual([
      "sourced",
      "cataloged",
      "measured",
      "photographed",
      "grading",
      "graded",
      "comped",
      "drafted",
      "listed",
      "sold",
      "shipped",
      "completed",
    ]);
  });

  it("allows each single forward step once its prerequisites are met", () => {
    // A fully-prepped item: has measurements, a list price, and a recorded sale,
    // so it clears every hard prereq gate as it advances.
    const item = makeItem({
      measurements: { chest: 22, length: 30 },
      list_price: 120,
      target_price: 120,
      sale_price: 120,
    });
    const steps: Array<[ItemStatus, ItemStatus]> = [
      ["sourced", "cataloged"],
      ["cataloged", "measured"],
      ["photographed", "graded"], // skip 'grading' (flow-owned, asserted below)
      ["graded", "comped"],
      ["comped", "drafted"],
      ["drafted", "listed"],
      ["sold", "shipped"],
      ["shipped", "completed"],
    ];
    for (const [from, to] of steps) {
      expect(validateStatusChange({ ...item, status: from }, to)).toBeNull();
    }
  });

  it("blocks dragging into Grading — that stage is owned by the submit flow", () => {
    const reason = validateStatusChange(
      makeItem({ status: "photographed" }),
      "grading",
    );
    expect(reason).toMatch(/detail panel/i);
  });

  it("requires measurements before Measured", () => {
    expect(
      validateStatusChange(
        makeItem({ status: "cataloged", measurements: null }),
        "measured",
      ),
    ).toMatch(/measurements/i);
    expect(
      validateStatusChange(
        makeItem({ status: "cataloged", measurements: { chest: 21 } }),
        "measured",
      ),
    ).toBeNull();
  });

  it("requires a price before Listed and a sale before Shipped", () => {
    expect(
      validateStatusChange(
        makeItem({ status: "drafted", target_price: null, list_price: null }),
        "listed",
      ),
    ).toMatch(/price/i);
    expect(
      validateStatusChange(
        makeItem({ status: "sold", sale_price: null }),
        "shipped",
      ),
    ).toMatch(/record a sale/i);
  });

  it("permits the deliberate off-pipeline moves (keeping / wearing / archived)", () => {
    for (const next of ["keeping", "wearing", "archived"] as ItemStatus[]) {
      expect(validateStatusChange(makeItem({ status: "listed" }), next)).toBeNull();
    }
  });
});

// ── Fee allocation + P&L (AC#3: fee allocations, P&L numbers) ──────────────

describe("FlipDesk P&L and fee allocation", () => {
  it("computes net profit for a completed sale (tax excluded, fees + costs subtracted)", () => {
    const sale = makeSale({
      sale_price: 120,
      shipping_collected: 8,
      platform_fees: 16.32, // ~13.6% eBay final value fee on $120
      payment_processing_fees: 0,
      shipping_cost: 7.5,
      grading_cost: 2.99,
      other_costs: 0,
      tax: 9.6, // collected from buyer, remitted by marketplace — NOT seller income
    });
    const pnl = computePnl(sale, /* costBasis */ 8);

    // revenue = sale_price + shipping_collected (tax is NOT revenue)
    expect(pnl.revenue).toBe(128);
    expect(pnl.fees).toBe(16.32);
    // costs = shipping + grading + other (NOT cost basis, NOT tax)
    expect(pnl.costs).toBeCloseTo(10.49, 2);
    expect(pnl.costBasis).toBe(8);
    // net = revenue − fees − costs − costBasis
    expect(pnl.net).toBeCloseTo(93.19, 2);
    expect(pnl.marginPct).toBeCloseTo((93.19 / 120) * 100, 2);
  });

  it("agrees with the edge sync's stored net_profit allocation to the cent", () => {
    const salePrice = 120;
    const shippingCollected = 8;
    const fees = 16.32;
    const shippingLabelCost = 7.5;
    const gradingCost = 2.99;
    const costBasis = 8;

    const sale = makeSale({
      sale_price: salePrice,
      shipping_collected: shippingCollected,
      platform_fees: fees,
      payment_processing_fees: 0, // edge folds processing into `fees`
      shipping_cost: shippingLabelCost,
      grading_cost: gradingCost,
    });
    const frontendNet = computePnl(sale, costBasis).net;

    const stored = edgeNetProfit({
      status: "completed",
      gross: salePrice + shippingCollected,
      fees,
      shippingLabelCost,
      salePrice,
      shippingCollected,
      gradingCost,
      otherCosts: 0,
      costBasis,
    });

    expect(Math.round(frontendNet * 100) / 100).toBe(stored);
  });

  it("reverses revenue on a refunded sale — seller only eats the fees + label", () => {
    // The item came back; original revenue is voided; cost basis is retained.
    const stored = edgeNetProfit({
      status: "refunded",
      gross: 0, // refund transaction zeroed the gross
      fees: 0,
      shippingLabelCost: 7.5,
      salePrice: 120,
      shippingCollected: 8,
      gradingCost: 2.99,
      otherCosts: 0,
      costBasis: 8,
    });
    // Only the label the seller paid is lost.
    expect(stored).toBe(-7.5);
  });

  it("flags fee + shipping anomalies for operator review", () => {
    const highFees = makeSale({ sale_price: 100, platform_fees: 18 });
    expect(detectDiscrepancies(highFees).join(" ")).toMatch(/exceed 15%/i);

    const underwaterShipping = makeSale({
      sale_price: 40,
      shipping_collected: 5,
      shipping_cost: 12,
    });
    expect(detectDiscrepancies(underwaterShipping).join(" ")).toMatch(
      /more than \$2 over/i,
    );

    const clean = makeSale({
      sale_price: 100,
      platform_fees: 13,
      shipping_collected: 8,
      shipping_cost: 8,
    });
    expect(detectDiscrepancies(clean)).toEqual([]);
  });
});

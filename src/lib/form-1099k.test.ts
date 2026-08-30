import { describe, it, expect } from "vitest";
import {
  bridgeRows,
  bridgeAddsUp,
  varianceCauses,
  type Bridge1099k,
} from "./form-1099k";

// US-2988. The aggregation is checked against Postgres by
// scripts/check-1099k-bridge.mjs; this covers the statement the seller reads.

/** The eBay 2026 bridge the fixture actually produced on Postgres. */
function ebay(over: Partial<Bridge1099k> = {}): Bridge1099k {
  return {
    platform: "ebay",
    tax_year: 2026,
    from: "2026-01-01",
    to: "2027-01-01",
    form_present: true,
    reported_gross_cents: 12324,
    payer_name: "eBay Commerce Inc.",
    payer_tin_last4: "4821",
    reported_transaction_count: 2,
    computed_gross_cents: 11824,
    sale_count: 1,
    variance_cents: 500,
    facilitator_tax_cents: 825,
    remitted_tax_cents: 0,
    shipping_income_cents: 999,
    fees_cents: -1590,
    shipping_cents: -750,
    cogs_cents: -3000,
    returns_cents: 0,
    profit_before_overheads_cents: 5659,
    ...over,
  };
}

/** The Shopify 2026 bridge, same money, opposite tax branch. */
function shopify(over: Partial<Bridge1099k> = {}): Bridge1099k {
  return ebay({
    platform: "shopify",
    form_present: false,
    reported_gross_cents: null,
    payer_name: null,
    payer_tin_last4: null,
    reported_transaction_count: null,
    variance_cents: 0,
    facilitator_tax_cents: 0,
    remitted_tax_cents: -825,
    ...over,
  });
}

describe("the bridge adds up", () => {
  it("walks from the reported figure to profit", () => {
    // A bridge whose visible arithmetic does not reach its own total is worse
    // than no bridge: the seller checks it with a calculator, it fails, and
    // they stop trusting every other number in the app.
    expect(bridgeAddsUp(bridgeRows(ebay()))).toBe(true);
  });

  it("adds up on the other tax branch too", () => {
    expect(bridgeAddsUp(bridgeRows(shopify()))).toBe(true);
  });

  it("adds up when there is no form at all", () => {
    expect(bridgeAddsUp(bridgeRows(ebay({ form_present: false, reported_gross_cents: null, variance_cents: 0 })))).toBe(true);
  });

  it("adds up when the variance runs the other way", () => {
    expect(bridgeAddsUp(bridgeRows(ebay({ reported_gross_cents: 11000, variance_cents: -824 })))).toBe(true);
  });

  it("catches a broken chain rather than reporting success", () => {
    // Guard the guard: bridgeAddsUp must be capable of saying no.
    const rows = bridgeRows(ebay());
    const fees = rows.find((r) => r.key === "fees");
    if (fees) fees.cents += 1;
    expect(bridgeAddsUp(rows)).toBe(false);
  });
});

describe("row shape", () => {
  it("starts at the number that frightens people", () => {
    // The seller opens this with the form in their hand, so the statement has
    // to begin where they are.
    const rows = bridgeRows(ebay());
    expect(rows[0]?.key).toBe("reported");
    expect(rows[0]?.cents).toBe(12324);
    expect(rows[0]?.source).toContain("eBay Commerce Inc.");
  });

  it("ends at what the sales left", () => {
    const rows = bridgeRows(ebay());
    expect(rows[rows.length - 1]?.key).toBe("profit");
    expect(rows[rows.length - 1]?.cents).toBe(5659);
  });

  it("names a source on every single row", () => {
    // "Fees: -$15.90" with nothing beside it is a number a seller cannot check.
    for (const r of bridgeRows(ebay())) {
      expect(r.source.length, `${r.key} has no source`).toBeGreaterThan(10);
    }
  });

  it("shows the facilitator tax as a subtraction and says it was never yours", () => {
    const row = bridgeRows(ebay()).find((r) => r.key === "facilitator_tax");
    expect(row?.cents).toBe(-825);
    expect(row?.source).toMatch(/never yours/i);
  });

  it("shows the seller-collected remittance instead on the other branch", () => {
    const rows = bridgeRows(shopify());
    expect(rows.some((r) => r.key === "facilitator_tax")).toBe(false);
    const remitted = rows.find((r) => r.key === "remitted_tax");
    expect(remitted?.cents).toBe(-825);
    expect(remitted?.source).toMatch(/line 23/);
  });

  it("omits rows that are zero rather than printing $0.00 noise", () => {
    const rows = bridgeRows(ebay({ returns_cents: 0, remitted_tax_cents: 0 }));
    expect(rows.some((r) => r.key === "returns")).toBe(false);
    expect(rows.some((r) => r.key === "remitted_tax")).toBe(false);
  });

  it("says overheads are deliberately absent", () => {
    // They are business-wide and not attributable to one platform. Splitting
    // them here would invent a number.
    const profit = bridgeRows(ebay()).find((r) => r.key === "profit");
    expect(profit?.source).toMatch(/not tied to one platform/i);
  });

  it("skips the variance row when the two figures agree", () => {
    const rows = bridgeRows(ebay({ reported_gross_cents: 11824, variance_cents: 0 }));
    expect(rows.some((r) => r.kind === "variance")).toBe(false);
  });
});

describe("varianceCauses", () => {
  it("says nothing when there is nothing to explain", () => {
    expect(varianceCauses(ebay({ variance_cents: 0 }))).toEqual([]);
    expect(varianceCauses(ebay({ form_present: false }))).toEqual([]);
  });

  it("leads with missing sales when the FORM is higher", () => {
    const causes = varianceCauses(ebay({ variance_cents: 500, reported_transaction_count: null }));
    expect(causes[0]?.title).toMatch(/never saw/i);
  });

  it("gives a completely different list when OUR figure is higher", () => {
    // The sign changes what could have happened. A shrug that ignores it sends
    // the seller hunting for the wrong thing.
    const causes = varianceCauses(
      ebay({ variance_cents: -500, reported_transaction_count: null }),
    );
    expect(causes[0]?.title).toMatch(/did not process/i);
    expect(causes.some((c) => /duplicate/i.test(c.title))).toBe(true);
  });

  it("leads with the transaction count when it disagrees, because it narrows fastest", () => {
    const causes = varianceCauses(ebay({ reported_transaction_count: 2, sale_count: 1 }));
    expect(causes[0]?.title).toMatch(/1 more transaction than we have sales/);
  });

  it("pluralises the count difference correctly", () => {
    expect(
      varianceCauses(ebay({ reported_transaction_count: 5, sale_count: 1 }))[0]?.title,
    ).toMatch(/4 more transactions/);
    expect(
      varianceCauses(ebay({ reported_transaction_count: 1, sale_count: 3 }))[0]?.title,
    ).toMatch(/2 more sales/);
  });

  it("does not lead with the count when it agrees", () => {
    const causes = varianceCauses(ebay({ reported_transaction_count: 1, sale_count: 1 }));
    expect(causes[0]?.title).not.toMatch(/transaction/);
  });

  it("always names the date boundary, whichever way the variance runs", () => {
    // The cause a seller would never guess, and the one that resolves itself.
    for (const v of [500, -500]) {
      const causes = varianceCauses(ebay({ variance_cents: v }));
      expect(causes.some((c) => /date/i.test(c.title))).toBe(true);
    }
  });
});

describe("the fixture's own numbers", () => {
  it("reproduces the profit Postgres computed", () => {
    // 118.24 gross - 8.25 tax - 15.90 fees - 7.50 shipping - 30.00 cost = 56.59
    const rows = bridgeRows(ebay());
    expect(rows.find((r) => r.key === "profit")?.cents).toBe(5659);
    expect(bridgeAddsUp(rows)).toBe(true);
  });

  it("reaches the same profit on the opposite branch", () => {
    // The assertion the database check makes too: identical sales on opposite
    // tax branches land in the same place.
    expect(
      bridgeRows(shopify()).find((r) => r.key === "profit")?.cents,
    ).toBe(bridgeRows(ebay()).find((r) => r.key === "profit")?.cents);
  });
});

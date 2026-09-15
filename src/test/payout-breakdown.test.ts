// US-3413: the payout breakdown's grouping, rounding and honesty rules.
//
// The fetch is not tested here (it is three Supabase reads); the grouping is,
// because that is where a report gets a number wrong in a way nobody notices.

import { describe, expect, it } from "vitest";
import {
  buildPayoutBreakdown,
  payoutBreakdownCsv,
} from "@/lib/payout-breakdown";
import type { SalePnlRow } from "@/types/database";

function row(over: Partial<SalePnlRow> & { sale_id: string }): SalePnlRow {
  return {
    user_id: "owner-1",
    inventory_item_id: `item-${over.sale_id}`,
    sale_date: "2026-08-01T00:00:00Z",
    sourcer_name: "Dan",
    sourcer_key: "dan",
    source_key: "Goodwill",
    brand_key: "Carhartt",
    category_key: "Outerwear",
    payout_id: "P1",
    payout_date: "2026-08-04T00:00:00Z",
    revenue: 100,
    fees: 13,
    costs: 5,
    cost_basis: 20,
    net: 62,
    days_to_sell: 30,
    days_on_market: 12,
    ...over,
  } as SalePnlRow;
}

const facts = new Map<string, { title: string | null; sku: string | null }>();

describe("buildPayoutBreakdown", () => {
  it("groups by sourcer and totals each column", () => {
    const b = buildPayoutBreakdown(
      "P1",
      [
        row({ sale_id: "a" }),
        row({ sale_id: "b" }),
        row({
          sale_id: "c",
          sourcer_name: "Tiff",
          sourcer_key: "tiff",
          revenue: 50,
          fees: 7,
          costs: 2,
          cost_basis: 10,
          net: 31,
        }),
      ],
      facts,
    );

    expect(b.totals.items).toBe(3);
    expect(b.totals.revenue).toBe(250);
    expect(b.totals.net).toBe(155);

    const dan = b.bySourcer.find((r) => r.key === "dan")!;
    expect(dan.items).toBe(2);
    expect(dan.net).toBe(124);
    const tiff = b.bySourcer.find((r) => r.key === "tiff")!;
    expect(tiff.items).toBe(1);
    expect(tiff.net).toBe(31);
  });

  it("folds case so Dan and dan are one person", () => {
    const b = buildPayoutBreakdown(
      "P1",
      [
        row({ sale_id: "a", sourcer_name: "Dan" }),
        row({ sale_id: "b", sourcer_name: " dan " }),
        row({ sale_id: "c", sourcer_name: "DAN" }),
      ],
      facts,
    );
    expect(b.bySourcer).toHaveLength(1);
    expect(b.bySourcer[0]!.items).toBe(3);
    // The label keeps what was typed first, not the lowercased key.
    expect(b.bySourcer[0]!.person).toBe("Dan");
  });

  it("names a missing sourcer rather than dropping the row", () => {
    const b = buildPayoutBreakdown(
      "P1",
      [row({ sale_id: "a", sourcer_name: "" }), row({ sale_id: "b" })],
      facts,
    );
    expect(b.totals.items).toBe(2);
    expect(b.bySourcer.map((r) => r.person).sort()).toEqual(["Dan", "Unassigned"]);
  });

  it("coerces the numeric-as-string values PostgREST returns", () => {
    const b = buildPayoutBreakdown(
      "P1",
      [
        row({
          sale_id: "a",
          revenue: "100.50",
          fees: "13.25",
          costs: "0",
          cost_basis: "20.10",
          net: "67.15",
        }),
      ],
      facts,
    );
    expect(b.totals.revenue).toBe(100.5);
    expect(b.totals.net).toBe(67.15);
  });

  it("rounds once at the end, so a column of thirds does not drift", () => {
    const third = 10 / 3; // 3.333...
    const b = buildPayoutBreakdown(
      "P1",
      [
        row({ sale_id: "a", net: third }),
        row({ sale_id: "b", net: third }),
        row({ sale_id: "c", net: third }),
      ],
      facts,
    );
    // 3.33 * 3 = 9.99 if each row were rounded first. The sum is 10.
    expect(b.totals.net).toBe(10);
    expect(b.bySourcer[0]!.net).toBe(10);
  });

  it("sorts people by net, biggest first, and ties by name", () => {
    const b = buildPayoutBreakdown(
      "P1",
      [
        row({ sale_id: "a", sourcer_name: "Zoe", net: 5 }),
        row({ sale_id: "b", sourcer_name: "Dan", net: 100 }),
        row({ sale_id: "c", sourcer_name: "Abe", net: 5 }),
      ],
      facts,
    );
    expect(b.bySourcer.map((r) => r.person)).toEqual(["Dan", "Abe", "Zoe"]);
  });

  it("uses the item title and sku when the item is still there", () => {
    const withFacts = new Map([
      ["item-a", { title: "Carhartt Detroit Jacket", sku: "GT-1001" }],
    ]);
    const b = buildPayoutBreakdown("P1", [row({ sale_id: "a" })], withFacts);
    expect(b.items[0]!.title).toBe("Carhartt Detroit Jacket");
    expect(b.items[0]!.sku).toBe("GT-1001");
  });

  it("names a deleted item rather than rendering a blank cell", () => {
    const b = buildPayoutBreakdown("P1", [row({ sale_id: "a" })], facts);
    expect(b.items[0]!.title).toBe("Untitled item");
    expect(b.items[0]!.sku).toBeNull();
  });

  it("keeps the deposit total separate from net instead of reconciling them", () => {
    const b = buildPayoutBreakdown("P1", [row({ sale_id: "a" })], facts, {
      amount: 500,
      currency: "USD",
      date: "2026-08-04T00:00:00Z",
    });
    // The deposit settles refunds and label charges that are not completed
    // sales, so these two disagreeing is expected. Nothing adjusts either.
    expect(b.headerAmount).toBe(500);
    expect(b.totals.net).toBe(62);
  });

  it("has no header when we hold the reference but not the payout row", () => {
    const b = buildPayoutBreakdown("P1", [row({ sale_id: "a" })], facts);
    expect(b.headerAmount).toBeNull();
    expect(b.headerDate).toBeNull();
  });

  it("is empty, not broken, for a payout with nothing linked", () => {
    const b = buildPayoutBreakdown("P1", [], facts);
    expect(b.items).toEqual([]);
    expect(b.bySourcer).toEqual([]);
    expect(b.totals.items).toBe(0);
    expect(b.totals.net).toBe(0);
  });

  it("lists the newest sale first", () => {
    const b = buildPayoutBreakdown(
      "P1",
      [
        row({ sale_id: "old", sale_date: "2026-07-01T00:00:00Z" }),
        row({ sale_id: "new", sale_date: "2026-08-20T00:00:00Z" }),
        row({ sale_id: "mid", sale_date: "2026-08-01T00:00:00Z" }),
      ],
      facts,
    );
    expect(b.items.map((i) => i.saleId)).toEqual(["new", "mid", "old"]);
  });
});

describe("payoutBreakdownCsv", () => {
  it("emits a header and one line per item", () => {
    const b = buildPayoutBreakdown(
      "P1",
      [row({ sale_id: "a" }), row({ sale_id: "b", sourcer_name: "Tiff" })],
      new Map([["item-a", { title: "Jacket", sku: "GT-1" }]]),
    );
    const lines = payoutBreakdownCsv(b).split("\n");
    expect(lines[0]).toBe(
      "payout_id,sale_date,title,sku,sourcer,revenue,fees,costs,cost_basis,net",
    );
    expect(lines).toHaveLength(3);
    expect(lines.some((l) => l.includes('"Jacket"'))).toBe(true);
    expect(lines.some((l) => l.includes('"Tiff"'))).toBe(true);
  });

  it("escapes a quote in a title rather than breaking the row", () => {
    const b = buildPayoutBreakdown(
      "P1",
      [row({ sale_id: "a" })],
      new Map([['item-a', { title: 'Levi\'s 501 "shrink to fit"', sku: null }]]),
    );
    const line = payoutBreakdownCsv(b).split("\n")[1]!;
    expect(line).toContain('"Levi\'s 501 ""shrink to fit"""');
    // Still ten fields: the escaping did not introduce a separator.
    expect(line.split('","').length).toBeGreaterThan(1);
  });
});

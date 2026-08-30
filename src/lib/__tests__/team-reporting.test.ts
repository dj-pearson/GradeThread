import { describe, expect, it } from "vitest";
import {
  buildScorecard,
  money,
  sortScorecard,
  sourcerKey,
  sourcerLabel,
  type TeamItemRow,
} from "@/lib/team-reporting";
import type { SalePnlRow } from "@/types/database";

// US-3019 -- the scorecard's arithmetic, with no database.
//
// The cases that matter are the ones where a person exists on only ONE side of
// the join. sale_pnl is keyed on the sale date and inventory_items on the
// acquired date, so a person who bought this month and has not sold yet, and a
// person who sold this month from stock bought last year, are both normal and
// both easy to drop.

function sale(over: Partial<SalePnlRow> = {}): SalePnlRow {
  return {
    sale_id: "s1",
    user_id: "u1",
    inventory_item_id: "i1",
    sale_date: "2026-08-01",
    sourcer_name: "Dan",
    sourcer_key: "dan",
    source_key: "Goodwill",
    brand_key: "Carhartt",
    category_key: "Outerwear",
    revenue: "100.00",
    fees: "10.00",
    costs: "5.00",
    cost_basis: "20.00",
    net: "65.00",
    days_to_sell: 30,
    days_on_market: 20,
    ...over,
  };
}

function item(over: Partial<TeamItemRow> = {}): TeamItemRow {
  return {
    id: "i1",
    sourced_by: "Dan",
    acquired_price: "20.00",
    acquired_date: "2026-07-01",
    status: "sold",
    sold: true,
    ...over,
  };
}

describe("money", () => {
  it("reads the strings PostgREST sends for a numeric column", () => {
    expect(money("19.99")).toBe(19.99);
    expect(money(19.99)).toBe(19.99);
  });

  it("treats a missing cost as zero, never NaN", () => {
    expect(money(null)).toBe(0);
    expect(money(undefined)).toBe(0);
    expect(money("")).toBe(0);
    expect(money("not a number")).toBe(0);
  });
});

describe("sourcerKey", () => {
  it("folds case and whitespace so one person is one person", () => {
    expect(sourcerKey("Dan")).toBe("dan");
    expect(sourcerKey("dan")).toBe("dan");
    expect(sourcerKey("  DAN  ")).toBe("dan");
  });

  it("puts a missing name in Unassigned rather than dropping the row", () => {
    expect(sourcerKey(null)).toBe("unassigned");
    expect(sourcerKey("")).toBe("unassigned");
    expect(sourcerKey("   ")).toBe("unassigned");
    expect(sourcerLabel(null)).toBe("Unassigned");
  });

  it("shows the name as typed, not the folded key", () => {
    expect(sourcerLabel("Dan")).toBe("Dan");
    expect(sourcerLabel("  Sam Wu ")).toBe("Sam Wu");
  });
});

describe("buildScorecard", () => {
  it("merges 'Dan' and 'dan' into one row", () => {
    const card = buildScorecard(
      [
        sale({ sale_id: "s1", sourcer_name: "Dan", net: "10.00" }),
        sale({ sale_id: "s2", sourcer_name: "dan", net: "5.00" }),
      ],
      [
        item({ id: "i1", sourced_by: "DAN" }),
        item({ id: "i2", sourced_by: "dan" }),
      ],
      0,
    );
    expect(card.rows).toHaveLength(1);
    expect(card.rows[0]!.key).toBe("dan");
    expect(card.rows[0]!.itemsSold).toBe(2);
    expect(card.rows[0]!.itemsBought).toBe(2);
    expect(card.rows[0]!.net).toBe(15);
  });

  it("keeps a person who bought but has not sold, with zeros", () => {
    const card = buildScorecard(
      [],
      [item({ id: "i9", sourced_by: "Priya", sold: false, status: "listed" })],
      0,
    );
    const priya = card.rows.find((r) => r.key === "priya");
    expect(priya).toBeDefined();
    expect(priya!.itemsSold).toBe(0);
    expect(priya!.revenue).toBe(0);
    expect(priya!.net).toBe(0);
    expect(priya!.itemsBought).toBe(1);
    expect(priya!.unsoldValue).toBe(20);
  });

  it("keeps a person who sold this period but bought nothing in it", () => {
    // Bought last year, sold this month. Spend is 0 for the window, so the
    // return multiple has no denominator and must be null, not Infinity.
    const card = buildScorecard([sale({ sourcer_name: "Sam" })], [], 0);
    const sam = card.rows.find((r) => r.key === "sam");
    expect(sam).toBeDefined();
    expect(sam!.itemsBought).toBe(0);
    expect(sam!.spend).toBe(0);
    expect(sam!.revenue).toBe(100);
    expect(sam!.returnMultiple).toBeNull();
    expect(sam!.sellThrough).toBeNull();
  });

  it("never divides by zero on the return multiple", () => {
    const card = buildScorecard(
      [sale({ sourcer_name: "Zero", revenue: "50.00" })],
      [item({ id: "z1", sourced_by: "Zero", acquired_price: null })],
      0,
    );
    const zero = card.rows.find((r) => r.key === "zero")!;
    expect(zero.spend).toBe(0);
    expect(zero.returnMultiple).toBeNull();
    expect(Number.isFinite(zero.revenue)).toBe(true);
  });

  it("computes the return multiple when there is spend", () => {
    const card = buildScorecard(
      [sale({ sourcer_name: "Dan", revenue: "100.00" })],
      [item({ id: "i1", sourced_by: "Dan", acquired_price: "25.00" })],
      0,
    );
    expect(card.rows[0]!.returnMultiple).toBe(4);
  });

  it("puts sales with no sourced_by under Unassigned", () => {
    const card = buildScorecard(
      [sale({ sourcer_name: "Unassigned", sourcer_key: "unassigned" })],
      [item({ id: "i1", sourced_by: null })],
      0,
    );
    expect(card.rows).toHaveLength(1);
    expect(card.rows[0]!.person).toBe("Unassigned");
    expect(card.rows[0]!.itemsSold).toBe(1);
    expect(card.rows[0]!.itemsBought).toBe(1);
  });

  it("averages days to sell only over sales that have a purchase date", () => {
    // A null must not be counted as a zero -- that would reward the person who
    // leaves the field blank with the fastest turnaround on the page.
    const card = buildScorecard(
      [
        sale({ sale_id: "s1", days_to_sell: 10 }),
        sale({ sale_id: "s2", days_to_sell: 30 }),
        sale({ sale_id: "s3", days_to_sell: null }),
      ],
      [],
      0,
    );
    expect(card.rows[0]!.avgDaysToSell).toBe(20);
  });

  it("returns null for days to sell when no sale carries one", () => {
    const card = buildScorecard([sale({ days_to_sell: null })], [], 0);
    expect(card.rows[0]!.avgDaysToSell).toBeNull();
  });

  it("computes sell-through over items bought in the window", () => {
    const card = buildScorecard(
      [],
      [
        item({ id: "a", sourced_by: "Dan", sold: true }),
        item({ id: "b", sourced_by: "Dan", sold: true }),
        item({ id: "c", sourced_by: "Dan", sold: false }),
        item({ id: "d", sourced_by: "Dan", sold: false }),
      ],
      0,
    );
    expect(card.rows[0]!.sellThrough).toBe(0.5);
    expect(card.rows[0]!.unsoldCount).toBe(2);
  });

  it("carries overhead separately and attributes it to nobody", () => {
    const card = buildScorecard(
      [sale({ net: "65.00" })],
      [item({ acquired_price: "20.00" })],
      35.5,
    );
    expect(card.overhead).toBe(35.5);
    expect(card.totals.net).toBe(65);
    // No person's net absorbed it.
    expect(card.rows.reduce((n, r) => n + r.net, 0)).toBe(65);
  });

  it("flags overhead it could not read instead of showing a false zero", () => {
    // A zero and "I could not look" are different answers, and only one of
    // them means the page's totals tie to the P&L.
    const card = buildScorecard([], [], 0, true);
    expect(card.overheadUnavailable).toBe(true);
    expect(card.overhead).toBe(0);
  });

  it("totals every column across people", () => {
    const card = buildScorecard(
      [
        sale({ sale_id: "s1", sourcer_name: "Dan", revenue: "100.00", net: "40.00" }),
        sale({ sale_id: "s2", sourcer_name: "Sam", revenue: "60.00", net: "10.00" }),
      ],
      [
        item({ id: "i1", sourced_by: "Dan", acquired_price: "20.00", sold: true }),
        item({ id: "i2", sourced_by: "Sam", acquired_price: "10.00", sold: false }),
      ],
      0,
    );
    expect(card.totals.revenue).toBe(160);
    expect(card.totals.net).toBe(50);
    expect(card.totals.spend).toBe(30);
    expect(card.totals.itemsBought).toBe(2);
    expect(card.totals.itemsSold).toBe(2);
    expect(card.totals.unsoldValue).toBe(10);
    expect(card.totals.sellThrough).toBe(0.5);
  });

  it("is empty for an empty period rather than throwing", () => {
    const card = buildScorecard([], [], 0);
    expect(card.rows).toEqual([]);
    expect(card.totals.net).toBe(0);
    expect(card.totals.returnMultiple).toBeNull();
    expect(card.totals.avgDaysToSell).toBeNull();
  });
});

describe("sortScorecard", () => {
  const rows = buildScorecard(
    [
      sale({ sale_id: "s1", sourcer_name: "Ana", net: "10.00" }),
      sale({ sale_id: "s2", sourcer_name: "Bo", net: "30.00" }),
      sale({ sale_id: "s3", sourcer_name: "Cy", net: "20.00" }),
    ],
    [item({ id: "i1", sourced_by: "Bo", acquired_price: "10.00" })],
    0,
  ).rows;

  it("sorts descending by a numeric column", () => {
    expect(sortScorecard(rows, "net", "desc").map((r) => r.person)).toEqual([
      "Bo",
      "Cy",
      "Ana",
    ]);
  });

  it("sorts ascending by a numeric column", () => {
    expect(sortScorecard(rows, "net", "asc").map((r) => r.person)).toEqual([
      "Ana",
      "Cy",
      "Bo",
    ]);
  });

  it("sorts by name", () => {
    expect(sortScorecard(rows, "person", "asc").map((r) => r.person)).toEqual([
      "Ana",
      "Bo",
      "Cy",
    ]);
  });

  it("keeps nulls last in BOTH directions", () => {
    // Ana and Cy have no spend, so no return multiple. Ascending, a null read
    // as 0 would put them first and label them the worst buyers on the page.
    const asc = sortScorecard(rows, "returnMultiple", "asc");
    expect(asc[0]!.person).toBe("Bo");
    expect(asc[asc.length - 1]!.returnMultiple).toBeNull();

    const desc = sortScorecard(rows, "returnMultiple", "desc");
    expect(desc[0]!.person).toBe("Bo");
    expect(desc[desc.length - 1]!.returnMultiple).toBeNull();
  });

  it("does not mutate the input", () => {
    const before = rows.map((r) => r.person);
    sortScorecard(rows, "net", "asc");
    expect(rows.map((r) => r.person)).toEqual(before);
  });
});

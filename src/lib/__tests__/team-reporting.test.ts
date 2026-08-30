import { describe, expect, it } from "vitest";
import {
  ageBucket,
  buildDeadCapital,
  buildMissReport,
  buildScorecard,
  classifyMiss,
  daysHeld,
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

// ══════════════════════════════════════════════════════════
// DEAD CAPITAL (US-3020)
// ══════════════════════════════════════════════════════════

const NOW = new Date("2026-08-30T12:00:00.000Z");

/** An item bought `days` before NOW, so the boundaries can be pinned exactly. */
function agedItem(days: number | null, over: Partial<TeamItemRow> = {}): TeamItemRow {
  const acquired =
    days === null
      ? null
      : new Date(NOW.getTime() - days * 86_400_000).toISOString();
  return {
    id: `i-${days ?? "null"}-${over.id ?? ""}`,
    sourced_by: "Dan",
    acquired_price: "100.00",
    acquired_date: acquired,
    status: "listed",
    sold: false,
    ...over,
  };
}

describe("daysHeld", () => {
  it("counts whole days from the purchase date", () => {
    expect(daysHeld(new Date(NOW.getTime() - 45 * 86_400_000).toISOString(), NOW))
      .toBe(45);
  });

  it("returns null for a missing or unparseable date", () => {
    expect(daysHeld(null, NOW)).toBeNull();
    expect(daysHeld(undefined, NOW)).toBeNull();
    expect(daysHeld("", NOW)).toBeNull();
    expect(daysHeld("not a date", NOW)).toBeNull();
  });

  it("clamps a future purchase date to zero rather than going negative", () => {
    // A typo or a timezone slip on an import. A negative age would land in no
    // bucket at all and the money would silently leave the page.
    const future = new Date(NOW.getTime() + 10 * 86_400_000).toISOString();
    expect(daysHeld(future, NOW)).toBe(0);
  });
});

describe("ageBucket", () => {
  it("puts each boundary in the bucket its label claims", () => {
    expect(ageBucket(0)).toBe("0-30");
    expect(ageBucket(30)).toBe("0-30");
    expect(ageBucket(31)).toBe("31-60");
    expect(ageBucket(60)).toBe("31-60");
    expect(ageBucket(61)).toBe("61-90");
    expect(ageBucket(90)).toBe("61-90");
    expect(ageBucket(91)).toBe("91-180");
    expect(ageBucket(180)).toBe("91-180");
    expect(ageBucket(181)).toBe("180+");
    expect(ageBucket(5000)).toBe("180+");
  });

  it("gives a missing date its own bucket instead of calling it new", () => {
    expect(ageBucket(null)).toBe("unknown");
  });
});

describe("buildDeadCapital", () => {
  const titles = new Map<string, string>();

  it("splits one person's stock across the buckets by age", () => {
    const dc = buildDeadCapital(
      [
        agedItem(10, { id: "a" }),
        agedItem(45, { id: "b" }),
        agedItem(200, { id: "c" }),
      ],
      titles,
      NOW,
    );
    expect(dc.rows).toHaveLength(1);
    const row = dc.rows[0]!;
    expect(row.buckets["0-30"]).toBe(100);
    expect(row.buckets["31-60"]).toBe(100);
    expect(row.buckets["180+"]).toBe(100);
    expect(row.total).toBe(300);
    expect(row.count).toBe(3);
  });

  it("counts only past-90-day money as stale", () => {
    const dc = buildDeadCapital(
      [
        agedItem(90, { id: "fresh", acquired_price: "10.00" }),
        agedItem(91, { id: "stale1", acquired_price: "20.00" }),
        agedItem(400, { id: "stale2", acquired_price: "30.00" }),
      ],
      titles,
      NOW,
    );
    expect(dc.rows[0]!.stale).toBe(50);
    expect(dc.staleTotal).toBe(50);
    expect(dc.grandTotal).toBe(60);
  });

  it("keeps an item with no purchase date visible under Unknown age", () => {
    const dc = buildDeadCapital(
      [agedItem(null, { id: "x", acquired_price: "75.00" })],
      titles,
      NOW,
    );
    expect(dc.rows[0]!.buckets.unknown).toBe(75);
    expect(dc.rows[0]!.total).toBe(75);
    // Not counted as brand new, and not counted as stale either.
    expect(dc.rows[0]!.buckets["0-30"]).toBe(0);
    expect(dc.rows[0]!.stale).toBe(0);
  });

  it("counts an item with no price as a held item worth nothing", () => {
    const dc = buildDeadCapital(
      [agedItem(200, { id: "free", acquired_price: null })],
      titles,
      NOW,
    );
    expect(dc.rows[0]!.count).toBe(1);
    expect(dc.rows[0]!.counts["180+"]).toBe(1);
    expect(dc.rows[0]!.total).toBe(0);
    expect(Number.isFinite(dc.grandTotal)).toBe(true);
  });

  it("merges the same person written two ways", () => {
    const dc = buildDeadCapital(
      [
        agedItem(10, { id: "a", sourced_by: "Dan" }),
        agedItem(10, { id: "b", sourced_by: "dan" }),
      ],
      titles,
      NOW,
    );
    expect(dc.rows).toHaveLength(1);
    expect(dc.rows[0]!.count).toBe(2);
  });

  it("names the five oldest, oldest first, with the dateless ones last", () => {
    const dc = buildDeadCapital(
      [
        agedItem(10, { id: "a" }),
        agedItem(300, { id: "b" }),
        agedItem(100, { id: "c" }),
        agedItem(null, { id: "d" }),
        agedItem(50, { id: "e" }),
        agedItem(200, { id: "f" }),
        agedItem(20, { id: "g" }),
      ],
      titles,
      NOW,
    );
    const oldest = dc.rows[0]!.oldest;
    expect(oldest).toHaveLength(5);
    expect(oldest.map((o) => o.days)).toEqual([300, 200, 100, 50, 20]);
    // The dateless one did not jump to the front by sorting as a huge age.
    expect(oldest.some((o) => o.days === null)).toBe(false);
  });

  it("leads with the person who has the most money stuck past 90 days", () => {
    const dc = buildDeadCapital(
      [
        // Big total, all of it fresh.
        agedItem(5, { id: "p1", sourced_by: "Fresh", acquired_price: "900.00" }),
        // Small total, all of it stuck.
        agedItem(300, { id: "p2", sourced_by: "Stuck", acquired_price: "100.00" }),
      ],
      titles,
      NOW,
    );
    expect(dc.rows[0]!.person).toBe("Stuck");
  });

  it("totals every bucket across people", () => {
    const dc = buildDeadCapital(
      [
        agedItem(10, { id: "a", sourced_by: "Dan", acquired_price: "10.00" }),
        agedItem(10, { id: "b", sourced_by: "Sam", acquired_price: "5.00" }),
        agedItem(200, { id: "c", sourced_by: "Sam", acquired_price: "20.00" }),
      ],
      titles,
      NOW,
    );
    expect(dc.totals["0-30"]).toBe(15);
    expect(dc.totals["180+"]).toBe(20);
    expect(dc.grandTotal).toBe(35);
  });

  it("uses the title map, falling back to a name rather than a blank cell", () => {
    const withTitle = new Map([["a", "Carhartt Jacket"]]);
    const dc = buildDeadCapital(
      [agedItem(10, { id: "a" }), agedItem(10, { id: "b" })],
      withTitle,
      NOW,
    );
    const byId = new Map(dc.rows[0]!.oldest.map((o) => [o.id, o.title]));
    expect(byId.get("a")).toBe("Carhartt Jacket");
    expect(byId.get("b")).toBe("Untitled item");
  });

  it("is empty for an empty workspace rather than throwing", () => {
    const dc = buildDeadCapital([], titles, NOW);
    expect(dc.rows).toEqual([]);
    expect(dc.grandTotal).toBe(0);
    expect(dc.staleTotal).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════
// OVERPAY / MISS (US-3021)
// ══════════════════════════════════════════════════════════

describe("classifyMiss", () => {
  it("calls a sale that lost money a loss", () => {
    const v = classifyMiss({ revenue: "100.00", net: "-20.00" }, 0.3);
    expect(v.isMiss).toBe(true);
    expect(v.reason).toBe("loss");
    // Target was $30 of the $100; it came back $20 down, so it is $50 short.
    expect(v.shortfall).toBe(50);
  });

  it("does not flag a sale exactly at target", () => {
    const v = classifyMiss({ revenue: "100.00", net: "30.00" }, 0.3);
    expect(v.isMiss).toBe(false);
    expect(v.reason).toBeNull();
    expect(v.shortfall).toBe(0);
  });

  it("flags a sale one cent under target", () => {
    const v = classifyMiss({ revenue: "100.00", net: "29.99" }, 0.3);
    expect(v.isMiss).toBe(true);
    expect(v.reason).toBe("below-target");
    expect(v.shortfall).toBeCloseTo(0.01, 10);
  });

  it("does not flag a sale one cent OVER target", () => {
    expect(classifyMiss({ revenue: "100.00", net: "30.01" }, 0.3).isMiss).toBe(
      false,
    );
  });

  it("holds the exactly-at-target line on awkward numbers", () => {
    // The whole reason the arithmetic is done in cents. In floating point
    // 89.9 * 0.3 is 26.969999999999995, so a sale that made exactly its target
    // compares as a hundred-billionth of a cent under and gets a person named
    // on a report for missing by nothing at all.
    for (const [revenue, margin] of [
      ["89.90", 0.3],
      ["19.99", 0.3],
      ["0.03", 0.3],
      ["1234.56", 0.15],
      ["77.77", 0.7],
    ] as const) {
      const targetNet = (
        Math.round(Math.round(Number(revenue) * 100) * margin) / 100
      ).toFixed(2);
      const v = classifyMiss({ revenue, net: targetNet }, margin);
      expect(
        `${revenue} @ ${margin} -> net ${targetNet}: miss=${v.isMiss}`,
      ).toBe(`${revenue} @ ${margin} -> net ${targetNet}: miss=false`);
    }
  });

  it("judges a zero-revenue sale on loss alone, never dividing by zero", () => {
    const lost = classifyMiss({ revenue: "0", net: "-15.00" }, 0.3);
    expect(lost.isMiss).toBe(true);
    expect(lost.reason).toBe("loss");
    expect(lost.shortfall).toBe(15);

    const flat = classifyMiss({ revenue: "0", net: "0" }, 0.3);
    expect(flat.isMiss).toBe(false);
    expect(Number.isFinite(flat.shortfall)).toBe(true);
  });

  it("reads a target of zero as 'just do not lose money'", () => {
    expect(classifyMiss({ revenue: "100.00", net: "0.01" }, 0).isMiss).toBe(false);
    expect(classifyMiss({ revenue: "100.00", net: "-0.01" }, 0).isMiss).toBe(true);
  });
});

describe("buildMissReport", () => {
  const titles = new Map([
    ["i1", "Carhartt Jacket"],
    ["i2", "Levi 501"],
  ]);

  function missSale(over: Partial<SalePnlRow>): SalePnlRow {
    return sale({ revenue: "100.00", net: "-10.00", ...over });
  }

  it("keeps only the misses and counts what it examined", () => {
    const r = buildMissReport(
      [
        missSale({ sale_id: "a" }),
        sale({ sale_id: "b", revenue: "100.00", net: "60.00" }),
        sale({ sale_id: "c", revenue: "100.00", net: "50.00" }),
      ],
      titles,
      0.3,
    );
    expect(r.count).toBe(1);
    expect(r.salesConsidered).toBe(3);
  });

  it("separates a loss from a merely thin sale", () => {
    const r = buildMissReport(
      [
        missSale({ sale_id: "a", sourcer_name: "Dan", net: "-10.00" }),
        missSale({ sale_id: "b", sourcer_name: "Dan", net: "10.00" }),
      ],
      titles,
      0.3,
    );
    expect(r.rows[0]!.count).toBe(2);
    expect(r.rows[0]!.lossCount).toBe(1);
  });

  it("groups by person and rolls shops up from the same misses", () => {
    const r = buildMissReport(
      [
        missSale({ sale_id: "a", sourcer_name: "Dan", source_key: "Goodwill" }),
        missSale({ sale_id: "b", sourcer_name: "Dan", source_key: "Goodwill" }),
        missSale({ sale_id: "c", sourcer_name: "Dan", source_key: "Estate" }),
      ],
      titles,
      0.3,
    );
    const dan = r.rows[0]!;
    expect(dan.count).toBe(3);
    // The two halves of a group cannot disagree about how many misses there were.
    expect(dan.shops.reduce((n, s) => n + s.count, 0)).toBe(dan.count);
    expect(dan.shops[0]!.sourceKey).toBe("Goodwill");
    expect(dan.shops[0]!.count).toBe(2);
  });

  it("names the five worst by shortfall even when there are more", () => {
    const sales = Array.from({ length: 9 }, (_, i) =>
      missSale({
        sale_id: `s${i}`,
        inventory_item_id: "i1",
        net: String(-(i + 1) * 10),
      }),
    );
    const r = buildMissReport(sales, titles, 0.3);
    expect(r.rows[0]!.count).toBe(9);
    expect(r.rows[0]!.worst).toHaveLength(5);
    // The card says "the CSV has the rest", and the CSV reads `all`. If this
    // held only the same five, that sentence on screen would be a lie.
    expect(r.rows[0]!.all).toHaveLength(9);
    expect(r.rows[0]!.all.slice(0, 5)).toEqual(r.rows[0]!.worst);
    const shortfalls = r.rows[0]!.worst.map((w) => w.shortfall);
    expect(shortfalls).toEqual([...shortfalls].sort((a, b) => b - a));
    // The worst one is the biggest loss, not whichever arrived first.
    expect(r.rows[0]!.worst[0]!.net).toBe(-90);
  });

  it("shows what was paid and what it sold for, with the item title", () => {
    const r = buildMissReport(
      [
        missSale({
          sale_id: "a",
          inventory_item_id: "i1",
          cost_basis: "45.00",
          revenue: "50.00",
          net: "-5.00",
        }),
      ],
      titles,
      0.3,
    );
    const worst = r.rows[0]!.worst[0]!;
    expect(worst.title).toBe("Carhartt Jacket");
    expect(worst.paid).toBe(45);
    expect(worst.soldFor).toBe(50);
    expect(worst.net).toBe(-5);
  });

  it("falls back to a name when the item title is missing", () => {
    const r = buildMissReport(
      [missSale({ sale_id: "a", inventory_item_id: "gone" })],
      titles,
      0.3,
    );
    expect(r.rows[0]!.worst[0]!.title).toBe("Untitled item");
  });

  it("leads with the person who is furthest short overall", () => {
    const r = buildMissReport(
      [
        // One big miss.
        missSale({ sale_id: "a", sourcer_name: "Big", net: "-200.00" }),
        // Two small ones.
        missSale({ sale_id: "b", sourcer_name: "Small", net: "20.00" }),
        missSale({ sale_id: "c", sourcer_name: "Small", net: "20.00" }),
      ],
      titles,
      0.3,
    );
    expect(r.rows[0]!.person).toBe("Big");
  });

  it("merges the same person written two ways", () => {
    const r = buildMissReport(
      [
        missSale({ sale_id: "a", sourcer_name: "Dan" }),
        missSale({ sale_id: "b", sourcer_name: "dan" }),
      ],
      titles,
      0.3,
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.count).toBe(2);
  });

  it("reports zero misses out of a real number of sales, not just zero", () => {
    // "No misses" out of 80 sales is praise. Out of 0 sales it is silence, and
    // the card has to be able to tell them apart.
    const r = buildMissReport(
      [
        sale({ sale_id: "a", revenue: "100.00", net: "50.00" }),
        sale({ sale_id: "b", revenue: "100.00", net: "40.00" }),
      ],
      titles,
      0.3,
    );
    expect(r.rows).toEqual([]);
    expect(r.count).toBe(0);
    expect(r.salesConsidered).toBe(2);
  });

  it("totals the shortfall across everyone", () => {
    const r = buildMissReport(
      [
        missSale({ sale_id: "a", sourcer_name: "Dan", net: "-10.00" }),
        missSale({ sale_id: "b", sourcer_name: "Sam", net: "0.00" }),
      ],
      titles,
      0.3,
    );
    // 40 short and 30 short.
    expect(r.shortfall).toBe(70);
    expect(r.count).toBe(2);
  });
});

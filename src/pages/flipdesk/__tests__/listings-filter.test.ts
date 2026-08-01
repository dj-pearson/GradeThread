// US-2178 AC2: the listings table's search, sold-window and demote decisions.
//
// None of these had a test. Two of them decide what a seller can find; the
// third decides whether a LIVE marketplace listing gets quietly rewritten as a
// draft — the same failure class as US-2162's "ended locally" bug, where
// FlipDesk told a seller an item was off the market while it was still on sale.

import { describe, it, expect } from "vitest";
import {
  matchesSearch,
  matchesSoldFilter,
  payoutState,
  planListingDemote,
} from "@/pages/flipdesk/listings-filter";
import type { ItemFullRow } from "@/types/database";

const item = (over: Partial<ItemFullRow> = {}): ItemFullRow =>
  ({ id: "i1", status: "listed", ...over }) as ItemFullRow;

const DAY = 24 * 60 * 60 * 1000;
// A fixed "now" well clear of a year boundary, so the ytd cases don't flip on
// the day this suite happens to run.
const NOW = new Date("2026-06-15T12:00:00Z").getTime();
const daysAgo = (n: number) => new Date(NOW - n * DAY).toISOString();

describe("search", () => {
  const row = item({
    item_title: "Vintage Nike Windbreaker",
    brand: "Nike",
    style: "Anorak",
    item_number: "SKU-114",
    container: "Bin 7",
  });

  it("matches everything when the box is empty", () => {
    // An empty box is not a filter. Returning nothing here would make the page
    // look broken on first load.
    expect(matchesSearch(row, "")).toBe(true);
    expect(matchesSearch(row, "   ")).toBe(true);
  });

  it("matches a substring anywhere in the title, not just the start", () => {
    // A reseller typing "nike" expects "Vintage Nike Windbreaker".
    expect(matchesSearch(row, "nike")).toBe(true);
    expect(matchesSearch(row, "windbreaker")).toBe(true);
  });

  it("ignores case and surrounding spaces", () => {
    expect(matchesSearch(row, "  NIKE ")).toBe(true);
  });

  it.each([
    ["brand", "nike"],
    ["style", "anorak"],
    ["item number", "sku-114"],
    ["container", "bin 7"],
  ])("searches the %s column", (_label, needle) => {
    expect(matchesSearch(row, needle)).toBe(true);
  });

  it("does not match a term that appears nowhere", () => {
    expect(matchesSearch(row, "adidas")).toBe(false);
  });

  it("survives a row with every searchable column empty", () => {
    // Nulls used to be joined into the haystack as "null" in other code paths,
    // which made searching "null" match every blank row.
    const blank = item();
    expect(matchesSearch(blank, "null")).toBe(false);
    expect(matchesSearch(blank, "")).toBe(true);
  });

  it("does not let one column's end run into the next column's start", () => {
    // Fields are space-joined, so "Nike" + "Anorak" must not match "nikeanorak".
    expect(matchesSearch(row, "nikeanorak")).toBe(false);
  });
});

describe("payout state", () => {
  it("is pending until money actually lands", () => {
    expect(payoutState(item({ payout: null }))).toBe("pending");
    expect(payoutState(item({ payout: 0 }))).toBe("pending");
  });

  it("is cleared on a normal payout", () => {
    expect(payoutState(item({ payout: 40, sale_price: 50, fees: 8 }))).toBe("cleared");
  });

  it("flags a discrepancy when fees exceed 20% of the sale", () => {
    // This is the sale worth disputing. Averaging it in silently is how an
    // unexpected fee disappears into a margin number.
    expect(payoutState(item({ payout: 30, sale_price: 50, fees: 11 }))).toBe(
      "discrepancy",
    );
  });

  it("treats exactly 20% as normal, not a discrepancy", () => {
    // Boundary stated explicitly so a future `>=` doesn't start flagging every
    // standard-fee sale.
    expect(payoutState(item({ payout: 30, sale_price: 50, fees: 10 }))).toBe("cleared");
  });

  it("cannot flag a discrepancy without a sale price to measure against", () => {
    expect(payoutState(item({ payout: 30, sale_price: 0, fees: 99 }))).toBe("cleared");
  });
});

describe("the Sold tab's secondary filter", () => {
  it("passes everything on `all`", () => {
    expect(matchesSoldFilter(item(), "all", NOW)).toBe(true);
  });

  it("selects sales still waiting on money", () => {
    expect(matchesSoldFilter(item({ payout: null }), "awaiting_payout", NOW)).toBe(true);
    expect(
      matchesSoldFilter(item({ payout: 40, sale_price: 50, fees: 5 }), "awaiting_payout", NOW),
    ).toBe(false);
  });

  it("selects fee discrepancies", () => {
    expect(
      matchesSoldFilter(item({ payout: 30, sale_price: 50, fees: 11 }), "discrepancy", NOW),
    ).toBe(true);
  });

  it.each([
    ["d7", 3, true],
    ["d7", 10, false],
    ["d30", 10, true],
    ["d30", 45, false],
  ] as const)("%s includes a sale %i days old: %s", (filter, days, expected) => {
    expect(matchesSoldFilter(item({ sale_date: daysAgo(days) }), filter, NOW)).toBe(
      expected,
    );
  });

  it("includes a sale exactly on the window edge", () => {
    // An off-by-one here silently drops the oldest day of every window.
    expect(matchesSoldFilter(item({ sale_date: daysAgo(7) }), "d7", NOW)).toBe(true);
  });

  it("year-to-date keeps January and excludes last December", () => {
    expect(
      matchesSoldFilter(item({ sale_date: "2026-01-02T00:00:00Z" }), "ytd", NOW),
    ).toBe(true);
    expect(
      matchesSoldFilter(item({ sale_date: "2025-12-31T00:00:00Z" }), "ytd", NOW),
    ).toBe(false);
  });

  it("excludes an undated sale from every date window", () => {
    // Placing an undated row in "Last 7 days" puts it in a window nothing put
    // it in — worse than leaving it out, because the seller can't tell.
    for (const f of ["d7", "d30", "ytd"] as const) {
      expect(matchesSoldFilter(item({ sale_date: null }), f, NOW)).toBe(false);
    }
  });

  it("excludes an unparseable sale date rather than treating it as 1970", () => {
    expect(matchesSoldFilter(item({ sale_date: "not a date" }), "d7", NOW)).toBe(false);
  });
});

describe("demoting an item back to a draft-like status", () => {
  it("NEVER demotes a live marketplace offer", () => {
    // The one that costs a sale. Rewriting the local row would show the item as
    // a draft while it is still listed and purchasable, so the seller stops
    // watching a listing that can still sell.
    const plan = planListingDemote(
      item({ listing_id: "l1", listing_status: "active", link: "https://ebay.com/itm/1" }),
    );
    expect(plan.action).toBe("live");
  });

  it("does demote a local `active` row with no marketplace URL", () => {
    // The URL is what distinguishes a published offer from a local row someone
    // set to active. Without it there is nothing live to protect.
    const plan = planListingDemote(item({ listing_id: "l1", listing_status: "active" }));
    expect(plan).toEqual({
      action: "patch",
      patch: { listing_status: "draft", is_active: false },
    });
  });

  it("only clears is_active on a row already at draft", () => {
    // Rewriting listing_status to the value it already holds is a pointless
    // write on a table the whole page reads.
    expect(planListingDemote(item({ listing_id: "l1", listing_status: "draft" }))).toEqual(
      { action: "patch", patch: { is_active: false } },
    );
  });

  it.each(["sold", "ended"] as const)("never rewinds a %s listing", (status) => {
    // A sold listing is a record, not a state to move.
    expect(
      planListingDemote(item({ listing_id: "l1", listing_status: status })).action,
    ).toBe("none");
  });

  it("does nothing for an item with no listing at all", () => {
    expect(planListingDemote(item({ listing_id: null })).action).toBe("none");
    expect(
      planListingDemote(item({ listing_id: "l1", listing_status: null })).action,
    ).toBe("none");
  });
});

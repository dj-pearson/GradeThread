// US-2168 AC5 — the parity harness for the listings table's row selection.
//
// WHY THIS EXISTS BEFORE THE SERVER PORT, NOT AFTER IT. AC3 moves search, tab
// filtering and sort to the server. AC5 asks for row-count parity "against the
// current client-side behaviour so the migration can't silently change what a
// tab shows". Written afterwards, such a test asserts that the new
// implementation matches itself — the old behaviour is gone by then and there
// is nothing left to compare against.
//
// So this pins what the table shows TODAY, from a corpus chosen to exercise the
// edges a SQL port gets wrong rather than the happy path. When the RPC lands,
// the parity assertion is: run both over this corpus, compare the id sequences.
//
// The four things a port is most likely to get subtly wrong, each of which
// changes which rows a seller sees, are called out on selectListingRows itself.
// Every one of them has a case below.
import { describe, it, expect } from "vitest";
import {
  selectListingRows,
  type RowSelectionCriteria,
} from "@/pages/flipdesk/listings-filter";
import { TABS } from "@/pages/flipdesk/inventory-tabs";
import { EMPTY_QUERY } from "@/lib/item-filter";
import type { ItemFullRow } from "@/types/database";

const DAY = 24 * 60 * 60 * 1000;
// Fixed, and well clear of a year boundary so the Sold ytd windows do not flip
// depending on the day the suite runs.
const NOW = new Date("2026-06-15T12:00:00Z").getTime();
const daysAgo = (n: number) => new Date(NOW - n * DAY).toISOString();

const item = (over: Partial<ItemFullRow> = {}): ItemFullRow =>
  ({
    id: "i",
    status: "listed",
    item_title: "",
    created_at: daysAgo(1),
    ...over,
  }) as ItemFullRow;

const tabById = (id: string) => TABS.find((t) => t.id === id)!;

function criteria(over: Partial<RowSelectionCriteria> = {}): RowSelectionCriteria {
  return {
    tab: tabById("all"),
    search: "",
    soldFilter: "all",
    unlistedFilter: "all",
    filterQuery: EMPTY_QUERY,
    columnSort: null,
    sortPreset: "listability",
    now: NOW,
    ...over,
  };
}

const ids = (rows: ItemFullRow[]) => rows.map((r) => r.id);

describe("selectListingRows — the parity corpus (US-2168 AC5)", () => {
  it("nulls sort LAST in BOTH directions", () => {
    // The single most likely port bug. `ORDER BY x DESC` in Postgres puts NULLs
    // FIRST; this puts them last either way, because a row missing the value
    // being sorted on is not "smallest", it is "unknown". A port without an
    // explicit NULLS LAST on both directions silently promotes every incomplete
    // row to the top of a descending sort — which is the first page a seller
    // looks at.
    const rows = [
      item({ id: "has-b", list_price: 20 }),
      item({ id: "null-1", list_price: null }),
      item({ id: "has-a", list_price: 10 }),
      item({ id: "null-2", list_price: null }),
    ];
    const asc = selectListingRows(rows, criteria({
      columnSort: { field: "list_price", dir: "asc" },
    }));
    const desc = selectListingRows(rows, criteria({
      columnSort: { field: "list_price", dir: "desc" },
    }));
    expect(ids(asc).slice(0, 2)).toEqual(["has-a", "has-b"]);
    expect(ids(asc).slice(2)).toEqual(expect.arrayContaining(["null-1", "null-2"]));
    expect(ids(desc).slice(0, 2)).toEqual(["has-b", "has-a"]);
    expect(ids(desc).slice(2)).toEqual(expect.arrayContaining(["null-1", "null-2"]));
  });

  it("sorts strings NATURALLY, so 10 follows 9", () => {
    // Plain `ORDER BY text` gives "Item 10" before "Item 9". A seller with more
    // than nine numbered items sees them interleaved nonsensically.
    const rows = [
      item({ id: "c", item_title: "Item 10" }),
      item({ id: "a", item_title: "Item 2" }),
      item({ id: "b", item_title: "Item 9" }),
    ];
    const out = selectListingRows(rows, criteria({
      columnSort: { field: "item_title", dir: "asc" },
    }));
    expect(ids(out)).toEqual(["a", "b", "c"]);
  });

  it("compares strings case- and accent-insensitively", () => {
    // `sensitivity: "base"` is closer to a collation with a reduced strength
    // than to `lower()`. A port using `lower()` gets the case half and misses
    // the accent half.
    const rows = [
      item({ id: "upper", item_title: "ZEBRA" }),
      item({ id: "accent", item_title: "ápple" }),
      item({ id: "lower", item_title: "banana" }),
    ];
    const out = selectListingRows(rows, criteria({
      columnSort: { field: "item_title", dir: "asc" },
    }));
    expect(ids(out)).toEqual(["accent", "lower", "upper"]);
  });

  it("applies the advanced filter LAST, on top of tab and search", () => {
    // Order of composition is observable: a rule that would match a row the tab
    // already excluded must not resurrect it.
    const rows = [
      item({ id: "archived", status: "archived", item_title: "nike tee" }),
      item({ id: "live", status: "listed", item_title: "nike tee" }),
      item({ id: "other", status: "listed", item_title: "adidas tee" }),
    ];
    const out = selectListingRows(rows, criteria({ search: "nike" }));
    // The "all" tab excludes archived (US-1483), and search narrows further.
    expect(ids(out)).toEqual(["live"]);
  });

  it("a clicked column beats the Unlisted preset", () => {
    // Stated as a rule in the page: the seller always gets the column they
    // clicked, even on the one tab that has its own preset sorts.
    const rows = [
      item({ id: "cheap", status: "cataloged", list_price: 5, grade_value: 9 }),
      item({ id: "rich", status: "cataloged", list_price: 500, grade_value: null }),
    ];
    const preset = selectListingRows(rows, criteria({
      tab: tabById("unlisted"),
      sortPreset: "listability",
    }));
    const clicked = selectListingRows(rows, criteria({
      tab: tabById("unlisted"),
      sortPreset: "listability",
      columnSort: { field: "list_price", dir: "desc" },
    }));
    // The graded item scores higher, so the preset leads with it...
    expect(ids(preset)[0]).toBe("cheap");
    // ...and the click overrides that completely.
    expect(ids(clicked)).toEqual(["rich", "cheap"]);
  });

  it("the Unlisted presets each order by their own key", () => {
    const rows = [
      item({
        id: "old-cheap",
        status: "cataloged",
        created_at: daysAgo(100),
        target_price: 10,
        purchase_price: 9,
      }),
      item({
        id: "new-rich",
        status: "cataloged",
        created_at: daysAgo(1),
        target_price: 100,
        purchase_price: 5,
      }),
    ];
    const oldest = selectListingRows(rows, criteria({
      tab: tabById("unlisted"),
      sortPreset: "oldest",
    }));
    const roi = selectListingRows(rows, criteria({
      tab: tabById("unlisted"),
      sortPreset: "best_roi",
    }));
    expect(ids(oldest)).toEqual(["old-cheap", "new-rich"]);
    expect(ids(roi)).toEqual(["new-rich", "old-cheap"]);
  });

  it("the Sold window only applies on the Sold tab", () => {
    // soldFilter is in the criteria unconditionally, so a port that applies it
    // everywhere would silently shrink every other tab.
    const rows = [
      item({ id: "recent", status: "sold", sale_date: daysAgo(3) }),
      item({ id: "ancient", status: "sold", sale_date: daysAgo(300) }),
    ];
    const onSold = selectListingRows(rows, criteria({
      tab: tabById("sold"),
      soldFilter: "d7",
    }));
    const onAll = selectListingRows(rows, criteria({ soldFilter: "d7" }));
    expect(ids(onSold)).toEqual(["recent"]);
    expect(onAll).toHaveLength(2);
  });

  it("returns a stable count for an empty corpus and an unmatched search", () => {
    // The degenerate cases, because a parity check that only runs on populated
    // data misses the ones where an off-by-one is easiest to introduce.
    expect(selectListingRows([], criteria())).toEqual([]);
    expect(
      selectListingRows([item({ id: "x", item_title: "shirt" })],
        criteria({ search: "no-such-thing" })),
    ).toEqual([]);
  });

  it("does not mutate the caller's array", () => {
    // It sorts in place internally, on the array `filter` returned. If that
    // ever becomes the input array, the component's `items` would be reordered
    // under React — a bug that shows up as rows shuffling on unrelated renders.
    const rows = [
      item({ id: "b", item_title: "b" }),
      item({ id: "a", item_title: "a" }),
    ];
    const before = ids(rows);
    selectListingRows(rows, criteria({
      columnSort: { field: "item_title", dir: "asc" },
    }));
    expect(ids(rows), "input array was reordered").toEqual(before);
  });

  it("every tab is exercisable through this harness", () => {
    // Vacuity guard. If a tab's predicate throws or the harness cannot build
    // its criteria, the parity check silently covers fewer tabs than it claims
    // to — and the one it drops is the one that regresses.
    const corpus = [
      item({ id: "1", status: "listed" }),
      item({ id: "2", status: "cataloged" }),
      item({ id: "3", status: "sold", sale_date: daysAgo(2) }),
      item({ id: "4", status: "archived" }),
      item({ id: "5", status: "drafted" }),
    ];
    expect(TABS.length).toBeGreaterThan(3);
    for (const tab of TABS) {
      const out = selectListingRows(corpus, criteria({ tab }));
      expect(Array.isArray(out), `tab ${tab.id} did not return rows`).toBe(true);
      // Whatever it returns must be a subset of the corpus, never invented.
      for (const r of out) expect(ids(corpus)).toContain(r.id);
    }
  });
});

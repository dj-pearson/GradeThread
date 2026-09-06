// Every sortable header on the Inventory table sorts in the DATABASE, and the
// database validates the field name against `items_full`'s real columns
// (flipdesk_listing_page, migration 00515: an unknown name raises 22023 rather
// than reaching format('%I')).
//
// THE FAILURE THIS GUARDS. `field` is typed `keyof ItemFullRow`, so tsc already
// catches a misspelling. What it cannot catch is a field that is a valid TYPE
// key but not a real column to order by — and the table displays several values
// that look exactly like columns and are not: Margin and the to-list Score are
// computed per row on the client, Impressions and CTR are not in `items_full`,
// Platforms is joined from the listing rows. Making one of those sortable
// compiles cleanly, ships, and then throws 22023 the first time a seller clicks
// it. That is a runtime error on a page that was working, caused by an edit
// that looked safe.
//
// So the intent is pinned here rather than left to be re-derived: this is the
// set that sorts, and that set is the one someone decided on.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const TABLE = "src/pages/flipdesk/listings-table.tsx";
const source = readFileSync(resolve(process.cwd(), TABLE), "utf8");

/** Every `field="…"` a SortHeader is given, deduped. */
function sortableFields(): Set<string> {
  return new Set(
    [...source.matchAll(/field="([a-z_]+)"/g)].map((m) => m[1]!),
  );
}

// Real `items_full` columns, each backing a header a seller can click.
const EXPECTED_SORTABLE = [
  "item_title", // Title — the A-to-Z the request started from
  "item_number", // SKU
  "brand", // Brand · Size (sorts on brand; size is free text)
  // US-3122. This header only RENDERS while the table is already ordered by
  // sourced_by, but it is a real items_full column either way, and clicking it
  // flips the direction like any other.
  "sourced_by",
  "status",
  "notes",
  "updated_at", // Age, which is rendered as days-since-updated
  "purchase_price", // Cost
  "target_price", // Target / List
  "sale_price", // Sale / Sold $
  "net_profit", // Net
  "payout",
  "list_price", // Price (Active)
  "list_date", // Days listed
  "listing_views",
  "listing_watchers",
  "quality_score",
  "carrier",
  "tracking",
  "delivered_at", // Delivery
] as const;

// Values the table renders that are NOT columns. Sorting these would compile
// and then fail in production.
const MUST_NOT_BE_SORTABLE = [
  "margin", // marginPct(it), computed per row
  "score", // scoreById map, computed per row
  "impressions",
  "ctr",
  "platforms", // joined from the listing rows
  "buyer_id", // an opaque id: ordering by it looks sorted and means nothing
] as const;

describe("Inventory table: sortable columns", () => {
  it("sorts every header that has a real column behind it", () => {
    const actual = sortableFields();
    for (const field of EXPECTED_SORTABLE) {
      expect(actual, `${field} should be sortable`).toContain(field);
    }
  });

  it("does not sort values computed on the client or absent from items_full", () => {
    const actual = sortableFields();
    for (const field of MUST_NOT_BE_SORTABLE) {
      expect(
        actual,
        `${field} is not an items_full column — sorting it raises 22023 at ` +
          `runtime the first time someone clicks that header`,
      ).not.toContain(field);
    }
  });

  it("has no sortable field outside the reviewed set", () => {
    // A new one is not necessarily wrong — but it has to be a real column, and
    // adding it here is the moment to check that. Failing loudly beats a
    // production 22023.
    const unexpected = [...sortableFields()].filter(
      (f) => !(EXPECTED_SORTABLE as readonly string[]).includes(f),
    );
    expect(unexpected).toEqual([]);
  });

  it("routes them all through the one SortHeader, so the arrows agree", () => {
    // The SKU header used to be a hand-rolled button with its own copy of the
    // chevron logic. Two implementations of "which way is this sorted" is how
    // one of them ends up pointing the wrong way.
    const handRolled = source.match(/onClick=\{\(\) => toggleColumnSort\(/g);
    expect(handRolled).toBeNull();
  });
});

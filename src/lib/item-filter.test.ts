import { describe, expect, it } from "vitest";
import {
  EMPTY_QUERY,
  decodeQuery,
  describeRule,
  encodeQuery,
  evalQuery,
  fieldValue,
  opLabel,
  opsForField,
  type FilterField,
  type FilterOp,
  type FilterQuery,
} from "./item-filter";
import { sortByField } from "@/pages/flipdesk/listings-filter";
import type { ItemFullRow } from "@/types/database";

// Minimal ItemFullRow factory — only the fields the filter reads matter; the
// rest get null/zero defaults so the cast is sound.
function makeItem(overrides: Partial<ItemFullRow> = {}): ItemFullRow {
  return {
    id: "i1",
    user_id: "u1",
    item_number: null,
    container: null,
    item_title: "Item",
    item_description: null,
    brand: null,
    style: null,
    size: null,
    notes: null,
    comps: [],
    category: null,
    source_name: null,
    source_id: null,
    sourced_by: null,
    purchase_date: null,
    purchase_price: null,
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
    floor_price: null,
    grade_value: null,
    grade_label: null,
    certificate_url: null,
    measurements: null,
    location_bin: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
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

function rule(field: FilterField, op: FilterOp, value = ""): FilterQuery {
  return { combinator: "and", rules: [{ id: "r1", field, op, value }] };
}

describe("evalQuery — empty / combinator", () => {
  it("an empty query matches everything", () => {
    expect(evalQuery(makeItem(), EMPTY_QUERY)).toBe(true);
  });

  it("AND requires every rule; OR requires one", () => {
    const it = makeItem({ brand: "Nike", color: "Red" });
    const and: FilterQuery = {
      combinator: "and",
      rules: [
        { id: "a", field: "brand", op: "eq", value: "Nike" },
        { id: "b", field: "color", op: "eq", value: "Blue" },
      ],
    };
    const or: FilterQuery = { ...and, combinator: "or" };
    expect(evalQuery(it, and)).toBe(false);
    expect(evalQuery(it, or)).toBe(true);
  });
});

describe("text + enum facets (US-1051)", () => {
  it("color eq is case-insensitive", () => {
    expect(evalQuery(makeItem({ color: "Red" }), rule("color", "eq", "red"))).toBe(
      true,
    );
  });

  it("location_bin contains", () => {
    const q = rule("location_bin", "contains", "a-1");
    expect(evalQuery(makeItem({ location_bin: "Shelf A-12" }), q)).toBe(true);
    expect(evalQuery(makeItem({ location_bin: "Shelf B-3" }), q)).toBe(false);
  });

  it("sku maps to item_number", () => {
    const q = rule("sku", "eq", "SKU-9");
    expect(evalQuery(makeItem({ item_number: "SKU-9" }), q)).toBe(true);
  });

  it("marketplace eq matches the listing platform", () => {
    const q = rule("marketplace", "eq", "ebay");
    expect(evalQuery(makeItem({ listing_platform: "ebay" }), q)).toBe(true);
    expect(evalQuery(makeItem({ listing_platform: "poshmark" }), q)).toBe(false);
  });

  it("photo_state distinguishes complete vs incomplete", () => {
    const complete = rule("photo_state", "eq", "complete");
    expect(evalQuery(makeItem({ has_required_photos: true }), complete)).toBe(
      true,
    );
    expect(evalQuery(makeItem({ has_required_photos: false }), complete)).toBe(
      false,
    );
    const incomplete = rule("photo_state", "eq", "incomplete");
    expect(evalQuery(makeItem({ has_required_photos: false }), incomplete)).toBe(
      true,
    );
  });

  it("in / nin over a comma list", () => {
    const inq = rule("brand", "in", "nike, adidas");
    expect(evalQuery(makeItem({ brand: "Adidas" }), inq)).toBe(true);
    expect(evalQuery(makeItem({ brand: "Puma" }), inq)).toBe(false);
    const ninq = rule("brand", "nin", "nike, adidas");
    expect(evalQuery(makeItem({ brand: "Puma" }), ninq)).toBe(true);
  });

  it("isnull / notnull", () => {
    expect(evalQuery(makeItem({ color: null }), rule("color", "isnull"))).toBe(
      true,
    );
    expect(
      evalQuery(makeItem({ color: "Red" }), rule("color", "notnull")),
    ).toBe(true);
  });
});

describe("numeric facets", () => {
  it("cost gte / target_price lt", () => {
    expect(
      evalQuery(makeItem({ purchase_price: 20 }), rule("cost", "gte", "10")),
    ).toBe(true);
    expect(
      evalQuery(makeItem({ purchase_price: 5 }), rule("cost", "gte", "10")),
    ).toBe(false);
    expect(
      evalQuery(
        makeItem({ target_price: 30 }),
        rule("target_price", "lt", "40"),
      ),
    ).toBe(true);
  });

  it("a numeric comparison against a null value never matches", () => {
    expect(
      evalQuery(makeItem({ grade_value: null }), rule("grade", "gte", "8")),
    ).toBe(false);
  });
});

// US-3195 AC1: the days_listed accessor itself, not just the rule that reads
// it. The parallel helper in aged-inventory.ts has always been tested; this
// FilterField never was, and the two can drift because they are two functions
// computing the same number from the same column.
//
// The whole point of the field is the null. A drafted item has not been listed
// for zero days — it has not been listed — and a zero here would put every
// never-listed row inside "days listed >= 60", which is the death-pile filter.
describe("days_listed (US-3195)", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();

  it("a listing that has never been listed is null, not zero", () => {
    const v = fieldValue(makeItem({ list_date: null }), "days_listed");
    expect(v).toBeNull();
    // Spelled out because `0` and `null` both read as falsy and the bug this
    // guards against is exactly the two being treated as the same thing.
    expect(v).not.toBe(0);
  });

  it("an unparseable list_date is null too, not NaN", () => {
    expect(fieldValue(makeItem({ list_date: "not a date" }), "days_listed")).toBeNull();
  });

  it("counts whole days since list_date for a listing that has one", () => {
    expect(fieldValue(makeItem({ list_date: daysAgo(90) }), "days_listed")).toBe(90);
  });

  it("is a different number from days_in_status for the same row", () => {
    // The row that motivated the field: repriced yesterday, listed eight
    // months ago. days_in_status says 1 and says nothing about dead stock.
    const it_ = makeItem({ list_date: daysAgo(240), updated_at: daysAgo(1) });
    expect(fieldValue(it_, "days_in_status")).toBe(1);
    expect(fieldValue(it_, "days_listed")).toBe(240);
  });

  it("a never-listed row falls out of a days_listed threshold rather than into it", () => {
    const never = makeItem({ list_date: null });
    expect(evalQuery(never, rule("days_listed", "gte", "60"))).toBe(false);
    // Not even ">= 0", which is what a zero would satisfy.
    expect(evalQuery(never, rule("days_listed", "gte", "0"))).toBe(false);
    expect(evalQuery(never, rule("days_listed", "isnull"))).toBe(true);
  });

  it("sorts LAST in both directions, because the column it derives from is null", () => {
    // The Aged tab orders on list_date (inventory-tabs.ts), so this is the
    // production sorter, not a comparator written for the test. Oldest first
    // must not open on the rows that were never listed at all.
    const rows = [
      makeItem({ id: "never", list_date: null }),
      makeItem({ id: "old", list_date: daysAgo(200) }),
      makeItem({ id: "new", list_date: daysAgo(3) }),
    ];
    expect(sortByField([...rows], "list_date", "asc").map((r) => r.id)).toEqual([
      "old",
      "new",
      "never",
    ]);
    expect(sortByField([...rows], "list_date", "desc").map((r) => r.id)).toEqual([
      "new",
      "old",
      "never",
    ]);
  });
});

describe("date facets (US-1051)", () => {
  const item = makeItem({
    purchase_date: "2026-06-10",
    sale_date: "2026-06-15T12:00:00Z",
  });

  it("before / after / on a purchase date", () => {
    expect(evalQuery(item, rule("purchase_date", "lt", "2026-06-11"))).toBe(true);
    expect(evalQuery(item, rule("purchase_date", "gt", "2026-06-11"))).toBe(
      false,
    );
    expect(evalQuery(item, rule("purchase_date", "eq", "2026-06-10"))).toBe(
      true,
    );
    expect(evalQuery(item, rule("purchase_date", "eq", "2026-06-11"))).toBe(
      false,
    );
  });

  it("on-or-after / on-or-before bounds are inclusive of the day", () => {
    expect(evalQuery(item, rule("purchase_date", "gte", "2026-06-10"))).toBe(
      true,
    );
    expect(evalQuery(item, rule("purchase_date", "lte", "2026-06-10"))).toBe(
      true,
    );
  });

  it("a null date never matches a comparison but matches isnull", () => {
    const nodate = makeItem({ sale_date: null });
    expect(evalQuery(nodate, rule("sale_date", "gte", "2026-01-01"))).toBe(
      false,
    );
    expect(evalQuery(nodate, rule("sale_date", "isnull"))).toBe(true);
  });
});

describe("operator sets snap to field type", () => {
  it("numeric fields offer comparisons, not contains", () => {
    expect(opsForField("cost")).toContain("gte");
    expect(opsForField("cost")).not.toContain("contains");
  });
  it("date fields offer date comparisons", () => {
    expect(opsForField("purchase_date")).toEqual([
      "lt",
      "lte",
      "gt",
      "gte",
      "eq",
      "isnull",
      "notnull",
    ]);
  });
  it("enum fields only offer equality + emptiness", () => {
    expect(opsForField("marketplace")).toEqual(["eq", "neq", "isnull", "notnull"]);
  });
  it("text fields offer contains + in", () => {
    expect(opsForField("brand")).toContain("contains");
    expect(opsForField("brand")).toContain("in");
  });
});

describe("labels + serialization", () => {
  it("date operators read with date verbs", () => {
    expect(opLabel("purchase_date", "lt")).toBe("before");
    expect(opLabel("purchase_date", "gte")).toBe("on or after");
    expect(opLabel("cost", "lt")).toBe("<");
  });

  it("describeRule shows enum labels, not stored values", () => {
    expect(
      describeRule({ id: "r", field: "marketplace", op: "eq", value: "ebay" }),
    ).toBe("Marketplace is eBay");
    expect(
      describeRule({
        id: "r",
        field: "photo_state",
        op: "eq",
        value: "incomplete",
      }),
    ).toBe("Photo state is Missing required photos");
  });

  it("encode → decode round-trips a query", () => {
    const q: FilterQuery = {
      combinator: "or",
      rules: [
        { id: "a", field: "color", op: "eq", value: "Red" },
        { id: "b", field: "purchase_date", op: "gte", value: "2026-01-01" },
      ],
    };
    expect(decodeQuery(encodeQuery(q))).toEqual(q);
  });

  it("decodeQuery rejects garbage", () => {
    expect(decodeQuery("not-base64!!")).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import {
  boardFiltersActive,
  boardMoreLink,
  planBatchAdvance,
  type BoardFilters,
} from "@/lib/pipeline-board";
import { decodeQuery, EMPTY_QUERY, evalQuery, type FilterQuery } from "@/lib/item-filter";
import type { ItemListRow } from "@/lib/item-list-columns";

function item(overrides: Partial<ItemListRow>): ItemListRow {
  return {
    id: "x",
    item_title: "Item",
    status: "cataloged",
    measurements: { chest: 20 },
    has_required_photos: true,
    target_price: null,
    list_price: null,
    sale_price: null,
    brand: null,
    category: null,
    source_name: null,
    ...overrides,
  } as ItemListRow;
}

const NO_FILTERS: BoardFilters = {
  q: "",
  category: "all",
  brand: "all",
  source: "all",
  filterQuery: EMPTY_QUERY,
};

describe("planBatchAdvance", () => {
  it("groups passing cards by target stage so each stage is one write", () => {
    const plan = planBatchAdvance([
      item({ id: "a", status: "sourced" }),
      item({ id: "b", status: "acquired" }),
      item({ id: "c", status: "cataloged" }),
      item({ id: "d", status: "sourced" }),
      item({ id: "e", status: "cataloged" }),
    ]);
    expect(plan.refused).toEqual([]);
    expect(plan.groups.map((g) => [g.status, g.items.map((i) => i.id)])).toEqual([
      ["cataloged", ["a", "b", "d"]],
      ["measured", ["c", "e"]],
    ]);
  });

  it("keeps refused cards out of every write and says why", () => {
    const plan = planBatchAdvance([
      item({ id: "a", item_title: "No tape", status: "cataloged", measurements: null }),
      item({ id: "b", item_title: "No photos", status: "measured", has_required_photos: false }),
      item({ id: "c", item_title: "Done", status: "returned" }),
      item({ id: "d", status: "measured" }),
    ]);
    expect(plan.groups).toEqual([
      { status: "photographed", items: [expect.objectContaining({ id: "d" })] },
    ]);
    expect(plan.refused.map((r) => r.title)).toEqual(["No tape", "No photos", "Done"]);
    expect(plan.refused.every((r) => !r.ok)).toBe(true);
  });
});

describe("boardMoreLink", () => {
  function linkQuery(href: string): { params: URLSearchParams; filter: FilterQuery | null } {
    const params = new URL(href, "https://x.test").searchParams;
    const f = params.get("filter");
    return { params, filter: f ? decodeQuery(f) : null };
  }

  it("carries search, facets and the stage into the table link", () => {
    const href = boardMoreLink("measured", {
      q: " coat ",
      category: "outerwear" as BoardFilters["category"],
      brand: "Acme",
      source: "Goodwill bins",
      filterQuery: {
        combinator: "and",
        rules: [{ id: "r1", field: "size", op: "eq", value: "L" }],
      },
    });
    expect(href.startsWith("/dashboard/flipdesk/items?")).toBe(true);
    const { params, filter } = linkQuery(href);
    expect(params.get("status")).toBe("measured");
    expect(params.get("q")).toBe("coat");
    expect(filter?.combinator).toBe("and");
    const match = item({
      status: "measured",
      category: "outerwear" as ItemListRow["category"],
      brand: "Acme",
      source_name: "Goodwill bins",
      size: "L",
    });
    expect(evalQuery(match, filter!)).toBe(true);
    // Each carried condition narrows: flip any one and the row drops out.
    for (const miss of [
      { status: "cataloged" },
      { brand: "Other" },
      { source_name: "Estate sale" },
      { category: "tops" },
      { size: "M" },
    ] as Partial<ItemListRow>[]) {
      expect(evalQuery({ ...match, ...miss }, filter!)).toBe(false);
    }
  });

  it("folds acquired into the Sourced link, as the column does", () => {
    const { filter } = linkQuery(boardMoreLink("sourced", NO_FILTERS));
    expect(evalQuery(item({ status: "acquired" }), filter!)).toBe(true);
    expect(evalQuery(item({ status: "sourced" }), filter!)).toBe(true);
    expect(evalQuery(item({ status: "cataloged" }), filter!)).toBe(false);
  });

  it("does not rewrite an 'any of' filter it cannot AND onto", () => {
    const own: FilterQuery = {
      combinator: "or",
      rules: [
        { id: "r1", field: "brand", op: "eq", value: "Acme" },
        { id: "r2", field: "brand", op: "eq", value: "Zeta" },
      ],
    };
    const { filter } = linkQuery(boardMoreLink("measured", { ...NO_FILTERS, filterQuery: own }));
    expect(filter).toEqual(own);
  });
});

describe("boardFiltersActive", () => {
  it("is false with nothing set and true for any one filter", () => {
    expect(boardFiltersActive(NO_FILTERS)).toBe(false);
    expect(boardFiltersActive({ ...NO_FILTERS, q: "coat" })).toBe(true);
    expect(boardFiltersActive({ ...NO_FILTERS, brand: "Acme" })).toBe(true);
    expect(
      boardFiltersActive({
        ...NO_FILTERS,
        filterQuery: { combinator: "and", rules: [{ id: "r", field: "size", op: "eq", value: "L" }] },
      }),
    ).toBe(true);
  });
});

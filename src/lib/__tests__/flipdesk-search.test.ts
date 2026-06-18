import { describe, expect, it } from "vitest";
import {
  buildSearchArgs,
  deepLinkForHit,
  isSearchableQuery,
  mapHits,
  normalizeQuery,
  normalizeScope,
  parseSnippet,
  type SearchHit,
} from "../flipdesk-search";

function hit(overrides: Partial<SearchHit> = {}): SearchHit {
  return {
    result_type: "item",
    result_id: "r1",
    inventory_item_id: "i1",
    title: "Levi's 501",
    snippet: "Vintage <mark>Levi's</mark> denim",
    rank: 0.5,
    ...overrides,
  };
}

describe("normalizeQuery", () => {
  it("trims and collapses internal whitespace", () => {
    expect(normalizeQuery("  vintage   denim  ")).toBe("vintage denim");
  });
  it("preserves websearch operators verbatim", () => {
    expect(normalizeQuery('"vintage denim" -kids OR levis')).toBe(
      '"vintage denim" -kids OR levis',
    );
  });
});

describe("isSearchableQuery", () => {
  it("requires at least two non-whitespace characters", () => {
    expect(isSearchableQuery("a")).toBe(false);
    expect(isSearchableQuery("  x ")).toBe(false);
    expect(isSearchableQuery("ab")).toBe(true);
  });
});

describe("normalizeScope", () => {
  it("accepts the four valid scopes", () => {
    for (const s of ["all", "items", "listings", "sales"] as const) {
      expect(normalizeScope(s)).toBe(s);
    }
  });
  it("falls back to 'all' for anything else", () => {
    expect(normalizeScope("bogus")).toBe("all");
    expect(normalizeScope(null)).toBe("all");
    expect(normalizeScope(undefined)).toBe("all");
  });
});

describe("buildSearchArgs", () => {
  it("returns null for an empty / too-short query", () => {
    expect(buildSearchArgs("")).toBeNull();
    expect(buildSearchArgs("  ")).toBeNull();
    expect(buildSearchArgs("a")).toBeNull();
  });

  it("builds args with normalized query and defaults", () => {
    expect(buildSearchArgs("  hello  world ")).toEqual({
      p_query: "hello world",
      p_scope: "all",
      p_limit: 50,
    });
  });

  it("passes the chosen scope through", () => {
    expect(buildSearchArgs("denim", "listings")?.p_scope).toBe("listings");
  });

  it("coerces an invalid scope to 'all'", () => {
    // @ts-expect-error — exercise the defensive coercion
    expect(buildSearchArgs("denim", "nope")?.p_scope).toBe("all");
  });

  it("preserves websearch syntax for the RPC's tsquery parser", () => {
    const args = buildSearchArgs('"vintage denim" -kids OR levis');
    expect(args?.p_query).toBe('"vintage denim" -kids OR levis');
  });

  it("clamps the limit to the RPC's accepted range", () => {
    expect(buildSearchArgs("x y", "all", 9999)?.p_limit).toBe(200);
    expect(buildSearchArgs("x y", "all", 0)?.p_limit).toBe(50);
    expect(buildSearchArgs("x y", "all", -10)?.p_limit).toBe(1);
    expect(buildSearchArgs("x y", "all", 25)?.p_limit).toBe(25);
  });
});

describe("deepLinkForHit", () => {
  it("links an item to its detail page by result_id", () => {
    expect(deepLinkForHit(hit({ result_type: "item", result_id: "abc" }))).toBe(
      "/dashboard/flipdesk/items/abc",
    );
  });

  it("links a listing to its parent item when known", () => {
    expect(
      deepLinkForHit(
        hit({ result_type: "listing", result_id: "L1", inventory_item_id: "i9" }),
      ),
    ).toBe("/dashboard/flipdesk/items/i9");
  });

  it("falls back to the listings index when a listing has no parent item", () => {
    expect(
      deepLinkForHit(
        hit({ result_type: "listing", result_id: "L1", inventory_item_id: null }),
      ),
    ).toBe("/dashboard/flipdesk/listings");
  });

  it("links a sale to its parent item, else reconciliation", () => {
    expect(
      deepLinkForHit(
        hit({ result_type: "sale", result_id: "S1", inventory_item_id: "i3" }),
      ),
    ).toBe("/dashboard/flipdesk/items/i3");
    expect(
      deepLinkForHit(
        hit({ result_type: "sale", result_id: "S1", inventory_item_id: null }),
      ),
    ).toBe("/dashboard/flipdesk/reconciliation");
  });
});

describe("parseSnippet", () => {
  it("returns an empty array for an empty snippet", () => {
    expect(parseSnippet("")).toEqual([]);
  });

  it("splits highlighted and plain segments", () => {
    expect(parseSnippet("Vintage <mark>Levi's</mark> denim")).toEqual([
      { text: "Vintage ", highlight: false },
      { text: "Levi's", highlight: true },
      { text: " denim", highlight: false },
    ]);
  });

  it("handles multiple marks and a leading highlight", () => {
    expect(parseSnippet("<mark>red</mark> and <mark>blue</mark>")).toEqual([
      { text: "red", highlight: true },
      { text: " and ", highlight: false },
      { text: "blue", highlight: true },
    ]);
  });

  it("treats a snippet with no marks as a single plain segment", () => {
    expect(parseSnippet("just text")).toEqual([
      { text: "just text", highlight: false },
    ]);
  });
});

describe("mapHits", () => {
  it("returns an empty array for null / undefined", () => {
    expect(mapHits(null)).toEqual([]);
    expect(mapHits(undefined)).toEqual([]);
  });

  it("enriches each row with key, link, segments and label, preserving order", () => {
    const rows: SearchHit[] = [
      hit({ result_type: "item", result_id: "a", rank: 0.9 }),
      hit({
        result_type: "sale",
        result_id: "b",
        inventory_item_id: null,
        snippet: "buyer notes",
        rank: 0.1,
      }),
    ];
    const mapped = mapHits(rows);
    expect(mapped.map((m) => m.key)).toEqual(["item-a", "sale-b"]);
    expect(mapped[0]!.link).toBe("/dashboard/flipdesk/items/a");
    expect(mapped[0]!.typeLabel).toBe("Item");
    expect(mapped[1]!.link).toBe("/dashboard/flipdesk/reconciliation");
    expect(mapped[1]!.typeLabel).toBe("Sale");
    expect(mapped[1]!.segments).toEqual([
      { text: "buyer notes", highlight: false },
    ]);
  });
});

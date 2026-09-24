import { describe, expect, it } from "vitest";
import {
  buildSearchArgs,
  classifyQuery,
  escapeLike,
  groupHitsByItem,
  stripTitleEcho,
  summarizeHits,
  deepLinkForHit,
  isSearchableQuery,
  itemTabFromParam,
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

  it("links a listing to its parent item's Listing tab", () => {
    expect(
      deepLinkForHit(
        hit({ result_type: "listing", result_id: "L1", inventory_item_id: "i9" }),
      ),
    ).toBe("/dashboard/flipdesk/items/i9?tab=listing&listing=L1");
  });

  it("links a sale to its parent item's Money tab", () => {
    expect(
      deepLinkForHit(
        hit({ result_type: "sale", result_id: "S1", inventory_item_id: "i3" }),
      ),
    ).toBe("/dashboard/flipdesk/items/i3?tab=money&sale=S1");
  });

  it("never falls back to an index page (both FKs are NOT NULL, 00002)", () => {
    for (const t of ["listing", "sale"] as const) {
      expect(
        deepLinkForHit(hit({ result_type: t, result_id: "x", inventory_item_id: "i1" })),
      ).toMatch(/^\/dashboard\/flipdesk\/items\/i1/);
    }
  });
});

describe("itemTabFromParam (F6)", () => {
  it("accepts every tab a deep link can name", () => {
    for (const h of [
      hit({ result_type: "listing", result_id: "L", inventory_item_id: "i" }),
      hit({ result_type: "sale", result_id: "S", inventory_item_id: "i" }),
    ]) {
      const tab = new URL(deepLinkForHit(h), "https://x.test").searchParams.get("tab");
      expect(itemTabFromParam(tab)).toBe(tab);
    }
    expect(itemTabFromParam("details")).toBe("details");
    expect(itemTabFromParam("grade")).toBe("grade");
  });

  it("ignores anything else", () => {
    expect(itemTabFromParam(null)).toBeNull();
    expect(itemTabFromParam("")).toBeNull();
    expect(itemTabFromParam("admin")).toBeNull();
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
        inventory_item_id: "i7",
        snippet: "buyer notes",
        rank: 0.1,
      }),
    ];
    const mapped = mapHits(rows);
    expect(mapped.map((m) => m.key)).toEqual(["item-a", "sale-b"]);
    expect(mapped[0]!.link).toBe("/dashboard/flipdesk/items/a");
    expect(mapped[0]!.typeLabel).toBe("Item");
    expect(mapped[1]!.link).toBe("/dashboard/flipdesk/items/i7?tab=money&sale=b");
    expect(mapped[1]!.typeLabel).toBe("Sale");
    expect(mapped[1]!.segments).toEqual([
      { text: "buyer notes", highlight: false },
    ]);
  });
});

describe("summarizeHits (U2)", () => {
  const rows = [
    hit({ result_type: "item" }),
    hit({ result_type: "item", result_id: "r2" }),
    hit({ result_type: "listing", result_id: "L" }),
    hit({ result_type: "sale", result_id: "S" }),
  ];

  it("counts exactly when the RPC did not hit its limit", () => {
    const s = summarizeHits(rows, false, 50);
    expect(s.headline).toBe("4 results");
    expect(s.breakdown).toBe("2 items, 1 listing, 1 sale");
    expect(s.byType).toEqual({ item: 2, listing: 1, sale: 1 });
  });

  it("says 50+ and marks the split as the top 50 when capped", () => {
    const s = summarizeHits(rows, true, 50);
    expect(s.headline).toBe("50+ results, showing the best 50");
    expect(s.breakdown).toBe("2 items, 1 listing, 1 sale in the top 50");
  });

  it("handles one and none", () => {
    expect(summarizeHits([rows[0]!], false).headline).toBe("1 result");
    expect(summarizeHits([], false).breakdown).toBe("");
  });
});

describe("groupHitsByItem (D1)", () => {
  it("collapses an item, its listing and its sale into one entry", () => {
    const mapped = mapHits([
      hit({ result_type: "sale", result_id: "S1", inventory_item_id: "i1", title: "buyer_jo" }),
      hit({ result_type: "item", result_id: "i1", inventory_item_id: "i1" }),
      hit({ result_type: "listing", result_id: "L1", inventory_item_id: "i1" }),
      hit({ result_type: "item", result_id: "i2", inventory_item_id: "i2" }),
    ]);
    const groups = groupHitsByItem(mapped);
    expect(groups.map((g) => g.itemId)).toEqual(["i1", "i2"]);
    expect(groups[0]!.matchedIn).toEqual(["item", "listing", "sale"]);
    expect(groups[0]!.hits).toHaveLength(3);
    // The best-ranked hit (first) decides where the row goes.
    expect(groups[0]!.best.result_type).toBe("sale");
    expect(groups[0]!.sale?.title).toBe("buyer_jo");
    expect(groups[1]!.sale).toBeNull();
  });
});

describe("classifyQuery (D2)", () => {
  it("treats a single token with a digit as a code", () => {
    expect(classifyQuery("J0042")).toEqual({
      kind: "code",
      term: "J0042",
      fields: ["sku", "bin"],
      rpcQuery: "J0042",
    });
    expect(classifyQuery(" A3 ").kind).toBe("code");
  });

  it("honours sku: and bin: and hands the RPC the bare code", () => {
    expect(classifyQuery("sku:J0042")).toMatchObject({ kind: "code", fields: ["sku"], rpcQuery: "J0042" });
    expect(classifyQuery("BIN: A3")).toMatchObject({ kind: "code", fields: ["bin"], term: "A3" });
  });

  it("leaves words, phrases and odd characters to full text", () => {
    expect(classifyQuery("levis 501").kind).toBe("text");
    expect(classifyQuery("carhartt").kind).toBe("text");
    expect(classifyQuery("a,b1").kind).toBe("text");
    expect(classifyQuery("sku:a,b").kind).toBe("text");
  });
});

describe("escapeLike", () => {
  it("escapes LIKE wildcards", () => {
    expect(escapeLike("A_1%")).toBe("A\\_1\\%");
  });
});

describe("stripTitleEcho (D1)", () => {
  it("drops the leading title and separator the RPC writes", () => {
    const segs = parseSnippet("Levi's 501 \u2014 faded <mark>denim</mark> jeans");
    expect(stripTitleEcho(segs, "Levi's 501")).toEqual([
      { text: "faded ", highlight: false },
      { text: "denim", highlight: true },
      { text: " jeans", highlight: false },
    ]);
  });

  it("leaves a fragment from further in alone", () => {
    const segs = parseSnippet("faded <mark>denim</mark> jeans");
    expect(stripTitleEcho(segs, "Levi's 501")).toEqual(segs);
  });

  it("mapHits applies it to items but not to sales", () => {
    const [item, sale] = mapHits([
      hit({ title: "Coat", snippet: "Coat \u2014 wool" }),
      hit({ result_type: "sale", result_id: "s", title: "Coat", snippet: "Coat \u2014 wool" }),
    ]);
    expect(item!.segments.map((x) => x.text).join("")).toBe("wool");
    expect(sale!.segments.map((x) => x.text).join("")).toBe("Coat \u2014 wool");
  });
});

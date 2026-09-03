// US-1060: comp broadening ladder. comps-ladder.ts -> ebay-client + supabase
// (both throw at init w/o env), so dummy-env then dynamic-import. The fetchers
// are injected, so these tests exercise the PURE stage-building + rung-selection
// + sold-merge logic with no eBay or DB I/O.
import { assert, assertEquals } from "@std/assert";
import type { BrowseComp, BrowseCompsResult } from "../lib/ebay-client.ts";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  buildLadderStages,
  searchCompsWithLadder,
  DEFAULT_MIN_COMP_RESULTS,
  STYLE_CODE_MIN_RESULTS,
} = await import("../lib/comps-ladder.ts");

type Args = {
  categoryId?: string;
  q?: string;
  brand?: string;
  size?: string;
  conditionId?: string;
  limit?: number;
  gtin?: string;
  styleCode?: string;
};

// US-2764: these were three hand-written copies of the real shapes, and adding
// a field to BrowseComp broke every fake here at once. Aliasing the real types
// means the compiler tells us about the next field too, instead of the fakes
// quietly describing a response the client stopped returning.
type Stats = BrowseCompsResult["stats"];
type Comp = BrowseComp;
type Result = BrowseCompsResult;

function stats(count: number): Stats {
  return {
    count,
    currency: "USD",
    min: count ? 10 : null,
    p25: count ? 15 : null,
    median: count ? 20 : null,
    p75: count ? 25 : null,
    max: count ? 30 : null,
  };
}

function comps(n: number, prefix: string): Comp[] {
  return Array.from({ length: n }, (_, i) => ({
    itemId: `${prefix}-${i}`,
    title: `${prefix} ${i}`,
    price: 20,
    currency: "USD",
    imageUrl: null,
    itemWebUrl: null,
    condition: "Used",
    buyingOptions: ["FIXED_PRICE"],
    // US-3098: fixtures state it explicitly; null means 'this source
    // cannot say', which is not the same fact as free shipping.
    shippingCents: null,
    categories: [],
    leafCategoryIds: [],
  }));
}

function result(n: number, prefix: string): Result {
  return {
    items: comps(n, prefix),
    total: n,
    stats: stats(n),
    categoryVotes: [],
    leafCategoryVotes: [],
  };
}

// ── buildLadderStages (pure) ───────────────────────────────────────────────

Deno.test("buildLadderStages: full ladder labels exact → broadened → brand_category → category", () => {
  const stages = buildLadderStages({
    categoryId: "11450",
    q: "Nike Dri-Fit running shirt",
    brand: "Nike",
    size: "M",
  });
  const breadths = stages.map((s) => s.breadth);

  assertEquals(breadths[0], "exact");
  assert(breadths.includes("broadened"));
  assertEquals(breadths.at(-2), "brand_category");
  assertEquals(breadths.at(-1), "category");

  // exact carries q + brand + size; category drops them all.
  assertEquals(stages[0]!.args.size, "M");
  const category = stages.at(-1)!.args;
  assertEquals(category.q, undefined);
  assertEquals(category.brand, undefined);
  assertEquals(category.size, undefined);
  assertEquals(category.categoryId, "11450");

  // brand_category keeps brand, drops q + size.
  const bc = stages.at(-2)!.args;
  assertEquals(bc.brand, "Nike");
  assertEquals(bc.q, undefined);
  assertEquals(bc.size, undefined);
});

Deno.test("buildLadderStages: broadened rungs drop trailing title tokens, keep brand, drop size", () => {
  const stages = buildLadderStages({
    categoryId: "11450",
    q: "Nike Dri-Fit running shirt",
    brand: "Nike",
    size: "M",
  });
  const broadened = stages.filter((s) => s.breadth === "broadened");
  // Title has 4 tokens → broadened rungs progressively shorten the query.
  const queries = broadened.map((s) => s.args.q);
  assertEquals(queries[0], "Nike Dri-Fit running shirt"); // full q, no size
  assertEquals(queries.at(-1), "Nike"); // single trailing token
  // No broadened rung carries a size; all keep the brand.
  for (const s of broadened) {
    assertEquals(s.args.size, undefined);
    assertEquals(s.args.brand, "Nike");
  }
});

Deno.test("buildLadderStages: dedupes no-op broadening (no size, single-token query)", () => {
  const stages = buildLadderStages({
    categoryId: "11450",
    q: "Levis",
    brand: "Levis",
  });
  const keys = stages.map((s) =>
    JSON.stringify([s.args.q ?? "", s.args.brand ?? "", s.args.size ?? ""])
  );
  // No duplicate effective queries survive the dedupe.
  assertEquals(new Set(keys).size, keys.length);
});

Deno.test("buildLadderStages: category-only input yields a single rung", () => {
  const stages = buildLadderStages({ categoryId: "11450" });
  assertEquals(stages.length, 1);
  assertEquals(stages[0]!.breadth, "exact");
});

// ── searchCompsWithLadder: rung selection ──────────────────────────────────

Deno.test("searchCompsWithLadder: stops at the first rung clearing minResults", async () => {
  const calls: string[] = [];
  const out = await searchCompsWithLadder(
    { categoryId: "11450", q: "Nike running shirt", brand: "Nike", size: "M" },
    {
      minResults: 3,
      soldEnabled: false,
      fetchActive: (a: Args) => {
        calls.push(a.q ?? "(no-q)");
        // exact + first broadened are thin; a later rung clears the bar.
        const n = (a.q ?? "").split(/\s+/).filter(Boolean).length <= 2 ? 5 : 1;
        return Promise.resolve(result(n, "active"));
      },
    },
  );
  assertEquals(out.broadened, true);
  assertEquals(out.breadth, "broadened");
  assertEquals(out.stats.count, 5);
  // It stopped early — it did not walk all the way to the category rung.
  assert(out.ladder.length < calls.length + 1);
  assert(out.items.every((i) => i.source === "active"));
});

Deno.test("searchCompsWithLadder: exact rung wins when it already clears the bar", async () => {
  const out = await searchCompsWithLadder(
    { categoryId: "11450", q: "Nike", brand: "Nike" },
    {
      minResults: 2,
      soldEnabled: false,
      fetchActive: () => Promise.resolve(result(8, "active")),
    },
  );
  assertEquals(out.breadth, "exact");
  assertEquals(out.broadened, false);
  assertEquals(out.ladder.length, 1); // stopped on the first rung
});

Deno.test("searchCompsWithLadder: no rung clears the bar → broadest non-empty wins", async () => {
  const out = await searchCompsWithLadder(
    { categoryId: "11450", q: "rare vintage band tee", brand: "Acme" },
    {
      minResults: 50,
      soldEnabled: false,
      fetchActive: (a: Args) =>
        // Only the category rung (no q, no brand) returns anything.
        Promise.resolve(
          result(!a.q && !a.brand ? 4 : 0, "active"),
        ),
    },
  );
  assertEquals(out.breadth, "category");
  assertEquals(out.stats.count, 4);
});

Deno.test("searchCompsWithLadder: all rungs empty → empty result, never throws", async () => {
  const out = await searchCompsWithLadder(
    { categoryId: "11450", q: "nothing here", brand: "Acme" },
    {
      minResults: 3,
      soldEnabled: false,
      fetchActive: () => Promise.resolve(result(0, "active")),
    },
  );
  assertEquals(out.items.length, 0);
  assertEquals(out.stats.count, 0);
  assert(out.ladder.length > 0);
});

Deno.test("searchCompsWithLadder: a fetch failure counts as 0 and the ladder continues", async () => {
  const out = await searchCompsWithLadder(
    { categoryId: "11450", q: "Nike tee", brand: "Nike" },
    {
      minResults: 2,
      soldEnabled: false,
      fetchActive: (a: Args) => {
        if (a.q && a.brand) return Promise.reject(new Error("eBay 500"));
        return Promise.resolve(result(5, "active")); // brand_category / category
      },
    },
  );
  // It survived the throwing rungs and surfaced a later one.
  assertEquals(out.stats.count, 5);
  assert(out.ladder.some((r) => r.count === 0));
});

// ── searchCompsWithLadder: sold-comp merge ─────────────────────────────────

Deno.test("searchCompsWithLadder: merges + tags sold comps when enabled", async () => {
  const out = await searchCompsWithLadder(
    { categoryId: "11450", q: "Nike", brand: "Nike" },
    {
      minResults: 2,
      soldEnabled: true,
      fetchActive: () => Promise.resolve(result(3, "active")),
      fetchSold: () => Promise.resolve(result(2, "sold")),
    },
  );
  assertEquals(out.soldEnabled, true);
  assertEquals(out.items.filter((i) => i.source === "active").length, 3);
  assertEquals(out.items.filter((i) => i.source === "sold").length, 2);
  assert(out.soldStats !== null);
  assertEquals(out.soldStats!.count, 2);
  // Pricing stats stay over the ACTIVE set only.
  assertEquals(out.stats.count, 3);
});

Deno.test("searchCompsWithLadder: graceful no-op when sold grant disabled", async () => {
  let soldCalled = false;
  const out = await searchCompsWithLadder(
    { categoryId: "11450", q: "Nike", brand: "Nike" },
    {
      minResults: 2,
      soldEnabled: false,
      fetchActive: () => Promise.resolve(result(3, "active")),
      fetchSold: () => {
        soldCalled = true;
        return Promise.resolve(result(2, "sold"));
      },
    },
  );
  assertEquals(soldCalled, false);
  assertEquals(out.soldEnabled, false);
  assertEquals(out.soldStats, null);
  assert(out.items.every((i) => i.source === "active"));
});

Deno.test("searchCompsWithLadder: sold fetch failure degrades to active-only", async () => {
  const out = await searchCompsWithLadder(
    { categoryId: "11450", q: "Nike", brand: "Nike" },
    {
      minResults: 2,
      soldEnabled: true,
      fetchActive: () => Promise.resolve(result(3, "active")),
      fetchSold: () => Promise.reject(new Error("insights 403")),
    },
  );
  assertEquals(out.soldStats, null);
  assertEquals(out.items.length, 3);
});

// ── US-2245: the style-code rung ───────────────────────────────────────────

Deno.test("buildLadderStages: a style code adds a FIRST rung and changes nothing else", () => {
  const args = {
    categoryId: "11450",
    q: "Lululemon ABC pant classic",
    brand: "Lululemon",
    size: "32",
  };
  const without = buildLadderStages(args);
  const with_ = buildLadderStages({ ...args, styleCode: "LW7DVCS" });

  assertEquals(with_[0]!.breadth, "style_code");
  assertEquals(with_[0]!.args.styleCode, "LW7DVCS");
  assertEquals(with_[0]!.args.brand, "Lululemon");
  // The code identifies the product, not the size.
  assertEquals(with_[0]!.args.size, undefined);

  // Every rung after it is the old ladder, untouched — and no other rung
  // inherits the code.
  assertEquals(with_.length, without.length + 1);
  assertEquals(
    JSON.stringify(with_.slice(1)),
    JSON.stringify(without),
  );
  for (const s of with_.slice(1)) assertEquals(s.args.styleCode, undefined);
});

Deno.test("buildLadderStages: a blank style code adds no rung", () => {
  for (const code of ["", "   ", undefined]) {
    const stages = buildLadderStages({
      categoryId: "11450",
      q: "Nike tee",
      brand: "Nike",
      styleCode: code,
    });
    assertEquals(stages[0]!.breadth, "exact");
  }
});

Deno.test("searchCompsWithLadder: ONE style-code comp wins, even below minResults", async () => {
  const out = await searchCompsWithLadder(
    {
      categoryId: "11450",
      q: "Lululemon ABC pant",
      brand: "Lululemon",
      styleCode: "LW7DVCS",
    },
    {
      minResults: 5,
      soldEnabled: false,
      // The code returns a single identical-product comp; the title query would
      // have returned a fat page of same-brand-different-product listings.
      fetchActive: (a: Args) =>
        Promise.resolve(result(a.styleCode ? 1 : 20, "active")),
    },
  );
  assertEquals(STYLE_CODE_MIN_RESULTS, 1);
  assertEquals(out.breadth, "style_code");
  assertEquals(out.stats.count, 1);
  // Tightening is not broadening — no "we loosened your search" warning.
  assertEquals(out.broadened, false);
  assertEquals(out.ladder.length, 1); // stopped on the first rung
});

Deno.test("searchCompsWithLadder: an empty style-code rung falls through to the old outcome", async () => {
  const args = {
    categoryId: "11450",
    q: "Nike Dri-Fit shirt",
    brand: "Nike",
    size: "M",
  };
  const fetchActive = (a: Args) =>
    Promise.resolve(result(a.styleCode ? 0 : 6, "active"));

  const baseline = await searchCompsWithLadder(args, {
    minResults: 5,
    soldEnabled: false,
    fetchActive,
  });
  const withCode = await searchCompsWithLadder(
    { ...args, styleCode: "NOSUCHCODE" },
    { minResults: 5, soldEnabled: false, fetchActive },
  );

  assertEquals(withCode.breadth, baseline.breadth);
  assertEquals(withCode.stats.count, baseline.stats.count);
  assertEquals(withCode.broadened, baseline.broadened);
  // The dead rung is still reported, so the panel can show it was tried.
  assertEquals(withCode.ladder[0], { breadth: "style_code", count: 0 });
});

Deno.test("searchCompsWithLadder: an all-empty ladder never reports style_code breadth", async () => {
  const out = await searchCompsWithLadder(
    { categoryId: "11450", q: "nothing", brand: "Acme", styleCode: "XYZ1" },
    {
      minResults: 3,
      soldEnabled: false,
      fetchActive: () => Promise.resolve(result(0, "active")),
    },
  );
  // A blank panel labelled "same style code" would be a lie.
  assert(out.breadth !== "style_code");
  assertEquals(out.items.length, 0);
});

Deno.test("searchCompsWithLadder: sold comps are searched at the winning style-code rung", async () => {
  let soldArgs: Args | null = null;
  const out = await searchCompsWithLadder(
    {
      categoryId: "11450",
      q: "Lululemon ABC pant",
      brand: "Lululemon",
      styleCode: "LW7DVCS",
    },
    {
      minResults: 5,
      soldEnabled: true,
      fetchActive: (a: Args) =>
        Promise.resolve(result(a.styleCode ? 2 : 20, "active")),
      fetchSold: (a: Args) => {
        soldArgs = a;
        return Promise.resolve(result(1, "sold"));
      },
    },
  );
  assertEquals(out.breadth, "style_code");
  assertEquals((soldArgs as Args | null)?.styleCode, "LW7DVCS");
});

Deno.test("searchCompsWithLadder: defaults the threshold when none is passed", async () => {
  const out = await searchCompsWithLadder(
    { categoryId: "11450", q: "Nike", brand: "Nike" },
    {
      soldEnabled: false,
      fetchActive: () => Promise.resolve(result(1, "active")),
    },
  );
  assertEquals(out.minResults, DEFAULT_MIN_COMP_RESULTS);
});

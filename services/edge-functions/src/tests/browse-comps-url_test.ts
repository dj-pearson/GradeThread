// US-3098: the comp callers' request URL is unchanged, character for character.
//
// This is the test that had to exist before the sourcing filters could be added
// to `searchBrowseComps`, and the reason is not tidiness.
//
// `cachedSearchBrowseComps` keys a SHARED, Postgres-backed cache on the request
// it is about to make. Every condition-adjusted price in the product — the
// composer's comps panel, the Add flow's value hint, Prospect's going rate, the
// price guide — reads through that cache. A single extra parameter appearing in
// the URL that existing callers produce would invalidate all of it at once:
// every comp read in the system would miss, and each miss is a live eBay call
// against an app-wide rate limit.
//
// So the new arguments are all optional, all emit nothing when absent, and this
// test pins the exact string the old callers produce.
//
//   deno test --allow-env --allow-net src/tests/browse-comps-url_test.ts

import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);
Deno.env.set("EBAY_APP_ID", Deno.env.get("EBAY_APP_ID") ?? "test-app-id");
Deno.env.set("EBAY_CERT_ID", Deno.env.get("EBAY_CERT_ID") ?? "test-cert-id");
Deno.env.set("EBAY_ENV", "sandbox");

const { searchBrowseComps } = await import("../lib/ebay-client.ts");

const realFetch = globalThis.fetch;

/** Runs one search against a stubbed fetch and returns the URL it asked for. */
async function urlFor(args: Parameters<typeof searchBrowseComps>[0]): Promise<string> {
  let seen = "";
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    // The token call goes out first; only the search URL is of interest.
    if (url.includes("/item_summary/search")) {
      seen = url;
      return Promise.resolve(
        new Response(JSON.stringify({ itemSummaries: [], total: 0 }), { status: 200 }),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify({ access_token: "t", expires_in: 7200 }), { status: 200 }),
    );
  }) as typeof fetch;
  try {
    await searchBrowseComps(args);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert(seen !== "", "no Browse search URL was requested");
  return seen;
}

/** Just the query string, which is the part a cache key is built from. */
function query(url: string): string {
  return url.slice(url.indexOf("?") + 1);
}

// ── The frozen shape ───────────────────────────────────────────────────────
//
// Written out in full rather than compared against a rebuilt string. A test
// that constructs its expectation the same way the code does passes when both
// are wrong together, which is exactly the failure mode this guards.

Deno.test("a plain comps call produces the URL it always has", async () => {
  const url = await urlFor({ categoryId: "57988", q: "patagonia better sweater", limit: 25 });
  assertEquals(
    query(url),
    "category_ids=57988&q=patagonia+better+sweater&filter=conditionIds%3A%7B3000%7D%2CbuyingOptions%3A%7BFIXED_PRICE%7CAUCTION%7CBEST_OFFER%7D&limit=25",
  );
  assert(!url.includes("sort="), "Best Match is the ABSENCE of a sort parameter");
  assert(!url.includes("price"), "no price filter unless one was asked for");
  assert(!url.includes("maxDeliveryCost"));
});

Deno.test("brand and size still ride on the aspect filter, unchanged", async () => {
  const url = await urlFor({
    categoryId: "57988",
    q: "better sweater",
    brand: "Patagonia",
    size: "M",
    limit: 12,
  });
  assert(url.includes("aspect_filter=categoryId%3A57988%2CBrand%3A%7BPatagonia%7D%2CSize%3A%7BM%7D"));
  assert(!url.includes("sort="));
  assert(!url.includes("priceCurrency"));
});

Deno.test("an explicit conditionId still wins, and nothing else appears", async () => {
  const url = await urlFor({ categoryId: "57988", q: "tee", conditionId: "1000", limit: 12 });
  assert(url.includes("filter=conditionIds%3A%7B1000%7D%2CbuyingOptions"));
  assertEquals(query(url).split("&").length, 4, "category_ids, q, filter, limit — and no more");
});

// ── The new arguments, which only appear when asked for ────────────────────

Deno.test("a max price emits the range filter AND the currency eBay demands", async () => {
  // Without priceCurrency, eBay rejects the search with a 400 that names
  // neither field — it reads as a broken search rather than a missing param.
  const url = await urlFor({ categoryId: "57988", q: "tee", maxPriceCents: 4550, limit: 50 });
  assert(url.includes("price%3A%5B..45.50%5D"), url);
  assert(url.includes("priceCurrency%3AUSD"), url);
});

Deno.test("the price filter is appended after the two that were always there", async () => {
  // Order matters for exactly one reason: the existing callers' string must be
  // a prefix of the filtered one, so their cache key is untouched.
  const plain = await urlFor({ categoryId: "57988", q: "tee", limit: 50 });
  const filtered = await urlFor({ categoryId: "57988", q: "tee", maxPriceCents: 4550, limit: 50 });
  const plainFilter = decodeURIComponent(plain.split("filter=")[1].split("&")[0]);
  const richFilter = decodeURIComponent(filtered.split("filter=")[1].split("&")[0]);
  assert(richFilter.startsWith(plainFilter), `${richFilter} does not start with ${plainFilter}`);
});

Deno.test("buying options and multiple condition ids replace their defaults", async () => {
  const url = await urlFor({
    categoryId: "57988",
    q: "tee",
    buyingOptions: ["FIXED_PRICE", "BEST_OFFER"],
    conditionIds: ["3000", "4000"],
    limit: 50,
  });
  const filter = decodeURIComponent(url.split("filter=")[1].split("&")[0]);
  assertEquals(filter, "conditionIds:{3000|4000},buyingOptions:{FIXED_PRICE|BEST_OFFER}");
});

Deno.test("conditionIds beats a single conditionId when both are given", async () => {
  const url = await urlFor({
    categoryId: "57988",
    q: "tee",
    conditionId: "1000",
    conditionIds: ["3000"],
    limit: 50,
  });
  const filter = decodeURIComponent(url.split("filter=")[1].split("&")[0]);
  assert(filter.startsWith("conditionIds:{3000}"), filter);
});

Deno.test("free shipping only, and each sort maps to eBay's own spelling", async () => {
  const free = await urlFor({ categoryId: "57988", q: "tee", freeShippingOnly: true, limit: 50 });
  assert(decodeURIComponent(free).includes("maxDeliveryCost:0"));

  const cases: Array<[string, string | null]> = [
    ["bestMatch", null],
    ["newlyListed", "sort=newlyListed"],
    ["endingSoonest", "sort=endingSoonest"],
    // eBay spells ascending price as the bare field name.
    ["priceAsc", "sort=price"],
  ];
  for (const [sort, expected] of cases) {
    const url = await urlFor({
      categoryId: "57988",
      q: "tee",
      limit: 50,
      sort: sort as "bestMatch" | "newlyListed" | "endingSoonest" | "priceAsc",
    });
    if (expected == null) {
      assert(!url.includes("sort="), "bestMatch must emit no sort at all");
    } else {
      assert(url.includes(expected), `${sort} should map to ${expected}: ${url}`);
    }
  }
});

Deno.test("a zero or negative max price emits no filter rather than an absurd one", async () => {
  const url = await urlFor({ categoryId: "57988", q: "tee", maxPriceCents: 0, limit: 50 });
  assert(!url.includes("price%3A"), "a zero cap would return nothing at all");
});

// US-542: realized/sold comp math. sold-comps.ts -> ebay-client + supabase
// (both throw at init w/o env), so dummy-env then dynamic-import. These tests
// cover the PURE range/confidence math + the sold-vs-estimated invariant; the
// I/O paths (eBay Insights, private sales query) are best-effort and degrade to
// null, exercised by the orchestration logic.
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { realizedRangeFromPrices, soldConfidenceFromCount, MIN_SOLD_COMPS } =
  await import("../lib/sold-comps.ts");

Deno.test("realizedRangeFromPrices: sufficient comps → low ≤ median ≤ high in cents", () => {
  const r = realizedRangeFromPrices([20, 30, 40, 55, 90]);
  assert(r !== null);
  assertEquals(r!.count, 5);
  assertEquals(r!.medianCents, 40 * 100);
  assert(r!.lowCents! <= r!.medianCents!);
  assert(r!.medianCents! <= r!.highCents!);
  assertEquals(r!.source, "private_sales");
});

Deno.test("realizedRangeFromPrices: too few comps → null (never claims sold-backed)", () => {
  const r = realizedRangeFromPrices([20, 30]); // < MIN_SOLD_COMPS
  assertEquals(r, null);
});

Deno.test("realizedRangeFromPrices: drops non-positive / non-finite prices", () => {
  // Two valid prices after filtering 0/-5/NaN → below MIN_SOLD_COMPS → null.
  const r = realizedRangeFromPrices([0, -5, Number.NaN, 30, 40]);
  assertEquals(r, null);
  // Add enough valid prices and the junk is excluded from the stats.
  const r2 = realizedRangeFromPrices([0, -5, 30, 40, 50, 60]);
  assert(r2 !== null);
  assertEquals(r2!.count, 4);
});

Deno.test("realizedRangeFromPrices: source label is carried through", () => {
  const r = realizedRangeFromPrices([10, 20, 30, 40], "USD", "ebay_sold");
  assert(r !== null);
  assertEquals(r!.source, "ebay_sold");
});

Deno.test("soldConfidenceFromCount: 0 below the minimum, rising and capped", () => {
  assertEquals(soldConfidenceFromCount(MIN_SOLD_COMPS - 1), 0);
  const few = soldConfidenceFromCount(MIN_SOLD_COMPS);
  const many = soldConfidenceFromCount(20);
  assert(few > 0);
  assert(many > few);
  assert(many <= 0.95);
});

Deno.test("MIN_SOLD_COMPS is a sane floor", () => {
  assert(MIN_SOLD_COMPS >= 3);
});

// ── ebaySoldSearchUrl: the public sold-search link Scout hands the seller ────
// This URL is the ONLY realized-price surface we have until the Marketplace
// Insights grant lands, so a wrong param here is a seller reading the wrong
// item's prices in a thrift aisle.
const { ebaySoldSearchUrl } = await import("../lib/sold-comps.ts");

Deno.test("ebaySoldSearchUrl: sold + completed filters and recent-first sort", () => {
  const url = new URL(ebaySoldSearchUrl({ query: "patagonia synchilla" }));
  assertEquals(url.origin + url.pathname, "https://www.ebay.com/sch/i.html");
  assertEquals(url.searchParams.get("_nkw"), "patagonia synchilla");
  assertEquals(url.searchParams.get("LH_Sold"), "1");
  assertEquals(url.searchParams.get("LH_Complete"), "1");
  // Best Match would lead with a two-year-old sale; ended-recent is the point.
  assertEquals(url.searchParams.get("_sop"), "13");
});

Deno.test("ebaySoldSearchUrl: a resolved leaf category scopes the search", () => {
  const url = new URL(
    ebaySoldSearchUrl({ query: "patagonia synchilla", categoryId: "57988" }),
  );
  assertEquals(url.searchParams.get("_sacat"), "57988");
});

Deno.test("ebaySoldSearchUrl: no category → site-wide, never a blank _sacat", () => {
  for (const categoryId of [null, undefined, ""]) {
    const url = new URL(ebaySoldSearchUrl({ query: "levis 501", categoryId }));
    assertEquals(url.searchParams.has("_sacat"), false);
  }
});

Deno.test("ebaySoldSearchUrl: a non-numeric category is dropped, not passed on", () => {
  // eBay answers a malformed _sacat with zero results, which a seller reads as
  // "nothing like this ever sold" rather than as our bug.
  const url = new URL(
    ebaySoldSearchUrl({ query: "levis 501", categoryId: "Men's Jeans" }),
  );
  assertEquals(url.searchParams.has("_sacat"), false);
});

Deno.test("ebaySoldSearchUrl: query is escaped, not concatenated", () => {
  const url = new URL(
    ebaySoldSearchUrl({ query: "carhartt 34x30 & double-knee" }),
  );
  assertEquals(url.searchParams.get("_nkw"), "carhartt 34x30 & double-knee");
});

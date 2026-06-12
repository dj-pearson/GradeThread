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

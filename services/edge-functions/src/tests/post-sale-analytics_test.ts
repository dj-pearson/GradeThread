// US-2936: the return-rate arithmetic.
//
// Three properties, each of which would produce a plausible wrong number:
//
//   1. A sale counts ONCE however many cases it produced. A buyer who opens a
//      return, escalates it to a case and files a dispute has not returned
//      three garments — counting the cases puts the rate over 100%.
//   2. A slice under the minimum reports rate: null, not a percentage. One
//      return in two sales is not a 50% return rate, it is noise, and a seller
//      who reprices a brand on it has been misled by their own tool.
//   3. Items with no grade report are in NEITHER disclosure bucket. "We do not
//      know what was disclosed" is not "nothing was", and folding them into the
//      no-defect bucket would manufacture the very finding the slice exists to
//      test.
import { assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { MIN_SALES_FOR_RATE, gradeBand, isSnadReason, summarizeReturns } = await import(
  "../lib/post-sale-analytics.ts"
);
import type { AnalyticsCase, AnalyticsSale } from "../lib/post-sale-analytics.ts";

const sale = (
  id: string,
  over: Partial<AnalyticsSale> = {},
): AnalyticsSale => ({
  inventoryItemId: id,
  brand: "Carhartt",
  category: "Jackets",
  grade: 8.5,
  disclosedDefects: 1,
  ...over,
});

const kase = (itemId: string, over: Partial<AnalyticsCase> = {}): AnalyticsCase => ({
  caseType: "return",
  reason: "NOT_AS_DESCRIBED",
  inventoryItemId: itemId,
  openedAt: "2026-08-01T00:00:00.000Z",
  closedAt: "2026-08-05T00:00:00.000Z",
  ...over,
});

function salesOf(n: number, over: Partial<AnalyticsSale> = {}): AnalyticsSale[] {
  return Array.from({ length: n }, (_, i) => sale(`i${i}`, over));
}

Deno.test("one sale with three cases counts as ONE return", () => {
  const sales = salesOf(10);
  const cases = [
    kase("i0", { caseType: "return" }),
    kase("i0", { caseType: "case" }),
    kase("i0", { caseType: "payment_dispute" }),
  ];
  const out = summarizeReturns(sales, cases);
  assertEquals(out.overall.returns, 1);
  assertEquals(out.overall.sales, 10);
  assertEquals(out.overall.rate, 0.1);
});

Deno.test("a slice under the minimum reports no rate at all", () => {
  const small = salesOf(MIN_SALES_FOR_RATE - 1);
  const out = summarizeReturns(small, [kase("i0")]);
  assertEquals(out.overall.rate, null, "a rate on 7 sales is noise");
  assertEquals(out.overall.returns, 1, "the count is still reported");
  assertEquals(out.overall.snadShare, null);

  const enough = salesOf(MIN_SALES_FOR_RATE);
  assertEquals(summarizeReturns(enough, [kase("i0")]).overall.rate, 1 / MIN_SALES_FOR_RATE);
});

Deno.test("items with no grade report land in NEITHER disclosure bucket", () => {
  const sales = [
    ...salesOf(8, { disclosedDefects: 1 }),
    ...Array.from({ length: 8 }, (_, i) => sale(`u${i}`, { disclosedDefects: null })),
  ];
  const out = summarizeReturns(sales, []);
  assertEquals(out.byDisclosure.length, 1);
  assertEquals(out.byDisclosure[0]!.key, "Defect disclosed");
  assertEquals(out.byDisclosure[0]!.sales, 8, "the ungraded eight are not folded in");
});

Deno.test("the disclosure comparison is the one a seller actually wants", () => {
  const disclosed = Array.from({ length: 10 }, (_, i) =>
    sale(`d${i}`, { disclosedDefects: 2 }));
  const silent = Array.from({ length: 10 }, (_, i) =>
    sale(`s${i}`, { disclosedDefects: 0 }));
  const cases = [kase("s0"), kase("s1"), kase("s2"), kase("d0")];
  const out = summarizeReturns([...disclosed, ...silent], cases);
  const byKey = new Map(out.byDisclosure.map((s) => [s.key, s]));
  assertEquals(byKey.get("No defect disclosed")!.rate, 0.3);
  assertEquals(byKey.get("Defect disclosed")!.rate, 0.1);
  // Worst first, so the problem is the row a seller reads before scrolling.
  assertEquals(out.byDisclosure[0]!.key, "No defect disclosed");
});

Deno.test("a case whose item is outside the window is ignored, not counted", () => {
  // Otherwise a slow month produces a return rate above 100%.
  const out = summarizeReturns(salesOf(8), [kase("not-in-this-window")]);
  assertEquals(out.overall.returns, 0);
  assertEquals(out.overall.rate, 0);
});

Deno.test("snadShare is of RETURNS, not of sales", () => {
  const sales = salesOf(10);
  const cases = [
    kase("i0", { reason: "NOT_AS_DESCRIBED" }),
    kase("i1", { reason: "BUYER_CHANGED_MIND" }),
  ];
  const out = summarizeReturns(sales, cases);
  assertEquals(out.overall.returns, 2);
  assertEquals(out.overall.snad, 1);
  assertEquals(out.overall.snadShare, 0.5);
});

Deno.test("days-to-resolve ignores cases still open", () => {
  const out = summarizeReturns(salesOf(8), [
    kase("i0", { openedAt: "2026-08-01T00:00:00.000Z", closedAt: "2026-08-04T00:00:00.000Z" }),
    kase("i1", { openedAt: "2026-08-01T00:00:00.000Z", closedAt: null }),
  ]);
  assertEquals(out.overall.avgDaysToResolve, 3);
});

Deno.test("gradeBand groups by tier rather than by 0.1 step", () => {
  assertEquals(gradeBand(8.5), "8.0-8.9");
  assertEquals(gradeBand(8.0), "8.0-8.9");
  assertEquals(gradeBand(10), "10 (NWT)");
  assertEquals(gradeBand(null), null);
  assertEquals(gradeBand(Number.NaN), null);
});

Deno.test("isSnadReason matches the frontend's vocabulary", () => {
  assertEquals(isSnadReason("NOT_AS_DESCRIBED"), true);
  assertEquals(isSnadReason("DEFECTIVE_ITEM"), true);
  assertEquals(isSnadReason("BUYER_CHANGED_MIND"), false);
  assertEquals(isSnadReason(null), false);
});

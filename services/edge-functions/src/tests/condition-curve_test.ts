// US-611: price-vs-grade curve builder. Dummy-env then dynamic-import (pulls in
// ebay-client/supabase). Comp fetcher is injected so no eBay call is made.
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { buildValueCurve, normalizeItemKey, CURVE_GRADE_POINTS } = await import(
  "../lib/condition-curve.ts"
);

function statsFor(conditionId: string) {
  // Return richer comps for the "used" bucket; thin for new buckets.
  if (conditionId === "3000") {
    return { count: 14, currency: "USD", min: 20, p25: 30, median: 42, p75: 58, max: 95 };
  }
  return { count: 4, currency: "USD", min: 60, p25: 65, median: 70, p75: 80, max: 90 };
}

// Fake fetcher records which conditionIds were requested.
function fakeFetcher() {
  const calls: string[] = [];
  const fetcher = (args: { conditionId?: string }) => {
    const cid = args.conditionId ?? "3000";
    calls.push(cid);
    return Promise.resolve({ items: [], total: 0, stats: statsFor(cid) });
  };
  return { fetcher, calls };
}

Deno.test("normalizeItemKey is stable + case-insensitive", () => {
  const a = normalizeItemKey({ categoryId: "57988", brand: "Patagonia", q: "Better Sweater" });
  const b = normalizeItemKey({ categoryId: "57988", brand: "patagonia", q: "better sweater" });
  assertEquals(a, b);
  assertEquals(a, "patagonia|57988|better sweater");
});

Deno.test("buildValueCurve fetches ONE comp set per distinct conditionId", async () => {
  const { fetcher, calls } = fakeFetcher();
  await buildValueCurve({ categoryId: "57988", brand: "Patagonia" }, fetcher);
  // Distinct conditionIds across the grade points: 1000, 1500, 3000.
  const distinct = [...new Set(calls)];
  assertEquals(distinct.sort(), ["1000", "1500", "3000"]);
  // Not one call per grade point.
  assert(calls.length < CURVE_GRADE_POINTS.length);
});

Deno.test("curve has a point per grade and is monotonic-ish (higher grade ≥ lower in used band)", async () => {
  const { fetcher } = fakeFetcher();
  const curve = await buildValueCurve({ categoryId: "57988", brand: "Patagonia" }, fetcher);
  assertEquals(curve.points.length, CURVE_GRADE_POINTS.length);
  const g5 = curve.points.find((p) => p.grade === 5)!;
  const g8 = curve.points.find((p) => p.grade === 8)!;
  assert(g8.medianCents! >= g5.medianCents!);
  // Used-band points have real comps → sufficient.
  assertEquals(g5.sufficient, true);
});

Deno.test("a bucket fetch failure degrades that bucket's grades to insufficient, not a thrown curve", async () => {
  const fetcher = (args: { conditionId?: string }) => {
    if (args.conditionId === "3000") return Promise.reject(new Error("eBay 503"));
    return Promise.resolve({ items: [], total: 0, stats: statsFor(args.conditionId ?? "1500") });
  };
  const curve = await buildValueCurve({ categoryId: "57988" }, fetcher);
  const g6 = curve.points.find((p) => p.grade === 6)!; // used bucket → failed
  assertEquals(g6.sufficient, false);
  const g9 = curve.points.find((p) => p.grade === 9)!; // 1500 bucket → ok-ish
  assert(g9 !== undefined);
});

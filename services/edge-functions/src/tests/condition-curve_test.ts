// US-611: price-vs-grade curve builder. Dummy-env then dynamic-import (pulls in
// ebay-client/supabase). Comp fetcher is injected so no eBay call is made.
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { buildValueCurve, normalizeItemKey, CURVE_GRADE_POINTS, enforceGradeMonotonic } =
  await import("../lib/condition-curve.ts");

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

// US-1947 bucket-count sanity on GENERATED curve data: because comps are fetched
// once per condition bucket and shared by every grade in that bucket, per-grade
// `sampleSize` REPEATS and its naive sum overstates the real sample. The honest
// aggregate is `totalSampleSize` = the sum over DISTINCT buckets (each counted
// once) — it must never exceed the naive per-grade sum, and each bucket's own
// count must never exceed the total.
Deno.test("totalSampleSize sums DISTINCT buckets once (never the inflated per-grade sum)", async () => {
  const { fetcher } = fakeFetcher();
  const curve = await buildValueCurve({ categoryId: "57988", brand: "Patagonia" }, fetcher);
  const sufficient = curve.points.filter((p) => p.sufficient);
  const naivePerGradeSum = sufficient.reduce((s, p) => s + p.sampleSize, 0);
  // The shared-bucket reality: the naive per-grade sum inflates past the honest total.
  assert(
    naivePerGradeSum > curve.totalSampleSize,
    "per-grade sampleSize should repeat across a bucket, inflating the naive sum",
  );
  // Each grade's sampleSize is a single bucket's count — never more than the total.
  for (const p of sufficient) {
    assert(
      p.sampleSize <= curve.totalSampleSize,
      `grade ${p.grade} bucket count ${p.sampleSize} must be ≤ total ${curve.totalSampleSize}`,
    );
  }
  // The used bucket ("3000") has 14 comps and the two new buckets 4 each → 22 distinct.
  assertEquals(curve.totalSampleSize, 14 + 4 + 4);
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

// US-1947: a better grade must never be valued below a worse one, even when the
// higher-condition bucket has cheaper/thinner comps than a lower one (the
// "grade-9 priced above grade-10" bug the Condition Index QA found).
Deno.test("enforceGradeMonotonic lifts an inverted higher grade (value never decreases with grade)", () => {
  const points = [
    { grade: 10, lowCents: 15000, medianCents: 21800, highCents: 25800, sampleSize: 25, sufficient: true },
    // Inverted: grade 9 is priced ABOVE grade 10.
    { grade: 9, lowCents: 18700, medianCents: 23000, highCents: 30600, sampleSize: 25, sufficient: true },
    { grade: 8, lowCents: 10000, medianCents: 15000, highCents: 20000, sampleSize: 20, sufficient: true },
    // Insufficient point stays untouched (null).
    { grade: 3, lowCents: null, medianCents: null, highCents: null, sampleSize: 0, sufficient: false },
  ];
  enforceGradeMonotonic(points);
  const med = (grade: number): number =>
    points.find((p) => p.grade === grade)!.medianCents!;
  // Non-decreasing with grade: 10 ≥ 9 ≥ 8.
  assert(med(10) >= med(9), "grade 10 must be ≥ grade 9");
  assert(med(9) >= med(8), "grade 9 must be ≥ grade 8");
  // The inverted grade-10 was lifted up to the grade-9 floor.
  assertEquals(med(10), 23000);
  // Each point keeps low ≤ median ≤ high; the insufficient point stays null.
  for (const p of points) {
    if (p.medianCents === null) {
      assertEquals(p.lowCents, null);
      continue;
    }
    assert(p.lowCents! <= p.medianCents!, "low ≤ median");
    assert(p.medianCents! <= p.highCents!, "median ≤ high");
  }
});

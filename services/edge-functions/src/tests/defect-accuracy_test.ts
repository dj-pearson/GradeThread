import { assert, assertEquals } from "@std/assert";
import {
  extractGradeDefects,
  recommendWeightAdjustments,
  summarizeByDefectType,
  summarizeBySizeBucket,
  type DefectTypeAccuracy,
  type ReviewedGradeDefects,
} from "../lib/defect-accuracy.ts";

Deno.test("summarizeByDefectType: counts, MAE, signed delta, agreement", () => {
  const grades: ReviewedGradeDefects[] = [
    { signedDelta: 1.0, defectTypes: ["stain"], sizeBuckets: ["medium"] },
    { signedDelta: 2.0, defectTypes: ["stain"], sizeBuckets: ["large"] },
    { signedDelta: 0.0, defectTypes: ["pilling"], sizeBuckets: ["small"] },
  ];
  const out = summarizeByDefectType(grades);
  const stain = out.find((o) => o.defect_type === "stain")!;
  assertEquals(stain.count, 2);
  assertEquals(stain.mean_abs_error, 1.5);
  assertEquals(stain.mean_signed_delta, 1.5);
  assertEquals(stain.agreement_rate, 0); // both errors > 0.5
  const pilling = out.find((o) => o.defect_type === "pilling")!;
  assertEquals(pilling.agreement_rate, 1); // 0.0 error agrees
  // Worst (highest MAE) first.
  assertEquals(out[0].defect_type, "stain");
});

Deno.test("a defect type counts once per grade even if repeated", () => {
  const grades: ReviewedGradeDefects[] = [
    { signedDelta: 1.0, defectTypes: ["hole_puncture", "hole_puncture"], sizeBuckets: ["small", "small"] },
  ];
  const byType = summarizeByDefectType(grades);
  assertEquals(byType[0].count, 1);
  const bySize = summarizeBySizeBucket(grades);
  assertEquals(bySize[0].count, 1);
});

Deno.test("recommend: over-penalized type (AI lower than human) → decrease", () => {
  const byType: DefectTypeAccuracy[] = [
    { defect_type: "pilling", count: 12, mean_abs_error: 0.9, mean_signed_delta: 0.8, agreement_rate: 0.3 },
  ];
  const recs = recommendWeightAdjustments(byType);
  assertEquals(recs.length, 1);
  assertEquals(recs[0].direction, "decrease");
  assertEquals(recs[0].defect_type, "pilling");
});

Deno.test("recommend: under-penalized type (AI higher than human) → increase", () => {
  const byType: DefectTypeAccuracy[] = [
    { defect_type: "seam_failure_unthreading", count: 20, mean_abs_error: 1.1, mean_signed_delta: -0.9, agreement_rate: 0.2 },
  ];
  const recs = recommendWeightAdjustments(byType);
  assertEquals(recs[0].direction, "increase");
});

Deno.test("recommend: ignores low sample size and sub-threshold deltas", () => {
  const byType: DefectTypeAccuracy[] = [
    { defect_type: "stain", count: 3, mean_abs_error: 2.0, mean_signed_delta: 1.5, agreement_rate: 0 }, // too few
    { defect_type: "fading", count: 50, mean_abs_error: 0.2, mean_signed_delta: 0.1, agreement_rate: 0.95 }, // tiny delta
  ];
  assertEquals(recommendWeightAdjustments(byType).length, 0);
});

Deno.test("recommend: custom thresholds honored + strongest-signal-first ordering", () => {
  const byType: DefectTypeAccuracy[] = [
    { defect_type: "stain", count: 10, mean_abs_error: 0.6, mean_signed_delta: 0.5, agreement_rate: 0.4 },
    { defect_type: "rip_tear", count: 10, mean_abs_error: 1.4, mean_signed_delta: -1.3, agreement_rate: 0.1 },
  ];
  const recs = recommendWeightAdjustments(byType, { minSamples: 5, deltaThreshold: 0.3 });
  assertEquals(recs.length, 2);
  assertEquals(recs[0].defect_type, "rip_tear"); // |−1.3| > |0.5|
});

Deno.test("extractGradeDefects: tolerant of missing/garbage and pre-v3 rows", () => {
  const r = extractGradeDefects([
    { defect_type: "stain", size_bucket: "medium" },
    { defect: "worn area" }, // pre-v3: no type/size
    "garbage",
    null,
  ]);
  assert(r.defectTypes.includes("stain"));
  assert(r.defectTypes.includes("other")); // missing type → other
  assert(r.sizeBuckets.includes("medium"));
  assert(r.sizeBuckets.includes("unknown")); // missing size → unknown
});

Deno.test("extractGradeDefects: non-array → empty", () => {
  assertEquals(extractGradeDefects(null), { defectTypes: [], sizeBuckets: [] });
  assertEquals(extractGradeDefects("nope"), { defectTypes: [], sizeBuckets: [] });
});

import { assert, assertEquals } from "@std/assert";
import {
  applyDefectWeighting,
  bboxImpliedBucket,
  coerceAreaPct,
  coerceDefectType,
  coerceRepairability,
  coerceSizeBucket,
  defectPenalty,
  sizeBucketConflict,
  WRINKLE_FLOOR_FACTOR,
  type FactorScores,
  type WeightedDefect,
} from "../lib/defect-weighting.ts";

const PRISTINE: FactorScores = {
  fabric_condition: 10,
  structural_integrity: 10,
  cosmetic_appearance: 10,
  functional_elements: 10,
  odor_cleanliness: 10,
};

Deno.test("no defects → ceilings stay at 10, blended unchanged", () => {
  const r = applyDefectWeighting(PRISTINE, []);
  for (const v of Object.values(r.ceilingByFactor)) assertEquals(v, 10);
  assertEquals(r.blendedFactors, PRISTINE);
  assertEquals(r.divergence, 0);
});

Deno.test("size is monotonic: bigger hole → bigger penalty → lower fabric ceiling", () => {
  const base = { defect_type: "hole_puncture", severity: "moderate", location: "front chest" } as const;
  const pinhole = applyDefectWeighting(PRISTINE, [{ ...base, size_bucket: "pinhole" }]);
  const small = applyDefectWeighting(PRISTINE, [{ ...base, size_bucket: "small" }]);
  const medium = applyDefectWeighting(PRISTINE, [{ ...base, size_bucket: "medium" }]);
  const large = applyDefectWeighting(PRISTINE, [{ ...base, size_bucket: "large" }]);

  assert(pinhole.ceilingByFactor.fabric_condition > small.ceilingByFactor.fabric_condition);
  assert(small.ceilingByFactor.fabric_condition > medium.ceilingByFactor.fabric_condition);
  assert(medium.ceilingByFactor.fabric_condition > large.ceilingByFactor.fabric_condition);
  // A pinhole is a near-trivial deduction; a large hole is a serious one.
  assert(pinhole.ceilingByFactor.fabric_condition >= 9.0);
  assert(large.ceilingByFactor.fabric_condition < 5);
});

Deno.test("type matters: broken zipper hits functional hard, not fabric", () => {
  const r = applyDefectWeighting(PRISTINE, [
    { defect_type: "broken_zipper", severity: "major", size_bucket: "medium" },
  ]);
  assert(r.ceilingByFactor.functional_elements < 3); // severe functional hit
  assertEquals(r.ceilingByFactor.fabric_condition, 10); // fabric untouched
});

Deno.test("seam failure routes entirely to structural integrity", () => {
  const r = applyDefectWeighting(PRISTINE, [
    { defect_type: "seam_failure_unthreading", severity: "major", size_bucket: "large" },
  ]);
  assert(r.ceilingByFactor.structural_integrity <= 1);
  assertEquals(r.ceilingByFactor.functional_elements, 10);
  assertEquals(r.ceilingByFactor.fabric_condition, 10);
});

Deno.test("stain routes to cleanliness + cosmetic", () => {
  const r = applyDefectWeighting(PRISTINE, [
    { defect_type: "stain", severity: "moderate", size_bucket: "medium", location: "front" },
  ]);
  assert(r.ceilingByFactor.odor_cleanliness < 10);
  assert(r.ceilingByFactor.cosmetic_appearance < 10);
  assertEquals(r.ceilingByFactor.structural_integrity, 10);
});

Deno.test("location: high-visibility penalizes more than hidden", () => {
  const front = applyDefectWeighting(PRISTINE, [
    { defect_type: "stain", severity: "moderate", size_bucket: "medium", location: "front chest" },
  ]);
  const hidden = applyDefectWeighting(PRISTINE, [
    { defect_type: "stain", severity: "moderate", size_bucket: "medium", location: "inside lining" },
  ]);
  assert(
    front.ceilingByFactor.odor_cleanliness < hidden.ceilingByFactor.odor_cleanliness,
  );
});

Deno.test("area_pct can outweigh the size bucket", () => {
  const smallBucket = applyDefectWeighting(PRISTINE, [
    { defect_type: "fading", severity: "moderate", size_bucket: "small" },
  ]);
  const largeArea = applyDefectWeighting(PRISTINE, [
    { defect_type: "fading", severity: "moderate", size_bucket: "small", area_pct: 40 },
  ]);
  assert(
    largeArea.ceilingByFactor.cosmetic_appearance <
      smallBucket.ceilingByFactor.cosmetic_appearance,
  );
});

Deno.test("US-1030: wrinkles alone never drop below the configured floor", () => {
  const many: WeightedDefect[] = Array.from({ length: 6 }, () => ({
    defect_type: "wrinkle_crease" as const,
    severity: "major" as const,
    size_bucket: "extensive" as const,
    location: "front chest",
    area_pct: 60,
  }));
  const r = applyDefectWeighting(PRISTINE, many);
  // Cosmetic ceiling held at/above the wrinkle floor despite heavy wrinkling.
  assert(r.ceilingByFactor.cosmetic_appearance >= WRINKLE_FLOOR_FACTOR - 1e-9);
  // Other factors untouched by wrinkles.
  assertEquals(r.ceilingByFactor.fabric_condition, 10);
  assertEquals(r.ceilingByFactor.structural_integrity, 10);
});

Deno.test("intentional features are ignored", () => {
  const r = applyDefectWeighting(PRISTINE, [
    { defect_type: "rip_tear", severity: "major", size_bucket: "large", is_intentional: true },
  ]);
  assertEquals(r.ceilingByFactor.structural_integrity, 10);
  assertEquals(r.appliedDefects.length, 0);
});

Deno.test("blend = min(model, ceiling); model can grade lower", () => {
  // Model already harsh on fabric (4); a small hole only justifies a high
  // ceiling — blended stays at the model's harsher 4, with large divergence.
  const model: FactorScores = { ...PRISTINE, fabric_condition: 4 };
  const r = applyDefectWeighting(model, [
    { defect_type: "hole_puncture", severity: "minor", size_bucket: "small" },
  ]);
  assertEquals(r.blendedFactors.fabric_condition, 4);
  assert(r.divergence >= 3);
});

Deno.test("blend = min: ceiling pulls an over-generous model score down", () => {
  // Model graded fabric a generous 9 despite a large hole; the ceiling caps it.
  const model: FactorScores = { ...PRISTINE, fabric_condition: 9 };
  const r = applyDefectWeighting(model, [
    { defect_type: "hole_puncture", severity: "major", size_bucket: "large", location: "front" },
  ]);
  assert(r.blendedFactors.fabric_condition < 9);
  assertEquals(r.blendedFactors.fabric_condition, r.ceilingByFactor.fabric_condition);
});

Deno.test("multiple real defects stack", () => {
  const one = applyDefectWeighting(PRISTINE, [
    { defect_type: "pilling", severity: "moderate", size_bucket: "medium" },
  ]);
  const three = applyDefectWeighting(PRISTINE, [
    { defect_type: "pilling", severity: "moderate", size_bucket: "medium" },
    { defect_type: "abrasion_thinning", severity: "moderate", size_bucket: "medium" },
    { defect_type: "snag_pull", severity: "moderate", size_bucket: "medium" },
  ]);
  assert(three.ceilingByFactor.fabric_condition < one.ceilingByFactor.fabric_condition);
});

Deno.test("unknown size is conservative (treated like small, not large)", () => {
  const unknown = defectPenalty({
    defect_type: "hole_puncture", severity: "moderate", size_bucket: "unknown",
  });
  const small = defectPenalty({
    defect_type: "hole_puncture", severity: "moderate", size_bucket: "small",
  });
  const large = defectPenalty({
    defect_type: "hole_puncture", severity: "moderate", size_bucket: "large",
  });
  assertEquals(unknown, small);
  assert(unknown < large);
});

Deno.test("coercion helpers normalize model output safely", () => {
  assertEquals(coerceDefectType("STAIN"), "stain");
  assertEquals(coerceDefectType("frobnicated"), "other");
  assertEquals(coerceDefectType(null), "other");
  assertEquals(coerceSizeBucket("Large"), "large");
  assertEquals(coerceSizeBucket("huge"), "unknown");
  assertEquals(coerceRepairability("reversible"), "reversible");
  assertEquals(coerceRepairability(undefined), "permanent");
  assertEquals(coerceAreaPct(150), 100);
  assertEquals(coerceAreaPct(-5), 0);
  assertEquals(coerceAreaPct("nope"), null);
});

Deno.test("bbox cross-check: tiny box claimed large is a conflict", () => {
  assertEquals(bboxImpliedBucket([0.1, 0.1, 0.4, 0.4]), "extensive"); // 16% area
  assertEquals(bboxImpliedBucket([0.5, 0.5, 0.01, 0.01]), "pinhole");
  assertEquals(bboxImpliedBucket(null), null);
  assert(sizeBucketConflict("large", [0.5, 0.5, 0.01, 0.01])); // claims large, box pinhole
  assert(!sizeBucketConflict("medium", [0.1, 0.1, 0.1, 0.1])); // consistent
  assert(!sizeBucketConflict("unknown", [0.5, 0.5, 0.01, 0.01])); // unknown never conflicts
});

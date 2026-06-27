// US-1282: Garment Passport condition-over-time curve. Pure — no DB / no env.
import { assertEquals } from "@std/assert";
import {
  buildConditionCurve,
  CONDITION_FACTORS,
  type PublicGradePoint,
} from "../lib/passport-curve.ts";

function pt(over: Partial<PublicGradePoint>): PublicGradePoint {
  return {
    certificate_id: "cert",
    created_at: "2026-01-01T00:00:00Z",
    overall_score: 8,
    grade_tier: "Excellent",
    confidence_label: "high",
    fabric_condition_score: 8,
    structural_integrity_score: 8,
    cosmetic_appearance_score: 8,
    functional_elements_score: 8,
    odor_cleanliness_score: 8,
    ...over,
  };
}

Deno.test("buildConditionCurve: empty + single grade have no deltas", () => {
  assertEquals(buildConditionCurve([]), []);
  const [only] = buildConditionCurve([pt({})]);
  assertEquals(only.overall_delta, null, "first point has no prior → null delta");
  for (const f of CONDITION_FACTORS) {
    assertEquals(only.factor_deltas[f.key], null);
  }
});

Deno.test("AC5: two grades on the same garment → a 2-point curve with correct deltas", () => {
  const first = pt({
    certificate_id: "cert-1",
    created_at: "2026-01-01T00:00:00Z",
    overall_score: 8.0,
    grade_tier: "Excellent",
    fabric_condition_score: 8.5,
    structural_integrity_score: 8.0,
    cosmetic_appearance_score: 7.5,
    functional_elements_score: 9.0,
    odor_cleanliness_score: 8.0,
  });
  // A re-grade after wear: condition has dropped on most factors.
  const second = pt({
    certificate_id: "cert-2",
    created_at: "2026-06-01T00:00:00Z",
    overall_score: 6.5,
    grade_tier: "Very Good",
    fabric_condition_score: 7.0, // -1.5
    structural_integrity_score: 8.0, // 0
    cosmetic_appearance_score: 6.0, // -1.5
    functional_elements_score: 9.0, // 0
    odor_cleanliness_score: 5.5, // -2.5
  });

  const curve = buildConditionCurve([second, first]); // unsorted on input
  assertEquals(curve.length, 2);

  // Sorted oldest→newest regardless of input order.
  assertEquals(curve[0].certificate, "cert-1");
  assertEquals(curve[1].certificate, "cert-2");

  // First point: no deltas.
  assertEquals(curve[0].overall_delta, null);

  // Second point: overall + every factor delta = (this − prior).
  assertEquals(curve[1].overall_delta, -1.5);
  assertEquals(curve[1].factor_deltas.fabric_condition_score, -1.5);
  assertEquals(curve[1].factor_deltas.structural_integrity_score, 0);
  assertEquals(curve[1].factor_deltas.cosmetic_appearance_score, -1.5);
  assertEquals(curve[1].factor_deltas.functional_elements_score, 0);
  assertEquals(curve[1].factor_deltas.odor_cleanliness_score, -2.5);

  // The scores themselves are carried verbatim.
  assertEquals(curve[1].factors.fabric_condition_score, 7.0);
  assertEquals(curve[1].overall, 6.5);
});

Deno.test("buildConditionCurve: a missing score on either side yields a null delta", () => {
  const a = pt({ created_at: "2026-01-01T00:00:00Z", fabric_condition_score: 8 });
  const b = pt({ created_at: "2026-02-01T00:00:00Z", fabric_condition_score: null });
  const curve = buildConditionCurve([a, b]);
  assertEquals(curve[1].factors.fabric_condition_score, null);
  assertEquals(curve[1].factor_deltas.fabric_condition_score, null);
});

Deno.test("buildConditionCurve: improvement (re-clean/repair) shows positive deltas", () => {
  const a = pt({ created_at: "2026-01-01T00:00:00Z", odor_cleanliness_score: 5.0, overall_score: 6.0 });
  const b = pt({ created_at: "2026-03-01T00:00:00Z", odor_cleanliness_score: 8.0, overall_score: 7.0 });
  const curve = buildConditionCurve([a, b]);
  assertEquals(curve[1].factor_deltas.odor_cleanliness_score, 3.0);
  assertEquals(curve[1].overall_delta, 1.0);
});

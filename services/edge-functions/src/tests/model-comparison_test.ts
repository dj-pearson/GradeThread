import { assert, assertEquals } from "@std/assert";
import {
  compareModelEvals,
  detectionMetrics,
  type ModelEvalRun,
} from "../lib/model-comparison.ts";

function run(model: string, mae: number, agree: number, perTag = {}): ModelEvalRun {
  return {
    model,
    mean_absolute_error: mae,
    agreement_rate: agree,
    cases_total: 20,
    cases_passed: 18,
    per_tag: perTag,
    cost_per_grade_usd: null,
  };
}

Deno.test("promote B when it meaningfully cuts MAE without regressing", () => {
  const cmp = compareModelEvals(run("sonnet", 0.8, 0.7), run("opus", 0.5, 0.8));
  assert(cmp.recommend_promote_b);
  assertEquals(cmp.mae_delta, -0.3);
  assertEquals(cmp.agreement_delta, 0.1);
  assert(cmp.rationale.startsWith("PROMOTE"));
});

Deno.test("hold B when MAE gain is below the threshold", () => {
  const cmp = compareModelEvals(run("sonnet", 0.80, 0.7), run("opus", 0.75, 0.7));
  assert(!cmp.recommend_promote_b); // only 0.05 gain < 0.1
  assert(cmp.rationale.startsWith("HOLD"));
});

Deno.test("hold B when overall agreement drops", () => {
  const cmp = compareModelEvals(run("sonnet", 0.8, 0.8), run("opus", 0.4, 0.7));
  assert(!cmp.recommend_promote_b); // big MAE gain but agreement fell
});

Deno.test("hold B when it regresses a well-sampled tag", () => {
  const a = run("sonnet", 0.8, 0.7, {
    distressed_denim: { mean_absolute_error: 0.6, agreement_rate: 0.8, count: 10 },
  });
  const b = run("opus", 0.4, 0.8, {
    distressed_denim: { mean_absolute_error: 1.0, agreement_rate: 0.5, count: 10 },
  });
  const cmp = compareModelEvals(a, b);
  assert(cmp.regressed_tags.includes("distressed_denim"));
  assert(!cmp.recommend_promote_b);
});

Deno.test("a tag regression below min sample count does not block promotion", () => {
  const a = run("sonnet", 0.8, 0.7, {
    rare: { mean_absolute_error: 0.5, agreement_rate: 0.8, count: 2 },
  });
  const b = run("opus", 0.5, 0.8, {
    rare: { mean_absolute_error: 1.2, agreement_rate: 0.4, count: 2 },
  });
  const cmp = compareModelEvals(a, b);
  assertEquals(cmp.regressed_tags.length, 0); // count < min
  assert(cmp.recommend_promote_b);
});

Deno.test("cost delta computed when both costs known", () => {
  const a = { ...run("sonnet", 0.8, 0.7), cost_per_grade_usd: 0.01 };
  const b = { ...run("opus", 0.5, 0.8), cost_per_grade_usd: 0.04 };
  const cmp = compareModelEvals(a, b);
  assertEquals(cmp.cost_delta_usd_per_grade, 0.03);
});

Deno.test("detectionMetrics: precision/recall/F1 per defect type", () => {
  const m = detectionMetrics([
    { expected: ["stain", "hole_puncture"], predicted: ["stain"] }, // stain TP, hole FN
    { expected: ["stain"], predicted: ["stain", "pilling"] }, // stain TP, pilling FP
  ]);
  const stain = m.find((x) => x.defect_type === "stain")!;
  assertEquals(stain.true_positive, 2);
  assertEquals(stain.recall, 1);
  assertEquals(stain.precision, 1);
  const hole = m.find((x) => x.defect_type === "hole_puncture")!;
  assertEquals(hole.false_negative, 1);
  assertEquals(hole.recall, 0);
  const pilling = m.find((x) => x.defect_type === "pilling")!;
  assertEquals(pilling.false_positive, 1);
  assertEquals(pilling.precision, 0);
  // Worst recall first.
  assertEquals(m[0].recall, 0);
});

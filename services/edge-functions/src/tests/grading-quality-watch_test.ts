// US-3525: the monitor watches grade drift, per-category bias, the review
// backlog and the failure rate, and every grade sends one outcome event.
import { assert, assertEquals } from "@std/assert";

Deno.env.set(
  "SUPABASE_URL",
  Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321",
);
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { evaluateAlerts, monitorThresholds } = await import(
  "../lib/grading-monitor.ts"
);
const { emitGradingOutcome, gradingOutcomeEvent } = await import(
  "../lib/grading-outcome-event.ts"
);

const T = {
  min_sample: 10,
  min_agreement: 0.7,
  max_intentional_misread: 0.1,
  max_dispute_rate: 0.05,
  eval_mae_regression_delta: 0.3,
  eval_agreement_regression_delta: 0.1,
  max_mean_shift: 0.3,
  max_category_bias: 0.5,
  max_queue_depth: 50,
  max_queue_age_hours: 48,
  max_failure_rate: 0.05,
};
const HEALTHY = {
  human_reviews: 50,
  agreement_rate: 0.92,
  mean_absolute_error: 0.3,
  intentional_misread_rate: 0.02,
  graded_sales: 40,
  dispute_rate: 0.01,
};
const codes = (extra: Record<string, unknown>) =>
  evaluateAlerts({
    eval_passed: true,
    eval_regression: false,
    production: HEALTHY,
    ...extra,
  }, T)
    .map((a) => a.code);

Deno.test("US-3525: defaults exist for every new threshold", () => {
  const t = monitorThresholds();
  assertEquals(t.max_mean_shift, 0.3);
  assertEquals(t.max_category_bias, 0.5);
  assertEquals(t.max_queue_depth, 50);
  assertEquals(t.max_queue_age_hours, 48);
  assertEquals(t.max_failure_rate, 0.05);
});

Deno.test("US-3525: grade creep of 0.4 over a real sample raises grade_mean_shift", () => {
  assertEquals(
    codes({
      grade_drift: {
        recent_mean: 8.1,
        recent_n: 40,
        prior_mean: 7.7,
        prior_n: 200,
      },
    }),
    ["grade_mean_shift"],
  );
});

Deno.test("US-3525: a small move, or a thin week, raises nothing", () => {
  assertEquals(
    codes({
      grade_drift: {
        recent_mean: 7.9,
        recent_n: 40,
        prior_mean: 7.7,
        prior_n: 200,
      },
    }),
    [],
  );
  assertEquals(
    codes({
      grade_drift: {
        recent_mean: 9.5,
        recent_n: 3,
        prior_mean: 7.7,
        prior_n: 200,
      },
    }),
    [],
  );
});

Deno.test("US-3525: category bias fires per category with a sample, either direction", () => {
  const alerts = evaluateAlerts({
    eval_passed: true,
    eval_regression: false,
    production: HEALTHY,
    category_bias: [
      { category: "outerwear", mean_signed_error: -0.7, count: 25 },
      { category: "denim", mean_signed_error: 0.6, count: 12 },
      { category: "tees", mean_signed_error: 1.5, count: 4 },
      { category: "dresses", mean_signed_error: 0.2, count: 80 },
    ],
  }, T);
  assertEquals(alerts.map((a) => a.metric), [
    "mean_signed_error:outerwear",
    "mean_signed_error:denim",
  ]);
  assert(alerts[0]!.message.includes("generous"));
  assert(alerts[1]!.message.includes("harsh"));
});

Deno.test("US-3525: an overdue or old review is critical; a deep queue is a warning", () => {
  assertEquals(
    codes({ review_queue: { depth: 3, oldest_age_hours: 5, overdue: 1 } }),
    ["review_queue_stale"],
  );
  assertEquals(
    codes({ review_queue: { depth: 3, oldest_age_hours: 60, overdue: 0 } }),
    ["review_queue_stale"],
  );
  assertEquals(
    codes({ review_queue: { depth: 80, oldest_age_hours: 2, overdue: 0 } }),
    ["review_queue_deep"],
  );
  assertEquals(
    codes({ review_queue: { depth: 0, oldest_age_hours: null, overdue: 0 } }),
    [],
  );
});

Deno.test("US-3525: failure rate above 5% over a real sample is critical", () => {
  assertEquals(codes({ grading_outcomes: { failed: 8, total: 100 } }), [
    "high_failure_rate",
  ]);
  assertEquals(codes({ grading_outcomes: { failed: 4, total: 100 } }), []);
  assertEquals(codes({ grading_outcomes: { failed: 3, total: 5 } }), []);
});

Deno.test("US-3525: the outcome event carries duration, cost, review flag and prompt version", async () => {
  const sent: Array<{ event: string; props: Record<string, unknown> }> = [];
  await emitGradingOutcome(
    {
      outcome: "completed",
      submissionId: "s1",
      durationMs: 41234.6,
      promptVersion: "composite_v4+imgtext",
      needsHumanReview: true,
      autoApproved: false,
    },
    {
      sumCostUsd: () => Promise.resolve(0.1634),
      capture: (event, props) => {
        sent.push({ event, props });
        return Promise.resolve();
      },
    },
  );
  assertEquals(sent.length, 1);
  assertEquals(sent[0]!.event, "grading.completed");
  assertEquals(sent[0]!.props.duration_ms, 41235);
  assertEquals(sent[0]!.props.cost_usd, 0.1634);
  assertEquals(sent[0]!.props.prompt_version, "composite_v4+imgtext");
  assertEquals(sent[0]!.props.needs_human_review, true);
});

Deno.test("US-3525: a failed grade names the error, truncated, and a cost read failure is null", async () => {
  const e = gradingOutcomeEvent(
    {
      outcome: "failed",
      submissionId: "s1",
      durationMs: 5,
      error: "x".repeat(900),
    },
    null,
  );
  assertEquals(e.event, "grading.failed");
  assertEquals((e.props.error as string).length, 300);
  assertEquals(e.props.cost_usd, null);
  let threw = false;
  await emitGradingOutcome(
    { outcome: "failed", submissionId: "s1", durationMs: 5 },
    {
      sumCostUsd: () => Promise.reject(new Error("db")),
      capture: () => Promise.reject(new Error("net")),
    },
  ).catch(() => threw = true);
  assertEquals(threw, false);
});

Deno.test("US-3525: the pipeline emits the event on success and on a real failure", async () => {
  const src = await Deno.readTextFile(
    new URL("../lib/grading-pipeline.ts", import.meta.url),
  );
  assert(src.includes('outcome: "completed",'));
  const failAt = src.indexOf('outcome: "failed",');
  const restore = src.indexOf(
    "// US-3515: this read decides whether we refund",
  );
  assert(
    failAt > restore && restore > 0,
    "failure event only after the restore check",
  );
});

Deno.test("US-3521: a stage serving an unevaluated prompt raises a critical alert per stage", () => {
  const alerts = evaluateAlerts({
    eval_passed: null,
    eval_regression: false,
    production: HEALTHY,
    unevaluated_serving: [
      {
        stage: "per_image",
        version: "per_image_v5",
        reason:
          "the code default has no ai_prompt_versions row, so it has never been evaluated.",
      },
      {
        stage: "composite",
        version: "composite_v4",
        reason: "Prompt version has not passed the eval gate.",
      },
    ],
  }, T);
  assertEquals(alerts.map((a) => [a.code, a.severity, a.metric]), [
    ["serving_unevaluated_prompt", "critical", "serving_prompt:per_image"],
    ["serving_unevaluated_prompt", "critical", "serving_prompt:composite"],
  ]);
  assert(alerts[0]!.message.includes("per_image_v5"));
});

Deno.test("US-3521: the monitor checks what serves with the activation gate's own rule", async () => {
  const src = await Deno.readTextFile(
    new URL("../lib/grading-monitor.ts", import.meta.url),
  );
  const fn = src.slice(
    src.indexOf("export async function findUnevaluatedServingPrompts"),
  );
  assert(
    fn.includes("PER_IMAGE_PROMPT_VERSION") &&
      fn.includes("COMPOSITE_PROMPT_VERSION"),
  );
  assert(
    fn.includes(
      "checkPromptServingEligibility(row, servingModelForStage(stage))",
    ),
  );
  assert(src.includes("unevaluated_serving: unevaluatedServing,"));
});

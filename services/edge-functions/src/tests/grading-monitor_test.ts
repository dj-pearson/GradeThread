// Unit tests for the grading regression-monitor alert logic (US-327).
//
// evaluateAlerts/worstSeverity are pure — no DB/AI — so we assert the threshold
// and sample-size guards directly. grading-monitor.ts imports the service-role
// supabase client at module load, so set dummy env BEFORE the dynamic import.
//
//   deno test --allow-env src/tests/grading-monitor_test.ts

import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { evaluateAlerts, worstSeverity, dispatchAlert } = await import("../lib/grading-monitor.ts");

const THRESHOLDS = {
  min_sample: 10,
  min_agreement: 0.7,
  max_intentional_misread: 0.1,
  max_dispute_rate: 0.05,
  eval_mae_regression_delta: 0.3,
  eval_agreement_regression_delta: 0.1,
};

const HEALTHY = {
  human_reviews: 50,
  agreement_rate: 0.92,
  mean_absolute_error: 0.3,
  intentional_misread_rate: 0.02,
  graded_sales: 40,
  dispute_rate: 0.01,
};

Deno.test("healthy metrics raise no alerts", () => {
  const alerts = evaluateAlerts(
    { eval_passed: true, eval_regression: false, production: HEALTHY },
    THRESHOLDS,
  );
  assertEquals(alerts, []);
  assertEquals(worstSeverity(alerts), "ok");
});

// US-482: a grading-model change in the recent window raises a warn alert.
Deno.test("model_changed raises a warn alert", () => {
  const alerts = evaluateAlerts(
    { eval_passed: true, eval_regression: false, production: HEALTHY, model_changed: true },
    THRESHOLDS,
  );
  assertEquals(alerts.map((a) => a.code), ["model_changed"]);
  assertEquals(worstSeverity(alerts), "warn");
});

Deno.test("no model_changed alert when the model is stable", () => {
  const alerts = evaluateAlerts(
    { eval_passed: true, eval_regression: false, production: HEALTHY, model_changed: false },
    THRESHOLDS,
  );
  assertEquals(alerts, []);
});

Deno.test("low agreement above min_sample is a critical alert", () => {
  const alerts = evaluateAlerts(
    {
      eval_passed: true,
      eval_regression: false,
      production: { ...HEALTHY, agreement_rate: 0.55 },
    },
    THRESHOLDS,
  );
  const low = alerts.find((a) => a.code === "low_agreement");
  assert(low, "expected low_agreement alert");
  assertEquals(low?.severity, "critical");
  assertEquals(worstSeverity(alerts), "critical");
});

Deno.test("low agreement BELOW min_sample is suppressed (too noisy)", () => {
  const alerts = evaluateAlerts(
    {
      eval_passed: true,
      eval_regression: false,
      production: { ...HEALTHY, human_reviews: 4, agreement_rate: 0.2 },
    },
    THRESHOLDS,
  );
  assertEquals(alerts.find((a) => a.code === "low_agreement"), undefined);
});

Deno.test("failed eval gate is critical; null (not run) is not", () => {
  const failed = evaluateAlerts(
    { eval_passed: false, eval_regression: false, production: HEALTHY },
    THRESHOLDS,
  );
  assert(failed.find((a) => a.code === "eval_gate_failed"));
  assertEquals(worstSeverity(failed), "critical");

  const notRun = evaluateAlerts(
    { eval_passed: null, eval_regression: false, production: HEALTHY },
    THRESHOLDS,
  );
  assertEquals(notRun.find((a) => a.code === "eval_gate_failed"), undefined);
});

Deno.test("high intentional-misread and dispute rates warn", () => {
  const alerts = evaluateAlerts(
    {
      eval_passed: true,
      eval_regression: true,
      production: { ...HEALTHY, intentional_misread_rate: 0.25, dispute_rate: 0.12 },
    },
    THRESHOLDS,
  );
  assert(alerts.find((a) => a.code === "high_intentional_misread"));
  assert(alerts.find((a) => a.code === "high_dispute_rate"));
  assert(alerts.find((a) => a.code === "eval_regression"));
  // No critical here → overall warn.
  assertEquals(worstSeverity(alerts), "warn");
});

// US-502: an alert that reaches NO channel must report NOT-delivered so the
// 12h cooldown does not engage (the old code returned true unconditionally).
// With no MONITOR_ALERT_EMAIL / SMTP_ADMIN_EMAIL / MONITOR_ALERT_WEBHOOK set,
// dispatchAlert must return false.
Deno.test("dispatchAlert returns false when no channel is configured", async () => {
  for (const k of ["MONITOR_ALERT_EMAIL", "SMTP_ADMIN_EMAIL", "MONITOR_ALERT_WEBHOOK"]) {
    Deno.env.delete(k);
  }
  const delivered = await dispatchAlert(
    "critical",
    [{ code: "low_agreement", severity: "critical", metric: "agreement_rate", value: 0.5, threshold: 0.7, message: "x" }],
    HEALTHY,
    { ran: false, regression_vs_baseline: false },
  );
  assertEquals(delivered, false);
});

// ─── US-2036: the live model must be the model the gate qualified ────
//
// The eval gate stamped a naked eval_passed boolean with no model attribution,
// so pointing DEFAULT_AI_MODEL at a different allowlisted model via an env
// change inherited a pass it never earned. activatePromptVersion blocks that at
// activation time; these cover the runtime half, where the model changes UNDER
// an already-active version and nothing else downstream would notice.

Deno.test("matching qualified model raises no model_not_qualified alert", () => {
  const alerts = evaluateAlerts(
    {
      eval_passed: true,
      eval_regression: false,
      production: HEALTHY,
      model_qualification: { live: "claude-sonnet-5", qualified: "claude-sonnet-5" },
    },
    THRESHOLDS,
  );
  assertEquals(alerts.filter((a) => a.code === "model_not_qualified").length, 0);
});

Deno.test("live model differing from the qualified model is CRITICAL", () => {
  const alerts = evaluateAlerts(
    {
      eval_passed: true,
      eval_regression: false,
      production: HEALTHY,
      model_qualification: { live: "claude-opus-4", qualified: "claude-sonnet-5" },
    },
    THRESHOLDS,
  );
  const a = alerts.find((x) => x.code === "model_not_qualified");
  assert(a, "expected a model_not_qualified alert");
  assertEquals(a.severity, "critical");
  // Both model names must appear — an operator reading the page needs to know
  // what to revert TO, not just that something is wrong.
  assert(a.message.includes("claude-opus-4"));
  assert(a.message.includes("claude-sonnet-5"));
  assertEquals(worstSeverity(alerts), "critical");
});

Deno.test("a missing qualification stamp is CRITICAL, not silently OK", () => {
  const alerts = evaluateAlerts(
    {
      eval_passed: true,
      eval_regression: false,
      production: HEALTHY,
      model_qualification: { live: "claude-sonnet-5", qualified: null },
    },
    THRESHOLDS,
  );
  const a = alerts.find((x) => x.code === "model_not_qualified");
  assert(a, "an unattributable pass must alert — fail closed, not open");
  assertEquals(a.severity, "critical");
});

Deno.test("no active version to compare against raises nothing", () => {
  const alerts = evaluateAlerts(
    { eval_passed: true, eval_regression: false, production: HEALTHY, model_qualification: null },
    THRESHOLDS,
  );
  assertEquals(alerts.filter((a) => a.code === "model_not_qualified").length, 0);
});

// ─── US-2037: a shrinking golden set is the red flag ─────────────────
//
// The grading-engine skill says "never delete cases to make an eval pass" and
// nothing enforced it. This is the mechanism behind that sentence: deleting the
// cases a stubborn prompt version fails is how it gets nudged past the gate.

Deno.test("a growing or steady golden set raises no alert", () => {
  for (const [active, baseline] of [[12, 12], [15, 12]]) {
    const alerts = evaluateAlerts(
      {
        eval_passed: true,
        eval_regression: false,
        production: HEALTHY,
        golden_set: { active, baseline },
      },
      THRESHOLDS,
    );
    assertEquals(
      alerts.filter((a) => a.code === "golden_set_shrank").length,
      0,
      `active=${active} baseline=${baseline} should not alert`,
    );
  }
});

Deno.test("a shrinking golden set is CRITICAL and names both sizes", () => {
  const alerts = evaluateAlerts(
    {
      eval_passed: true,
      eval_regression: false,
      production: HEALTHY,
      golden_set: { active: 9, baseline: 12 },
    },
    THRESHOLDS,
  );
  const a = alerts.find((x) => x.code === "golden_set_shrank");
  assert(a, "expected a golden_set_shrank alert");
  assertEquals(a.severity, "critical");
  assertEquals(a.value, 9);
  assertEquals(a.threshold, 12);
  assertEquals(worstSeverity(alerts), "critical");
});

Deno.test("no prior run means no shrink baseline, so no alert", () => {
  const alerts = evaluateAlerts(
    {
      eval_passed: true,
      eval_regression: false,
      production: HEALTHY,
      golden_set: { active: 0, baseline: null },
    },
    THRESHOLDS,
  );
  assertEquals(alerts.filter((a) => a.code === "golden_set_shrank").length, 0);
});

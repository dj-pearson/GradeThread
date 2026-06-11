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

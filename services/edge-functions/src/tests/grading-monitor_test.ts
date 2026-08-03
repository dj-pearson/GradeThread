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

// ── US-2301: an EMPTY golden set is the gate being off, not "nothing to do" ──
//
// runScheduledEval skipped cleanly on zero active cases, reasoning that a fresh
// deployment legitimately has none. That is true, and it is exactly why the
// state was invisible: with no cases, the eval never runs, `eval_passed` is
// null rather than false, and NO other rule in evaluateAlerts fires. So the
// configuration where no prompt has ever been evaluated — and none can be —
// produced complete silence from the only component whose job is to notice.
//
// The repo confirms that is not hypothetical: there are zero INSERTs into
// grading_eval_cases anywhere in the migrations, so a fresh database starts in
// exactly this state.
//
// Alert rather than throw: throwing would break the monitor cron on a fresh
// deploy, which trades a silent gap for a noisy one and teaches operators to
// ignore the job.

Deno.test("US-2301: an empty golden set raises a CRITICAL alert", () => {
  const alerts = evaluateAlerts(
    {
      eval_passed: null, // the eval could not run — this is the whole problem
      eval_regression: false,
      production: HEALTHY,
      golden_set: { active: 0, baseline: null },
    },
    THRESHOLDS,
  );
  const empty = alerts.find((a) => a.code === "golden_set_empty");
  assert(empty, "an empty golden set must not pass silently");
  assertEquals(empty?.severity, "critical");
  assertEquals(worstSeverity(alerts), "critical");
});

Deno.test("US-2301: the message says what to do, and what NOT to do", () => {
  // The golden set grows from REAL human-corrected grades. An operator reading
  // "the set is empty" under time pressure will reach for fabricated cases,
  // which would make every future eval meaningless while reading green.
  const alerts = evaluateAlerts(
    { eval_passed: null, eval_regression: false, production: HEALTHY, golden_set: { active: 0, baseline: null } },
    THRESHOLDS,
  );
  const empty = alerts.find((a) => a.code === "golden_set_empty");
  assert(empty?.message.includes("never synthetic"));
});

Deno.test("US-2301: a non-empty golden set raises nothing on its own", () => {
  const alerts = evaluateAlerts(
    {
      eval_passed: true,
      eval_regression: false,
      production: HEALTHY,
      golden_set: { active: 12, baseline: 12 },
    },
    THRESHOLDS,
  );
  assertEquals(alerts, []);
});

Deno.test("US-2301: empty and shrank are distinct alerts, not one collapsed rule", () => {
  // A set that went 40 → 0 is BOTH: the gate is off AND cases were removed.
  // Collapsing them would lose the second signal, which is the deliberate-abuse
  // one (US-2037: never delete cases to make an eval pass).
  const alerts = evaluateAlerts(
    {
      eval_passed: null,
      eval_regression: false,
      production: HEALTHY,
      golden_set: { active: 0, baseline: 40 },
    },
    THRESHOLDS,
  );
  const codes = alerts.map((a) => a.code).sort();
  assert(codes.includes("golden_set_empty"));
  assert(codes.includes("golden_set_shrank"));
});

// ── US-2301: a prompt version the code can use must be seedable ─────────────
//
// The code defaults are per_image_v5 / composite_v4. The only grading seed
// migration inserts per_image_v2 / composite_v2 and sets is_active false. So
// the versions actually serving traffic have NO ai_prompt_versions row — which
// means no eval result, no qualified_model, and nothing for the accuracy join
// to attribute grades to.
//
// That gap cannot be closed from here: seeding rows is a migration, and this
// host cannot push one. So it is PINNED instead — the current mismatch is
// declared, and any FURTHER version bump fails until its author either seeds a
// row or adds it to the declaration. That turns "nobody noticed for four
// versions" into "you cannot bump a version without deciding".

const KNOWN_UNSEEDED_PROMPT_VERSIONS = ["composite_v4", "per_image_v5"] as const;

Deno.test("US-2301: every code-default prompt version is seeded, or declared unseeded", async () => {
  const src = await Deno.readTextFile(
    new URL("../lib/ai-grading.ts", import.meta.url),
  );
  const codeVersions = [
    /PER_IMAGE_PROMPT_VERSION = "([^"]+)"/.exec(src)?.[1],
    /COMPOSITE_PROMPT_VERSION = "([^"]+)"/.exec(src)?.[1],
  ].filter((v): v is string => !!v).sort();
  assertEquals(codeVersions.length, 2, "both prompt-version constants must exist");

  // Which versions any migration actually seeds.
  const migrations = new URL("../../../../supabase/migrations/", import.meta.url);
  let seeded = "";
  for await (const entry of Deno.readDir(migrations)) {
    if (!entry.isFile || !entry.name.endsWith(".sql")) continue;
    const text = await Deno.readTextFile(new URL(entry.name, migrations));
    if (text.includes("ai_prompt_versions")) seeded += text;
  }

  const unseeded = codeVersions.filter((v) => !seeded.includes(`'${v}'`)).sort();
  assertEquals(
    unseeded,
    [...KNOWN_UNSEEDED_PROMPT_VERSIONS].sort(),
    "A prompt version the code can serve has no ai_prompt_versions row, so it " +
      "has no eval result and no qualified_model. Seed it in a migration — or, " +
      "if you just seeded one, remove it from KNOWN_UNSEEDED_PROMPT_VERSIONS.",
  );
});

// US-2302 AC3: the monitor must target the SAME version string the pipeline
// stamps on live grades.
//
// It did not. The fallback lookup hardcoded "composite_v2" while ai-grading.ts
// attributes COMPOSITE_PROMPT_VERSION ("composite_v4"), and the fallback is the
// NORMAL path — it runs whenever no composite override is active. So the
// scheduled monitor evaluated a stale row and stamped eval_passed and
// qualified_model onto it, while every live grade pointed somewhere else.
// Orphaned in both directions: the version being graded had no row, and the row
// being certified ran nothing.
//
// A SOURCE SCAN, not a behavioural test, and deliberately so. The defect is a
// literal that drifts away from a constant, and the failure is silent by
// construction — the monitor ran, wrote rows and reported success the whole
// time. Nothing at runtime could have caught it, because nothing was broken;
// the two ends simply described different things.
Deno.test("US-2302: the monitor resolves the live prompt version, not a literal", async () => {
  const src = await Deno.readTextFile(
    new URL("../lib/grading-monitor.ts", import.meta.url),
  );
  // Comment lines are stripped FIRST. The fix's own explanation quotes both
  // version strings in order to say what went wrong, and a scan that punished
  // the file for documenting itself would get the explanation deleted rather
  // than the literal — the same trap already noted on
  // no-client-storage-upload.test.ts.
  const code = src
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  const literals = [...code.matchAll(/"composite_v\d+"/g)].map((m) => m[0]);
  assertEquals(
    literals,
    [],
    `grading-monitor.ts hardcodes ${literals.join(", ")} — import ` +
      `COMPOSITE_PROMPT_VERSION instead, so a version bump moves both ends ` +
      `together. A literal here silently detaches the gate from the grades.`,
  );
  // And it reads the constant the pipeline stamps.
  assertEquals(src.includes("COMPOSITE_PROMPT_VERSION"), true);
});

Deno.test("US-2302: ai-grading still exports the constant the monitor imports", async () => {
  // The other half. If the export is renamed, the monitor's import breaks
  // loudly at type-check — but if it were ever made optional or re-exported
  // through a shim, this pins the name the guard above depends on.
  const src = await Deno.readTextFile(
    new URL("../lib/ai-grading.ts", import.meta.url),
  );
  assertEquals(/export const COMPOSITE_PROMPT_VERSION\s*=/.test(src), true);
});

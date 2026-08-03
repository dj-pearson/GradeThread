import { supabaseAdmin } from "./supabase.ts";
import { COMPOSITE_PROMPT_VERSION } from "./ai-grading.ts";
import { requireJobSecret } from "./job-auth.ts";
import { computeAccuracySummary, computeOutcomeFeedback } from "./accuracy-tracking.ts";
import { evalThresholds, runEval } from "./grading-eval.ts";
import { getGradingCompositeModel } from "./ai-config.ts";
import { sendGradingRegressionAlertEmail } from "./email.ts";
import { captureException, recordMetric } from "./observability.ts";
import { fetchWithTimeout } from "./circuit-breaker.ts";

// Grading regression monitor (US-327).
//
// Runs on a schedule (cron → POST /api/jobs/grading-monitor). Two jobs:
//   1. Re-run the golden-set eval against the LIVE prompt version and compare
//      to its previous baseline — catches a model/prompt regressing in place.
//   2. Recompute production accuracy (human reviews) + post-sale outcomes
//      (disputes) and check them against published thresholds.
// Any breach persists a grading_monitor_runs row and (subject to a cooldown)
// emails the team. This is what makes "self-improving over time" autonomous:
// the platform watches its own quality instead of waiting for a human to look.

// ─── Thresholds (env-tunable) ───────────────────────────────────────

function num(name: string, fallback: number): number {
  const raw = Number(Deno.env.get(name));
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

export interface MonitorThresholds {
  min_sample: number;
  min_agreement: number;
  max_intentional_misread: number;
  max_dispute_rate: number;
  eval_mae_regression_delta: number;
  eval_agreement_regression_delta: number;
}

export function monitorThresholds(): MonitorThresholds {
  const gate = evalThresholds();
  return {
    // Below this many reviewed/sold items, rates are too noisy to alert on.
    min_sample: num("MONITOR_MIN_SAMPLE", 10),
    // Default to the same agreement bar the activation gate enforces.
    min_agreement: num("MONITOR_MIN_AGREEMENT", gate.min_agreement),
    max_intentional_misread: num("MONITOR_MAX_MISREAD", 0.1),
    max_dispute_rate: num("MONITOR_MAX_DISPUTE", 0.05),
    // A live eval may go UP by this much vs. baseline before it's a regression.
    eval_mae_regression_delta: num("MONITOR_EVAL_MAE_REGRESSION_DELTA", 0.3),
    eval_agreement_regression_delta: num("MONITOR_EVAL_AGREEMENT_REGRESSION_DELTA", 0.1),
  };
}

// ─── Types ──────────────────────────────────────────────────────────

export type Severity = "ok" | "warn" | "critical";

export interface MonitorAlert {
  code: string;
  severity: Exclude<Severity, "ok">;
  metric: string;
  value: number;
  threshold: number;
  message: string;
}

export interface MonitorEvalResult {
  ran: boolean;
  skipped_reason?: string;
  prompt_version_id?: string;
  prompt_version_name?: string;
  mean_absolute_error?: number;
  agreement_rate?: number;
  passed?: boolean;
  regression_vs_baseline: boolean;
  baseline_mae?: number | null;
  baseline_agreement_rate?: number | null;
}

export interface MonitorProductionMetrics {
  human_reviews: number;
  agreement_rate: number;
  mean_absolute_error: number;
  intentional_misread_rate: number;
  graded_sales: number;
  dispute_rate: number;
}

export interface MonitorResult {
  ran_at: string;
  trigger: "scheduled" | "manual";
  eval: MonitorEvalResult;
  production: MonitorProductionMetrics;
  alerts: MonitorAlert[];
  severity: Severity;
  alerted: boolean;
}

// ─── Pure alert evaluation (unit-tested) ────────────────────────────

export interface AlertInputs {
  eval_passed: boolean | null; // null = eval not run this cycle
  eval_regression: boolean;
  production: MonitorProductionMetrics;
  // US-482: true when more than one distinct grading model appears in the recent
  // production window (i.e. the active model changed) — graders must alert on
  // this since a model swap can silently shift accuracy/reproducibility.
  model_changed?: boolean;
  // US-2036: the live grading model vs. the model the ACTIVE prompt version was
  // qualified on. activatePromptVersion blocks this mismatch at activation time,
  // but the model is env config and can change UNDER an already-active version —
  // so it also has to be caught at runtime. null = nothing active to compare.
  model_qualification?: { live: string; qualified: string | null } | null;
  // US-2037: size of the ACTIVE golden set vs. the size the last eval run saw.
  // A shrinking golden set is the exact signal the grading-engine skill asks
  // reviewers to watch for, and a human watching a table is not a mechanism.
  golden_set?: { active: number; baseline: number | null } | null;
}

/**
 * Decide which alerts a monitor run raises. Pure — no I/O — so the thresholds
 * and sample-size guards are unit-testable (grading-monitor_test.ts).
 */
export function evaluateAlerts(
  inputs: AlertInputs,
  t: MonitorThresholds,
): MonitorAlert[] {
  const alerts: MonitorAlert[] = [];
  const p = inputs.production;

  // US-482: the active grading model changed within the recent window.
  if (inputs.model_changed) {
    alerts.push({
      code: "model_changed",
      severity: "warn",
      metric: "grading_model",
      value: 1,
      threshold: 0,
      message:
        "The active grading model changed (more than one model in the recent grade window). Confirm the new model is allowlisted and clears the eval gate.",
    });
  }

  // US-2036: live grading model ≠ the model the active prompt version was
  // qualified on. Critical, not warn: every grade served in this state comes
  // from a model that never cleared the gate, and the prompt row still says
  // eval_passed:true, so nothing else downstream will notice.
  const mq = inputs.model_qualification;
  if (mq && mq.qualified !== mq.live) {
    alerts.push({
      code: "model_not_qualified",
      severity: "critical",
      metric: "grading_model_qualified",
      value: 0,
      threshold: 1,
      message: mq.qualified
        ? `Live grading model "${mq.live}" is NOT the model the active prompt version was qualified on ("${mq.qualified}"). Grades are being served by a model that never cleared the eval gate — re-run the eval or revert the model.`
        : `The active prompt version has no qualifying model recorded, so we cannot prove live model "${mq.live}" ever cleared the eval gate. Re-run the eval.`,
    });
  }

  // US-2037: the active golden set shrank since the last eval run. That is how
  // a stubborn prompt version gets nudged past the gate — delete the cases it
  // fails, then activate — and it also silently breaks cross-run comparisons,
  // because the denominator moved underneath them.
  const gs = inputs.golden_set;

  // US-2301: an EMPTY golden set is not "nothing to check", it is the accuracy
  // gate being switched off.
  //
  // runScheduledEval skipped cleanly on zero cases, reasoning that a fresh
  // deployment legitimately has none. True — and it means the state where no
  // prompt has ever been evaluated, and none can be, produces silence. The
  // monitor is the only thing that would ever say so, and it said nothing.
  //
  // Deliberately an ALERT rather than a thrown error: throwing would break the
  // monitor cron on a fresh deploy, which trades a silent gap for a noisy one
  // and teaches operators to ignore the job. Critical severity because every
  // grade served in this state is ungated, and eval_passed reads null rather
  // than false — so no other rule in this function fires.
  if (gs && gs.active === 0) {
    alerts.push({
      code: "golden_set_empty",
      severity: "critical",
      metric: "golden_set_active_cases",
      value: 0,
      threshold: 1,
      message:
        "The golden set is EMPTY, so the eval gate cannot run and no prompt version " +
        "can be qualified. Every grade being served is ungated. Promote real " +
        "human-corrected grades into grading_eval_cases (never synthetic cases).",
    });
  }

  if (gs && gs.baseline !== null && gs.active < gs.baseline) {
    alerts.push({
      code: "golden_set_shrank",
      severity: "critical",
      metric: "golden_set_active_cases",
      value: gs.active,
      threshold: gs.baseline,
      message:
        `The active golden set shrank from ${gs.baseline} to ${gs.active} cases since the last eval run. Cases must not be removed to make an eval pass, and accuracy figures across that boundary are no longer comparable.`,
    });
  }

  if (inputs.eval_passed === false) {
    alerts.push({
      code: "eval_gate_failed",
      severity: "critical",
      metric: "eval_passed",
      value: 0,
      threshold: 1,
      message:
        "The live prompt version no longer clears the golden-set eval gate (MAE/agreement). Investigate before it grades more traffic.",
    });
  }

  if (inputs.eval_regression) {
    alerts.push({
      code: "eval_regression",
      severity: "warn",
      metric: "eval_mae",
      value: 0,
      threshold: 0,
      message:
        "The live prompt version's golden-set accuracy regressed versus its previous baseline run.",
    });
  }

  if (p.human_reviews >= t.min_sample && p.agreement_rate < t.min_agreement) {
    alerts.push({
      code: "low_agreement",
      severity: "critical",
      metric: "agreement_rate",
      value: p.agreement_rate,
      threshold: t.min_agreement,
      message: `AI-vs-human agreement (${pct(p.agreement_rate)}) fell below the ${pct(
        t.min_agreement,
      )} floor across ${p.human_reviews} reviews.`,
    });
  }

  if (
    p.human_reviews >= t.min_sample &&
    p.intentional_misread_rate > t.max_intentional_misread
  ) {
    alerts.push({
      code: "high_intentional_misread",
      severity: "warn",
      metric: "intentional_misread_rate",
      value: p.intentional_misread_rate,
      threshold: t.max_intentional_misread,
      message: `Intentional-design misread rate (${pct(
        p.intentional_misread_rate,
      )}) exceeded ${pct(t.max_intentional_misread)} — the grader may be penalizing design as damage again.`,
    });
  }

  if (p.graded_sales >= t.min_sample && p.dispute_rate > t.max_dispute_rate) {
    alerts.push({
      code: "high_dispute_rate",
      severity: "warn",
      metric: "dispute_rate",
      value: p.dispute_rate,
      threshold: t.max_dispute_rate,
      message: `Buyer dispute rate on graded sales (${pct(p.dispute_rate)}) exceeded ${pct(
        t.max_dispute_rate,
      )}.`,
    });
  }

  return alerts;
}

export function worstSeverity(alerts: MonitorAlert[]): Severity {
  if (alerts.some((a) => a.severity === "critical")) return "critical";
  if (alerts.length > 0) return "warn";
  return "ok";
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

// ─── Live-eval baseline comparison ──────────────────────────────────

// Resolve the prompt version that represents live composite grading: the active
// composite override if one exists, else the seeded in-code default row.
async function resolveLiveCompositeVersion(): Promise<
  { id: string; version_name: string } | null
> {
  const { data: active } = await supabaseAdmin
    .from("ai_prompt_versions")
    .select("id, version_name")
    .eq("stage", "composite")
    .eq("is_active", true)
    .is("garment_scope", null)
    .maybeSingle();
  if (active) return active as { id: string; version_name: string };

  // US-2302: fall back to the version the PIPELINE ACTUALLY ATTRIBUTES, not a
  // hardcoded string. This read "composite_v2" while ai-grading.ts stamps live
  // grades COMPOSITE_PROMPT_VERSION ("composite_v4"), so with no override
  // active — the normal state — the scheduled monitor evaluated a stale row and
  // wrote eval_passed and qualified_model onto it. Orphaned in both directions:
  // the version being graded had no row, and the row being certified ran
  // nothing. Monitor results and accuracy slices could never join, so the gate
  // reported on a prompt that had not produced a grade in months.
  //
  // Importing the constant rather than repeating the string is the point — a
  // v5 bump now moves both ends together, which is the only reason this cannot
  // silently drift back apart.
  const { data: seeded } = await supabaseAdmin
    .from("ai_prompt_versions")
    .select("id, version_name")
    .eq("version_name", COMPOSITE_PROMPT_VERSION)
    .maybeSingle();
  return (seeded as { id: string; version_name: string } | null) ?? null;
}

async function runScheduledEval(t: MonitorThresholds): Promise<MonitorEvalResult> {
  const base: MonitorEvalResult = { ran: false, regression_vs_baseline: false };

  if ((Deno.env.get("MONITOR_RUN_EVAL") ?? "true").toLowerCase() === "false") {
    return { ...base, skipped_reason: "MONITOR_RUN_EVAL=false" };
  }

  // No golden cases → nothing to eval. The RUN still skips (there is genuinely
  // nothing to measure), but US-2301: this is no longer silent — the golden-set
  // size travels to evaluateAlerts, which raises `golden_set_empty` at critical.
  // An empty set means the accuracy gate is switched off, not that everything is
  // fine, and this skip was the only thing standing between that state and an
  // alert.
  const { count: caseCount } = await supabaseAdmin
    .from("grading_eval_cases")
    .select("id", { count: "exact", head: true })
    .eq("is_active", true)
    .is("deleted_at", null); // US-2037
  if (!caseCount || caseCount === 0) {
    return { ...base, skipped_reason: "no active eval cases" };
  }

  const version = await resolveLiveCompositeVersion();
  if (!version) {
    return { ...base, skipped_reason: "no live composite prompt version to evaluate" };
  }

  try {
    const run = await runEval(version.id, null);

    // Baseline = the most recent prior run for this version (exclude this one).
    // Guard the id filter so a null run_id (persist failed) can't send an empty
    // string to a uuid column.
    let baselineQuery = supabaseAdmin
      .from("grading_eval_runs")
      .select("id, mean_absolute_error, agreement_rate")
      .eq("prompt_version_id", version.id);
    if (run.run_id) baselineQuery = baselineQuery.neq("id", run.run_id);
    const { data: prior } = await baselineQuery
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    let regression = false;
    let baselineMae: number | null = null;
    let baselineAgreement: number | null = null;
    if (prior) {
      baselineMae = Number((prior as { mean_absolute_error: number }).mean_absolute_error);
      baselineAgreement = Number((prior as { agreement_rate: number }).agreement_rate);
      regression =
        run.mean_absolute_error > baselineMae + t.eval_mae_regression_delta ||
        run.agreement_rate < baselineAgreement - t.eval_agreement_regression_delta;
    }

    return {
      ran: true,
      prompt_version_id: version.id,
      prompt_version_name: version.version_name,
      mean_absolute_error: run.mean_absolute_error,
      agreement_rate: run.agreement_rate,
      passed: run.passed,
      regression_vs_baseline: regression,
      baseline_mae: baselineMae,
      baseline_agreement_rate: baselineAgreement,
    };
  } catch (err) {
    return {
      ...base,
      prompt_version_id: version.id,
      prompt_version_name: version.version_name,
      skipped_reason: `eval errored: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ─── Orchestrator ───────────────────────────────────────────────────

const COOLDOWN_MS = () => num("MONITOR_COOLDOWN_HOURS", 12) * 60 * 60 * 1000;

export async function runGradingRegressionScan(
  trigger: "scheduled" | "manual" = "scheduled",
): Promise<MonitorResult> {
  const t = monitorThresholds();

  // Production metrics first — these never make AI calls and should always run
  // even if the golden-set eval is skipped or errors.
  const [accuracy, outcomes, evalResult] = await Promise.all([
    computeAccuracySummary(),
    computeOutcomeFeedback(),
    runScheduledEval(t),
  ]);

  const production: MonitorProductionMetrics = {
    human_reviews: accuracy.total_reviews,
    agreement_rate: accuracy.global_agreement_rate,
    mean_absolute_error: accuracy.global_mean_absolute_error,
    intentional_misread_rate: accuracy.global_intentional_misread_rate,
    graded_sales: outcomes.total_graded_sales,
    dispute_rate: outcomes.overall_dispute_rate,
  };

  // US-482: detect a grading-model change from the recent grade window. The
  // composite model is recorded as the part before "|" in model_version
  // (grading-pipeline.ts). More than one distinct value = the model changed.
  let modelChanged = false;
  try {
    const { data: recentReports } = await supabaseAdmin
      .from("grade_reports")
      .select("model_version")
      .not("model_version", "is", null)
      .order("created_at", { ascending: false })
      .limit(50);
    const models = new Set(
      ((recentReports ?? []) as Array<{ model_version: string | null }>)
        .map((r) => (r.model_version ?? "").split("|")[0]?.trim())
        .filter((m): m is string => !!m),
    );
    modelChanged = models.size > 1;
  } catch (err) {
    console.error("[grading-monitor] model-change check failed:", err);
  }

  // US-2036: compare the live grading model against the model the ACTIVE
  // composite prompt version was qualified on. The activation gate can only
  // check this at activation time; the model is env config and can change under
  // an already-active version, which is precisely the bypass this catches.
  let modelQualification: { live: string; qualified: string | null } | null = null;
  try {
    const live = await resolveLiveCompositeVersion();
    if (live) {
      const { data: row } = await supabaseAdmin
        .from("ai_prompt_versions")
        .select("qualified_model")
        .eq("id", live.id)
        .maybeSingle();
      modelQualification = {
        live: getGradingCompositeModel(),
        qualified: (row as { qualified_model: string | null } | null)?.qualified_model ?? null,
      };
    }
  } catch (err) {
    console.error("[grading-monitor] model-qualification check failed:", err);
  }

  // US-2037: active golden-set size vs. its recent HIGH-WATER MARK
  // (grading_eval_runs.cases_total records the size at each run — no extra
  // bookkeeping needed). Deliberately the max over a window rather than the
  // single previous run: this cycle's own eval has already inserted a row whose
  // cases_total equals the current count, so a last-run comparison would always
  // compare the set against itself and never fire. The window also lets the
  // alert age out on its own once a legitimate deactivation becomes the norm.
  let goldenSet: { active: number; baseline: number | null } | null = null;
  try {
    const { count: activeCases } = await supabaseAdmin
      .from("grading_eval_cases")
      .select("id", { count: "exact", head: true })
      .eq("is_active", true)
      .is("deleted_at", null);
    const { data: recentRuns } = await supabaseAdmin
      .from("grading_eval_runs")
      .select("cases_total")
      .order("created_at", { ascending: false })
      .limit(10);
    const totals = ((recentRuns ?? []) as Array<{ cases_total: number | null }>)
      .map((r) => Number(r.cases_total))
      .filter((n) => Number.isFinite(n) && n > 0);
    goldenSet = {
      active: activeCases ?? 0,
      baseline: totals.length > 0 ? Math.max(...totals) : null,
    };
  } catch (err) {
    console.error("[grading-monitor] golden-set size check failed:", err);
  }

  const alerts = evaluateAlerts(
    {
      eval_passed: evalResult.ran ? evalResult.passed ?? null : null,
      eval_regression: evalResult.regression_vs_baseline,
      production,
      model_changed: modelChanged,
      model_qualification: modelQualification,
      golden_set: goldenSet,
    },
    t,
  );
  const severity = worstSeverity(alerts);
  const alertCodes = [...new Set(alerts.map((a) => a.code))].sort();

  // Cooldown: don't re-email the same alert set within the cooldown window.
  let shouldAlert = alerts.length > 0;
  if (shouldAlert) {
    const since = new Date(Date.now() - COOLDOWN_MS()).toISOString();
    const { data: recent } = await supabaseAdmin
      .from("grading_monitor_runs")
      .select("alert_codes, created_at")
      .eq("alerted", true)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (recent) {
      const prevCodes = [...((recent as { alert_codes: string[] }).alert_codes ?? [])].sort();
      if (prevCodes.join(",") === alertCodes.join(",")) shouldAlert = false;
    }
  }

  const ran_at = new Date().toISOString();
  let alerted = false;

  if (shouldAlert) {
    alerted = await dispatchAlert(severity, alerts, production, evalResult);
  }

  // Persist the run (service role bypasses RLS).
  const { error: insertError } = await supabaseAdmin.from("grading_monitor_runs").insert({
    trigger,
    severity,
    eval: evalResult,
    production,
    alerts,
    alert_codes: alertCodes,
    alerted,
  });
  if (insertError) {
    console.error("[grading-monitor] failed to persist run:", insertError.message);
  }

  return { ran_at, trigger, eval: evalResult, production, alerts, severity, alerted };
}

// US-502: returns TRUE only if at least one channel ACTUALLY delivered. The
// caller uses this to set `alerted`, which gates the cooldown — so when nothing
// is delivered the cooldown does NOT engage and the next run retries (instead of
// the old behavior, which marked alerted=true unconditionally and then
// suppressed every alert for 12h even though the team never heard anything).
export async function dispatchAlert(
  severity: Severity,
  alerts: MonitorAlert[],
  production: MonitorProductionMetrics,
  evalResult: MonitorEvalResult,
): Promise<boolean> {
  const evalSummary = evalResult.ran
    ? `${evalResult.prompt_version_name}: MAE ${evalResult.mean_absolute_error}, agreement ${(
        (evalResult.agreement_rate ?? 0) * 100
      ).toFixed(1)}%, ${evalResult.passed ? "passed" : "FAILED"}`
    : `skipped (${evalResult.skipped_reason ?? "unknown"})`;

  const to = Deno.env.get("MONITOR_ALERT_EMAIL") || Deno.env.get("SMTP_ADMIN_EMAIL") || "";
  const webhook = Deno.env.get("MONITOR_ALERT_WEBHOOK")?.trim() || "";

  let delivered = 0;

  // Channel 1: email.
  if (to) {
    try {
      await sendGradingRegressionAlertEmail(to, {
        severity,
        alerts: alerts.map((a) => ({ severity: a.severity, message: a.message })),
        production,
        evalSummary,
      });
      delivered += 1;
    } catch (err) {
      captureException(err, { route: "grading-monitor.alert.email", tags: { severity } });
    }
  }

  // Channel 2: reliable webhook (Slack incoming-webhook / generic / PagerDuty
  // Events v2-compatible `text`+`summary` payload). 5s deadline so a hung
  // endpoint can't wedge the cron.
  if (webhook) {
    try {
      const summary = `[GradeThread grading monitor] ${severity.toUpperCase()}: ` +
        alerts.map((a) => a.message).join(" | ") + ` (eval: ${evalSummary})`;
      const res = await fetchWithTimeout(
        webhook,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: summary, // Slack
            summary, // PagerDuty/generic
            severity,
            alert_codes: [...new Set(alerts.map((a) => a.code))],
          }),
        },
        5000,
      );
      if (res.ok) delivered += 1;
      else {
        captureException(
          new Error(`grading-monitor alert webhook returned ${res.status}`),
          { route: "grading-monitor.alert.webhook", tags: { severity } },
        );
      }
      await res.body?.cancel();
    } catch (err) {
      captureException(err, { route: "grading-monitor.alert.webhook", tags: { severity } });
    }
  }

  // US-502 AC#3: a raised alert that reached NO channel must itself be reported,
  // and must NOT engage the cooldown (delivered stays 0 → alerted=false).
  if (delivered === 0) {
    recordMetric("grading_monitor.alert_undelivered", 1, { severity });
    captureException(
      new Error(
        `grading-monitor raised ${alerts.length} alert(s) (severity ${severity}) but NO channel was configured/reachable — set MONITOR_ALERT_EMAIL or MONITOR_ALERT_WEBHOOK`,
      ),
      { level: "warn", route: "grading-monitor.alert", tags: { severity } },
    );
  }

  return delivered > 0;
}

// ─── Cron entry point ───────────────────────────────────────────────

// Mirrors handleGscSyncCron: NOT mounted under /api/admin (no user JWT on a
// cron), guards itself with the shared internal-job secret.
export async function handleGradingMonitorCron(c: {
  req: { header: (name: string) => string | undefined };
  json: (body: unknown, status?: number) => Response;
}): Promise<Response> {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  try {
    const result = await runGradingRegressionScan("scheduled");
    return c.json(result, 200);
  } catch (err) {
    return c.json(
      { error: "Monitor scan failed", detail: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
}

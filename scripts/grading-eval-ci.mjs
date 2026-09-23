#!/usr/bin/env node
// US-2301 (grading plan action 3): the verdict for the scheduled golden-set
// eval workflow (.github/workflows/grading-eval.yml).
//
// The workflow POSTs /api/jobs/grading-monitor, which runs runEval() against the
// live composite prompt version on the edge (where the Anthropic key, the
// service-role client and the private submission-images bucket already are) and
// returns a MonitorResult. This file decides whether that result is a CI pass.
//
// Why a separate verdict and not the monitor's own severity: the monitor is
// deliberately forgiving about an empty golden set. It returns 200 with
// `eval.ran: false` and raises `golden_set_empty` as an alert, because throwing
// would break the cron on a fresh deploy. That is right for a cron and wrong for
// this job, whose only purpose is to say the gate measured something. So here:
//
//   FAIL  the eval did not run, for ANY reason (empty set, no live version row,
//         the eval threw, MONITOR_RUN_EVAL=false). A skipped eval is not a pass.
//   FAIL  the live version does not clear the activation thresholds.
//   FAIL  it regressed against its previous run (monitor's baseline delta).
//   FAIL  the golden set shrank, or the live model is not the one the version
//         was qualified on. Both are the gate being bypassed rather than failed.
//   WARN  production-metric alerts (agreement on human reviews, disputes,
//         misreads, model change). Those are the monitor's email to send, and
//         they move with traffic rather than with the prompt.
//
// Usage: node scripts/grading-eval-ci.mjs <http_status> <response.json>

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Alert codes that fail the job. Anything else the monitor raises is a warning. */
export const FAILING_ALERT_CODES = [
  "golden_set_empty",
  "golden_set_shrank",
  "eval_gate_failed",
  "eval_regression",
  "model_not_qualified",
];

/**
 * @param {{ status: number, body: unknown }} input
 * @returns {{ ok: boolean, failures: string[], warnings: string[], summary: string }}
 */
export function judgeGradingEval({ status, body }) {
  const failures = [];
  const warnings = [];

  if (status !== 200) {
    failures.push(`grading-monitor returned HTTP ${status}, so no eval verdict exists.`);
    return { ok: false, failures, warnings, summary: "no verdict" };
  }
  if (!body || typeof body !== "object") {
    failures.push("grading-monitor returned a body that is not a JSON object.");
    return { ok: false, failures, warnings, summary: "no verdict" };
  }
  const b = /** @type {Record<string, any>} */ (body);
  if (b.error) {
    failures.push(`grading-monitor returned an error payload: ${b.error}${b.detail ? ` (${b.detail})` : ""}`);
    return { ok: false, failures, warnings, summary: "no verdict" };
  }

  const ev = b.eval && typeof b.eval === "object" ? b.eval : null;
  const alerts = Array.isArray(b.alerts) ? b.alerts : [];

  if (!ev) {
    failures.push("the response has no `eval` section; the monitor contract changed under this job.");
  } else if (ev.ran !== true) {
    failures.push(
      `the golden-set eval did not run: ${ev.skipped_reason ?? "no reason given"}. ` +
        "A skipped eval is not a pass.",
    );
  } else {
    if (ev.passed !== true) {
      failures.push(
        `${ev.prompt_version_name} does not clear the eval gate ` +
          `(MAE ${ev.mean_absolute_error}, agreement ${ev.agreement_rate}).`,
      );
    }
    if (ev.regression_vs_baseline === true) {
      failures.push(
        `${ev.prompt_version_name} regressed against its previous run ` +
          `(MAE ${ev.baseline_mae} -> ${ev.mean_absolute_error}, ` +
          `agreement ${ev.baseline_agreement_rate} -> ${ev.agreement_rate}).`,
      );
    }
  }

  for (const a of alerts) {
    const msg = `[${a?.code ?? "unknown"}] ${a?.message ?? ""}`.trim();
    if (FAILING_ALERT_CODES.includes(a?.code)) {
      // eval_gate_failed / eval_regression restate the eval section above; say
      // them once.
      if (a.code === "eval_gate_failed" || a.code === "eval_regression") continue;
      failures.push(msg);
    } else {
      warnings.push(msg);
    }
  }

  const summary = ev && ev.ran === true
    ? `${ev.prompt_version_name}: MAE ${ev.mean_absolute_error}, agreement ${ev.agreement_rate}, ` +
      `${ev.passed ? "passed" : "FAILED"}${ev.regression_vs_baseline ? ", REGRESSED" : ""}`
    : `eval skipped (${ev?.skipped_reason ?? "unknown"})`;

  return { ok: failures.length === 0, failures, warnings, summary };
}

function main() {
  const [statusArg, file] = process.argv.slice(2);
  if (!statusArg || !file) {
    console.error("usage: node scripts/grading-eval-ci.mjs <http_status> <response.json>");
    process.exit(2);
  }
  const raw = readFileSync(file, "utf8");
  let body = null;
  try {
    body = JSON.parse(raw);
  } catch {
    body = null;
  }
  const verdict = judgeGradingEval({ status: Number(statusArg), body });
  console.log(`Golden-set eval: ${verdict.summary}`);
  for (const w of verdict.warnings) console.log(`::warning::${w}`);
  for (const f of verdict.failures) console.log(`::error::${f}`);
  process.exit(verdict.ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

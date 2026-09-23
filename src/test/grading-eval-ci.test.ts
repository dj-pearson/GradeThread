import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error -- plain .mjs script with no type declarations
import { judgeGradingEval } from "../../scripts/grading-eval-ci.mjs";

// US-2301 (grading plan action 3): the scheduled golden-set eval must go RED on
// a regression and on an empty set, and must skip cleanly without its secret.
// The monitor it calls returns 200 in both of the red cases, so the verdict
// script is the only thing standing between those states and a green run.

type Verdict = { ok: boolean; failures: string[]; warnings: string[]; summary: string };
const judge = judgeGradingEval as (input: { status: number; body: unknown }) => Verdict;

const ranEval = {
  ran: true,
  prompt_version_id: "v1",
  prompt_version_name: "composite_v4",
  mean_absolute_error: 0.31,
  agreement_rate: 0.82,
  passed: true,
  regression_vs_baseline: false,
  baseline_mae: 0.3,
  baseline_agreement_rate: 0.83,
};

function body(overrides: Record<string, unknown> = {}) {
  return {
    ran_at: "2026-09-23T00:00:00Z",
    trigger: "scheduled",
    eval: ranEval,
    production: {},
    alerts: [],
    severity: "ok",
    alerted: false,
    ...overrides,
  };
}

describe("judgeGradingEval", () => {
  it("passes a live version that clears the gate with no regression", () => {
    const v = judge({ status: 200, body: body() });
    expect(v.failures).toEqual([]);
    expect(v.ok).toBe(true);
  });

  it("fails on an EMPTY golden set, which the monitor answers with a 200", () => {
    // This is exactly what runGradingRegressionScan returns today with zero
    // active cases: a skipped eval and a critical alert, HTTP 200.
    const v = judge({
      status: 200,
      body: body({
        eval: { ran: false, regression_vs_baseline: false, skipped_reason: "no active eval cases" },
        alerts: [{ code: "golden_set_empty", severity: "critical", message: "The golden set is EMPTY" }],
        severity: "critical",
      }),
    });
    expect(v.ok).toBe(false);
    expect(v.failures.join("\n")).toMatch(/no active eval cases/);
    expect(v.failures.join("\n")).toMatch(/golden_set_empty/);
  });

  it("fails when the eval was skipped for any other reason", () => {
    for (const reason of [
      "no live composite prompt version to evaluate",
      "eval errored: boom",
      "MONITOR_RUN_EVAL=false",
    ]) {
      const v = judge({
        status: 200,
        body: body({ eval: { ran: false, regression_vs_baseline: false, skipped_reason: reason } }),
      });
      expect(v.ok, reason).toBe(false);
    }
  });

  it("fails on a regression against the previous run even while above threshold", () => {
    const v = judge({
      status: 200,
      body: body({ eval: { ...ranEval, regression_vs_baseline: true } }),
    });
    expect(v.ok).toBe(false);
    expect(v.failures.join("\n")).toMatch(/regressed/);
  });

  it("fails when the live version no longer clears the thresholds", () => {
    const v = judge({ status: 200, body: body({ eval: { ...ranEval, passed: false } }) });
    expect(v.ok).toBe(false);
    expect(v.failures.join("\n")).toMatch(/does not clear the eval gate/);
  });

  it("fails on a shrunk golden set and on an unqualified live model", () => {
    for (const code of ["golden_set_shrank", "model_not_qualified"]) {
      const v = judge({ status: 200, body: body({ alerts: [{ code, message: "x" }] }) });
      expect(v.ok, code).toBe(false);
    }
  });

  it("only warns on production-metric alerts", () => {
    const v = judge({
      status: 200,
      body: body({ alerts: [{ code: "high_dispute_rate", severity: "warn", message: "disputes" }] }),
    });
    expect(v.ok).toBe(true);
    expect(v.warnings).toHaveLength(1);
  });

  it("fails on a non-200, an error payload, and a non-JSON body", () => {
    expect(judge({ status: 401, body: { error: "Unauthorized" } }).ok).toBe(false);
    expect(judge({ status: 500, body: null }).ok).toBe(false);
    expect(judge({ status: 0, body: null }).ok).toBe(false);
    expect(judge({ status: 200, body: { error: "Monitor scan failed" } }).ok).toBe(false);
    expect(judge({ status: 200, body: null }).ok).toBe(false);
  });
});

describe(".github/workflows/grading-eval.yml", () => {
  const wf = readFileSync(join(process.cwd(), ".github/workflows/grading-eval.yml"), "utf8");
  const onBlock = wf.match(/^on:\n([\s\S]*?)\n\S/m)?.[1] ?? "";

  it("runs on a schedule and on demand, never on push or pull_request", () => {
    expect(onBlock).toMatch(/schedule:/);
    expect(onBlock).toMatch(/workflow_dispatch:/);
    expect(onBlock).not.toMatch(/pull_request|push:/);
  });

  it("never runs on a fork", () => {
    expect(wf).toMatch(/if:\s*github\.repository\s*==\s*'dj-pearson\/GradeThread'/);
  });

  it("skips cleanly (exit 0) when the secret is absent, before any request", () => {
    const skip = wf.indexOf('if [ -z "${EDGE_JOB_SECRET:-}" ]');
    const curl = wf.indexOf("curl ");
    expect(skip).toBeGreaterThan(-1);
    expect(skip).toBeLessThan(curl);
    expect(wf.slice(skip, curl)).toMatch(/exit 0/);
  });

  it("on a 401 names the repo secret to check, before the verdict fails the job", () => {
    // A rotated FLIPDESK_INTERNAL_JOB_SECRET turns this job red with only
    // "HTTP 401" to go on. The hint says which of the two secrets to compare.
    const hint = wf.indexOf('if [ "$code" = "401" ]');
    const verdict = wf.indexOf("node scripts/grading-eval-ci.mjs");
    expect(hint).toBeGreaterThan(-1);
    expect(hint).toBeLessThan(verdict);
    expect(wf.slice(hint, verdict)).toMatch(/::error::[^\n]*EDGE_JOB_SECRET/);
  });

  it("does not present itself as the only eval run", () => {
    // The Coolify grading-monitor cron hits the same endpoint every 12h and
    // runs runEval() each time, so a comment pricing "weekly" as the whole
    // spend undercounts it about fifteen-fold.
    expect(wf).toMatch(/NOT the only eval run/);
    expect(wf).toMatch(/0 \*\/12 \* \* \*/);
  });

  it("hands the response to the verdict script rather than a bare status check", () => {
    expect(wf).toMatch(/node scripts\/grading-eval-ci\.mjs "\$code"/);
    expect(wf).toMatch(/\/api\/jobs\/grading-monitor/);
  });
});

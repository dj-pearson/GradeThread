// US-1610 / AGENTIC-OS Phase 2 (Module Q): release verification — post-deploy
// regression detection by comparing health metrics to a pre-deploy baseline.
// PURE + fixture-tested. The agent NEVER rolls back (that's a human procedure,
// vault/10-ops/rollback.md); it verifies and files an admin task on a regression.
//
// Deploy detection is by RELEASE_SHA change; the comparison uses the health
// signals that ARE queryable (24h cron-failure count, webhook/email dead-letter
// depths) rather than a metrics store the platform doesn't keep windowed.

export interface ReleaseMetrics {
  job_failures_24h: number;
  webhook_dlq: number;
  email_dlq: number;
}

export interface ReleaseState {
  last_sha: string | null;
  baseline: ReleaseMetrics | null; // metrics captured while last_sha was steady
  checked_at: string | null;
}

// ── Deploy detection ─────────────────────────────────────────────────────────

export interface DeployDetection {
  deployed: boolean;
  from_sha: string | null;
  to_sha: string | null;
}

// A deploy happened when the running SHA differs from the last one we saw. An
// unknown current SHA (null/empty) is never a deploy. Pure.
export function detectDeploy(currentSha: string | null, lastSha: string | null): DeployDetection {
  const cur = currentSha && currentSha.trim() ? currentSha.trim() : null;
  const deployed = cur !== null && cur !== lastSha;
  return { deployed, from_sha: lastSha, to_sha: cur };
}

// ── Baseline comparison ──────────────────────────────────────────────────────

export interface RegressionThresholds {
  // A metric regresses when it grows by BOTH at least `min_absolute` AND
  // `ratio_band` (e.g. 0.5 = 50% worse) over the baseline — so tiny noise on a
  // near-zero baseline doesn't false-alarm.
  min_absolute: number;
  ratio_band: number;
}

export const DEFAULT_THRESHOLDS: RegressionThresholds = { min_absolute: 3, ratio_band: 0.5 };

export interface MetricRegression {
  metric: string;
  baseline: number;
  current: number;
  delta: number;
}

export interface ReleaseComparison {
  regressions: MetricRegression[];
  regressed: boolean;
  // null when there's no baseline to compare against (first observation).
  comparable: boolean;
}

const METRIC_KEYS: Array<keyof ReleaseMetrics> = ["job_failures_24h", "webhook_dlq", "email_dlq"];

// Compare post-deploy metrics to the pre-deploy baseline. A metric regresses
// when it exceeds the baseline by both the absolute floor and the ratio band.
// Pure.
export function compareRelease(
  baseline: ReleaseMetrics | null,
  current: ReleaseMetrics,
  thresholds: RegressionThresholds = DEFAULT_THRESHOLDS,
): ReleaseComparison {
  if (!baseline) return { regressions: [], regressed: false, comparable: false };
  const regressions: MetricRegression[] = [];
  for (const k of METRIC_KEYS) {
    const b = baseline[k] ?? 0;
    const c = current[k] ?? 0;
    const delta = c - b;
    const ratioOk = c >= b * (1 + thresholds.ratio_band);
    if (delta >= thresholds.min_absolute && ratioOk) {
      regressions.push({ metric: k, baseline: b, current: c, delta });
    }
  }
  return { regressions, regressed: regressions.length > 0, comparable: true };
}

// ── The assembled memo ───────────────────────────────────────────────────────

export interface ReleaseMemo {
  deploy: DeployDetection;
  metrics: ReleaseMetrics;
  comparison: ReleaseComparison;
  verdict: "no_deploy" | "clean" | "regression" | "insufficient_baseline";
  summary: string;
}

export function assembleReleaseMemo(deploy: DeployDetection, metrics: ReleaseMetrics, comparison: ReleaseComparison): ReleaseMemo {
  let verdict: ReleaseMemo["verdict"];
  let summary: string;
  if (!deploy.deployed) {
    verdict = "no_deploy";
    summary = "No new release since the last check — baseline refreshed.";
  } else if (!comparison.comparable) {
    verdict = "insufficient_baseline";
    summary = `Deploy ${short(deploy.to_sha)} detected but no pre-deploy baseline to compare — recording one now.`;
  } else if (comparison.regressed) {
    verdict = "regression";
    const worst = comparison.regressions.map((r) => `${r.metric} ${r.baseline}→${r.current}`).join(", ");
    summary = `Regression after deploy ${short(deploy.from_sha)}→${short(deploy.to_sha)}: ${worst}.`;
  } else {
    verdict = "clean";
    summary = `Deploy ${short(deploy.from_sha)}→${short(deploy.to_sha)} verified clean — no health regression.`;
  }
  return { deploy, metrics, comparison, verdict, summary };
}

function short(sha: string | null): string {
  return sha ? sha.slice(0, 8) : "unknown";
}

// Compute the next persisted state after a check: on a deploy we adopt the new
// SHA and reset the baseline to the just-observed metrics; with no deploy we
// simply refresh the baseline (a rolling steady-state snapshot). Pure.
export function nextReleaseState(deploy: DeployDetection, metrics: ReleaseMetrics, nowIso: string): ReleaseState {
  return {
    last_sha: deploy.to_sha ?? deploy.from_sha,
    baseline: metrics,
    checked_at: nowIso,
  };
}

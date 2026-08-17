// US-1611 / AGENTIC-OS Phase 2 (Module J): cron-fleet governance — the diff
// between the SCHEDULE (CRON_REGISTRY) and REALITY (cron_runs), continuously.
// Detects missed ticks (a scheduled slot with no run), duration creep, and
// tolerates maintenance windows so a planned pause is never a false alarm.
//
// PURE + fixture-tested. Reuses the existing, tested nextCronRun() so "expected"
// here means exactly what the Coolify scheduler fires. The tool supplies the
// reads (cron_runs + active maintenance windows); this module is the analysis.

import { type CronDef, nextCronRun } from "./cron-runs.ts";

const MINUTE = 60_000;

// ── Expected ticks (schedule → fire times in a window) ───────────────────────

export interface ExpectedTicks {
  ticks: number[]; // ms, ascending, within (fromMs, toMs]
  capped: boolean; // true if we hit the cap and stopped (NO silent truncation)
}

// Enumerate a schedule's fire times in (fromMs, toMs] via nextCronRun. Capped so
// a per-minute schedule over a long window can't run away; `capped` is surfaced.
export function expectedTicks(schedule: string, fromMs: number, toMs: number, cap = 2000): ExpectedTicks {
  const ticks: number[] = [];
  let cursor = fromMs;
  for (let i = 0; i < cap; i++) {
    const next = nextCronRun(schedule, new Date(cursor));
    if (!next) break;
    const t = Date.parse(next);
    if (!Number.isFinite(t) || t > toMs) break;
    ticks.push(t);
    cursor = t; // nextCronRun starts at the whole minute AFTER `from` → advances
  }
  return { ticks, capped: ticks.length >= cap };
}

// ── Maintenance suppression ──────────────────────────────────────────────────

export interface MaintenanceInterval {
  startMs: number; // -Infinity ⇒ open-started
  endMs: number; // Infinity ⇒ open-ended
}

export function inMaintenance(tMs: number, intervals: readonly MaintenanceInterval[]): boolean {
  return intervals.some((w) => tMs >= w.startMs && tMs < w.endMs);
}

// ── Missed-tick detection ────────────────────────────────────────────────────

export interface MissedTickResult {
  expected: number; // complete slots evaluated
  missed: number; // slots with no run (excluding maintenance-suppressed)
  suppressed: number; // slots skipped because a maintenance window covered them
  missed_ticks: number[]; // the missed slot start times (ms)
  consecutive_missed: number; // trailing run of missed slots (a stall signal)
  last_run_ms: number | null;
  capped: boolean;
}

// A scheduled slot is [tick[i], tick[i+1]); it is MISSED when no run landed in it
// and the slot fully elapsed (tick[i+1] <= now). Maintenance windows over the
// slot start suppress the miss. Interval-agnostic — no fixed tolerance needed.
export function detectMissedTicks(params: {
  schedule: string;
  runMs: readonly number[]; // run timestamps (ms), any order
  nowMs: number;
  lookbackMs?: number;
  maintenance?: readonly MaintenanceInterval[];
}): MissedTickResult {
  const lookbackMs = params.lookbackMs ?? 24 * 60 * MINUTE;
  const maintenance = params.maintenance ?? [];
  const { ticks, capped } = expectedTicks(params.schedule, params.nowMs - lookbackMs, params.nowMs);
  const runs = [...params.runMs].filter((t) => Number.isFinite(t)).sort((a, b) => a - b);
  const lastRun = runs.length ? runs[runs.length - 1] : null;

  let expected = 0, missed = 0, suppressed = 0;
  const missedTicks: number[] = [];
  for (let i = 0; i < ticks.length - 1; i++) {
    const slotStart = ticks[i], slotEnd = ticks[i + 1];
    if (slotEnd > params.nowMs) break; // slot not fully elapsed yet
    expected++;
    const ran = runs.some((r) => r >= slotStart && r < slotEnd);
    if (ran) continue;
    if (inMaintenance(slotStart, maintenance)) {
      suppressed++;
      continue;
    }
    missed++;
    missedTicks.push(slotStart);
  }
  // Consecutive-missed = the trailing run of missed slots ending at the latest
  // fully-elapsed slot (computed cleanly from the end).
  let consecutive = 0;
  for (let i = ticks.length - 2; i >= 0; i--) {
    const slotStart = ticks[i], slotEnd = ticks[i + 1];
    if (slotEnd > params.nowMs) continue;
    const ran = runs.some((r) => r >= slotStart && r < slotEnd);
    if (ran) break;
    if (inMaintenance(slotStart, maintenance)) continue; // maintenance doesn't break the count but isn't a miss
    consecutive++;
  }

  return {
    expected,
    missed,
    suppressed,
    missed_ticks: missedTicks,
    consecutive_missed: consecutive,
    last_run_ms: lastRun,
    capped,
  };
}

// ── Duration creep ───────────────────────────────────────────────────────────

export interface DurationCreep {
  samples: number;
  baseline_ms: number | null; // avg of the older half
  recent_ms: number | null; // avg of the newer half
  creep_pct: number | null; // (recent - baseline) / baseline
  creeping: boolean;
}

export const DURATION_CREEP_BAND = 0.5; // recent avg > 1.5x baseline avg
const CREEP_MIN_SAMPLES = 6;

// Split durations (CHRONOLOGICAL) into older-half baseline vs newer-half recent;
// flag creep when recent averages materially higher. Pure.
export function detectDurationCreep(
  durationsChrono: readonly number[],
  band = DURATION_CREEP_BAND,
): DurationCreep {
  const d = durationsChrono.filter((x) => typeof x === "number" && Number.isFinite(x) && x >= 0);
  if (d.length < CREEP_MIN_SAMPLES) {
    return { samples: d.length, baseline_ms: null, recent_ms: null, creep_pct: null, creeping: false };
  }
  const mid = Math.floor(d.length / 2);
  const avg = (arr: number[]) => arr.reduce((s, x) => s + x, 0) / arr.length;
  const baseline = avg(d.slice(0, mid));
  const recent = avg(d.slice(mid));
  const creepPct = baseline > 0 ? Number(((recent - baseline) / baseline).toFixed(4)) : null;
  return {
    samples: d.length,
    baseline_ms: Math.round(baseline),
    recent_ms: Math.round(recent),
    creep_pct: creepPct,
    creeping: creepPct !== null && creepPct >= band,
  };
}

// ── Fleet report ─────────────────────────────────────────────────────────────

export interface JobRun {
  created_at: string;
  duration_ms: number | null;
  // US-2312: the run's OUTCOME, not just its timing. Before this the fleet
  // report could only see whether a job ticked — a job that ran on schedule and
  // failed every unit of work inside it read as healthy.
  status?: string | null;
  rows_processed?: number | null;
  // US-2668: the HTTP status the handler answered with. `status === "error"`
  // deliberately merges two different incidents (see cronRunStatusFor): a 5xx,
  // where the whole run failed, and a 2xx that reported failed units in its own
  // body. The 100%-failure signal below needs to tell them apart, so it reads
  // this rather than `status`.
  http_status?: number | null;
}

export interface JobScorecard {
  name: string;
  label: string;
  schedule: string;
  category: string;
  verdict: "healthy" | "slow" | "failing" | "stalled";
  missed: number;
  consecutive_missed: number;
  suppressed: number;
  last_run_ms: number | null;
  duration: DurationCreep;
  // US-2312: runs in the window, and how many of them errored. `idle_runs`
  // counts runs that recorded rows_processed === 0, so "ran every hour and did
  // nothing all week" is a readable state rather than an absence of evidence.
  runs: number;
  failed_runs: number;
  idle_runs: number;
  /** True when every run in the window processed zero rows (and there was at least one). */
  all_idle: boolean;
  // ── US-2668: failure RATE, not failure count ───────────────────────────────
  //
  // Four jobs failed on 100% of their runs for nine days and were read as an
  // intermittent container problem, because the numbers reached the operator as
  // counts: "7 failures in 7 days, about once a day". They are daily crons, so
  // 7 in 7 days is EVERY run — a deterministic app bug, and a different class of
  // incident from a sweep that fails one transfer in five hundred.
  /** Runs whose handler answered >= 400 — the whole run failed, not units inside it. */
  hard_failed_runs: number;
  /** failed_runs / runs, including body-reported failures. null when runs === 0. */
  failure_rate: number | null;
  /** hard_failed_runs / runs. null when runs === 0. */
  hard_failure_rate: number | null;
  /**
   * Every run in the window answered >= 400. Read off http_status rather than
   * `status` on purpose: a payout sweep with one permanently-failing transfer
   * records `status: "error"` on every run forever and is NOT this. A run with
   * no recorded http_status (rows predating the column being populated) cannot
   * satisfy it, so the signal fails toward silence rather than toward a page.
   */
  always_failing: boolean;
}

export interface CronFleetReport {
  summary: string;
  jobs_total: number;
  stalled: JobScorecard[];
  /** US-2312: ticking on schedule, but erroring — including body-reported failures. */
  failing: JobScorecard[];
  /**
   * US-2668: the SUBSET of `failing` that failed on every single run. Deliberately
   * a subset rather than a fifth verdict — a job here is still `failing`, so the
   * existing warning keeps covering it and nothing that reads `failing` loses a
   * job it used to see. What this adds is the reading: 100% is a bug in the job,
   * not a run of bad luck, and it is worth waking someone for.
   */
  always_failing: JobScorecard[];
  slow: JobScorecard[];
  scorecards: JobScorecard[];
  all_clear: boolean;
  /**
   * US-2616: registry entries this report did NOT examine — `recorded: false`
   * (no ledger cadence to check) and `oneOff` (no cadence at all).
   *
   * Deliberately NOT folded into `all_clear`. These are not failures; they are
   * the edge of what the detector can observe, and flipping the fleet alert on
   * a permanent condition would train the on-call to ignore it — the same
   * reasoning as the re-alert suppression in routes/jobs-cron-fleet.ts.
   */
  unmonitored: string[];
}

export function assembleCronFleetReport(params: {
  registry: readonly CronDef[];
  runsByJob: Record<string, JobRun[]>;
  maintenance: readonly MaintenanceInterval[];
  nowMs: number;
  lookbackMs?: number;
}): CronFleetReport {
  const scorecards: JobScorecard[] = [];
  for (const def of params.registry) {
    if (!def.recorded || def.oneOff) continue; // one-offs + unrecorded jobs have no expected cadence
    const runs = (params.runsByJob[def.name] ?? []).slice().sort(
      (a, b) => Date.parse(a.created_at) - Date.parse(b.created_at),
    );
    const runMs = runs.map((r) => Date.parse(r.created_at)).filter(Number.isFinite);
    const missed = detectMissedTicks({
      schedule: def.schedule,
      runMs,
      nowMs: params.nowMs,
      lookbackMs: params.lookbackMs,
      maintenance: params.maintenance,
    });
    const duration = detectDurationCreep(runs.map((r) => r.duration_ms ?? NaN).filter((x) => Number.isFinite(x)));
    // US-2312. `status === "error"` now also covers a 2xx run that reported
    // failed units in its own body (see lib/cron-run-outcome.ts), which is how a
    // payout sweep that transferred nothing stops reading as a healthy tick.
    const failedRuns = runs.filter((r) => r.status === "error").length;
    const idleRuns = runs.filter((r) => r.rows_processed === 0).length;
    // US-2668. A run counts as HARD-failed only when it recorded an HTTP status
    // of its own and that status was >= 400.
    const hardFailedRuns = runs.filter(
      (r) => typeof r.http_status === "number" && r.http_status >= 400,
    ).length;
    const rate = (n: number) => (runs.length === 0 ? null : Number((n / runs.length).toFixed(4)));
    // Stalled outranks failing: a job that is not running at all is the more
    // urgent fact, and reporting it twice would split one incident in two.
    const verdict: JobScorecard["verdict"] = missed.missed > 0
      ? "stalled"
      : failedRuns > 0
      ? "failing"
      : duration.creeping
      ? "slow"
      : "healthy";
    scorecards.push({
      name: def.name,
      label: def.label,
      schedule: def.schedule,
      category: def.category,
      verdict,
      missed: missed.missed,
      consecutive_missed: missed.consecutive_missed,
      suppressed: missed.suppressed,
      last_run_ms: missed.last_run_ms,
      duration,
      runs: runs.length,
      failed_runs: failedRuns,
      idle_runs: idleRuns,
      all_idle: runs.length > 0 && idleRuns === runs.length,
      hard_failed_runs: hardFailedRuns,
      failure_rate: rate(failedRuns),
      hard_failure_rate: rate(hardFailedRuns),
      always_failing: runs.length > 0 && hardFailedRuns === runs.length,
    });
  }

  const stalled = scorecards.filter((s) => s.verdict === "stalled").sort((a, b) => b.consecutive_missed - a.consecutive_missed);
  const failing = scorecards.filter((s) => s.verdict === "failing").sort((a, b) => b.failed_runs - a.failed_runs);
  // US-2668: sorted by how many runs back the evidence goes, so the job with the
  // longest unbroken run of failures is named first.
  const alwaysFailing = failing.filter((s) => s.always_failing).sort((a, b) => b.runs - a.runs);
  const slow = scorecards.filter((s) => s.verdict === "slow").sort((a, b) => (b.duration.creep_pct ?? 0) - (a.duration.creep_pct ?? 0));
  const allClear = stalled.length === 0 && failing.length === 0 && slow.length === 0;

  // US-2616: what this report CANNOT see, stated in the report.
  //
  // The loop above skips every `recorded: false` and `oneOff` entry, because
  // neither has a cadence in the ledger to check. That is correct and it is not
  // the same as "nothing to worry about": six of the seventy-eight registry
  // entries are recorded:false, and they include `ebay-token-refresh` (hourly)
  // and `ebay-orders-sync` (every 30 minutes) — jobs whose silent failure
  // expires seller connections and stops orders arriving, which is precisely
  // the blast radius this whole alert exists for (see the header of
  // routes/jobs-cron-fleet.ts).
  //
  // Before this, the summary read "70 recorded jobs, all ticking on schedule".
  // The word "recorded" was carrying the entire caveat, and no reader was going
  // to unpack it into "and eight others were never examined". A monitor that
  // reports all-clear on a subset without naming the subset is the shape of
  // guard this repo has been bitten by repeatedly.
  const unmonitored = params.registry
    .filter((d) => !d.recorded || d.oneOff)
    .map((d) => d.name)
    .sort();

  const coverage = unmonitored.length > 0
    ? ` ${unmonitored.length} not monitored: ${unmonitored.join(", ")}.`
    : "";
  // US-2668: the summary states the RATE for anything failing on every run.
  // "content-refresh failed 7 of 7 runs" cannot be misread as "7 failures over
  // the week, roughly one a day", which is how four deterministic bugs were read
  // as a container restart pattern for nine days.
  const alwaysClause = alwaysFailing.length > 0
    ? ` ${alwaysFailing.length} failing on EVERY run: ` +
      alwaysFailing.slice(0, 5).map((s) => `${s.name} (${s.hard_failed_runs}/${s.runs})`).join(", ") +
      (alwaysFailing.length > 5 ? `, +${alwaysFailing.length - 5} more` : "") + "."
    : "";

  const summary = (allClear
    ? `Cron fleet healthy: ${scorecards.length} recorded jobs, all ticking on schedule.`
    : `${stalled.length} stalled, ${failing.length} failing, ${slow.length} slow of ${scorecards.length} recorded jobs.`) +
    alwaysClause +
    coverage;

  return {
    summary,
    jobs_total: scorecards.length,
    stalled,
    failing,
    always_failing: alwaysFailing,
    slow,
    scorecards,
    all_clear: allClear,
    unmonitored,
  };
}

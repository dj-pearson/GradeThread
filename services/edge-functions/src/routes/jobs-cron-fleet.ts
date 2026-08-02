// US-2004: turn cron-fleet stall detection into an ALERT.
//
// The detection logic (lib/cron-fleet-governance.ts) has existed and been
// unit-tested since US-1611, but its only consumer was the agent read-tool
// `get_cron_fleet_health` — something a human has to think to invoke. So a cron
// that silently stopped firing (a Coolify task never added, a typo'd secret, a
// container missing curl — see vault/10-ops/launch-checklist.md:116-120) stayed invisible.
//
// That blast radius is money and compliance, not cosmetics:
//   • consignor-payouts / affiliate-payouts → sellers silently unpaid
//   • stuck-submissions → users charged for grades that never complete; note the
//     recursion, since that cron IS the auto-refund remediation the incident
//     runbook points at
//   • data-retention → the GDPR storage-limitation control
//
// This job runs hourly and emits a CRITICAL ops event when any recorded job has
// missed its schedule, so the existing fan-out (webhook + notification centre)
// carries it to a human.
//
// It deliberately reuses prodToolIO() rather than re-querying: the alert and the
// agent's read-tool then share ONE data path and cannot drift into disagreeing
// about whether the fleet is healthy.

import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { requireJobSecret } from "../lib/job-auth.ts";
import { acquireJobLock } from "../lib/job-lock.ts";
import { captureException, recordMetric } from "../lib/observability.ts";
import { emitOpsEvent } from "../lib/ops-events.ts";
import { CRON_REGISTRY } from "../lib/cron-runs.ts";
import { prodToolIO } from "../lib/agent-tools.ts";
import {
  assembleCronFleetReport,
  type JobRun,
} from "../lib/cron-fleet-governance.ts";

const OPS_EVENT_TYPE = "cron.fleet_stalled";
/**
 * US-2312: a job that TICKS but errors is a different incident from one that
 * stopped ticking, and it needs its own suppression memory — folding it into
 * cron.fleet_stalled would let one stalled job silence every failing job for six
 * hours. Warning, not critical: the schedule is intact and the remediation is
 * usually a fix rather than a page.
 */
const FAILING_EVENT_TYPE = "cron.fleet_failing";
/** Analysis window. 24h covers every schedule in the registry except the rarest. */
const LOOKBACK_MS = 24 * 3600_000;
/**
 * Re-alert suppression. A stall persists until someone fixes it, so re-emitting
 * hourly would train the on-call to ignore the channel — the precise way an
 * alert stops being an alert. Mirrors the ai-budget guardrail's "an OPEN breach
 * suppresses re-action" rule.
 */
const SUPPRESS_MS = 6 * 3600_000;

/**
 * Decide whether to alert, given what we already told the operator.
 *
 * Pure + exported so the suppression rule is unit-testable without a DB — the
 * rule is the part most likely to be wrong, and the part whose failure (silent
 * suppression of a NEW stall) is invisible in production.
 */
export function shouldAlert(params: {
  stalledNames: string[];
  lastAlert: { atMs: number; jobs: string[] } | null;
  nowMs: number;
  suppressMs?: number;
}): boolean {
  if (params.stalledNames.length === 0) return false;
  const { lastAlert } = params;
  if (!lastAlert) return true;

  const withinWindow =
    params.nowMs - lastAlert.atMs < (params.suppressMs ?? SUPPRESS_MS);
  if (!withinWindow) return true;

  // Inside the window we still alert if a job stalled that the operator has NOT
  // already been told about. Suppressing on "something is already stalled" would
  // hide every subsequent failure during an incident — exactly when new failures
  // matter most. Only a subset of what we already reported stays quiet.
  const known = new Set(lastAlert.jobs);
  return params.stalledNames.some((n) => !known.has(n));
}

/** The most recent alert OF ONE TYPE, for that type's suppression decision. */
async function loadLastAlert(
  sinceIso: string,
  type: string = OPS_EVENT_TYPE,
): Promise<{ atMs: number; jobs: string[] } | null> {
  const { data, error } = await supabaseAdmin
    .from("ops_events")
    .select("created_at, payload")
    .eq("type", type)
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as { created_at: string; payload: Record<string, unknown> | null };
  const jobs = Array.isArray(row.payload?.jobs)
    ? (row.payload!.jobs as unknown[]).filter((j): j is string => typeof j === "string")
    : [];
  const atMs = Date.parse(row.created_at);
  return Number.isFinite(atMs) ? { atMs, jobs } : null;
}

export async function handleCronFleetHealthCron(c: Context): Promise<Response> {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const lock = await acquireJobLock("cron-fleet-health", 300);
  if (!lock.acquired) {
    return c.json({ ok: true, skipped: true, reason: lock.reason });
  }
  try {
    const nowMs = Date.now();
    const sinceIso = new Date(nowMs - LOOKBACK_MS).toISOString();
    const io = prodToolIO();
    const [runs, maintenance] = await Promise.all([
      io.fetchCronRuns(20000),
      io.fetchMaintenanceIntervals(sinceIso),
    ]);

    const runsByJob: Record<string, JobRun[]> = {};
    for (const r of runs) {
      (runsByJob[r.job_name] ??= []).push({
        created_at: r.created_at,
        duration_ms: r.duration_ms,
        // US-2312: the outcome fields the failing/idle verdicts read.
        status: r.status,
        rows_processed: r.rows_processed,
      });
    }

    const report = assembleCronFleetReport({
      registry: CRON_REGISTRY,
      runsByJob,
      maintenance,
      nowMs,
      lookbackMs: LOOKBACK_MS,
    });

    recordMetric("cron_fleet.stalled", report.stalled.length, {});
    recordMetric("cron_fleet.slow", report.slow.length, {});
    // US-2312: ran-but-failed and ran-but-did-nothing, as first-class counts.
    recordMetric("cron_fleet.failing", report.failing.length, {});
    recordMetric(
      "cron_fleet.idle",
      report.scorecards.filter((s) => s.all_idle).length,
      {},
    );

    const stalledNames = report.stalled.map((s) => s.name);
    const lastAlert = await loadLastAlert(
      new Date(nowMs - SUPPRESS_MS * 2).toISOString(),
    );
    const alert = shouldAlert({ stalledNames, lastAlert, nowMs });

    if (alert) {
      const worst = report.stalled[0];
      await emitOpsEvent(OPS_EVENT_TYPE, "critical", {
        title:
          `${report.stalled.length} cron job(s) STALLED: ` +
          `${stalledNames.slice(0, 5).join(", ")}` +
          (stalledNames.length > 5 ? `, +${stalledNames.length - 5} more` : "") +
          (worst ? ` (worst: ${worst.name}, ${worst.consecutive_missed} consecutive misses)` : ""),
        source: "cron-fleet-health",
        data: {
          // `jobs` is read back by loadLastAlert for the suppression decision —
          // keep the key and the shape (string[]) stable.
          jobs: stalledNames,
          stalled_count: report.stalled.length,
          slow_count: report.slow.length,
          jobs_total: report.jobs_total,
          summary: report.summary,
          detail: report.stalled.slice(0, 10).map((s) => ({
            name: s.name,
            schedule: s.schedule,
            missed: s.missed,
            consecutive_missed: s.consecutive_missed,
            last_run_ms: s.last_run_ms,
          })),
        },
      });
    }

    // US-2312: the ran-but-failed signal, with its own suppression memory so a
    // stalled job cannot mute it (and vice versa).
    const failingNames = report.failing.map((s) => s.name);
    const lastFailingAlert = await loadLastAlert(
      new Date(nowMs - SUPPRESS_MS * 2).toISOString(),
      FAILING_EVENT_TYPE,
    );
    const failingAlert = shouldAlert({
      stalledNames: failingNames,
      lastAlert: lastFailingAlert,
      nowMs,
    });
    if (failingAlert) {
      const worst = report.failing[0];
      await emitOpsEvent(FAILING_EVENT_TYPE, "warning", {
        title:
          `${report.failing.length} cron job(s) ran but FAILED work: ` +
          `${failingNames.slice(0, 5).join(", ")}` +
          (failingNames.length > 5 ? `, +${failingNames.length - 5} more` : "") +
          (worst ? ` (worst: ${worst.name}, ${worst.failed_runs} of ${worst.runs} runs)` : ""),
        source: "cron-fleet-health",
        data: {
          // Same key + shape as the stalled event — loadLastAlert reads it back.
          jobs: failingNames,
          failing_count: report.failing.length,
          jobs_total: report.jobs_total,
          detail: report.failing.slice(0, 10).map((s) => ({
            name: s.name,
            runs: s.runs,
            failed_runs: s.failed_runs,
            idle_runs: s.idle_runs,
          })),
        },
      });
    }

    return c.json({
      ok: true,
      summary: report.summary,
      jobs_total: report.jobs_total,
      stalled: stalledNames,
      failing: failingNames,
      // Ticking, not erroring, and processing nothing every single run — usually
      // a disabled feature flag or a drained backlog, occasionally a job whose
      // query silently stopped matching.
      idle: report.scorecards.filter((s) => s.all_idle).map((s) => s.name),
      slow: report.slow.map((s) => s.name),
      all_clear: report.all_clear,
      alerted: alert || failingAlert,
    });
  } catch (err) {
    captureException(err, { route: "jobs.cron-fleet-health" });
    console.error("[cron-fleet-health] run failed:", err);
    return c.json(
      {
        error: "Cron fleet health run failed",
        detail: err instanceof Error ? err.message : String(err),
      },
      500,
    );
  } finally {
    await lock.release();
  }
}

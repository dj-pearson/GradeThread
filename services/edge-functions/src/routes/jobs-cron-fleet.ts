// US-2004: turn cron-fleet stall detection into an ALERT.
//
// The detection logic (lib/cron-fleet-governance.ts) has existed and been
// unit-tested since US-1611, but its only consumer was the agent read-tool
// `get_cron_fleet_health` — something a human has to think to invoke. So a cron
// that silently stopped firing (a Coolify task never added, a typo'd secret, a
// container missing curl — see LAUNCH_CHECKLIST.md:116-120) stayed invisible.
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

/** The most recent stall alert, for the suppression decision. */
async function loadLastAlert(
  sinceIso: string,
): Promise<{ atMs: number; jobs: string[] } | null> {
  const { data, error } = await supabaseAdmin
    .from("ops_events")
    .select("created_at, payload")
    .eq("type", OPS_EVENT_TYPE)
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

    return c.json({
      ok: true,
      summary: report.summary,
      jobs_total: report.jobs_total,
      stalled: stalledNames,
      slow: report.slow.map((s) => s.name),
      all_clear: report.all_clear,
      alerted: alert,
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

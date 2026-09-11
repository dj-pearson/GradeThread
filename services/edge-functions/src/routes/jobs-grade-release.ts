// US-3326: release grades that were held for their paid turnaround.
//
// Two kinds of row come due, and both are keyed on grade_reports.release_at
// (set only while the hold is on; see lib/grade-release.ts):
//
//   1. HELD: a reviewer (or auto-approve) decided, and release_at has passed.
//      releaseHeldGrade runs the normal go-live through finalizeGradeReview,
//      whose finalized_at flip makes it exactly-once.
//   2. PENDING: still waiting for a human when release_at passed. The owner can
//      now see the preliminary grade (the RLS policy is time-based), so send the
//      preliminary notice the pipeline held back, once.
//
// Turning the hold OFF releases every held grade on the next run rather than
// leaving them parked until their original time.
//
// Mounted at POST /api/jobs/grade-release, job-secret gated and job-locked;
// every 5 minutes (CRON_REGISTRY). Recorded to cron_runs by the /api/jobs/*
// middleware.

import type { Context } from "hono";
import { requireJobSecret } from "../lib/job-auth.ts";
import { acquireJobLock } from "../lib/job-lock.ts";
import { supabaseAdmin } from "../lib/supabase.ts";
import { getSetting } from "../lib/system-settings.ts";
import {
  GRADE_RELEASE_HOLD_DEFAULT,
  GRADE_RELEASE_HOLD_SETTING,
  type GradeReleaseHoldSetting,
  holdEnabled,
} from "../lib/grade-release.ts";
import {
  notifyPreliminaryAtRelease,
  releaseHeldGrade,
} from "../lib/grading-pipeline.ts";

// Per run. A backlog drains over consecutive runs; every row read is ordered
// oldest-due first, so nothing starves.
export const GRADE_RELEASE_BATCH = 100;

export async function handleGradeReleaseCron(c: Context): Promise<Response> {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const lock = await acquireJobLock("grade-release", 240);
  if (!lock.acquired) {
    return c.json({ ok: true, skipped: true, reason: lock.reason });
  }

  try {
    return await runGradeRelease(c);
  } finally {
    await lock.release();
  }
}

async function runGradeRelease(c: Context): Promise<Response> {
  const nowIso = new Date().toISOString();
  const enabled = holdEnabled(
    await getSetting<GradeReleaseHoldSetting>(
      GRADE_RELEASE_HOLD_SETTING,
      GRADE_RELEASE_HOLD_DEFAULT,
    ),
  );

  // 1. Held grades whose time has come (or all of them, once the hold is off).
  let heldQuery = supabaseAdmin
    .from("grade_reports")
    .select("id")
    .eq("review_status", "held")
    .is("finalized_at", null)
    .order("release_at", { ascending: true })
    .limit(GRADE_RELEASE_BATCH);
  if (enabled) heldQuery = heldQuery.lte("release_at", nowIso);
  const { data: heldRows, error: heldErr } = await heldQuery;
  if (heldErr) {
    return c.json({ ok: false, error: `held read failed: ${heldErr.message}` }, 500);
  }

  let released = 0;
  const failures: Array<{ id: string; reason: string }> = [];
  for (const row of (heldRows ?? []) as Array<{ id: string }>) {
    const r = await releaseHeldGrade(row.id, { early: !enabled });
    if (r.released) released++;
    else if (r.reason !== "already_final") {
      failures.push({ id: row.id, reason: r.reason ?? "unknown" });
    }
  }

  // 2. Still-in-review grades that just became visible to their owner.
  const { data: pendingRows, error: pendingErr } = await supabaseAdmin
    .from("grade_reports")
    .select("id")
    .eq("review_status", "pending")
    .lte("release_at", nowIso)
    .is("release_notified_at", null)
    .order("release_at", { ascending: true })
    .limit(GRADE_RELEASE_BATCH);
  if (pendingErr) {
    return c.json({ ok: false, error: `pending read failed: ${pendingErr.message}` }, 500);
  }
  let noticed = 0;
  for (const row of (pendingRows ?? []) as Array<{ id: string }>) {
    if (await notifyPreliminaryAtRelease(row.id)) noticed++;
  }

  return c.json({
    ok: failures.length === 0,
    hold_enabled: enabled,
    released,
    preliminary_notices: noticed,
    failures,
  });
}

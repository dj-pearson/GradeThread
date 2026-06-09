// eBay sync concurrency guard + stuck-run reaper (US-456).
//
// flipdesk_sync_runs holds one row per pull. A partial unique index
// (migration 00116) allows at most ONE 'running' row per (user, marketplace),
// so claimSyncRun() is a race-free lock: the insert that wins owns the sync;
// a concurrent pull gets a unique violation → "already running". A run is
// finalized to success/partial by recordSyncRun, to failed by failSyncRun (on
// an unexpected throw), and a run left 'running' past the threshold (crashed
// container / killed mid-pull) is reaped to 'failed' so the UI unblocks.

import type { Context } from "hono";
import { supabaseAdmin } from "./supabase.ts";
import { requireJobSecret } from "./job-auth.ts";

// A pull normally takes 60–120s. A run still 'running' well past that is dead.
// Configurable; defaults to 15 minutes.
export function stuckThresholdMs(): number {
  const min = Number(Deno.env.get("SYNC_STUCK_THRESHOLD_MIN"));
  return (Number.isFinite(min) && min > 0 ? min : 15) * 60_000;
}

/** Pure: is a run that started at `startedAtIso` stuck as of `now`? */
export function isStuckRun(
  startedAtIso: string | null,
  now: Date,
  thresholdMs: number,
): boolean {
  if (!startedAtIso) return true; // unknown start → treat as stuck (reapable)
  const t = new Date(startedAtIso).getTime();
  if (!Number.isFinite(t)) return true;
  return now.getTime() - t >= thresholdMs;
}

export type ClaimResult =
  | { status: "claimed"; runId: string }
  | { status: "already_running" }
  | { status: "error" };

// Flip this user's stale 'running' rows to 'failed' so a dead run can't block a
// fresh pull forever. Best-effort.
async function reapStaleForUser(
  userId: string,
  marketplace: string,
  now: Date,
): Promise<void> {
  const cutoff = new Date(now.getTime() - stuckThresholdMs()).toISOString();
  try {
    await supabaseAdmin
      .from("flipdesk_sync_runs")
      .update({ status: "failed", finished_at: now.toISOString() })
      .eq("user_id", userId)
      .eq("marketplace", marketplace)
      .eq("status", "running")
      .lt("started_at", cutoff);
  } catch (err) {
    console.error("[sync-lock] reapStaleForUser failed:", err);
  }
}

/**
 * Claim the in-flight sync lock for a tenant by inserting a 'running' row. The
 * partial unique index makes this atomic: a second concurrent pull gets a
 * unique violation (23505) → 'already_running'. A non-conflict DB error returns
 * 'error' so the caller can proceed best-effort (availability over the guard).
 */
export async function claimSyncRun(
  userId: string,
  marketplace = "ebay",
  now: Date = new Date(),
): Promise<ClaimResult> {
  // Clear THIS user's dead runs first so a crash doesn't lock them out.
  await reapStaleForUser(userId, marketplace, now);

  const { data, error } = await supabaseAdmin
    .from("flipdesk_sync_runs")
    .insert({
      user_id: userId,
      marketplace,
      status: "running",
      started_at: now.toISOString(),
    })
    .select("id")
    .single();

  if (error) {
    // 23505 = unique_violation → the partial index already holds a running row.
    if ((error as { code?: string }).code === "23505") {
      return { status: "already_running" };
    }
    console.error("[sync-lock] claimSyncRun insert failed:", error.message);
    return { status: "error" };
  }
  return { status: "claimed", runId: (data as { id: string }).id };
}

/**
 * Release a claimed run as 'failed' after an unexpected throw. Conditional on
 * status='running' so it's idempotent and never clobbers a run already
 * finalized (success/partial) by recordSyncRun.
 */
export async function failSyncRun(
  runId: string,
  errorMessage: string,
): Promise<void> {
  try {
    await supabaseAdmin
      .from("flipdesk_sync_runs")
      .update({
        status: "failed",
        error_count: 1,
        errors: [errorMessage.slice(0, 200)],
        finished_at: new Date().toISOString(),
      })
      .eq("id", runId)
      .eq("status", "running");
  } catch (err) {
    console.error("[sync-lock] failSyncRun failed:", err);
  }
}

/** Reap ALL tenants' stale 'running' runs → 'failed'. Returns the count. */
export async function reapStuckSyncRuns(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - stuckThresholdMs()).toISOString();
  try {
    const { data, error } = await supabaseAdmin
      .from("flipdesk_sync_runs")
      .update({
        status: "failed",
        error_count: 1,
        errors: ["reaped: run stuck in 'running' past the stuck threshold"],
        finished_at: now.toISOString(),
      })
      .eq("status", "running")
      .lt("started_at", cutoff)
      .select("id");
    if (error) {
      console.error("[sync-lock] reapStuckSyncRuns failed:", error.message);
      return 0;
    }
    return (data ?? []).length;
  } catch (err) {
    console.error("[sync-lock] reapStuckSyncRuns threw:", err);
    return 0;
  }
}

// Cron entrypoint (mounted at POST /api/jobs/sync-reaper, gated by
// X-Internal-Job-Secret like the other sweeps) so the UI unblocks even when no
// new pull is attempted.
export async function handleSyncReaperCron(c: Context): Promise<Response> {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const reaped = await reapStuckSyncRuns();
  return c.json({ ok: true, reaped });
}

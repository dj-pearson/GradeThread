// US-2972: the nightly pipeline-XP sweep.
//
// The on-demand sweep on the Rewards and FlipDesk pipeline screens is what makes
// working feel like it counts, but it only ever runs for someone who opened the
// app. This cron is the floor, and it is what delivers the one-time BACKFILL to
// a seller who has not visited the rewards screen at all — which, given the
// whole reason this feature exists, is most of them.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE QUEUE IS last_pipeline_sweep_at, OLDEST FIRST.
//
// The obvious implementation walks every distinct inventory_items owner and
// keeps a cursor. That reads the item table on every run and needs somewhere to
// persist the cursor, which is a second piece of state to get wrong.
//
// user_reward_state.last_pipeline_sweep_at is already the right queue: sort it
// ascending with nulls first and the front of the line is exactly "never swept",
// then "swept longest ago". Sweeping stamps the row, which moves that seller to
// the back. It is self-balancing, needs no cursor, and cannot starve anyone —
// coverage is a property of the ordering rather than of a counter surviving.
//
// It only works if every seller HAS a row, which is what migration 00680 seeds
// and what markSweepAttempted's upsert maintains for sellers who arrive later.
// ─────────────────────────────────────────────────────────────────────────────

import type { Context } from "hono";
import { requireJobSecret } from "../lib/job-auth.ts";
import { acquireJobLock } from "../lib/job-lock.ts";
import { supabaseAdmin } from "../lib/supabase.ts";
import { markSweepAttempted, sweepPipelineRewards } from "../lib/rewards-pipeline.ts";
import { logEvent } from "../lib/observability.ts";

/** Users swept per run. One sweep is a few paged reads plus a single recompute. */
const MAX_USERS = 200;

/** Lease in SECONDS (acquireJobLock takes seconds, not milliseconds). */
const LOCK_SECONDS = 15 * 60;

/**
 * The next sellers due a sweep: never swept first, then longest-unswept.
 *
 * Exported so the cadence is assertable without standing up the whole route.
 */
export async function dueForSweep(limit: number): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from("user_reward_state")
    .select("user_id")
    .order("last_pipeline_sweep_at", { ascending: true, nullsFirst: true })
    .limit(limit);
  if (error) throw new Error("sweep-cron: queue read failed: " + error.message);
  return ((data ?? []) as unknown as Array<{ user_id: string }>).map((r) => r.user_id);
}

export async function handleRewardsSweepCron(c: Context): Promise<Response> {
  if (!(await requireJobSecret(c))) return c.json({ error: "Unauthorized" }, 401);

  // One sweep at a time. Two concurrent runs would both be CORRECT — the unique
  // index makes a duplicate grant a no-op — but they would read the same queue
  // head twice and do the work twice for nothing.
  const lock = await acquireJobLock("rewards-pipeline-sweep", LOCK_SECONDS);
  if (!lock.acquired) return c.json({ ok: true, skipped: lock.reason ?? "locked" });

  try {
    const userIds = await dueForSweep(MAX_USERS);

    let swept = 0;
    let marksGranted = 0;
    let xpAdded = 0;
    let leveledUp = 0;
    let failed = 0;

    for (const userId of userIds) {
      try {
        const summary = await sweepPipelineRewards(userId);
        swept++;
        marksGranted += summary.marksGranted;
        xpAdded += summary.xpAdded;
        if (summary.levelAfter > summary.levelBefore) leveledUp++;
      } catch (err) {
        // One seller's bad row must not stop the walk. Counted and logged so a
        // systematic failure shows up as a number rather than as silence.
        failed++;
        logEvent("error", "reward.pipeline_sweep_user_failed", {
          message: err instanceof Error ? err.message : String(err),
        });
        // Stamp anyway. Without this a permanently broken account sits at the
        // head of the queue forever and starves every seller behind it.
        await markSweepAttempted(userId);
      }
    }

    return c.json({ ok: true, queued: userIds.length, swept, marksGranted, xpAdded, leveledUp, failed });
  } catch (err) {
    console.error(
      "[rewards-sweep] cron failed:",
      err instanceof Error ? err.message : String(err),
    );
    return c.json({ error: "Sweep failed" }, 500);
  } finally {
    await lock.release();
  }
}

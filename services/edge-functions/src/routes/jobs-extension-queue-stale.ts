// US-3198 AC4: tell a seller their extension queue is still waiting.
//
// The queue tray (AC1/AC2) answers "what is pending, and when did my desktop
// last take any of it" for a seller who is looking at the dashboard. This is for
// the seller who is not. It fires once when a queue that has been drained before
// has gone a day without a drain and holds more than one garment's worth of
// work, and it never fires twice about the same spell of silence.
//
// EVERY JUDGEMENT IS IN lib/extension-queue-stale.ts, not here: the threshold,
// the window, the repeat suppression and the wording. This file does the reads
// and the counting.
//
// TENANCY (US-268). A fleet sweep with no request ids at all: the only user ids
// in play are the ones the seller's OWN queue rows carry, and every follow-up
// read is `.eq("user_id", <that id>)`. Nothing here is addressable from outside,
// and the door is requireJobSecret.

import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { requireJobSecret } from "../lib/job-auth.ts";
import { acquireJobLock } from "../lib/job-lock.ts";
import { deliverPreferencePush } from "../lib/notify.ts";
import {
  DRAIN_SILENCE_HOURS,
  EXTENSION_QUEUE_PREF_KEY,
  shouldNotifyStaleQueue,
  STALE_QUEUE_THRESHOLD,
  staleQueueNotice,
  type StaleQueueSkipReason,
} from "../lib/extension-queue-stale.ts";

/**
 * Ceiling on the live-queue scan.
 *
 * Every row above this is another seller's pending work going unread, so the
 * number is reported in the response rather than silently clipped: a run that
 * hits the cap is a signal to shard this job, not a normal day. At present the
 * whole table is a few hundred rows.
 */
const SCAN_LIMIT = 5000;

const HOUR_MS = 3_600_000;

interface QueueOwnerRow {
  user_id: string;
}

/** When this seller's extension last TOOK a row. See the same read in
 *  routes/flipdesk-extension-queue.ts for why it is claimed_at and not
 *  completed_at. Null means no extension has ever run for them. */
async function lastDrainedAt(userId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from("extension_work_queue")
    .select("claimed_at")
    .eq("user_id", userId) // US-268
    .not("claimed_at", "is", null)
    .order("claimed_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return null;
  return (data as { claimed_at: string | null } | null)?.claimed_at ?? null;
}

export async function handleExtensionQueueStaleCron(c: Context): Promise<Response> {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const lock = await acquireJobLock("extension-queue-stale", 600);
  if (!lock.acquired) {
    return c.json({ ok: true, skipped: true, reason: lock.reason });
  }

  try {
    const now = new Date();
    const nowIso = now.toISOString();

    // Live work only. An expired row is not waiting for anything, and the seller is
    // shown those separately precisely so they are never counted as pending.
    const { data: queueData, error: queueError } = await supabaseAdmin
      .from("extension_work_queue")
      .select("user_id")
      .in("status", ["queued", "claimed"])
      .gt("expires_at", nowIso)
      .limit(SCAN_LIMIT);
    if (queueError) {
      console.error("[extension-queue-stale] queue scan failed:", queueError.message);
      return c.json({ ok: false, error: "queue scan failed" }, 500);
    }
    const rows = (queueData ?? []) as QueueOwnerRow[];

    const pendingByUser = new Map<string, number>();
    for (const row of rows) {
      pendingByUser.set(row.user_id, (pendingByUser.get(row.user_id) ?? 0) + 1);
    }

    // Only sellers already over the bar need the two extra reads. Everyone else
    // is decided by a count we already have.
    const candidates = [...pendingByUser.entries()]
      .filter(([, count]) => count >= STALE_QUEUE_THRESHOLD)
      .map(([userId, count]) => ({ userId, count }));

    const skipped: Record<StaleQueueSkipReason, number> = {
      never_drained: 0,
      below_threshold: pendingByUser.size - candidates.length,
      drained_recently: 0,
      already_told: 0,
      told_by_delist_notice: 0,
    };

    // US-3144 collision, read once for the whole batch rather than per seller.
    // A delist_needed notice inside the silence window already told this seller
    // there is browser-only work outstanding, and it named the garment.
    const recentDelist = new Set<string>();
    if (candidates.length > 0) {
      const since = new Date(now.getTime() - DRAIN_SILENCE_HOURS * HOUR_MS).toISOString();
      const { data: noticeData } = await supabaseAdmin
        .from("notifications")
        .select("user_id")
        .eq("type", "delist_needed")
        .gte("created_at", since)
        .in("user_id", candidates.map((cand) => cand.userId)); // US-268
      for (const row of (noticeData ?? []) as QueueOwnerRow[]) {
        recentDelist.add(row.user_id);
      }
    }

    let notified = 0;
    let suppressed = 0;
    for (const cand of candidates) {
      const verdict = shouldNotifyStaleQueue({
        pendingCount: cand.count,
        lastDrainedAt: await lastDrainedAt(cand.userId),
        recentDelistNotice: recentDelist.has(cand.userId),
        now,
      });
      if (!verdict.notify) {
        skipped[verdict.reason] += 1;
        continue;
      }
      const sent = await deliverPreferencePush(
        cand.userId,
        EXTENSION_QUEUE_PREF_KEY,
        staleQueueNotice(verdict.pendingCount),
      );
      // A seller who turned the category off, or who is inside their quiet
      // window, is a normal outcome and not a failure. Counted apart so an
      // operator can tell "nobody qualified" from "everybody opted out".
      if (sent) notified += 1;
      else suppressed += 1;
    }

    return c.json({
      ok: true,
      // `scanned` is read by the cron ledger as rows_processed (US-2312).
      scanned: pendingByUser.size,
      queueRows: rows.length,
      capped: rows.length >= SCAN_LIMIT,
      threshold: STALE_QUEUE_THRESHOLD,
      candidates: candidates.length,
      notified,
      suppressed,
      skipped,
    });
  } catch (err) {
    console.error(
      "[extension-queue-stale] run threw:",
      err instanceof Error ? err.message : String(err),
    );
    return c.json({ ok: false, error: "run failed" }, 500);
  } finally {
    await lock.release();
  }
}

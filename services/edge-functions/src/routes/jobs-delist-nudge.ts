// US-3453: tell a seller a delist has waited with no browser draining it.
//
// The sale-time notice (US-3144) says "still live, end it". This is the
// second sentence, half an hour later, for the seller whose laptop is shut:
// the listings still up, named, and the two ways out. EVERY JUDGEMENT IS IN
// lib/delist-nudge.ts; this file does the reads and the sends.
//
// TENANCY (US-268). A fleet sweep with no request ids at all: the only user
// ids in play are the ones the queue rows carry, the rows are grouped by that
// id before any verdict, and every follow-up read is `.eq("user_id", <that
// id>)`. The door is requireJobSecret.

import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { requireJobSecret } from "../lib/job-auth.ts";
import { acquireJobLock } from "../lib/job-lock.ts";
import { notifyUser } from "../lib/notify.ts";
import { pushDelistNeeded } from "../lib/transactional-push.ts";
import {
  groupByOwner,
  NUDGE_AFTER_MINUTES,
  nudgeChannels,
  type NudgePrefs,
  NUDGE_REPEAT_HOURS,
  nudgeNotice,
  type NudgeListing,
  type NudgeQueueRow,
  type NudgeSkipReason,
  shouldNudge,
} from "../lib/delist-nudge.ts";

/** Ceiling on the queued-delist scan; reported, never silently clipped. */
const SCAN_LIMIT = 5000;

/** When this seller's extension last TOOK a row. Same read as the queue tray. */
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

/** The newest delist notice already sent to this seller, of either sentence. */
async function lastNoticeAt(userId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from("notifications")
    .select("created_at")
    .eq("user_id", userId) // US-268
    .eq("type", "delist_needed")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return null;
  return (data as { created_at: string | null } | null)?.created_at ?? null;
}

/** The seller's channel switches for the category. A failed read is "default on". */
async function prefsFor(userId: string): Promise<NudgePrefs> {
  const { data } = await supabaseAdmin
    .from("users")
    .select("notification_preferences")
    .eq("id", userId) // US-268
    .maybeSingle();
  return (data as { notification_preferences?: NudgePrefs } | null)?.notification_preferences ?? null;
}

/** What each waiting row is, in the seller's words: marketplace, garment, page. */
async function describeRows(userId: string, rows: readonly NudgeQueueRow[]): Promise<NudgeListing[]> {
  const itemIds = [...new Set(rows.map((r) => r.inventory_item_id).filter((id): id is string => !!id))];
  const titles = new Map<string, string | null>();
  if (itemIds.length > 0) {
    const { data } = await supabaseAdmin
      .from("inventory_items")
      .select("id, title")
      .eq("user_id", userId) // US-268
      .in("id", itemIds);
    for (const it of (data ?? []) as { id: string; title: string | null }[]) titles.set(it.id, it.title);
  }
  const listingIds = rows.map((r) => r.listing_id).filter((id): id is string => !!id);
  const urls = new Map<string, string | null>();
  if (listingIds.length > 0) {
    const { data } = await supabaseAdmin
      .from("listings")
      .select("id, listing_url, inventory_items!inner(user_id)")
      .eq("inventory_items.user_id", userId) // US-268
      .in("id", listingIds);
    for (const l of (data ?? []) as { id: string; listing_url: string | null }[]) urls.set(l.id, l.listing_url);
  }
  return rows.map((r) => ({
    platform: r.platform,
    itemId: r.inventory_item_id,
    itemTitle: r.inventory_item_id ? titles.get(r.inventory_item_id) ?? null : null,
    listingUrl: r.listing_id ? urls.get(r.listing_id) ?? null : null,
  }));
}

export async function handleDelistNudgeCron(c: Context): Promise<Response> {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const lock = await acquireJobLock("delist-nudge", 300);
  if (!lock.acquired) {
    return c.json({ ok: true, skipped: true, reason: lock.reason });
  }
  try {
    const now = new Date();
    const { data, error } = await supabaseAdmin
      .from("extension_work_queue")
      .select("id, user_id, platform, inventory_item_id, listing_id, created_at, expires_at")
      .eq("kind", "delist")
      .eq("status", "queued")
      .gt("expires_at", now.toISOString())
      .lte("created_at", new Date(now.getTime() - NUDGE_AFTER_MINUTES * 60_000).toISOString())
      .order("created_at", { ascending: true })
      .limit(SCAN_LIMIT);
    if (error) {
      console.error("[delist-nudge] queue scan failed:", error.message);
      return c.json({ ok: false, error: "queue scan failed" }, 500);
    }
    const rows = (data ?? []) as NudgeQueueRow[];
    const byOwner = groupByOwner(rows);

    const skipped: Record<NudgeSkipReason, number> = {
      nothing_old_enough: 0,
      drained_since: 0,
      told_recently: 0,
    };
    let notified = 0;
    let optedOut = 0;
    for (const [userId, mine] of byOwner) {
      const verdict = shouldNudge({
        rows: mine,
        lastDrainedAt: await lastDrainedAt(userId),
        lastNoticeAt: await lastNoticeAt(userId),
        now,
      });
      if (!verdict.notify) {
        skipped[verdict.reason] += 1;
        continue;
      }
      // A seller who turned delist reminders off gets nothing on any channel.
      // Decided BEFORE the sends, so the phone push (which gates on quiet
      // hours only) cannot slip past a category the seller closed.
      const channels = nudgeChannels(await prefsFor(userId));
      if (!channels.inApp && !channels.push) {
        optedOut += 1;
        continue;
      }
      const listings = await describeRows(userId, verdict.rows);
      const notice = nudgeNotice(listings);
      // notifyUser writes the in-app row (which is also what lastNoticeAt reads
      // next run) and the browser push, gated on delist_reminders and quiet
      // hours. pushDelistNeeded reaches the phone under delist.needed, whose
      // tap lands on the pending-delist row, collapsing on the item.
      await notifyUser(userId, { type: "delist_needed", ...notice });
      if (channels.push) {
        const single = listings.length === 1 ? listings[0]! : null;
        void pushDelistNeeded(userId, {
          itemId: single?.itemId ?? null,
          itemTitle: single?.itemTitle ?? null,
          count: listings.length,
        });
      }
      notified += 1;
    }

    return c.json({
      ok: true,
      // `scanned` is read by the cron ledger as rows_processed (US-2312).
      scanned: byOwner.size,
      queueRows: rows.length,
      capped: rows.length >= SCAN_LIMIT,
      afterMinutes: NUDGE_AFTER_MINUTES,
      repeatHours: NUDGE_REPEAT_HOURS,
      notified,
      optedOut,
      skipped,
    });
  } catch (err) {
    console.error("[delist-nudge] run threw:", err instanceof Error ? err.message : String(err));
    return c.json({ ok: false, error: "run failed" }, 500);
  } finally {
    await lock.release();
  }
}

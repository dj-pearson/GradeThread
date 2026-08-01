// US-1832: demand-board match notifications.
//
// Re-runs matching for ACTIVE wants and notifies BOTH sides on newly-recorded
// matches (US-1829 "notified when matching graded inventory appears"):
//   • the buyer via notifyBuyer (condition_alert cadence caps + dedupe),
//   • the graded item's SELLER via notifyUser ("a buyer wants what you graded").
// computeWantMatches diffs against already-recorded matches, so only genuinely
// NEW matches notify — a slow trickle alerts once, never every run. Simple
// single-scan cron (job-secret + lock; auto-recorded by /api/jobs/* middleware).

import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { requireJobSecret } from "../lib/job-auth.ts";
import { acquireJobLock } from "../lib/job-lock.ts";
import { computeWantMatches } from "../lib/demand-board-db.ts";
import { notifyBuyer } from "../lib/buyer-notify.ts";
import { notifyUser } from "../lib/notify.ts";

const MAX_WANTS = 1000;

interface ActiveWant {
  id: string;
  user_id: string;
  brands: string[];
  categories: string[];
  keywords: string[];
  min_grade: number | null;
  max_price_cents: number | null;
}

export async function handleDemandMatchesCron(c: Context): Promise<Response> {
  if (!(await requireJobSecret(c))) return c.json({ error: "Unauthorized" }, 401);
  const lock = await acquireJobLock("demand-matches", 300);
  if (!lock.acquired) return c.json({ ok: true, skipped: true, reason: lock.reason });

  try {
    const { data: wants } = await supabaseAdmin
      .from("buyer_wants")
      .select("id, user_id, brands, categories, keywords, min_grade, max_price_cents")
      .eq("status", "active")
      .limit(MAX_WANTS);

    let buyersNotified = 0;
    let sellersNotified = 0;
    let totalNew = 0;

    for (const raw of wants ?? []) {
      const want = raw as ActiveWant;
      const { newMatches } = await computeWantMatches(want);
      if (newMatches.length === 0) continue;
      totalNew += newMatches.length;

      // Buyer: one aggregate notification per want per new batch.
      const first = newMatches[0]!.certificateId;
      const delivered = await notifyBuyer(want.user_id, {
        category: "condition_alert",
        title: "New matches for your want",
        body: `${newMatches.length} graded item${newMatches.length === 1 ? "" : "s"} just matched something you're hunting.`,
        link: "/buyer/demand",
        dedupeKey: `want-match:${want.id}:${first}`,
      }).catch(() => false);
      if (delivered) buyersNotified++;

      // Sellers: one per distinct seller whose graded item newly matched.
      const sellers = new Set(newMatches.map((m) => m.sellerUserId).filter((s): s is string => !!s));
      for (const sellerId of sellers) {
        try {
          await notifyUser(sellerId, {
            type: "system",
            title: "A buyer wants what you graded",
            message: "One of your graded items matches an active buyer request on the demand board.",
            // US-2161: Buyer Demand is a Sourcing tab now.
            link: "/dashboard/flipdesk/sourcing?tab=demand",
          });
          sellersNotified++;
        } catch { /* best-effort per seller */ }
      }
    }

    return c.json({ ok: true, wantsScanned: (wants ?? []).length, newMatches: totalNew, buyersNotified, sellersNotified });
  } catch (err) {
    console.error("[demand-matches] cron failed:", err instanceof Error ? err.message : String(err));
    return c.json({ error: "Demand-matches job failed." }, 500);
  }
}

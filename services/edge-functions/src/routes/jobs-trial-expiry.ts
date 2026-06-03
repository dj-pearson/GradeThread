// US-383: daily trial-expiry downgrade job.
//
// handle_new_user grants every signup a 14-day Pro trial (flipdesk_plan='pro',
// subscription_status='trialing', trial_ends_at +14d) but never creates a
// Stripe subscription. The promised daily cron that downgrades a lapsed trial
// to Free never existed — so a signup that never added a card kept Pro caps
// forever. This job flips those rows back to free/none.
//
// Defense-in-depth: effectivePlanFor()/requireFlipdesk already treat an expired
// trial as Free in real time (so caps are correct even before this runs); this
// job makes the stored state truthful and stops the user lingering as
// 'trialing' indefinitely.
//
// Mounted in main.ts as POST /api/jobs/trial-expiry, OUTSIDE /api/* JWT groups,
// gated by X-Internal-Job-Secret (same pattern as the reprice/GSC crons).

import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { requireJobSecret } from "../lib/job-auth.ts";

const BATCH_LIMIT = 1000;

export async function handleTrialExpiryCron(c: Context): Promise<Response> {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const nowIso = new Date().toISOString();

  // Target: still 'trialing', trial window elapsed, and NO Stripe subscription
  // (never converted). A user who upgraded during the trial has
  // subscription_status='active' and is excluded; a paused/canceled sub is also
  // not 'trialing' so it's untouched here.
  const { data, error } = await supabaseAdmin
    .from("users")
    .update({
      flipdesk_plan: "free",
      subscription_status: "none",
      updated_at: nowIso,
    })
    .eq("subscription_status", "trialing")
    .lt("trial_ends_at", nowIso)
    .is("flipdesk_subscription_id", null)
    .select("id")
    .limit(BATCH_LIMIT);

  if (error) {
    console.error("[trial-expiry] downgrade failed:", error.message);
    return c.json({ error: "Trial-expiry downgrade failed" }, 500);
  }

  const downgraded = data?.length ?? 0;
  if (downgraded > 0) {
    console.log(`[trial-expiry] downgraded ${downgraded} expired trial(s) to Free`);
  }
  return c.json({ ok: true, downgraded });
}

// US-629: referral qualification hook.
//
// When a referred user performs their first PAID action, their referral flips
// from `pending` → `qualified`, which surfaces it in the admin reward queue for
// a grant. Idempotent (only matches the still-pending row) and best-effort —
// never throws, so it can't break the payment flow it's wired into.

import { supabaseAdmin } from "./supabase.ts";

export async function maybeQualifyReferral(userId: string): Promise<void> {
  try {
    const { error } = await supabaseAdmin
      .from("referral_events")
      .update({ reward_status: "qualified", qualified_at: new Date().toISOString() })
      .eq("referred_user_id", userId)
      .eq("reward_status", "pending");
    if (error) {
      console.error("[referrals] qualify hook failed:", error.message);
    }
  } catch (err) {
    console.error("[referrals] qualify hook threw:", err instanceof Error ? err.message : err);
  }
}

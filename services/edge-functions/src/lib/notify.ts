import { supabaseAdmin } from "./supabase.ts";

// In-app notification types. Mirrors the public.notification_type enum
// (migrations 00007 + 00114) and the frontend NotificationType union.
export type NotificationType =
  | "grade_complete"
  | "grading_submitted"
  | "grading_ready"
  // Mandatory-review lifecycle. grading_preliminary = AI grade produced but
  // unofficial, awaiting human finalization; grading_finalized = a reviewer
  // approved/adjusted it, so it's now official + the certificate is live.
  | "grading_preliminary"
  | "grading_finalized"
  // US-1056: grading-lifecycle failure paths (not just the grade_complete happy
  // path). grading_failed = the run threw / a required angle failed; the charge
  // was reversed. grading_incomplete = the pre-grade quality gate abstained
  // (needs_photos) so no grade was produced.
  | "grading_failed"
  | "grading_incomplete"
  | "dispute_update"
  | "billing"
  | "system"
  | "item_status_change"
  | "listing_live"
  | "sale_recorded"
  // US-1056: a listing's available quantity crossed down into low-stock /
  // stockout territory.
  | "low_stock"
  | "payout_imported"
  | "offer_received"
  | "return_requested"
  // US-1055: offer responses + return/dispute openings across all channels.
  // offer_responded = a buyer offer was accepted/declined/countered;
  // return_opened = a buyer opened a return (Post-Order);
  // dispute_opened = a payment dispute/chargeback was opened (deadline-bearing).
  | "offer_responded"
  | "return_opened"
  | "dispute_opened"
  // US-1803: buyer-side categories — the delivery layer for the buyer feature
  // epics (alerts / rewards / guarantee / portfolio).
  | "buyer_condition_alert"
  | "buyer_reward"
  | "buyer_guarantee"
  | "buyer_portfolio";

// Which notification_preferences category gates each type's in-app delivery.
// `null` types are always delivered (e.g. system messages the user can't mute).
// US-1058 split payouts/offers/returns into their own opt-out categories — the
// frontend NOTIFICATION_EVENT_CATALOG mirrors this so the admin catalog reflects
// the real gate end-to-end. Exported so the admin catalog endpoint reuses it.
export const PREF_KEY: Record<NotificationType, string | null> = {
  grade_complete: "grade_complete",
  grading_submitted: "grade_complete",
  grading_ready: "grade_complete",
  // Review-lifecycle seller notices share the grading pref category.
  grading_preliminary: "grade_complete",
  grading_finalized: "grade_complete",
  // US-1056: grading-lifecycle failure paths share the grading pref category.
  grading_failed: "grade_complete",
  grading_incomplete: "grade_complete",
  dispute_update: "dispute_updates",
  billing: "billing_alerts",
  system: null,
  item_status_change: "selling_activity",
  listing_live: "selling_activity",
  sale_recorded: "selling_activity",
  // US-1056: low-stock alerts are selling-activity for the seller.
  low_stock: "selling_activity",
  payout_imported: "payouts",
  offer_received: "offers",
  return_requested: "returns",
  // US-1055: offer responses share the offers gate; return/dispute openings
  // share the returns gate (its label/description now covers disputes too).
  offer_responded: "offers",
  return_opened: "returns",
  dispute_opened: "returns",
  // US-1803: each buyer category gates on its own notification_preferences key
  // (code-defaulted ON in the frontend DEFAULT_NOTIFICATION_PREFERENCES).
  buyer_condition_alert: "buyer_alerts",
  buyer_reward: "buyer_rewards",
  buyer_guarantee: "buyer_guarantee",
  buyer_portfolio: "buyer_portfolio",
};

export interface NotifyInput {
  type: NotificationType;
  title: string;
  message: string;
  /** In-app deep link (path within the dashboard), e.g. /dashboard/flipdesk/items/:id */
  link?: string | null;
}

// Insert a single in-app notification for `userId`, honoring that user's
// in-app channel preference. Tenant-safe: the caller passes the already
// ownership-resolved userId (workspace owner for shared tenants).
//
// Fire-and-forget friendly — never throws; logs and swallows failures so a
// notification problem can't break the lifecycle action that triggered it.
export async function notifyUser(
  userId: string,
  input: NotifyInput,
): Promise<void> {
  try {
    const prefKey = PREF_KEY[input.type];
    if (prefKey) {
      const { data: user } = await supabaseAdmin
        .from("users")
        .select("notification_preferences")
        .eq("id", userId)
        .maybeSingle();
      const prefs = (
        user as
          | { notification_preferences?: Record<string, { in_app?: boolean }> }
          | null
      )?.notification_preferences;
      // Default on — only suppress when explicitly disabled.
      if (prefs?.[prefKey]?.in_app === false) return;
    }

    const { error } = await supabaseAdmin.from("notifications").insert({
      user_id: userId,
      type: input.type,
      title: input.title,
      message: input.message,
      link: input.link ?? null,
    });
    if (error) {
      console.error(
        `[notify] insert failed for ${userId} (${input.type}): ${error.message}`,
      );
    }
  } catch (err) {
    console.error(
      `[notify] unexpected error for ${userId} (${input.type}):`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

import { supabaseAdmin } from "./supabase.ts";

// In-app notification types. Mirrors the public.notification_type enum
// (migrations 00007 + 00114) and the frontend NotificationType union.
export type NotificationType =
  | "grade_complete"
  | "grading_submitted"
  | "grading_ready"
  | "dispute_update"
  | "billing"
  | "system"
  | "item_status_change"
  | "listing_live"
  | "sale_recorded"
  | "payout_imported"
  | "offer_received"
  | "return_requested";

// Which notification_preferences category gates each type's in-app delivery.
// `null` types are always delivered (e.g. system messages the user can't mute).
// US-1058 split payouts/offers/returns into their own opt-out categories — the
// frontend NOTIFICATION_EVENT_CATALOG mirrors this so the admin catalog reflects
// the real gate end-to-end. Exported so the admin catalog endpoint reuses it.
export const PREF_KEY: Record<NotificationType, string | null> = {
  grade_complete: "grade_complete",
  grading_submitted: "grade_complete",
  grading_ready: "grade_complete",
  dispute_update: "dispute_updates",
  billing: "billing_alerts",
  system: null,
  item_status_change: "selling_activity",
  listing_live: "selling_activity",
  sale_recorded: "selling_activity",
  payout_imported: "payouts",
  offer_received: "offers",
  return_requested: "returns",
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

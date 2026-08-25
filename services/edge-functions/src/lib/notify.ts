import { supabaseAdmin } from "./supabase.ts";
import { getVapidConfig, sendWebPush } from "./web-push.ts";
import { parseQuietHours, quietHoursActive } from "./quiet-hours.ts";

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
  // US-2560: a buyer asked to cancel an order (Post-Order). It sits beside
  // return_opened rather than inside it because the seller's decision is a
  // different one — approve and the sale is gone before it ships, reject and
  // you are on record refusing — and eBay runs its own clock on it.
  | "cancellation_requested"
  // US-1803: buyer-side categories — the delivery layer for the buyer feature
  // epics (alerts / rewards / guarantee / portfolio).
  | "buyer_condition_alert"
  | "buyer_reward"
  | "buyer_guarantee"
  | "buyer_portfolio"
  // US-1859: re-engagement nudges (streak-at-risk, near-miss, quests, expiring
  // rewards). Its own category because it is the only notification that fires
  // because the user did NOTHING — see lib/rewards-nudges.ts.
  | "reward_nudge"
  // US-1912: the seller's Grade Integrity tier moved. This is the PRIVATE half
  // of a deliberately asymmetric pair — a promotion is announced publicly via
  // the reputation ledger, a demotion is only ever told to the seller, here.
  | "integrity_tier_change";

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
  // US-2560: the `returns` gate, not a new one — but its SETTINGS COPY had to
  // change to earn that, and did (src/lib/notification-preferences.ts). The
  // sentence used to read "when a buyer opens a return, a return changes status,
  // or a payment dispute is opened", which does not cover a cancellation. Adding
  // a type under a category whose description does not describe it makes a
  // sentence the user already agreed to retroactively false — the same test
  // reward_nudge and integrity_tier_change failed, and they got their own
  // categories. This one passes because a cancellation genuinely is the same
  // family of post-order case, so the honest fix is to widen the sentence rather
  // than add a fifth switch to the same screen.
  cancellation_requested: "returns",
  // US-1803: each buyer category gates on its own notification_preferences key
  // (code-defaulted ON in the frontend DEFAULT_NOTIFICATION_PREFERENCES).
  buyer_condition_alert: "buyer_alerts",
  buyer_reward: "buyer_rewards",
  buyer_guarantee: "buyer_guarantee",
  buyer_portfolio: "buyer_portfolio",
  // US-1859: a DEDICATED category, never a reuse. Every other key's settings
  // copy describes an account event; "we noticed you were quiet" is not one, and
  // folding it under an existing toggle would make a sentence somebody already
  // agreed to retroactively false.
  reward_nudge: "reward_nudges",
  // US-1912: same reasoning as reward_nudges — its own category, not a reuse.
  // No existing toggle's copy covers "your standing with buyers changed", and
  // the one message it delivers (a demotion, with its driver) is the one a
  // seller is most entitled to both receive AND be able to turn off.
  integrity_tier_change: "integrity_updates",
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
// Per-category channel prefs as stored on users.notification_preferences.
type ChannelPrefs = Record<string, { in_app?: boolean; push?: boolean } | undefined>;

export async function notifyUser(
  userId: string,
  input: NotifyInput,
): Promise<void> {
  try {
    const prefKey = PREF_KEY[input.type];
    // US-2853: one read for both preferences. It used to be skipped entirely for
    // always-on types (prefKey === null), but quiet hours apply to those too —
    // an unmutable category is still not a reason to buzz someone at 3am.
    const { data: user } = await supabaseAdmin
      .from("users")
      .select("notification_preferences, notification_quiet_hours")
      .eq("id", userId)
      .maybeSingle();
    const row = user as
      | {
        notification_preferences?: ChannelPrefs;
        notification_quiet_hours?: unknown;
      }
      | null;
    const prefs: ChannelPrefs | undefined = row?.notification_preferences;
    const quiet = quietHoursActive(
      parseQuietHours(row?.notification_quiet_hours),
      new Date(),
    );

    // US-1901: deliver a browser push in parallel to the in-app row, gated on
    // the same category's `push` channel. Fire-and-forget — a push failure must
    // never affect the in-app insert or throw into the lifecycle action.
    // US-2853: and suppressed outright inside the user's quiet window. The
    // insert below still runs, so the notification is waiting in the bell.
    if (!quiet && pushChannelEnabled(prefs, prefKey)) {
      void deliverPush(userId, {
        title: input.title,
        body: input.message,
        url: input.link ?? "/dashboard",
      });
    }

    // In-app: default on — only suppress when explicitly disabled.
    if (prefKey && prefs?.[prefKey]?.in_app === false) return;

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

// Pure gate (unit-tested): is the push channel enabled for this category? A null
// prefKey (always-on types) always allows; otherwise default ON — only an
// explicit `push: false` suppresses.
export function pushChannelEnabled(
  prefs: ChannelPrefs | null | undefined,
  prefKey: string | null,
): boolean {
  if (!prefKey) return true;
  return prefs?.[prefKey]?.push !== false;
}

export interface PushPayload {
  title: string;
  body: string;
  url: string;
}

// Fan a single notification out to every browser subscription for `userId`.
// Tenant-safe: the caller passes the already-resolved recipient/owner id, and
// the query is scoped `.eq("user_id", userId)`. Best-effort throughout: no-ops
// silently when VAPID isn't provisioned, prunes dead (gone) subscriptions, and
// counts other failures without ever throwing.
export async function deliverPush(
  userId: string,
  payload: PushPayload,
): Promise<void> {
  try {
    if (!userId) return;
    const vapid = getVapidConfig();
    if (!vapid) {
      // Push not provisioned on this deploy — email/in-app remain the fallback.
      console.debug("[push] VAPID not configured — skipping web push delivery");
      return;
    }

    const { data: subs, error } = await supabaseAdmin
      .from("push_subscriptions")
      .select("id, endpoint, p256dh, auth")
      .eq("user_id", userId);
    if (error) {
      console.error(`[push] could not load subscriptions for ${userId}: ${error.message}`);
      return;
    }
    if (!subs || subs.length === 0) return;

    await Promise.all(
      (subs as Array<{ id: string; endpoint: string; p256dh: string; auth: string }>).map(
        async (sub) => {
          try {
            const { gone, status } = await sendWebPush(
              { endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth },
              payload,
              vapid,
            );
            if (gone) {
              // 404/410 — the browser dropped the subscription; prune it.
              await supabaseAdmin
                .from("push_subscriptions")
                .delete()
                .eq("id", sub.id)
                .eq("user_id", userId);
            } else if (status >= 400) {
              await bumpFailure(sub.id, userId);
            } else {
              await supabaseAdmin
                .from("push_subscriptions")
                .update({ last_used_at: new Date().toISOString(), failure_count: 0 })
                .eq("id", sub.id)
                .eq("user_id", userId);
            }
          } catch (err) {
            console.error(
              `[push] send failed for ${userId}:`,
              err instanceof Error ? err.message : String(err),
            );
            await bumpFailure(sub.id, userId);
          }
        },
      ),
    );
  } catch (err) {
    console.error(
      `[push] unexpected delivery error for ${userId}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

async function bumpFailure(subId: string, userId: string): Promise<void> {
  try {
    const { data } = await supabaseAdmin
      .from("push_subscriptions")
      .select("failure_count")
      .eq("id", subId)
      .eq("user_id", userId)
      .maybeSingle();
    const next = ((data as { failure_count?: number } | null)?.failure_count ?? 0) + 1;
    await supabaseAdmin
      .from("push_subscriptions")
      .update({ failure_count: next })
      .eq("id", subId)
      .eq("user_id", userId);
  } catch {
    // best-effort — never throw from the failure path.
  }
}

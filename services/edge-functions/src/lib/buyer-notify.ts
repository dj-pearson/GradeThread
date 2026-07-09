// US-1803: the buyer notification delivery layer.
//
// The SINGLE contract the buyer feature epics call — condition alerts (US-1809),
// rewards (US-1814), guarantee (US-1821), portfolio (US-1827) — so none rolls
// its own sender. Fans a buyer notification out across channels, gated by the
// buyer's per-category preference on each channel, and DEDUPED via the
// buyer_notification_log idempotency ledger (north-star 00170 pattern: a UNIQUE
// (user_id, dedupe_key) claim makes a repeat/racy call a no-op).
//
// Commit A (this file) delivers in-app + push IMMEDIATELY. Email + digest
// batching (daily/weekly, honoring the plan's alertFrequency cap) + quiet hours
// land in US-1803 phase B, which flushes queued log rows.
//
// Best-effort: a channel failure (or APNs/DB unconfigured) NEVER throws — a
// notification problem must not break the feature action that triggered it.
// Deps are injectable so fan-out + gating + idempotency are unit-testable
// without a DB or APNs (mirrors selling-activity-notify.ts).
//
// TENANT SCOPE (US-268): the caller passes the notification's OWNER userId (the
// authenticated buyer). Every query here is keyed on that id — never a
// request-body value.

import { supabaseAdmin } from "./supabase.ts";
import { notifyUser, type NotificationType, type NotifyInput, PREF_KEY } from "./notify.ts";
import { pushAllowed } from "./selling-activity-notify.ts";
import { type PushPayload, sendPushToUser } from "./apns.ts";

export type BuyerNotificationCategory =
  | "condition_alert"
  | "reward"
  | "guarantee"
  | "portfolio";

// Category → the in-app notification_type enum value (+ its PREF_KEY category).
const CATEGORY_TYPE: Record<BuyerNotificationCategory, NotificationType> = {
  condition_alert: "buyer_condition_alert",
  reward: "buyer_reward",
  guarantee: "buyer_guarantee",
  portfolio: "buyer_portfolio",
};

export interface BuyerNotifyInput {
  category: BuyerNotificationCategory;
  title: string;
  body: string;
  /** In-app deep link within the buyer app, e.g. /buyer/alerts. */
  link?: string | null;
  /**
   * Stable idempotency key. The SAME (userId, dedupeKey) delivers at most once —
   * pick something that identifies the unit of work (e.g. `alert:<alertId>:<listingId>`).
   */
  dedupeKey: string;
  /** Optional structured payload carried on push `data`. */
  data?: Record<string, string>;
}

type ChannelPrefs = Record<string, { push?: boolean; email?: boolean }> | null | undefined;

export interface BuyerNotifyDeps {
  /** Insert the idempotency claim; resolves true if NEWLY claimed (deliver),
   *  false if already handled (skip) or the claim failed (skip, fail-safe). */
  claim: (userId: string, category: string, dedupeKey: string) => Promise<boolean>;
  loadPrefs: (userId: string) => Promise<ChannelPrefs>;
  notify: (userId: string, input: NotifyInput) => Promise<void>;
  push: (userId: string, payload: PushPayload) => Promise<unknown>;
  /** Test interceptor: called (still preference-gated) INSTEAD of `push`. */
  onPush?: (userId: string, payload: PushPayload) => void | Promise<void>;
}

// INSERT-as-claim into the idempotency ledger. 23505 (unique violation) = a
// concurrent/earlier call already claimed it → skip. Any other error also skips
// (fail-safe: never double-deliver on an ambiguous write).
const defaultClaim = async (
  userId: string,
  category: string,
  dedupeKey: string,
): Promise<boolean> => {
  const { error } = await supabaseAdmin.from("buyer_notification_log").insert({
    user_id: userId,
    category,
    dedupe_key: dedupeKey,
    channels: [],
    sent_at: new Date().toISOString(),
  });
  if (error) {
    if (error.code === "23505") return false; // already handled — idempotent no-op
    console.error(`[buyer-notify] claim failed for ${userId} (${dedupeKey}): ${error.message}`);
    return false;
  }
  return true;
};

const defaultLoadPrefs = async (userId: string): Promise<ChannelPrefs> => {
  const { data } = await supabaseAdmin
    .from("users")
    .select("notification_preferences")
    .eq("id", userId)
    .maybeSingle();
  return (data as { notification_preferences?: ChannelPrefs } | null)?.notification_preferences ??
    null;
};

const defaultDeps: BuyerNotifyDeps = {
  claim: defaultClaim,
  loadPrefs: defaultLoadPrefs,
  notify: notifyUser,
  push: sendPushToUser,
};

/**
 * Deliver a buyer notification across in-app + push (immediate), gated by the
 * buyer's per-category channel preferences and deduped by (userId, dedupeKey).
 * Returns true if this call delivered, false if it was a dedupe no-op. Never
 * throws.
 */
export async function notifyBuyer(
  userId: string,
  input: BuyerNotifyInput,
  deps: BuyerNotifyDeps = defaultDeps,
): Promise<boolean> {
  if (!userId) return false;

  // Idempotency gate FIRST — a repeat/racy call for the same unit of work
  // delivers nothing.
  let claimed = false;
  try {
    claimed = await deps.claim(userId, input.category, input.dedupeKey);
  } catch (err) {
    console.error("[buyer-notify] claim threw:", err instanceof Error ? err.message : err);
    return false;
  }
  if (!claimed) return false;

  const type = CATEGORY_TYPE[input.category];

  // In-app (gated inside notifyUser by PREF_KEY, default ON).
  try {
    await deps.notify(userId, { type, title: input.title, message: input.body, link: input.link ?? null });
  } catch (err) {
    console.error("[buyer-notify] in-app failed:", err instanceof Error ? err.message : err);
  }

  // Push (gated here by the user's per-category push preference, default ON).
  let prefs: ChannelPrefs = null;
  try {
    prefs = await deps.loadPrefs(userId);
  } catch (err) {
    console.error("[buyer-notify] loadPrefs failed:", err instanceof Error ? err.message : err);
  }
  if (pushAllowed(prefs, PREF_KEY[type])) {
    const payload: PushPayload = {
      title: input.title,
      body: input.body,
      category: type,
      data: input.data,
      collapseId: input.dedupeKey,
    };
    try {
      if (deps.onPush) await deps.onPush(userId, payload);
      else await deps.push(userId, payload);
    } catch (err) {
      console.error("[buyer-notify] push failed:", err instanceof Error ? err.message : err);
    }
  }

  return true;
}

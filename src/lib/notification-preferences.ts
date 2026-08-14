import type {
  NotificationChannel,
  NotificationPreferences,
  NotificationType,
} from "@/types/database";

// All channels on by default — users opt out, not in. Each category only lists
// the channels it actually supports; that same list drives the settings UI and
// the admin event catalog (US-1058).
export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  grade_complete: { email: true, in_app: true, push: true },
  dispute_updates: { email: true, in_app: true },
  billing_alerts: { email: true, in_app: true },
  product_updates: { email: true },
  // US-911: master marketing umbrella + dedicated weekly-newsletter category.
  // Included here (not just runtime) so withPreferenceDefaults PRESERVES them on
  // save — otherwise a settings save would silently wipe a recipient's opt-out.
  marketing: { email: true },
  weekly_newsletter: { email: true },
  selling_activity: { email: true, in_app: true, push: true },
  offers: { email: true, in_app: true, push: true },
  returns: { email: true, in_app: true, push: true },
  payouts: { email: true, in_app: true, push: true },
  // US-1803: buyer notification categories (delivered by buyer-notify.ts).
  buyer_alerts: { email: true, in_app: true, push: true },
  buyer_rewards: { email: true, in_app: true, push: true },
  buyer_guarantee: { email: true, in_app: true, push: true },
  buyer_portfolio: { email: true, in_app: true, push: true },
  // US-1859: re-engagement nudges. No email channel on purpose — a nudge sent by
  // email is a marketing email, and the `marketing` umbrella already governs
  // those (the nudge engine honors it as a second gate).
  reward_nudges: { in_app: true, push: true },
  // US-1912: Grade Integrity standing. No email channel — the only message this
  // category ever sends is a private demotion notice, and a demotion arriving by
  // email reads as a punishment letter.
  integrity_updates: { in_app: true, push: true },
};

type PrefKey = keyof NotificationPreferences;

const PREF_KEYS = Object.keys(
  DEFAULT_NOTIFICATION_PREFERENCES,
) as PrefKey[];

// Fills any missing keys/channels with defaults so older/partial rows stay safe
// to read (e.g. rows written before offers/returns/payouts existed).
export function withPreferenceDefaults(
  prefs: Partial<NotificationPreferences> | null | undefined,
): NotificationPreferences {
  const out = {} as NotificationPreferences;
  for (const key of PREF_KEYS) {
    out[key] = {
      ...DEFAULT_NOTIFICATION_PREFERENCES[key],
      ...prefs?.[key],
    };
  }
  return out;
}

// Cross-surface activation nudges (US-1075) are promotional product glue, so
// they honor the same opt-out as other product messaging: when a user turns off
// "Product updates", we suppress these in-app cross-promo prompts entirely.
export function crossSurfacePromosEnabled(
  prefs: Partial<NotificationPreferences> | null | undefined,
): boolean {
  return withPreferenceDefaults(prefs).product_updates.email !== false;
}

export interface NotificationTypeMeta {
  key: PrefKey;
  label: string;
  description: string;
  channels: NotificationChannel[];
}

// The preference categories users toggle, in display order. `channels` is the
// authoritative set of channels each category supports.
export const NOTIFICATION_TYPES: NotificationTypeMeta[] = [
  {
    key: "grade_complete",
    label: "Grading",
    description: "When a submission is graded or an AI condition grade is ready.",
    channels: ["email", "in_app", "push"],
  },
  {
    key: "selling_activity",
    label: "Selling activity",
    description: "When a listing goes live, an item sells, or its status changes.",
    channels: ["email", "in_app", "push"],
  },
  {
    key: "offers",
    label: "Offers",
    description: "When a buyer sends an offer or counters on your listing.",
    channels: ["email", "in_app", "push"],
  },
  {
    key: "returns",
    label: "Returns & disputes",
    // US-2560 widened this. It listed returns and disputes and nothing else, so
    // routing cancellation_requested here would have delivered a message this
    // sentence does not promise — and, worse, would have silently taken
    // cancellations away from anyone who had turned the toggle off for returns.
    // A category's copy is the agreement; widen it in the same commit as the
    // type, or the type needs its own category.
    description:
      "When a buyer opens a return or asks to cancel an order, a return changes status, or a payment dispute is opened.",
    channels: ["email", "in_app", "push"],
  },
  {
    key: "payouts",
    label: "Payouts",
    description: "When a payout is imported or clears to your account.",
    channels: ["email", "in_app", "push"],
  },
  {
    key: "buyer_alerts",
    label: "Condition alerts",
    description: "When a graded item in your brands, sizes, and price range lists.",
    channels: ["email", "in_app", "push"],
  },
  {
    key: "buyer_rewards",
    label: "Buyer rewards",
    description: "Reward events — grade-confirmations, streaks, and redemptions.",
    channels: ["email", "in_app", "push"],
  },
  {
    key: "buyer_guarantee",
    label: "Purchase guarantee",
    description: "Updates on your grade-locked purchase protection and claims.",
    channels: ["email", "in_app", "push"],
  },
  {
    key: "buyer_portfolio",
    label: "Closet portfolio",
    description: "Value peaks and price-drop alerts on items in your closet.",
    channels: ["email", "in_app", "push"],
  },
  {
    // US-1859: the only category that fires because you were AWAY, which is why
    // it gets its own toggle instead of riding one of the reward categories.
    key: "reward_nudges",
    label: "Reward reminders",
    description:
      "Occasional nudges when a streak is about to break, a badge is one step away, a new quest opens, or a reward you were granted is about to expire. Capped to a couple a week.",
    channels: ["in_app", "push"],
  },
  {
    // US-1912: its own toggle because no other category's copy covers "your
    // standing with buyers changed" — and this is the one notice a seller is
    // most entitled to be able to switch off.
    key: "integrity_updates",
    label: "Grade Integrity standing",
    description:
      "When your Grade Integrity tier moves, with the specific reason. Only ever sent to you.",
    channels: ["in_app", "push"],
  },
  {
    key: "dispute_updates",
    label: "Dispute updates",
    description: "When a dispute you filed changes status.",
    channels: ["email", "in_app"],
  },
  {
    key: "billing_alerts",
    label: "Billing",
    description: "Payment receipts, failed charges, and plan changes.",
    channels: ["email", "in_app"],
  },
  {
    // US-2102: the MASTER marketing umbrella (US-911's MARKETING_MASTER_KEY).
    // Every marketing send path honors it — growth broadcasts, the trial drip,
    // journeys and the newsletter — but it was surfaced NOWHERE in the UI, so a
    // user could only opt out of marketing via an emailed link, never in-app.
    //
    // Listed FIRST and worded as an override, because that is what it is: the
    // granular toggles below gate ADDITIONALLY, so turning this off stops all
    // marketing regardless of them. A consent control that understates its own
    // scope is worse than none.
    key: "marketing",
    label: "All marketing email",
    description:
      "Master switch for every marketing email — newsletter, product announcements, tips and offers. Turning this off stops all of them, whatever the settings below say. Transactional email (receipts, grade results, disputes, security) is never affected.",
    channels: ["email"],
  },
  {
    key: "weekly_newsletter",
    label: "Weekly newsletter",
    description:
      "Curated grading tips, resale market trends, and product insights — about once a week. Turn off to stop the newsletter while keeping other email.",
    channels: ["email"],
  },
  {
    key: "product_updates",
    label: "Product updates",
    description: "New features and occasional product announcements.",
    channels: ["email"],
  },
];

export interface NotificationEventMeta {
  type: NotificationType;
  label: string;
  description: string;
  // The preference category that gates this event's delivery, or null when the
  // event is always delivered (e.g. system messages the user can't mute). MUST
  // mirror PREF_KEY in services/edge-functions/src/lib/notify.ts so the admin
  // catalog reflects the real end-to-end gate.
  prefKey: PrefKey | null;
}

// Canonical catalog of every in-app notification TYPE the platform emits, mapped
// to the preference category that gates it. Powers the admin event catalog
// (US-1058) and documents the gate.
export const NOTIFICATION_EVENT_CATALOG: NotificationEventMeta[] = [
  {
    type: "grade_complete",
    label: "Grade complete",
    description: "An AI condition grade is ready to view.",
    prefKey: "grade_complete",
  },
  {
    type: "grading_submitted",
    label: "Grading submitted",
    description: "A submission was sent for grading.",
    prefKey: "grade_complete",
  },
  {
    type: "grading_ready",
    label: "Grading ready",
    description: "A graded submission is ready to review.",
    prefKey: "grade_complete",
  },
  {
    type: "grading_failed",
    label: "Grading failed",
    description: "A grade couldn't finish — the charge was reversed.",
    prefKey: "grade_complete",
  },
  {
    type: "grading_incomplete",
    label: "Grading incomplete",
    description: "A grade was withheld because clearer photos are needed.",
    prefKey: "grade_complete",
  },
  {
    type: "item_status_change",
    label: "Item status changed",
    description: "An inventory item moved to a new pipeline stage.",
    prefKey: "selling_activity",
  },
  {
    type: "listing_live",
    label: "Listing live",
    description: "A listing was published to a marketplace.",
    prefKey: "selling_activity",
  },
  {
    type: "sale_recorded",
    label: "Sale recorded",
    description: "An item sold.",
    prefKey: "selling_activity",
  },
  {
    type: "low_stock",
    label: "Low stock",
    description: "A listing is running low or out of stock.",
    prefKey: "selling_activity",
  },
  {
    type: "offer_received",
    label: "Offer received",
    description: "A buyer sent an offer on a listing.",
    prefKey: "offers",
  },
  {
    type: "offer_responded",
    label: "Offer responded",
    description: "An offer was accepted, declined, or countered.",
    prefKey: "offers",
  },
  {
    type: "return_requested",
    label: "Return requested",
    description: "A buyer opened a return or refund request.",
    prefKey: "returns",
  },
  {
    type: "return_opened",
    label: "Return opened",
    description: "A buyer opened a return (eBay Post-Order).",
    prefKey: "returns",
  },
  {
    type: "dispute_opened",
    label: "Payment dispute opened",
    description: "A buyer opened a payment dispute or chargeback.",
    prefKey: "returns",
  },
  {
    type: "cancellation_requested",
    label: "Cancellation requested",
    description: "A buyer asked to cancel an order before it ships (eBay Post-Order).",
    prefKey: "returns",
  },
  {
    type: "payout_imported",
    label: "Payout imported",
    description: "A marketplace payout was imported.",
    prefKey: "payouts",
  },
  {
    type: "dispute_update",
    label: "Dispute update",
    description: "A grade dispute changed status.",
    prefKey: "dispute_updates",
  },
  {
    type: "billing",
    label: "Billing",
    description: "A payment, receipt, or plan-change event.",
    prefKey: "billing_alerts",
  },
  {
    type: "buyer_condition_alert",
    label: "Condition alert",
    description: "A graded item matching your watch criteria was listed.",
    prefKey: "buyer_alerts",
  },
  {
    type: "buyer_reward",
    label: "Buyer reward",
    description: "A reward, streak, or redemption event.",
    prefKey: "buyer_rewards",
  },
  {
    type: "buyer_guarantee",
    label: "Purchase guarantee",
    description: "An update on your grade-locked purchase protection.",
    prefKey: "buyer_guarantee",
  },
  {
    type: "buyer_portfolio",
    label: "Closet portfolio",
    description: "A value or price-drop alert on an item you own.",
    prefKey: "buyer_portfolio",
  },
  {
    type: "reward_nudge",
    label: "Reward reminder",
    description: "A streak, badge, quest, or expiring-reward nudge.",
    prefKey: "reward_nudges",
  },
  {
    type: "integrity_tier_change",
    label: "Grade Integrity standing",
    description: "Your Grade Integrity tier moved, and what moved it.",
    prefKey: "integrity_updates",
  },
  {
    type: "system",
    label: "System",
    description: "Essential account messages — always delivered.",
    prefKey: null,
  },
];

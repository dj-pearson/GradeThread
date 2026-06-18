import type { NotificationPreferences } from "@/types/database";

// All channels on by default — users opt out, not in.
export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  grade_complete: { email: true, in_app: true },
  dispute_updates: { email: true, in_app: true },
  billing_alerts: { email: true },
  product_updates: { email: true },
  selling_activity: { email: true, in_app: true },
};

// Fills any missing keys with defaults so older/partial rows stay safe to read.
export function withPreferenceDefaults(
  prefs: Partial<NotificationPreferences> | null | undefined
): NotificationPreferences {
  return {
    grade_complete: {
      ...DEFAULT_NOTIFICATION_PREFERENCES.grade_complete,
      ...prefs?.grade_complete,
    },
    dispute_updates: {
      ...DEFAULT_NOTIFICATION_PREFERENCES.dispute_updates,
      ...prefs?.dispute_updates,
    },
    billing_alerts: {
      ...DEFAULT_NOTIFICATION_PREFERENCES.billing_alerts,
      ...prefs?.billing_alerts,
    },
    product_updates: {
      ...DEFAULT_NOTIFICATION_PREFERENCES.product_updates,
      ...prefs?.product_updates,
    },
    selling_activity: {
      ...DEFAULT_NOTIFICATION_PREFERENCES.selling_activity,
      ...prefs?.selling_activity,
    },
  };
}

// Cross-surface activation nudges (US-1075) are promotional product glue, so
// they honor the same opt-out as other product messaging: when a user turns off
// "Product updates", we suppress these in-app cross-promo prompts entirely.
export function crossSurfacePromosEnabled(
  prefs: Partial<NotificationPreferences> | null | undefined
): boolean {
  return withPreferenceDefaults(prefs).product_updates.email;
}

export interface NotificationTypeMeta {
  key: keyof NotificationPreferences;
  label: string;
  description: string;
  channels: ("email" | "in_app")[];
}

export const NOTIFICATION_TYPES: NotificationTypeMeta[] = [
  {
    key: "grade_complete",
    label: "Grade complete",
    description: "When an AI condition grade is ready to view.",
    channels: ["email", "in_app"],
  },
  {
    key: "dispute_updates",
    label: "Dispute updates",
    description: "When a dispute you filed changes status.",
    channels: ["email", "in_app"],
  },
  {
    key: "billing_alerts",
    label: "Billing alerts",
    description: "Payment receipts, failed charges, and plan changes.",
    channels: ["email"],
  },
  {
    key: "product_updates",
    label: "Product updates",
    description: "New features and occasional product announcements.",
    channels: ["email"],
  },
  {
    key: "selling_activity",
    label: "Selling activity",
    description:
      "When a listing goes live, an item sells, or a payout is imported.",
    channels: ["email", "in_app"],
  },
];

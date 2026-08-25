// US-2854: operator kill switches for outgoing email, by category.
//
// Before this, the only way to stop a category of email mid-incident was a code
// deploy. A bad template, a runaway job, or a partner outage that turns one
// notification into forty all had the same remedy: edit, review, build, deploy,
// wait. This gives an operator a switch that takes effect on the next send.
//
// ── WHERE IT IS ENFORCED ────────────────────────────────────────────────────
//
// One place: deliverEmail() in lib/email.ts, immediately after the suppression
// check. Every outgoing message funnels through that function — the live sends,
// the outbox retry cron, the marketing coordinator and the operator brief — so
// gating there cannot be routed around by a new caller that forgets.
//
// ── WHAT IT CANNOT TURN OFF ─────────────────────────────────────────────────
//
// PROTECTED_CATEGORIES is not a suggestion and is not stored in the database.
// Sign-in codes, password resets, payment failures and receipts are either
// legally required or the only warning before someone loses access or money.
// An operator who disables those has not paused a program, they have locked
// people out of their accounts and stopped telling them their card failed. The
// switch refuses them at write time AND again at read time, so a row edited by
// hand in the database still cannot suppress one.
//
// A disabled category is SKIPPED, not queued. It records an audit row the same
// way a suppressed recipient does, so "why did nobody get this" has an answer
// that is not "read the deploy history".

import { getSetting } from "./system-settings.ts";

/** system_settings key holding the disabled list (json array of category ids). */
export const DISABLED_CATEGORIES_KEY = "email_categories_disabled";

export interface EmailCategoryMeta {
  category: string;
  label: string;
  /** Grouping for the admin table. */
  group: "account" | "grading" | "selling" | "billing" | "marketing" | "operator";
  /** True when no operator may disable it, whatever the stored list says. */
  protected: boolean;
}

// Categories that may never be switched off. Keep the REASON in mind when
// adding: it is "someone loses access or money, or we are legally obliged",
// not "this one seems important".
export const PROTECTED_CATEGORIES: ReadonlySet<string> = new Set([
  // Auth: the only way into the account. sendAuthActionEmail builds these as
  // `auth_${actionType}`, so the prefix is matched separately in isProtected().
  "account_deleted",
  // Money: the last warning before a card is declined or access lapses.
  "payment_failed",
  "payment_action_required",
  // Receipts: a charge with no record of it.
  "subscription_renewal_receipt",
  "credit_pack_purchased",
  "subscription_started",
  "subscription_canceled",
  "plan_downgraded",
]);

/** Every auth email is protected, whichever action type produced it. */
export const AUTH_CATEGORY_PREFIX = "auth_";

export function isProtectedCategory(category: string): boolean {
  return (
    PROTECTED_CATEGORIES.has(category) ||
    category.startsWith(AUTH_CATEGORY_PREFIX)
  );
}

// The catalog the admin table renders. A guard test asserts every `category:`
// literal in lib/email.ts appears here, so a new email type cannot ship with no
// switch and no operator visibility.
export const EMAIL_CATEGORY_CATALOG: readonly EmailCategoryMeta[] = [
  // ── account ──────────────────────────────────────────────────────────────
  { category: "welcome", label: "Welcome", group: "account", protected: false },
  {
    category: "account_deleted",
    label: "Account deleted confirmation",
    group: "account",
    protected: true,
  },
  {
    category: "workspace_invite",
    label: "Workspace invitation",
    group: "account",
    protected: false,
  },
  {
    category: "admin_message",
    label: "Message from an admin",
    group: "account",
    protected: false,
  },
  { category: "feedback", label: "Feedback reply", group: "account", protected: false },
  {
    category: "newsletter-confirm",
    label: "Newsletter confirmation",
    group: "account",
    protected: false,
  },
  // ── grading ──────────────────────────────────────────────────────────────
  {
    category: "grade_preliminary",
    label: "Grade ready (preliminary)",
    group: "grading",
    protected: false,
  },
  {
    category: "grade_finalized",
    label: "Grade finalized",
    group: "grading",
    protected: false,
  },
  {
    category: "grade_review_request",
    label: "Grade review requested",
    group: "grading",
    protected: false,
  },
  {
    category: "dispute_status",
    label: "Dispute resolved",
    group: "grading",
    protected: false,
  },
  {
    category: "dispute_filed_admin",
    label: "Dispute filed (admin notice)",
    group: "grading",
    protected: false,
  },
  {
    category: "guarantee_remedy",
    label: "Guarantee remedy",
    group: "grading",
    protected: false,
  },
  // ── selling ──────────────────────────────────────────────────────────────
  {
    category: "offer_received",
    label: "Offer received",
    group: "selling",
    protected: false,
  },
  {
    category: "offer_responded",
    label: "Offer answered",
    group: "selling",
    protected: false,
  },
  {
    category: "return_opened",
    label: "Return opened",
    group: "selling",
    protected: false,
  },
  {
    category: "dispute_opened",
    label: "Payment dispute opened",
    group: "selling",
    protected: false,
  },
  {
    category: "cancellation_requested",
    label: "Cancellation requested",
    group: "selling",
    protected: false,
  },
  {
    category: "buyer_notification",
    label: "Buyer notifications",
    group: "selling",
    protected: false,
  },
  // ── billing ──────────────────────────────────────────────────────────────
  {
    category: "subscription_started",
    label: "Subscription started",
    group: "billing",
    protected: true,
  },
  {
    category: "subscription_renewal_receipt",
    label: "Renewal receipt",
    group: "billing",
    protected: true,
  },
  {
    category: "subscription_renewal_reminder",
    label: "Renewal reminder",
    group: "billing",
    protected: false,
  },
  {
    category: "subscription_canceled",
    label: "Subscription canceled",
    group: "billing",
    protected: true,
  },
  {
    category: "subscription_paused",
    label: "Subscription paused",
    group: "billing",
    protected: false,
  },
  {
    category: "subscription_resumed",
    label: "Subscription resumed",
    group: "billing",
    protected: false,
  },
  {
    category: "plan_downgraded",
    label: "Plan downgraded",
    group: "billing",
    protected: true,
  },
  {
    category: "credit_pack_purchased",
    label: "Credit pack receipt",
    group: "billing",
    protected: true,
  },
  {
    category: "payment_failed",
    label: "Payment failed",
    group: "billing",
    protected: true,
  },
  {
    category: "payment_action_required",
    label: "Payment action required",
    group: "billing",
    protected: true,
  },
  {
    category: "trial_expiring",
    label: "Trial expiring",
    group: "billing",
    protected: false,
  },
  {
    category: "referral_reward",
    label: "Referral reward",
    group: "billing",
    protected: false,
  },
  // ── operator ─────────────────────────────────────────────────────────────
  { category: "ops_alert", label: "Ops alert", group: "operator", protected: false },
  {
    category: "ai_budget_alert",
    label: "AI budget alert",
    group: "operator",
    protected: false,
  },
  {
    category: "audit_anomaly_alert",
    label: "Audit anomaly alert",
    group: "operator",
    protected: false,
  },
  {
    category: "grading_regression_alert",
    label: "Grading regression alert",
    group: "operator",
    protected: false,
  },
  {
    category: "content_watchdog_alert",
    label: "Content watchdog alert",
    group: "operator",
    protected: false,
  },
  {
    category: "content_digest",
    label: "Content digest",
    group: "operator",
    protected: false,
  },
  {
    category: "support_escalation",
    label: "Support escalation",
    group: "operator",
    protected: false,
  },
  {
    category: "support_abuse_alert",
    label: "Support abuse alert",
    group: "operator",
    protected: false,
  },
] as const;

const KNOWN = new Set(EMAIL_CATEGORY_CATALOG.map((c) => c.category));

/**
 * Clean an operator-supplied disable list: drop anything unknown and anything
 * protected, de-duplicate, sort. Pure — the admin route uses it on write and the
 * read path uses it again, so a row edited directly in the database still cannot
 * suppress a protected category.
 */
export function sanitizeDisabledList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out = new Set<string>();
  for (const v of raw) {
    if (typeof v !== "string") continue;
    const c = v.trim();
    if (!c || !KNOWN.has(c) || isProtectedCategory(c)) continue;
    out.add(c);
  }
  return [...out].sort();
}

/** The current disabled set, read through the settings cache. */
export async function disabledEmailCategories(): Promise<Set<string>> {
  const raw = await getSetting<unknown>(DISABLED_CATEGORIES_KEY, []);
  return new Set(sanitizeDisabledList(raw));
}

/**
 * Is this category currently switched off? An uncategorized send is never
 * blocked — there is nothing to switch off, and failing closed on an absent
 * category would mute mail nobody chose to mute.
 */
export async function emailCategoryDisabled(
  category: string | undefined | null,
): Promise<boolean> {
  if (!category) return false;
  if (isProtectedCategory(category)) return false;
  try {
    return (await disabledEmailCategories()).has(category);
  } catch {
    // Fail OPEN. A settings read that throws must not become an outage in which
    // no email sends at all.
    return false;
  }
}

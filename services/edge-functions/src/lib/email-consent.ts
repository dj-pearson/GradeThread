// US-911: canonical marketing-consent model.
//
// ONE umbrella key (`marketing`) is the master marketing-email opt-out that
// EVERY marketing send path honors (growth broadcasts, the trial drip, journeys,
// and the weekly newsletter). Granular marketing categories (currently
// `weekly_newsletter`) let a recipient mute ONE program without unsubscribing
// from everything. Transactional categories (grading results, billing, …) are
// NOT marketing and can never be suppressed here.
//
// Before US-911 the no-login unsubscribe link wrote `product_updates.email`
// while every send gate read `marketing.email` — so an unsubscribe never
// actually suppressed a broadcast. This module is the single source of truth for
// BOTH the writer (the unsubscribe link / preference center) and the readers
// (the coordinator + drip entry filter), so the key can never drift again. Pure
// (no supabase / no import-time env) so the gates and their tests share it
// without an env dance.

export const MARKETING_MASTER_KEY = "marketing";
export const WEEKLY_NEWSLETTER_KEY = "weekly_newsletter";

type Prefs = Record<string, unknown> | null | undefined;

function channelDisabled(prefs: Prefs, key: string, channel: string): boolean {
  if (!prefs || typeof prefs !== "object") return false;
  const c = (prefs as Record<string, unknown>)[key];
  if (!c || typeof c !== "object") return false;
  return (c as Record<string, unknown>)[channel] === false;
}

/** Master marketing opt-out — the umbrella every marketing send honors. */
export function isMarketingOptedOut(prefs: Prefs, channel = "email"): boolean {
  return channelDisabled(prefs, MARKETING_MASTER_KEY, channel);
}

/** A granular marketing category is enabled unless it was explicitly turned off
 *  (opt-out model: absence ⇒ enabled). */
export function isMarketingCategoryEnabled(
  prefs: Prefs,
  key: string,
  channel = "email",
): boolean {
  return !channelDisabled(prefs, key, channel);
}

// Each marketing send SOURCE maps to the granular category that ALSO gates it
// (null ⇒ only the master umbrella applies). Keys mirror MarketingSource in
// lib/marketing-frequency.ts.
export const MARKETING_SOURCE_CATEGORY: Record<string, string | null> = {
  trial_drip: null,
  win_back: null,
  journey: null,
  weekly_newsletter: WEEKLY_NEWSLETTER_KEY,
};

/**
 * Is a marketing send to this recipient denied by consent? Honors the master
 * umbrella for EVERY source, plus the per-source granular category (so the
 * autonomous newsletter is suppressed when `weekly_newsletter` is off even if
 * the recipient still wants other marketing — US-911 AC2).
 */
export function marketingConsentDenied(
  prefs: Prefs,
  source: string,
  channel = "email",
): boolean {
  if (isMarketingOptedOut(prefs, channel)) return true;
  const cat = MARKETING_SOURCE_CATEGORY[source];
  if (cat && !isMarketingCategoryEnabled(prefs, cat, channel)) return true;
  return false;
}

// ── consent transforms (used by the no-login endpoints) ───────────────────────

/** Immutably set a single category/channel flag into a prefs blob. */
function setFlag(
  prefs: Prefs,
  key: string,
  channel: string,
  value: boolean,
): Record<string, unknown> {
  const base: Record<string, unknown> =
    prefs && typeof prefs === "object" ? { ...(prefs as Record<string, unknown>) } : {};
  const cur =
    base[key] && typeof base[key] === "object"
      ? { ...(base[key] as Record<string, unknown>) }
      : {};
  cur[channel] = value;
  base[key] = cur;
  return base;
}

/**
 * "Unsubscribe from ALL marketing" — flips the master umbrella off. This is the
 * SINGLE canonical write the no-login unsubscribe link performs (US-911 AC1), so
 * it lands on the exact key every send gate reads.
 */
export function applyUnsubscribeAll(prefs: Prefs, channel = "email"): Record<string, unknown> {
  return setFlag(prefs, MARKETING_MASTER_KEY, channel, false);
}

/** Toggle one granular marketing category (preference-center fine-tuning). */
export function applyCategoryConsent(
  prefs: Prefs,
  key: string,
  enabled: boolean,
  channel = "email",
): Record<string, unknown> {
  return setFlag(prefs, key, channel, enabled);
}

// ── preference-center metadata ────────────────────────────────────────────────

export interface ConsentCategoryMeta {
  key: string;
  label: string;
  description: string;
}

/** Suppressible marketing categories shown as toggles in the preference center. */
export const PREFERENCE_CENTER_CATEGORIES: ConsentCategoryMeta[] = [
  {
    key: WEEKLY_NEWSLETTER_KEY,
    label: "Weekly newsletter",
    description:
      "Curated grading tips, resale market trends, and product insights — about once a week.",
  },
];

/** Transactional categories — always sent, shown locked in the preference center
 *  so a recipient understands they can't be turned off here (US-911 AC3). */
export const TRANSACTIONAL_CATEGORY_LABELS: string[] = [
  "Grading results & submission status",
  "Billing, receipts & plan changes",
  "Selling activity, offers, returns & payouts",
  "Account, security & essential service messages",
];
